// 两个独立部署包保持一致。来源只升级同一收费的依据，不创造付款。
const { parse } = require('./loan-charge-domain')
const store = require('./loan-charge-store')
const fail = code => { throw Object.assign(new Error(code), { publicCode:code }) }
async function prepare(c,uid,event,evidence,loanId) {
  if(evidence.component==='principal')return null
  const [[contract]]=await c.execute(store.CONTRACT_SQL+` WHERE uid=? AND account_id=? AND
    (loan_id=? OR (? IS NOT NULL AND reference_key=?)) LIMIT 1`,[uid,event.ledgerAccountId,loanId||null,evidence.referenceKey,evidence.referenceKey])
  if(!contract)return null
  const [[loan]]=await c.execute('SELECT archived_at AS archivedAt,schedule_terms AS terms FROM catledger_loans WHERE uid=? AND loan_id=?',[uid,contract.loanId])
  if(!loan || evidence.totalTerms&&Number(loan.terms)!==evidence.totalTerms || evidence.periodNumber>Number(loan.terms))fail('LOAN_SOURCE_MISMATCH')
  const mapping=event.fieldSources && event.fieldSources.loanCharge
  const [rows]=await c.execute(store.CHARGE_SQL+' WHERE f.uid=? AND f.contract_id=? AND '+(mapping?'f.charge_id=?':'f.charge_key=?'),
    [uid,contract.contractId,mapping?mapping.chargeId:'period:'+evidence.periodNumber+':'+evidence.component])
  if(!rows[0])fail('LOAN_COVERAGE_REQUIRED')
  const item=store.publicCharge(rows[0])
  if(item.component!==evidence.component || item.periodNumber!==null && item.periodNumber!==evidence.periodNumber)fail('LOAN_SOURCE_MISMATCH')
  if(['suppressed','cancelled','paused'].includes(item.state))fail('LOAN_CHARGE_PAUSED')
  if(item.amountMinor!==String(event.amountMinor))fail('LOAN_CHARGE_DIFFERENCE')
  let financial=item
  if(item.state==='covered')financial=await store.charge(c,uid,item.coveredByChargeId)
  if(item.state==='covered'&&financial.state!=='recorded')fail('LOAN_CHARGE_PAUSED')
  if(financial.state==='recorded'&&(financial.deletedAt!=null||financial.transactionAmount!=financial.amountMinor))fail('LOAN_SOURCE_MISMATCH')
  const [sources]=await c.execute(`SELECT i.source_identity_id AS identityId,i.source_event_id AS eventId,e.status,u.status AS updateStatus
    FROM catledger_loan_charge_sources s JOIN catledger_installment_items i ON i.uid=s.uid AND i.item_id=s.item_id
    LEFT JOIN catledger_economic_events e ON e.uid=i.uid AND e.event_id=i.source_event_id
    LEFT JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id
    WHERE s.uid=? AND s.charge_id=? AND i.active=1`,[uid,item.chargeId])
  // 新的独立银行收费必须人工认领为追加项，不能因为一期同额吞掉。
  if(sources.some(s=>s.eventId!==event.eventId&&s.updateStatus==='posted'&&['posted','corrected'].includes(s.status)&&!mapping))fail('LOAN_SOURCE_MISMATCH')
  return {chargeId:item.chargeId,contractId:contract.contractId,state:item.state,loanId:loan.archivedAt==null?contract.loanId:null,
    transactionId:financial.transactionId,transactionVersion:financial.transactionVersion,
    distinct:!item.chargeKey.startsWith('period:')}
}
async function persist(c,uid,match,itemId,transactionId) {
  if(!match)return
  const [[existing]]=await c.execute('SELECT charge_id AS chargeId FROM catledger_loan_charge_sources WHERE uid=? AND item_id=?',[uid,itemId])
  if(existing&&existing.chargeId!==match.chargeId)fail('LOAN_SOURCE_MISMATCH')
  if(!existing)await c.execute('INSERT INTO catledger_loan_charge_sources(uid,charge_id,item_id) VALUES(?,?,?)',[uid,match.chargeId,itemId])
  if(!['covered','baseline'].includes(match.state))await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis='actual',transaction_id=?,version=version+1 WHERE uid=? AND charge_id=?",[transactionId,uid,match.chargeId])
  await store.audit(c,uid,match.contractId,match.chargeId,'bank_reconcile',{itemId,transactionId})
}
async function refreshEvidence(c,uid,updateId) {
  const [rows]=await c.execute(`SELECT DISTINCT f.charge_id AS chargeId,f.contract_id AS contractId FROM catledger_loan_charges f
    JOIN catledger_loan_charge_sources s ON s.uid=f.uid AND s.charge_id=f.charge_id
    JOIN catledger_installment_items i ON i.uid=s.uid AND i.item_id=s.item_id
    JOIN catledger_economic_events e ON e.uid=i.uid AND e.event_id=i.source_event_id
    JOIN catledger_transactions t ON t.uid=f.uid AND t.transaction_id=f.transaction_id
    WHERE f.uid=? AND e.update_id=? AND t.origin='loan_plan' AND NOT EXISTS(
      SELECT 1 FROM catledger_loan_charge_sources s2 JOIN catledger_installment_items i2 ON i2.uid=s2.uid AND i2.item_id=s2.item_id
      JOIN catledger_economic_events e2 ON e2.uid=i2.uid AND e2.event_id=i2.source_event_id
      JOIN catledger_finance_updates u2 ON u2.uid=e2.uid AND u2.update_id=e2.update_id AND u2.status='posted'
      WHERE s2.uid=f.uid AND s2.charge_id=f.charge_id AND i2.active=1 AND e2.status IN ('posted','corrected'))`,[uid,updateId])
  for(const row of rows) {
    await c.execute("UPDATE catledger_loan_charges SET basis='plan',version=version+1 WHERE uid=? AND charge_id=?",[uid,row.chargeId])
    await store.audit(c,uid,row.contractId,row.chargeId,'source_removed',{updateId})
  }
}
module.exports={prepare,persist,refreshEvidence}
