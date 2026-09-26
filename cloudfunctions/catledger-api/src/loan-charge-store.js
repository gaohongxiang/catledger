// 两函数共用的费用关系规则；调用者必须持有原用户写锁。无自建事务、无运行时 DDL。
const { randomUUID } = require('node:crypto')
const { parse } = require('./loan-charge-domain')
const fail = code => { throw Object.assign(new Error(code), { publicCode:code }) }
const CONTRACT_SQL = `SELECT contract_id AS contractId,loan_id AS loanId,account_id AS accountId,
  reference_key AS referenceKey,origin_kind AS originKind,plan_version AS planVersion,
  authorization_json AS authorization,version FROM catledger_loan_charge_contracts`
const CHARGE_SQL = `SELECT f.charge_id AS chargeId,f.contract_id AS contractId,f.charge_key AS chargeKey,
  f.component,f.period_number AS periodNumber,f.charge_date AS chargeDate,f.amount_minor AS amountMinor,
  f.category_id AS categoryId,f.state,f.basis,f.transaction_id AS transactionId,
  f.covered_by_charge_id AS coveredByChargeId,f.plan_version AS planVersion,f.version,
  t.version AS transactionVersion,t.deleted_at AS deletedAt,t.amount_minor AS transactionAmount,
  COALESCE((SELECT SUM(a.amount_minor) FROM catledger_loan_charge_allocations a
    JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id AND p.status='active'
    WHERE a.uid=f.uid AND a.charge_id=f.charge_id),0) AS settledMinor,
  COALESCE((SELECT SUM(r.amount_minor) FROM catledger_transactions r WHERE r.uid=f.uid AND r.original_transaction_id=f.transaction_id AND r.deleted_at IS NULL),0) AS refundMinor
  FROM catledger_loan_charges f LEFT JOIN catledger_transactions t ON t.uid=f.uid AND t.transaction_id=f.transaction_id`
function publicCharge(row) {
  return {...row, amountMinor:String(row.amountMinor),settledMinor:String(row.settledMinor || '0'),
    refundMinor:String(row.refundMinor||'0'),netAmountMinor:String(BigInt(row.amountMinor)-BigInt(row.refundMinor||'0')),
    version:Number(row.version),planVersion:Number(row.planVersion),periodNumber:row.periodNumber==null?null:Number(row.periodNumber),
    transactionVersion:Number(row.transactionVersion || 0),outstandingMinor:String([BigInt(row.amountMinor)-BigInt(row.settledMinor||'0')-BigInt(row.refundMinor||'0'),0n].reduce((a,b)=>a>b?a:b))}
}
async function contract(c,uid,loanId) {
  const [[row]]=await c.execute(CONTRACT_SQL+' WHERE uid=? AND loan_id=?',[uid,loanId])
  return row?{...row,authorization:parse(row.authorization),version:Number(row.version),planVersion:Number(row.planVersion)}:null
}
async function charges(c,uid,contractId) {
  const [rows]=await c.execute(CHARGE_SQL+' WHERE f.uid=? AND f.contract_id=? ORDER BY f.charge_date,f.charge_key LIMIT 1213',[uid,contractId])
  if (rows.length>1212) fail('LOAN_SOURCE_TOO_LARGE')
  return rows.map(publicCharge)
}
async function charge(c,uid,chargeId) {
  const [[row]]=await c.execute(CHARGE_SQL+' WHERE f.uid=? AND f.charge_id=?',[uid,chargeId])
  if (!row) fail('NOT_FOUND')
  return publicCharge(row)
}
async function audit(c,uid,contractId,chargeId,action,snapshot) {
  await c.execute(`INSERT INTO catledger_loan_charge_audit(uid,audit_id,contract_id,charge_id,action,snapshot_json)
    VALUES(?,?,?,?,?,?)`,[uid,randomUUID(),contractId,chargeId||null,action,JSON.stringify(snapshot)])
}
async function dependencies(c,uid,item) {
  const [[row]]=await c.execute(`SELECT
    (SELECT COUNT(*) FROM catledger_transactions WHERE uid=? AND original_transaction_id=? AND deleted_at IS NULL) AS refundCount,
    (SELECT COUNT(*) FROM catledger_economic_event_transactions WHERE uid=? AND transaction_id=? AND superseded_at IS NULL) AS sourceCount,
    (SELECT COUNT(*) FROM catledger_loan_payment_transactions WHERE uid=? AND active_transaction_id=?) AS paymentCount,
    (SELECT COUNT(*) FROM catledger_loan_charges WHERE uid=? AND covered_by_charge_id=?) AS coveredCount`,
    [uid,item.transactionId,uid,item.transactionId,uid,item.transactionId,uid,item.chargeId])
  return {settledMinor:item.settledMinor,...Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)]))}
}
async function assertUnencumbered(c,uid,item,{sources=false}={}) {
  const dep=await dependencies(c,uid,item)
  if (dep.settledMinor!=='0'||dep.refundCount||dep.paymentCount||dep.coveredCount||(!sources&&dep.sourceCount)) fail('LOAN_TRANSACTION_LOCKED')
  return dep
}
async function assertNoCharges(c,uid,ids) {
  if (!ids.length) return
  const [[row]]=await c.execute(`SELECT charge_id FROM catledger_loan_charges WHERE uid=? AND transaction_id IN (${ids.map(()=>'?').join(',')}) LIMIT 1`,[uid,...ids])
  if (row) fail('LOAN_TRANSACTION_LOCKED')
}
module.exports = { CONTRACT_SQL,CHARGE_SQL,publicCharge,contract,charges,charge,audit,dependencies,assertUnencumbered,assertNoCharges }
