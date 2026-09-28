const { ledgerError } = require('./ledger-errors')
const { parseVersion } = require('./transaction-domain')
const { encodeCursor } = require('./cursor')
const { digestRequest } = require('./request-digest')
const provenance = require('./transaction-provenance')
const store = require('./loan-charge-store')
const { transactionDeltas, queryBookBalance } = require('./cash-balance-guard')

// 完整范围先计算，再由唯一外层用户锁事务执行。任何依赖都不能静默跳过。
async function prepare(c, uid, data, secret, selectLoan) {
  const loan=await selectLoan(c,uid,data.loanId)
  if(loan.deletedAt!=null)throw ledgerError('NOT_FOUND')
  if(Number(loan.version)!==parseVersion(data.version))throw ledgerError('CONFLICT')
  const contract=await store.contract(c,uid,loan.loanId),charges=contract?await store.charges(c,uid,contract.contractId):[]
  const [items]=await c.execute('SELECT item_id AS itemId,transaction_id AS transactionId,loan_id AS loanId,component,active,version FROM catledger_installment_items WHERE uid=? AND loan_id=? ORDER BY item_id',[uid,loan.loanId])
  const [payments]=await c.execute(`SELECT DISTINCT p.payment_id AS paymentId,p.version,p.kind,p.origin_mode AS mode
    FROM catledger_loan_payments p WHERE p.uid=? AND p.status='active' AND (
      EXISTS(SELECT 1 FROM catledger_loan_payment_allocations a WHERE a.uid=p.uid AND a.payment_id=p.payment_id AND a.loan_id=?) OR
      EXISTS(SELECT 1 FROM catledger_loan_charge_allocations a JOIN catledger_loan_charges f ON f.uid=a.uid AND f.charge_id=a.charge_id
        WHERE a.uid=p.uid AND a.payment_id=p.payment_id AND f.contract_id=?)) ORDER BY p.payment_id`,[uid,loan.loanId,contract?.contractId||null])
  const [transactions]=await c.execute(`SELECT t.transaction_id AS transactionId,t.type,t.source_account_id AS sourceAccountId,t.destination_account_id AS destinationAccountId,
    t.amount_minor AS amountMinor,t.version,t.creation_provenance_json AS provenance FROM catledger_transactions t WHERE t.uid=? AND t.deleted_at IS NULL AND (
      JSON_CONTAINS(t.creation_provenance_json,JSON_QUOTE(?),'$.loanIds') OR
      EXISTS(SELECT 1 FROM catledger_loan_payment_transactions r JOIN catledger_loan_payment_allocations a ON a.uid=r.uid AND a.payment_id=r.payment_id
        WHERE r.uid=t.uid AND r.transaction_id=t.transaction_id AND a.loan_id=?) OR
      EXISTS(SELECT 1 FROM catledger_loan_payment_transactions r JOIN catledger_loan_charge_allocations a ON a.uid=r.uid AND a.payment_id=r.payment_id
        JOIN catledger_loan_charges f ON f.uid=a.uid AND f.charge_id=a.charge_id WHERE r.uid=t.uid AND r.transaction_id=t.transaction_id AND f.contract_id=?) OR
      EXISTS(SELECT 1 FROM catledger_installment_items i WHERE i.uid=t.uid AND i.transaction_id=t.transaction_id AND i.loan_id=?) OR
      EXISTS(SELECT 1 FROM catledger_loan_charges f WHERE f.uid=t.uid AND f.contract_id=? AND (f.transaction_id=t.transaction_id OR f.balance_adjustment_id=t.transaction_id)))
    ORDER BY t.transaction_id LIMIT 6001`,[uid,loan.loanId,loan.loanId,contract?.contractId||null,loan.loanId,contract?.contractId||null])
  if(transactions.length>6000||items.length>3600||payments.length>1200)throw ledgerError('LOAN_SOURCE_TOO_LARGE')
  const blockers=[],relations=[],byId=new Map(transactions.map(t=>[t.transactionId,t])),byCharge=new Map(charges.map(f=>[f.chargeId,f]))
  const dependencies=await require('./loan-deletion-relations').load(c,uid,payments,transactions)
  const block=(code,message,entry)=>{if(!blockers.some(b=>b.code===code&&b.entry.url===entry.url))blockers.push({code,message,entry})}
  const loanEntry={label:'返回贷款详情核对',url:'/pages/loan-detail/index?loanId='+loan.loanId}
  for(const payment of payments){
    const {allocations,links,coverage,periods}=payment
    if(allocations.some(a=>a.loanId!==loan.loanId)||coverage.some(f=>f.loanId!==loan.loanId)||periods.some(p=>p.loanId!==loan.loanId))
      block('SHARED_PAYMENT','这笔付款还涉及其他计划，请先在付款详情更正或解除分配。',{label:'处理共享付款',url:'/pages/loan-payment/index?paymentId='+payment.paymentId})
    // 费用分配可能命中未直接分配本金的付款；整组仍须完整纳入，不能只撤费用。
    if(!links.length||links.some(l=>!byId.has(l.transactionId)||Number(byId.get(l.transactionId).version)!==Number(l.version)))block('PAYMENT_REVIEW','付款与当前账目关系已变化，请先在付款详情核对。',{label:'核对付款',url:'/pages/loan-payment/index?paymentId='+payment.paymentId})
  }
  for(const t of transactions){
    t.amountMinor=String(t.amountMinor);t.version=Number(t.version)
    const sources=dependencies.sources(t.transactionId)
    const valid=sources.filter(s=>Number(s.version)===t.version&&s.updateStatus==='posted'&&(['posted','corrected'].includes(s.status)||s.status==='excluded'&&s.role==='historical_primary'))
    t.provenance=t.provenance?provenance.normalize(t.provenance):await provenance.resolve(c,uid,t.transactionId)
    const own=t.provenance.kind==='loan'&&t.provenance.loanIds.length===1&&t.provenance.loanIds[0]===loan.loanId
    t.disposition=valid.length?'retain':own?'revoke':t.provenance.kind==='unknown'?'review':'retain'
    t.reason=valid.length?'verified_source':own?'exclusive_creation':t.provenance.kind==='unknown'?'unknown_creation':'existing_transaction'
    if(sources.length!==valid.length)block('SOURCE_REVIEW','来源版本或有效状态待核对，请先处理原账单。',{label:'核对原账目',url:'/pages/transaction-editor/index?transactionId='+t.transactionId})
    const uses=dependencies.uses(t.transactionId)
    for(const use of uses)if(use.loanId!==loan.loanId)block('SHARED_RECORD','相关账目仍被其他业务使用，请先在原业务中解除或更正关系。',use.kind==='payment'?{label:'处理付款关系',url:'/pages/loan-payment/index?paymentId='+use.id}:{label:'核对关联计划',url:'/pages/loan-detail/index?loanId='+use.loanId})
    relations.push({id:t.transactionId,sources,uses})
  }
  for(const p of payments){
    const group=p.links.map(l=>byId.get(l.transactionId)).filter(Boolean)
    if(group.some(t=>t.disposition==='retain')&&group.some(t=>t.disposition==='revoke'))block('MIXED_PAYMENT','这笔付款含需保留和待撤销的记录，不能自动拆分，请先在付款详情核对。',{label:'核对完整付款',url:'/pages/loan-payment/index?paymentId='+p.paymentId})
    if(group.length&&group.every(t=>t.disposition==='retain')){
      for(const row of p.coverage){
        const f=byCharge.get(row.chargeId),t=f&&byId.get(f.transactionId)
        if(t&&t.disposition!=='retain'){t.disposition='retain';t.reason='retained_payment_coverage'}
      }
    }
  }
  // 费用、余额保全及一次性覆盖作为一个财务事实。认领保留整对，不能只撤校正。
  for(const charge of charges.filter(f=>f.balanceAdjustmentId)){
    const expense=byId.get(charge.transactionId),adjustment=byId.get(charge.balanceAdjustmentId)
    if(!expense&&!adjustment)continue
    if(!expense||!adjustment||expense.type!=='expense'||adjustment.type!=='balance_adjustment'||expense.sourceAccountId!==adjustment.destinationAccountId||expense.amountMinor!==adjustment.amountMinor){block('PAIR_REVIEW','历史费用与余额保全关系不完整，请先在费用详情核对。',loanEntry);continue}
    if(expense.disposition==='retain') {adjustment.disposition='retain';adjustment.reason='retained_fee_pair'}
    else if(expense.disposition!==adjustment.disposition)block('PAIR_REVIEW','费用与余额保全的归属不一致，请先核对。',loanEntry)
  }
  // 已核实付款及其明确配套关系足以决定保留；其余缺失创建证据仍须核对。
  for(const t of transactions.filter(t=>t.disposition==='review'))block('OWNERSHIP_REVIEW','旧记录缺少可靠创建归属，请先核对原账目与贷款来源；本次未删除。',{label:'核对原账目',url:'/pages/transaction-editor/index?transactionId='+t.transactionId})
  for(const t of transactions.filter(t=>t.disposition==='revoke')){
    const refunds=dependencies.refunds(t.transactionId)
    relations.push({id:t.transactionId,refunds})
    if(refunds.length)block('EXTERNAL_REFUND','待撤销账目有独立退款，请先在原账目处理退款关系。',{label:'处理原账目及退款',url:'/pages/transaction-editor/index?transactionId='+t.transactionId})
  }
  const changes=new Map()
  for(const t of transactions.filter(t=>t.disposition==='revoke'))for(const [id,delta] of transactionDeltas(t,-1n))changes.set(id,(changes.get(id)||0n)+delta)
  const accountChanges=[]
  for(const [accountId,delta] of [...changes].sort(([a],[b])=>a.localeCompare(b))){
    const [[account]]=await c.execute('SELECT type,version FROM catledger_accounts WHERE uid=? AND account_id=?',[uid,accountId])
    const balance=await queryBookBalance(c,uid,accountId)
    if(account.type==='cash'&&balance+delta<0n&&delta<0n)block('CASH_BALANCE','撤销后现金余额不足，请先在账户中核对。',{label:'核对账户',url:'/pages/accounts/index'})
    accountChanges.push({accountId,deltaMinor:String(delta),balanceMinor:String(balance),version:Number(account.version)})
  }
  const counts={drawdowns:0,repayments:0,fees:0,balanceAdjustments:0,retained:transactions.filter(t=>t.disposition==='retain').length}
  for(const p of payments)if(p.links.some(l=>byId.get(l.transactionId)?.disposition==='revoke'))counts[p.kind==='drawdown'?'drawdowns':'repayments']++
  counts.fees=transactions.filter(t=>t.disposition==='revoke'&&t.type==='expense').length
  counts.balanceAdjustments=transactions.filter(t=>t.disposition==='revoke'&&t.type==='balance_adjustment').length
  const scope={loanId:loan.loanId,version:Number(loan.version),contract,charges,items,payments,transactions,relations,accountChanges,blockers}
  const previewToken=encodeCursor(secret,{action:'loans.delete',uid,digest:digestRequest('loan-delete-v1',scope)})
  const impact={loanId:loan.loanId,version:Number(loan.version),canDelete:!blockers.length,counts,blockers,accountChanges,previewToken,
    revoke:transactions.filter(t=>t.disposition==='revoke').map(t=>({transactionId:t.transactionId,version:t.version})),
    retain:transactions.filter(t=>t.disposition==='retain').map(t=>({transactionId:t.transactionId,version:t.version,reason:t.reason}))}
  return {loan,...scope,impact}
}
module.exports={prepare}
