const { ledgerError } = require('./ledger-errors')
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
// 删除快照明确保留的完整付款组才可复用；同额、同日或账户相同都不是依据。
async function retainedGroup(c,uid,ids) {
  const [payments]=await c.execute(`SELECT p.payment_id AS paymentId,l.deletion_snapshot_json AS snapshot FROM catledger_loan_payments p
    JOIN catledger_loan_payment_allocations a ON a.uid=p.uid AND a.payment_id=p.payment_id
    JOIN catledger_loans l ON l.uid=a.uid AND l.loan_id=a.loan_id
    WHERE p.uid=? AND p.status='reversed' AND l.deleted_at IS NOT NULL
      AND JSON_CONTAINS(JSON_EXTRACT(l.deletion_snapshot_json,'$.payments[*].paymentId'),JSON_QUOTE(p.payment_id))
      AND EXISTS(SELECT 1 FROM catledger_loan_payment_transactions r WHERE r.uid=p.uid AND r.payment_id=p.payment_id AND r.transaction_id IN (${ids.map(()=>'?').join(',')}))
    ORDER BY l.deleted_at DESC,p.payment_id LIMIT 121`,[uid,...ids])
  if(payments.length>120)throw ledgerError('LOAN_SOURCE_TOO_LARGE')
  for(const payment of payments){
    const [links]=await c.execute(`SELECT r.transaction_id AS transactionId,t.version,t.deleted_at AS deletedAt
      FROM catledger_loan_payment_transactions r JOIN catledger_transactions t ON t.uid=r.uid AND t.transaction_id=r.transaction_id
      WHERE r.uid=? AND r.payment_id=? ORDER BY r.transaction_id`,[uid,payment.paymentId])
    const retained=parse(payment.snapshot).impact.retain
    if(!links.length||links.some(l=>l.deletedAt!=null||!retained.some(t=>t.transactionId===l.transactionId&&Number(t.version)===Number(l.version))))continue
    if(ids.some(id=>!links.some(l=>l.transactionId===id)))throw ledgerError('LOAN_SOURCE_MISMATCH')
    const [charges]=await c.execute(`SELECT a.charge_id AS chargeId,a.amount_minor AS amountMinor,f.transaction_id AS transactionId
      FROM catledger_loan_charge_allocations a JOIN catledger_loan_charges f ON f.uid=a.uid AND f.charge_id=a.charge_id
      WHERE a.uid=? AND a.payment_id=? ORDER BY a.charge_id`,[uid,payment.paymentId])
    const [allocations]=await c.execute(`SELECT l.account_id AS liabilityAccountId,a.principal_minor AS principalMinor,
      a.interest_minor AS interestMinor,a.fee_minor AS feeMinor,a.interest_treatment AS interestTreatment,a.fee_treatment AS feeTreatment,
      a.interest_category_id AS interestCategoryId,a.fee_category_id AS feeCategoryId
      FROM catledger_loan_payment_allocations a JOIN catledger_loans l ON l.uid=a.uid AND l.loan_id=a.loan_id
      JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
      WHERE a.uid=? AND a.payment_id=? AND p.kind='repayment' LIMIT 2`,[uid,payment.paymentId])
    const repayment=allocations.length===1?{...allocations[0],...Object.fromEntries(['principal','interest','fee'].map(f=>[f+'Minor',String(allocations[0][f+'Minor'])]))}:null
    return {paymentId:payment.paymentId,transactionIds:links.map(l=>l.transactionId),repayment,charges:charges.map(f=>({...f,amountMinor:String(f.amountMinor)}))}
  }
  return null
}
async function assertReusableCharges(c,uid,ids,retained) {
  const [charges]=await c.execute(`SELECT charge_id AS chargeId,transaction_id AS transactionId,balance_adjustment_id AS adjustmentId
    FROM catledger_loan_charges WHERE uid=? AND (transaction_id IN (${ids.map(()=>'?').join(',')}) OR balance_adjustment_id IN (${ids.map(()=>'?').join(',')}))`,[uid,...ids,...ids])
  if(charges.some(f=>ids.includes(f.adjustmentId)||!retained||!retained.charges.some(r=>r.chargeId===f.chargeId&&r.transactionId===f.transactionId)))throw ledgerError('LOAN_TRANSACTION_LOCKED')
}
function retainedCoverage(source) {
  return Object.fromEntries((source?.retained?.charges||[]).map(f=>[f.chargeId,f.amountMinor]))
}
module.exports={retainedGroup,assertReusableCharges,retainedCoverage}
