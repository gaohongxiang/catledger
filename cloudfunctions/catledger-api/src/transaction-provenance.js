// 创建归属只在 INSERT 时确定；关联、认领、调费不修改它。NULL 是待核对，不等于手工独立账。
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const independent = () => ({ kind: 'independent' })
const loanOrigin = ids => Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)
  ? { kind: 'loan', loanIds: [...new Set(ids)].sort() } : { kind: 'unknown' }
function normalize(value) {
  try {
    const v = parse(value)
    return v?.kind === 'independent' ? independent() : v?.kind === 'loan' ? loanOrigin(v.loanIds) : { kind: 'unknown' }
  } catch (_) { return { kind: 'unknown' } }
}
function combine(values) {
  values = values.map(normalize)
  if (!values.length || values.some(v => !v || !['independent','loan'].includes(v.kind))) return { kind:'unknown' }
  if (values.every(v => v.kind === 'independent')) return independent()
  if (values.every(v => v.kind === 'loan')) return loanOrigin(values.flatMap(v => v.loanIds))
  return { kind:'unknown' }
}
async function resolve(c, uid, transactionId, visited = new Set()) {
  if (visited.has(transactionId) || visited.size > 120) return { kind:'unknown' }
  visited.add(transactionId)
  const [[t]] = await c.execute('SELECT creation_provenance_json AS provenance FROM catledger_transactions WHERE uid=? AND transaction_id=?',[uid,transactionId])
  if (!t) return { kind:'unknown' }
  if (t.provenance) return normalize(t.provenance)
  const [created] = await c.execute(`SELECT p.payment_id AS paymentId,p.origin_mode AS mode,
    EXISTS(SELECT 1 FROM catledger_loan_repayment_details d WHERE d.uid=p.uid AND d.payment_id=p.payment_id) AS standalone
    FROM catledger_loan_payment_transactions r JOIN catledger_loan_payments p ON p.uid=r.uid AND p.payment_id=r.payment_id
    WHERE r.uid=? AND r.transaction_id=? AND r.created_by_payment=1`,[uid,transactionId])
  const evidence = []
  for (const p of created) {
    if (Number(p.standalone)) { evidence.push(independent()); continue }
    if (p.mode === 'correctExisting') {
      const [roots] = await c.execute('SELECT transaction_id AS id FROM catledger_loan_replaced_transactions WHERE uid=? AND payment_id=?',[uid,p.paymentId])
      const origins = []
      for (const root of roots) origins.push(await resolve(c,uid,root.id,new Set(visited)))
      evidence.push(combine(origins))
    } else if (p.mode === 'new') {
      const [[correction]] = await c.execute('SELECT previous_payment_id AS id FROM catledger_loan_payment_corrections WHERE uid=? AND payment_id=?',[uid,p.paymentId])
      if (correction) {
        const [prior] = await c.execute('SELECT transaction_id AS id FROM catledger_loan_payment_transactions WHERE uid=? AND payment_id=?',[uid,correction.id])
        const origins=[];for(const row of prior)origins.push(await resolve(c,uid,row.id,new Set(visited)))
        evidence.push(combine(origins))
      } else {
        const [allocations] = await c.execute('SELECT loan_id AS loanId FROM catledger_loan_payment_allocations WHERE uid=? AND payment_id=?',[uid,p.paymentId])
        if (allocations.length) evidence.push(loanOrigin(allocations.map(a=>a.loanId)))
      }
    }
  }
  // 原手工创建回执、独立导入的 created 链接是创建证据；manual/import 标签不是。
  const [[external]] = await c.execute(`SELECT
    EXISTS(SELECT 1 FROM catledger_mutation_receipts WHERE uid=? AND action='transactions.create'
      AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.transactionId'))=?) AS manualCreation,
    EXISTS(SELECT 1 FROM catledger_economic_event_transactions WHERE uid=? AND transaction_id=?
      AND creation_method='created' AND rule_version<>'loan-settlement-v1' AND role<>'refund_original') AS importCreation`,[uid,transactionId,uid,transactionId])
  if (Number(external.manualCreation) || Number(external.importCreation)) evidence.push(independent())
  const [audits] = await c.execute(`SELECT a.action,a.snapshot_json AS snapshot,a.created_at AS createdAt,a.contract_id AS contractId,k.loan_id AS loanId
    FROM catledger_loan_charge_audit a JOIN catledger_loan_charge_contracts k ON k.uid=a.uid AND k.contract_id=a.contract_id
    WHERE a.uid=? AND (JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.transactionId'))=?
      OR JSON_UNQUOTE(JSON_EXTRACT(a.snapshot_json,'$.balanceAdjustmentId'))=?)
    AND a.action IN ('accrue','record_upfront_fee','confirm_historical_paid','record_period_fee')`,[uid,transactionId,transactionId])
  for (const a of audits) {
    const s=parse(a.snapshot)
    if (a.action==='record_upfront_fee' && s.mode==='existing') continue
    // 历史费用可能复用外部账；只有配套余额保全或明确创建动作能证明新增。
    if (['confirm_historical_paid','record_period_fee'].includes(a.action) && !s.balanceAdjustmentId) continue
    const [claims]=await c.execute("SELECT snapshot_json AS snapshot,created_at AS createdAt FROM catledger_loan_charge_audit WHERE uid=? AND contract_id=? AND action='claim_contract' ORDER BY created_at,audit_id",[uid,a.contractId])
    let owner=a.loanId
    if (claims.length) {
      if (claims.some(row=>String(row.createdAt)===String(a.createdAt))) { evidence.push({kind:'unknown'}); continue }
      owner=parse(claims[0].snapshot).previousLoanId
      for(const row of claims)if(String(row.createdAt)<String(a.createdAt))owner=parse(row.snapshot).loanId
    }
    evidence.push(loanOrigin([owner]))
  }
  if (!evidence.length) return { kind:'unknown' }
  const signatures=new Set(evidence.map(v=>JSON.stringify(v)))
  return signatures.size===1?evidence[0]:{kind:'unknown'}
}
module.exports={parse,normalize,independent,loanOrigin,combine,resolve}
