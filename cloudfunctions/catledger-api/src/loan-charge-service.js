const { randomUUID } = require('node:crypto')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { validateId,parseVersion } = require('./transaction-domain')
const { fullPlan } = require('./installment-view')
const domain = require('./loan-charge-domain')
const store = require('./loan-charge-store')
const { ITEM_SELECT,publicItem } = require('./installment-items')
const { digestRequest } = require('./request-digest')

async function validateChargeAccount(c,uid,accountId) {
  const [[account]]=await c.execute('SELECT type,archived_at AS archivedAt FROM catledger_accounts WHERE uid=? AND account_id=?',[uid,accountId])
  if (!account || !['credit','other_liability'].includes(account.type)) throw ledgerError('VALIDATION_ERROR')
  if (account.archivedAt!=null) throw ledgerError('ACCOUNT_INACTIVE')
}
async function category(c,uid,id) {
  const [[row]]=await c.execute("SELECT category_id FROM catledger_categories WHERE uid=? AND category_id=? AND kind='expense' AND archived_at IS NULL",[uid,validateId(id)])
  if (!row) throw ledgerError('VALIDATION_ERROR')
}
async function chargeSchedule(c,uid,loan,auth,overrides) {
  const [saved]=await c.execute('SELECT period_number AS periodNumber,interest_minor AS interestMinor,fee_minor AS feeMinor,cancelled FROM catledger_loan_periods WHERE uid=? AND loan_id=? ORDER BY period_number',[uid,loan.loanId])
  const periods=fullPlan(loan).map(p=>{const row=saved.find(r=>Number(r.periodNumber)===p.periodNumber);return !row?p:{...p,interestMinor:row.cancelled?'0':String(row.interestMinor),feeMinor:row.cancelled?'0':String(row.feeMinor)}})
  const items=domain.plannedCharges(periods,auth,overrides)
  if(BigInt(loan.feeUpfrontMinor||'0')>0n)items.push({chargeKey:'upfront:fee',periodNumber:null,component:'fee',
    amountMinor:domain.amount(String(loan.feeUpfrontMinor)),chargeDate:domain.date(auth.upfrontChargeDate),categoryId:auth.feeCategoryId})
  return items
}
async function insertCharge(c,uid,contractId,item,planVersion) {
  const chargeId=randomUUID()
  await c.execute(`INSERT INTO catledger_loan_charges
    (uid,charge_id,contract_id,charge_key,component,period_number,charge_date,amount_minor,category_id,plan_version)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,[uid,chargeId,contractId,item.chargeKey,item.component,item.periodNumber||null,item.chargeDate,item.amountMinor,item.categoryId,planVersion])
  return chargeId
}
async function adoptTransaction(c,uid,contractId,item,transactionId,itemId) {
  validateId(transactionId)
  const [[t]]=await c.execute('SELECT type,source_account_id AS accountId,amount_minor AS amountMinor,deleted_at AS deletedAt FROM catledger_transactions WHERE uid=? AND transaction_id=?',[uid,transactionId])
  const [[scope]]=await c.execute('SELECT account_id AS accountId FROM catledger_loan_charge_contracts WHERE uid=? AND contract_id=?',[uid,contractId])
  if (!t || t.deletedAt!=null || t.type!=='expense' || t.accountId!==scope.accountId || String(t.amountMinor)!==item.amountMinor) throw ledgerError('LOAN_SOURCE_MISMATCH')
  if (item.state==='recorded' && item.transactionId!==transactionId || !['planned','recorded'].includes(item.state)) throw ledgerError('LOAN_SOURCE_MISMATCH')
  const [[other]]=await c.execute('SELECT charge_id FROM catledger_loan_charges WHERE uid=? AND transaction_id=? AND charge_id<>?',[uid,transactionId,item.chargeId])
  if(other)throw ledgerError('LOAN_SOURCE_MISMATCH')
  await c.execute("UPDATE catledger_loan_charges SET transaction_id=?,state='recorded',basis='actual',version=version+1 WHERE uid=? AND charge_id=?",[transactionId,uid,item.chargeId])
  if (itemId) {
    const [[linked]]=await c.execute('SELECT charge_id AS chargeId FROM catledger_loan_charge_sources WHERE uid=? AND item_id=?',[uid,itemId])
    if (linked && linked.chargeId!==item.chargeId) throw ledgerError('LOAN_SOURCE_MISMATCH')
    if (!linked) await c.execute('INSERT INTO catledger_loan_charge_sources(uid,charge_id,item_id) VALUES(?,?,?)',[uid,item.chargeId,itemId])
  }
}
function createLoanChargeService({getPool,selectLoan,now=Date.now}) {
  const read=(context,operation)=>executeLedgerRead({getPool,...context,consistentSnapshot:true,operation})
  const write=(context,action,operation)=>executeIdempotentMutation({getPool,...context,action,operation})
  async function chargePlan(context) {
    return read(context,async(c,uid,revision)=>{
      const loan=await selectLoan(c,uid,context.data.loanId),contract=await store.contract(c,uid,loan.loanId)
      const [prior]=await c.execute(store.CONTRACT_SQL+' WHERE uid=? AND account_id=? ORDER BY created_at DESC LIMIT 21',[uid,loan.accountId])
      const items=contract?await store.charges(c,uid,contract.contractId):[]
      const [sources]=await c.execute(ITEM_SELECT+" WHERE i.uid=? AND i.account_id=? AND (i.loan_id=? OR i.loan_id IS NULL) AND i.active=1 AND i.component<>'principal' ORDER BY i.period_number,i.item_id LIMIT 41",[uid,loan.accountId,loan.loanId])
      const preview=context.data.configuration?await chargeSchedule(c,uid,loan,domain.authorization(context.data.configuration),context.data.configuration.periodCharges):[]
      if(context.data.configuration){
        const input=context.data.configuration,auth=domain.authorization(input),ref=contract&&contract.referenceKey||domain.reference(input.referenceLabel)
        if(input.coverage!==undefined&&(!Array.isArray(input.coverage)||input.coverage.length>1200)||input.oneOffCharges!==undefined&&(!Array.isArray(input.oneOffCharges)||input.oneOffCharges.length>12))throw ledgerError('VALIDATION_ERROR')
        const [known]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.account_id=? AND i.active=1 AND i.canonical=1 AND i.component<>'principal'
          AND (i.loan_id=? OR (? IS NOT NULL AND i.reference_key=? AND i.loan_id IS NULL)) LIMIT 1201`,[uid,loan.accountId,loan.loanId,ref,ref])
        if(known.length>1200)throw ledgerError('LOAN_SOURCE_TOO_LARGE')
        const sources=known.map(publicItem).filter(i=>i.active),covered=new Set((input.coverage||[]).map(c=>c.chargeKey))
        for(const one of input.oneOffCharges||[]){if(!Array.isArray(one.covers))throw ledgerError('VALIDATION_ERROR');for(const key of one.covers)covered.add(key)}
        for(const item of preview){
          const prior=items.find(i=>i.chargeKey===item.chargeKey)
          item.previewState=prior&&!['planned','paused'].includes(prior.state)?'existing':covered.has(item.chargeKey)||auth.baselineCoveredThrough&&item.chargeDate<=auth.baselineCoveredThrough||sources.some(s=>s.periodNumber===item.periodNumber&&s.component===item.component&&s.amountMinor===item.amountMinor)?'covered':
            item.chargeDate<auth.fromDate||item.chargeDate>auth.throughDate?'outside':item.chargeDate>domain.today(now())?'future':'due'
        }
      }
      const {encodeCursor,decodeCursor}=require('./cursor'),data=context.data,size=data.pageSize||40
      const configurationDigest=data.configuration?digestRequest('charge-preview',data.configuration):null
      if(!Number.isInteger(size)||size<1||size>40||data.periodNumber!=null&&(!Number.isInteger(data.periodNumber)||data.periodNumber<0||data.periodNumber>600))throw ledgerError('VALIDATION_ERROR')
      const cursor=data.cursor?decodeCursor(context.subjectHash,data.cursor):null
      if(cursor&&(cursor.action!=='loans.chargePlan'||cursor.uid!==uid||cursor.loanId!==loan.loanId||cursor.revision!==revision||cursor.periodNumber!==(data.periodNumber??null)||cursor.configurationDigest!==configurationDigest))throw ledgerError('CONFLICT')
      const offset=cursor?cursor.offset:0,selected=data.periodNumber!=null?items.filter(i=>i.periodNumber===(data.periodNumber||null)):items
      const [issues]=contract?await c.execute(`SELECT e.event_id AS eventId,e.update_id AS updateId,e.amount_minor AS amountMinor,
        e.event_local_date AS localDate,JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.periodNumber')) AS periodNumber,
        JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.component')) AS component
        FROM catledger_economic_events e JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id
        WHERE e.uid=? AND e.ledger_account_id=? AND u.status NOT IN ('posted','undone','abandoned') AND e.status<>'excluded'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.referenceKey'))=?
          ${data.periodNumber!=null?"AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.field_sources_json,'$.installment.periodNumber')),'0')=?":''}
          ORDER BY e.event_local_date,e.event_id LIMIT 41`,[uid,contract.accountId,contract.referenceKey,...(data.periodNumber!=null?[String(data.periodNumber)]:[])]):[[]]
      return {loanId:loan.loanId,loanVersion:Number(loan.version),contract,items:selected.slice(offset,offset+size),preview:preview.slice(offset,offset+size),
        totalCharges:selected.length,oneOffCount:items.filter(i=>i.periodNumber===null).length,previewCount:preview.length,previewAmountMinor:preview.reduce((n,p)=>n+BigInt(p.amountMinor),0n).toString(),
        duePreviewCount:preview.filter(p=>p.previewState==='due').length,duePreviewMinor:preview.filter(p=>p.previewState==='due').reduce((n,p)=>n+BigInt(p.amountMinor),0n).toString(),
        nextCursor:offset+size<Math.max(selected.length,preview.length)?encodeCursor(context.subjectHash,{action:'loans.chargePlan',uid,loanId:loan.loanId,revision,offset:offset+size,periodNumber:data.periodNumber??null,configurationDigest}):null,
        issues:issues.slice(0,40).map(i=>({...i,amountMinor:String(i.amountMinor),periodNumber:Number(i.periodNumber)})),moreIssues:issues.length>40,
        candidates:sources.slice(0,40).map(publicItem).filter(i=>i.active),moreCandidates:sources.length>40,
        priorContracts:prior.map(r=>({...r,authorization:domain.parse(r.authorization)})),cutoff:domain.today(now()),
        recordedMinor:items.filter(i=>i.state==='recorded').reduce((s,i)=>s+BigInt(i.netAmountMinor),0n).toString(),
        unverifiedMinor:items.filter(i=>i.state==='recorded'&&i.basis==='plan').reduce((s,i)=>s+BigInt(i.netAmountMinor),0n).toString()}
    })
  }
  async function configureCharges(context) {
    return write(context,'loans.configureCharges',async(c,uid,data)=>{
      const loan=await selectLoan(c,uid,data.loanId,true)
      if (Number(loan.version)!==parseVersion(data.version)) throw ledgerError('CONFLICT')
      if (loan.archivedAt!=null || data.confirmed!==true) throw ledgerError('VALIDATION_ERROR')
      await validateChargeAccount(c,uid,loan.accountId)
      const auth=domain.authorization(data),plan=await chargeSchedule(c,uid,loan,auth,data.periodCharges)
      const oneOff=data.oneOffCharges||[]
      if(!Array.isArray(oneOff)||oneOff.length>12)throw ledgerError('VALIDATION_ERROR')
      for(const item of oneOff) {
        if(!/^[a-zA-Z0-9_-]{1,60}$/.test(item.key)||!['interest','fee'].includes(item.component)||
          !Array.isArray(item.covers)||!item.covers.length||new Set(item.covers).size!==item.covers.length)throw ledgerError('VALIDATION_ERROR')
        const covered=plan.filter(p=>item.covers.includes(p.chargeKey))
        if(covered.length!==item.covers.length||covered.some(p=>p.component!==item.component)||
          covered.reduce((n,p)=>n+BigInt(p.amountMinor),0n)!==BigInt(domain.amount(item.amountMinor)))throw ledgerError('VALIDATION_ERROR')
        plan.push({chargeKey:'once:'+item.key,component:item.component,periodNumber:null,chargeDate:domain.date(item.chargeDate),
          amountMinor:item.amountMinor,categoryId:auth[item.component+'CategoryId']})
      }
      if(new Set(plan.map(p=>p.chargeKey)).size!==plan.length)throw ledgerError('VALIDATION_ERROR')
      auth.confirmedAt=new Date(now()).toISOString()
      for(const id of new Set(plan.map(i=>i.categoryId))) await category(c,uid,id)
      if (!['cash_borrowing','recorded_consumption','new_consumption','historical'].includes(data.originKind)) throw ledgerError('VALIDATION_ERROR')
      let contract=await store.contract(c,uid,loan.loanId)
      const referenceKey=domain.reference(data.referenceLabel)
      if (!contract && data.contractId) {
        const [[previous]]=await c.execute(store.CONTRACT_SQL+' WHERE uid=? AND contract_id=?',[uid,validateId(data.contractId)])
        if (!previous || previous.accountId!==loan.accountId) throw ledgerError('NOT_FOUND')
        const oldLoan=await selectLoan(c,uid,previous.loanId,true)
        if (oldLoan.archivedAt==null) throw ledgerError('CONFLICT')
        contract={...previous,version:Number(previous.version),planVersion:Number(previous.planVersion),authorization:domain.parse(previous.authorization)}
        if(referenceKey&&referenceKey!==contract.referenceKey)throw ledgerError('LOAN_SOURCE_MISMATCH')
        await store.audit(c,uid,contract.contractId,null,'claim_contract',{previousLoanId:contract.loanId,loanId:loan.loanId})
        await c.execute('UPDATE catledger_loan_charge_contracts SET loan_id=? WHERE uid=? AND contract_id=?',[loan.loanId,uid,contract.contractId])
      }
      if (!contract) {
        const [[previous]]=await c.execute(`SELECT f.contract_id FROM catledger_loan_charge_contracts f JOIN catledger_loans l ON l.uid=f.uid AND l.loan_id=f.loan_id
          WHERE f.uid=? AND f.account_id=? AND (f.reference_key=? OR (? IS NULL AND l.archived_at IS NOT NULL)) LIMIT 1`,[uid,loan.accountId,referenceKey,referenceKey])
        if(previous)throw ledgerError('LOAN_COVERAGE_REQUIRED')
        contract={contractId:randomUUID(),loanId:loan.loanId,accountId:loan.accountId,referenceKey,version:0,planVersion:0,authorization:null}
        await c.execute(`INSERT INTO catledger_loan_charge_contracts(uid,contract_id,loan_id,account_id,reference_key,origin_kind,authorization_json)
          VALUES(?,?,?,?,?,?,?)`,[uid,contract.contractId,loan.loanId,loan.accountId,referenceKey,data.originKind,JSON.stringify(auth)])
      } else if (contract.accountId!==loan.accountId || !contract.authorization.coverageOnly&&contract.originKind!==data.originKind || referenceKey && contract.referenceKey!==referenceKey) throw ledgerError('LOAN_SOURCE_MISMATCH')
      if(contract.authorization&&contract.authorization.coverageOnly)await c.execute('UPDATE catledger_loan_charge_contracts SET origin_kind=? WHERE uid=? AND contract_id=?',[data.originKind,uid,contract.contractId])
      const old=await store.charges(c,uid,contract.contractId),planVersion=contract.planVersion+1
      for (const item of plan) {
        const previous=old.find(p=>p.chargeKey===item.chargeKey)
        if (!previous) await insertCharge(c,uid,contract.contractId,item,planVersion)
        else if (['planned','paused'].includes(previous.state)) await c.execute(`UPDATE catledger_loan_charges SET charge_date=?,amount_minor=?,category_id=?,plan_version=?,state='planned',version=version+1
          WHERE uid=? AND charge_id=?`,[item.chargeDate,item.amountMinor,item.categoryId,planVersion,uid,previous.chargeId])
        // 已记录/已覆盖/抑制的历史不能由新版本覆盖或复活。
      }
      for(const previous of old.filter(p=>p.chargeKey.startsWith('period:')&&!plan.some(i=>i.chargeKey===p.chargeKey)&&p.state==='planned')) {
        await c.execute("UPDATE catledger_loan_charges SET state='cancelled',version=version+1 WHERE uid=? AND charge_id=?",[uid,previous.chargeId])
      }
      let items=await store.charges(c,uid,contract.contractId)
      const [raw]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.account_id=? AND i.active=1 AND i.component<>'principal'
        AND (i.loan_id=? OR (? IS NOT NULL AND i.reference_key=? AND i.loan_id IS NULL))`,[uid,loan.accountId,loan.loanId,contract.referenceKey,contract.referenceKey])
      for (const source of raw.map(publicItem).filter(i=>i.active && i.canonical)) {
        const item=items.find(i=>i.chargeKey==='period:'+source.periodNumber+':'+source.component)
        if (!item || item.state!=='planned') continue
        await adoptTransaction(c,uid,contract.contractId,item,source.transactionId,source.itemId)
      }
      items=await store.charges(c,uid,contract.contractId)
      for(const one of oneOff) {
        const item=items.find(i=>i.chargeKey==='once:'+one.key)
        await adoptTransaction(c,uid,contract.contractId,item,one.transactionId,null)
        for(const key of one.covers) {
          const covered=items.find(i=>i.chargeKey===key)
          if(!['planned','covered'].includes(covered.state)||covered.coveredByChargeId&&covered.coveredByChargeId!==item.chargeId)throw ledgerError('LOAN_SOURCE_MISMATCH')
          await c.execute("UPDATE catledger_loan_charges SET state='covered',covered_by_charge_id=?,version=version+1 WHERE uid=? AND charge_id=?",[item.chargeId,uid,covered.chargeId])
        }
      }
      if(data.coverage!==undefined&&(!Array.isArray(data.coverage)||data.coverage.length>1200))throw ledgerError('VALIDATION_ERROR')
      for(const cover of data.coverage||[]) {
        const item=items.find(i=>i.chargeKey===cover.chargeKey)
        if(!item)throw ledgerError('VALIDATION_ERROR')
        await adoptTransaction(c,uid,contract.contractId,item,cover.transactionId,null)
      }
      if(auth.baselineCoveredThrough) await c.execute(`UPDATE catledger_loan_charges SET state='baseline',basis='baseline',version=version+1
        WHERE uid=? AND contract_id=? AND state='planned' AND charge_date<=?`,[uid,contract.contractId,auth.baselineCoveredThrough])
      await c.execute(`UPDATE catledger_loan_charge_contracts SET authorization_json=?,plan_version=?,version=? WHERE uid=? AND contract_id=?`,
        [JSON.stringify(auth),planVersion,contract.version+1,uid,contract.contractId])
      await store.audit(c,uid,contract.contractId,null,'authorize',{previous:contract.authorization,authorization:auth,planVersion,coverage:data.coverage||[]})
      await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1,contractId:contract.contractId,contractVersion:contract.version+1,planVersion}
    })
  }
  async function pauseCharges(context) {
    return write(context,'loans.pauseCharges',async(c,uid,data)=>{
      const loan=await selectLoan(c,uid,data.loanId,true),contract=await store.contract(c,uid,loan.loanId)
      if(Number(loan.version)!==parseVersion(data.version)||!contract)throw ledgerError('CONFLICT')
      const auth={...contract.authorization,mode:'paused'}
      await c.execute('UPDATE catledger_loan_charge_contracts SET authorization_json=?,version=version+1 WHERE uid=? AND contract_id=?',[JSON.stringify(auth),uid,contract.contractId])
      await store.audit(c,uid,contract.contractId,null,'pause',{previous:contract.authorization})
      await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1}
    })
  }
  return {chargePlan,configureCharges,pauseCharges}
}
module.exports = {createLoanChargeService,validateChargeAccount,adoptTransaction,insertCharge}
