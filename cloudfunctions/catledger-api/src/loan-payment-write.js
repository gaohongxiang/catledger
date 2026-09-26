const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { lockAccounts,validateCategory,insertManualTransaction } = require('./transaction-command-service')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { paymentInput,paymentDrafts } = require('./loan-payment-domain')
const { lockLoanVersions,advanceLoans,assertPrincipalTimeline } = require('./loan-payment-repository')
const { sourceTime,loadSource,sourceSelection,validateSourceAmounts,saveSource } = require('./loan-source')
const { inspectPayment,deactivatePayment,deleteTransactions } = require('./loan-payment-maintenance')
function versionInputs(input, previous, requested) {
  const versions=new Map(input.allocations.map(a=>[a.loanId,a.version]))
  if(previous) {
    if(!Array.isArray(requested) || requested.length!==previous.allocations.length || new Set(requested.map(r=>r.loanId)).size!==requested.length) throw ledgerError('VALIDATION_ERROR')
    if(previous.allocations.some(a=>!requested.some(r=>r.loanId===a.loanId))) throw ledgerError('VALIDATION_ERROR')
    for(const row of requested) {
      if(versions.has(row.loanId) && versions.get(row.loanId)!==row.version) throw ledgerError('CONFLICT')
      versions.set(row.loanId,row.version)
    }
  }
  if(versions.size>40) throw ledgerError('VALIDATION_ERROR')
  return [...versions].map(([loanId,version])=>({loanId,version}))
}
async function writePayment(connection,uid,data,secret,selectLoan,{correct=false}={}) {
  const replacement=correct ? {paymentId:data.paymentId,version:data.version,loans:data.loans} : data.replacePayment
  const previous=replacement ? await inspectPayment(connection,uid,replacement.paymentId,replacement.version) : null
  const mode=correct ? (previous.payment.mode==='new'?'new':'correctExisting') : data.mode
  if(previous)await require('./loan-charge-store').assertNoCharges(connection,uid,previous.transactions.map(t=>t.transactionId))
  const input=paymentInput({...data,mode}), loanVersions=versionInputs(input,previous,replacement&&replacement.loans)
  // 两组贷款版本一次核对，最终只递增一次；更正中间态不当作新的本金余额。
  const loans=await lockLoanVersions(connection,uid,loanVersions,selectLoan,40)
  const allocated=new Map(input.allocations.map(a=>[a.loanId,loans.get(a.loanId)]))
  const paymentPeriods=require('./loan-payment-period'), periodAllocations=await paymentPeriods.prepare(connection,uid,input,loans,previous)
  let source=null,originalSource=null,roots=[]
  if(correct && previous.payment.mode!=='new') {
    if(input.kind!==previous.payment.kind || input.assetAccountId!==previous.payment.assetAccountId || input.totalMinor!==previous.payment.totalMinor ||
      input.localAt!==sourceTime(previous.payment.occurredLocalAt,previous.payment.timezoneOffsetMinutes) || input.timezoneOffsetMinutes!==previous.payment.timezoneOffsetMinutes) throw ledgerError('LOAN_SOURCE_MISMATCH')
    source={...previous.source,transactions:previous.transactions}
    originalSource=previous.originalSource
    roots=previous.payment.mode==='correctExisting' ? previous.originals.map(t=>({transactionId:t.transactionId,deletedVersion:Number(t.version)})) : previous.transactions.map(t=>({transactionId:t.transactionId,deletedVersion:Number(t.version)+1}))
  } else if(input.mode!=='new') {
    if(!data.source || typeof data.source.fingerprint!=='string') throw ledgerError('VALIDATION_ERROR')
    source=await loadSource(connection,uid,data.source.transactionIds,{forUpdate:true})
    if(sourceSelection(uid,secret,source).fingerprint!==data.source.fingerprint) throw ledgerError('CONFLICT')
    if(input.mode==='correctExisting') roots=source.transactions.map(t=>({transactionId:t.transactionId,deletedVersion:Number(t.version)+1}))
  }
  if(previous && !correct) {
    if(input.mode!=='correctExisting' || !source.event || previous.payment.mode!=='new' || input.kind!=='repayment' || previous.payment.kind!=='repayment' ||
      input.totalMinor!==previous.payment.totalMinor || input.assetAccountId!==previous.payment.assetAccountId) throw ledgerError('LOAN_SOURCE_MISMATCH')
  }
  const chargePayments=require('./loan-charge-payments'), chargeAllocations=[]
  for (const a of input.allocations) {
    const loan=allocated.get(a.loanId), contract=await require('./loan-charge-store').contract(connection,uid,loan.loanId)
    if(contract)loan.originKind=contract.originKind
    if(input.kind==='repayment')chargeAllocations.push(...await chargePayments.validate(connection,uid,loan,a,{excludePaymentId:previous&&previous.payment.paymentId,paymentDate:input.localDate}))
  }
  const drafts=paymentDrafts(input,allocated,chargeAllocations)
  if(source) validateSourceAmounts(source,input,drafts,allocated,input.mode==='associate')
  const deleting=correct ? previous.transactions : (input.mode==='correctExisting'?source.transactions:[]).concat(previous?previous.transactions:[])
  const changes=deleting.map(transaction=>({transaction,multiplier:-1n})).concat(input.mode==='associate'?[]:drafts.map(transaction=>({transaction})))
  const accounts=await lockAccounts(connection,uid,[input.assetAccountId,...[...loans.values()].map(l=>l.accountId),...deleting.flatMap(t=>[t.sourceAccountId,t.destinationAccountId])])
  if(!['cash','bank','wallet','other_asset'].includes(accounts.get(input.assetAccountId).type)) throw ledgerError('VALIDATION_ERROR')
  for(const loan of allocated.values()) {
    if(input.unallocatedMinor!=='0'&&accounts.get(loan.accountId).type!=='credit')throw ledgerError('VALIDATION_ERROR')
    if(!['credit','other_liability'].includes(accounts.get(loan.accountId).type)) throw ledgerError('VALIDATION_ERROR')
    if(loan.baselinePrincipalMinor==null) throw ledgerError('LOAN_PRINCIPAL_UNCONFIRMED')
    if(input.localDate<loan.baselineDate) throw ledgerError('VALIDATION_ERROR')
  }
  for(const id of new Set(drafts.map(d=>d.categoryId).filter(Boolean))) await validateCategory(connection,uid,id,'expense')
  await assertCashBalanceChanges(connection,uid,accounts,changes)
  if(previous) await deactivatePayment(connection,uid,previous.payment.paymentId)
  await deleteTransactions(connection,uid,deleting)
  const paymentId=randomUUID()
  await connection.execute(`INSERT INTO catledger_loan_payments
    (uid,payment_id,kind,origin_mode,asset_account_id,total_minor,occurred_local_at,occurred_at_utc,timezone_offset_minutes) VALUES (?,?,?,?,?,?,?,?,?)`,
  [uid,paymentId,input.kind,input.mode,input.assetAccountId,input.totalMinor,input.localAt,input.occurredAtUtc,input.timezoneOffsetMinutes])
  for(const a of input.allocations) await connection.execute(`INSERT INTO catledger_loan_payment_allocations
    (uid,payment_id,loan_id,principal_minor,interest_minor,fee_minor,interest_treatment,fee_treatment,interest_category_id,fee_category_id,confirmed_loan_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[uid,paymentId,a.loanId,a.principalMinor,a.interestMinor,a.feeMinor,a.interestTreatment,a.feeTreatment,a.interestCategoryId,a.feeCategoryId,a.version])
  await assertPrincipalTimeline(connection,uid,loans)
  const transactions=[]
  if(input.mode==='associate') transactions.push(...source.transactions)
  else for(const draft of drafts) {
    const transactionId=randomUUID()
    await insertManualTransaction(connection,uid,transactionId,draft)
    if(source&&source.event) await connection.execute("UPDATE catledger_transactions SET origin='import' WHERE uid=? AND transaction_id=?",[uid,transactionId])
    transactions.push({...draft,transactionId,version:1})
  }
  await chargePayments.persist(connection,uid,paymentId,chargeAllocations,transactions)
  await paymentPeriods.persist(connection,uid,paymentId,periodAllocations)
  for(const row of transactions) await connection.execute(`INSERT INTO catledger_loan_payment_transactions
    (uid,payment_id,transaction_id,transaction_version,created_by_payment) VALUES (?,?,?,?,?)`,[uid,paymentId,row.transactionId,Number(row.version),input.mode==='associate'?0:1])
  for(const root of roots) await connection.execute(`INSERT INTO catledger_loan_replaced_transactions
    (uid,payment_id,transaction_id,deleted_version) VALUES (?,?,?,?)`,[uid,paymentId,root.transactionId,root.deletedVersion])
  if(source) await saveSource(connection,uid,paymentId,source,input,{original:originalSource,newTransactions:transactions})
  if(previous) await connection.execute('INSERT INTO catledger_loan_payment_corrections (uid,payment_id,previous_payment_id) VALUES (?,?,?)',[uid,paymentId,previous.payment.paymentId])
  return {paymentId,version:1,transactionCount:transactions.length,loans:await advanceLoans(connection,uid,loans),...(previous?{previousPaymentId:previous.payment.paymentId}:{})}
}
module.exports={writePayment}
