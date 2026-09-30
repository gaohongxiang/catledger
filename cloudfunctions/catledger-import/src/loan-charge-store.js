// 两函数共用的费用关系规则；调用者必须持有原用户写锁。无自建事务、无运行时 DDL。
const { randomUUID } = require('node:crypto')
const { parse } = require('./loan-charge-domain')
const fail = code => { throw Object.assign(new Error(code), { publicCode:code }) }
const CONTRACT_SQL = `SELECT contract_id AS contractId,loan_id AS loanId,account_id AS accountId,
  reference_key AS referenceKey,origin_kind AS originKind,plan_version AS planVersion,
  authorization_json AS authorization,version FROM catledger_loan_charge_contracts`
const CHARGE_SQL = `SELECT f.charge_id AS chargeId,f.contract_id AS contractId,f.charge_key AS chargeKey,
  f.component,f.period_number AS periodNumber,f.charge_date AS chargeDate,f.amount_minor AS amountMinor,
  f.category_id AS categoryId,f.state,f.basis,f.plan_removed_at AS planRemovedAt,f.transaction_id AS transactionId,f.balance_adjustment_id AS balanceAdjustmentId,
  f.covered_by_charge_id AS coveredByChargeId,f.plan_version AS planVersion,f.version,
  f.historical_settled_minor AS historicalSettledMinor,
  COALESCE((SELECT SUM(child.historical_settled_minor) FROM catledger_loan_charges child
    WHERE child.uid=f.uid AND child.covered_by_charge_id=f.charge_id AND child.state='covered'),0) AS historicalChildrenMinor,
  COALESCE((SELECT SUM(a.historical_replaced_minor) FROM catledger_loan_charge_allocations a
    JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id AND p.status='active'
    WHERE a.uid=f.uid AND a.charge_id=f.charge_id),0) AS historicalReplacedMinor,
  t.version AS transactionVersion,t.deleted_at AS deletedAt,t.amount_minor AS transactionAmount,a.type AS transactionAccountType,
  COALESCE((SELECT SUM(a.amount_minor) FROM catledger_loan_charge_allocations a
    JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id AND p.status='active'
    WHERE a.uid=f.uid AND a.charge_id=f.charge_id),0) AS settledMinor,
  COALESCE((SELECT SUM(r.amount_minor) FROM catledger_transactions r WHERE r.uid=f.uid AND r.original_transaction_id=f.transaction_id AND r.deleted_at IS NULL),0) AS refundMinor
  FROM catledger_loan_charges f LEFT JOIN catledger_transactions t ON t.uid=f.uid AND t.transaction_id=f.transaction_id
  LEFT JOIN catledger_accounts a ON a.uid=t.uid AND a.account_id=t.source_account_id`
function publicCharge(row) {
  const net = BigInt(row.amountMinor)-BigInt(row.refundMinor||'0')
  const directlyPaid = row.state==='recorded'&&row.deletedAt==null&&['cash','bank','wallet','other_asset'].includes(row.transactionAccountType)?net:0n
  const allocated=BigInt(row.settledMinor||'0'),actual=allocated>directlyPaid?allocated:directlyPaid
  const historical = [BigInt(row.historicalSettledMinor||'0'),BigInt(row.historicalChildrenMinor||'0')].reduce((a,b)=>a>b?a:b)
  const remainingHistory = historical-BigInt(row.historicalReplacedMinor||'0')
  const covered = [remainingHistory,net-actual].reduce((a,b)=>a<b?a:b)
  const historicalCoveredMinor = covered>0n?covered:0n
  const outstanding = net-actual-historicalCoveredMinor
  return {...row, amountMinor:String(row.amountMinor),settledMinor:String(actual),directlyPaidMinor:String(directlyPaid),
    historicalSettledMinor:String(row.historicalSettledMinor||'0'),historicalCoveredMinor:String(historicalCoveredMinor),
    refundMinor:String(row.refundMinor||'0'),netAmountMinor:String(BigInt(row.amountMinor)-BigInt(row.refundMinor||'0')),
    version:Number(row.version),planVersion:Number(row.planVersion),periodNumber:row.periodNumber==null?null:Number(row.periodNumber),
    transactionVersion:Number(row.transactionVersion || 0),outstandingMinor:String(outstanding>0n?outstanding:0n)}
}
async function contract(c,uid,loanId) {
  const [[row]]=await c.execute(CONTRACT_SQL+' WHERE uid=? AND loan_id=?',[uid,loanId])
  return row?{...row,authorization:parse(row.authorization),version:Number(row.version),planVersion:Number(row.planVersion)}:null
}
// 所有收费写入口共用认领规则。账户/金额/日期不是身份；只有明确选择或已绑定来源可认领旧合同。
async function ensureContract(c,uid,loan,{contractId=null,referenceKey=null,originKind='historical',authorization}={}) {
  const current=await contract(c,uid,loan.loanId)
  if(current){
    if(current.accountId!==loan.accountId||contractId&&current.contractId!==contractId||referenceKey&&current.referenceKey!==referenceKey)fail('LOAN_SOURCE_MISMATCH')
    return {contract:current,created:false}
  }
  const [bindings]=await c.execute('SELECT reference_key AS referenceKey FROM catledger_installment_bindings WHERE uid=? AND loan_id=? ORDER BY reference_key',[uid,loan.loanId])
  const verified=new Set(bindings.map(r=>r.referenceKey)),keys=[...new Set([...verified,referenceKey].filter(Boolean))]
  const [matching]=keys.length?await c.execute(CONTRACT_SQL+` WHERE uid=? AND account_id=? AND reference_key IN (${keys.map(()=>'?').join(',')})`,[uid,loan.accountId,...keys]):[[]]
  let previous
  if(contractId){
    if(typeof contractId!=='string'||!/^[0-9a-f-]{36}$/i.test(contractId))fail('VALIDATION_ERROR')
    const [[selected]]=await c.execute(CONTRACT_SQL+' WHERE uid=? AND contract_id=?',[uid,contractId])
    previous=selected
    if(!previous||previous.accountId!==loan.accountId)fail('NOT_FOUND')
    if(referenceKey&&previous.referenceKey!==referenceKey||verified.size&&previous.referenceKey&&!verified.has(previous.referenceKey)||matching.some(r=>r.contractId!==contractId))fail('LOAN_SOURCE_MISMATCH')
  }else if(matching.length){
    if(matching.length!==1||!verified.has(matching[0].referenceKey))fail('LOAN_COVERAGE_REQUIRED')
    previous=matching[0]
  }
  if(previous){
    const [[owner]]=await c.execute('SELECT archived_at AS archivedAt FROM catledger_loans WHERE uid=? AND loan_id=?',[uid,previous.loanId])
    if(!owner||owner.archivedAt==null)fail('CONFLICT')
    await c.execute('UPDATE catledger_loan_charge_contracts SET loan_id=?,version=version+1 WHERE uid=? AND contract_id=?',[loan.loanId,uid,previous.contractId])
    await audit(c,uid,previous.contractId,null,'claim_contract',{previousLoanId:previous.loanId,loanId:loan.loanId})
    // 只释放整组撤销的计划项；用户单独取消/抑制没有该标记。
    await c.execute("UPDATE catledger_loan_charges SET state='planned',plan_removed_at=NULL,version=version+1 WHERE uid=? AND contract_id=? AND plan_removed_at IS NOT NULL",[uid,previous.contractId])
    return {contract:await contract(c,uid,loan.loanId),created:false}
  }
  const id=randomUUID(),reference=referenceKey||bindings[0]?.referenceKey||null
  await c.execute(`INSERT INTO catledger_loan_charge_contracts(uid,contract_id,loan_id,account_id,reference_key,origin_kind,authorization_json)
    VALUES(?,?,?,?,?,?,?)`,[uid,id,loan.loanId,loan.accountId,reference,originKind,JSON.stringify(authorization)])
  return {contract:{contractId:id,loanId:loan.loanId,accountId:loan.accountId,referenceKey:reference,originKind,authorization,version:1,planVersion:1},created:true}
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
  const [[row]]=await c.execute(`SELECT charge_id FROM catledger_loan_charges WHERE uid=? AND (transaction_id IN (${ids.map(()=>'?').join(',')}) OR balance_adjustment_id IN (${ids.map(()=>'?').join(',')})) LIMIT 1`,[uid,...ids,...ids])
  if (row) fail('LOAN_TRANSACTION_LOCKED')
}
module.exports = { CONTRACT_SQL,CHARGE_SQL,publicCharge,contract,ensureContract,charges,charge,audit,dependencies,assertUnencumbered,assertNoCharges }
