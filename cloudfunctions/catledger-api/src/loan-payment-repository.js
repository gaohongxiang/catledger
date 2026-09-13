const { ledgerError } = require('./ledger-errors')
const { validateId, parseVersion } = require('./transaction-domain')
const { MAX_ALLOCATIONS } = require('./loan-payment-domain')
async function populatePrincipal(connection, uid, loans) {
  if (!loans.length) return loans
  const ids = loans.map(l => l.loanId)
  const [rows] = await connection.execute(`SELECT a.loan_id AS loanId,
    SUM(IF(p.kind='drawdown', CAST(a.principal_minor AS DECIMAL(65,0)), -CAST(a.principal_minor AS DECIMAL(65,0)))) AS delta
    FROM catledger_loan_payment_allocations a JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
    WHERE a.uid=? AND a.loan_id IN (${ids.map(() => '?').join(',')}) AND p.status='active' GROUP BY a.loan_id`, [uid,...ids])
  const deltas = new Map(rows.map(row => [row.loanId, BigInt(row.delta)]))
  return loans.map(loan => ({ ...loan, remainingPrincipalMinor: loan.baselinePrincipalMinor == null ? null :
    (BigInt(loan.baselinePrincipalMinor) + (deltas.get(loan.loanId) || 0n)).toString() }))
}
async function assertPrincipalTimeline(connection, uid, loans) {
  // 数据库计算每个历史时点的余额，应用层只收一行；回溯登记和撤销也不能制造负本金。
  for (const loan of loans.values()) {
    if (loan.baselinePrincipalMinor == null || loan.baselineDate == null) throw ledgerError('LOAN_PRINCIPAL_UNCONFIRMED')
    const [[row]] = await connection.execute(`SELECT MIN(balance) AS minimum, MAX(balance) AS maximum, MIN(localAt) AS firstAt FROM (
      SELECT p.occurred_local_at AS localAt, CAST(? AS DECIMAL(65,0)) + SUM(IF(p.kind='drawdown',
        CAST(a.principal_minor AS DECIMAL(65,0)), -CAST(a.principal_minor AS DECIMAL(65,0))))
        OVER (ORDER BY p.occurred_local_at, (p.kind='repayment'), p.payment_id ROWS UNBOUNDED PRECEDING) AS balance
      FROM catledger_loan_payment_allocations a JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
      WHERE a.uid=? AND a.loan_id=? AND p.status='active') timeline`, [String(loan.baselinePrincipalMinor), uid, loan.loanId])
    if (row.minimum != null && (BigInt(row.minimum) < 0n || BigInt(row.maximum) > 9223372036854775807n)) throw ledgerError('LOAN_PRINCIPAL_EXCEEDED')
    if (row.firstAt && String(row.firstAt).slice(0,10) < loan.baselineDate) throw ledgerError('VALIDATION_ERROR')
  }
}
async function lockLoanVersions(connection, uid, allocations, selectLoan) {
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > MAX_ALLOCATIONS) throw ledgerError('VALIDATION_ERROR')
  const ids = allocations.map(a => validateId(a.loanId))
  if (new Set(ids).size !== ids.length) throw ledgerError('VALIDATION_ERROR')
  const loans = new Map()
  for (const a of [...allocations].sort((a,b) => a.loanId.localeCompare(b.loanId))) {
    const loan = await selectLoan(connection, uid, a.loanId, true)
    if (Number(loan.version) !== parseVersion(a.version)) throw ledgerError('CONFLICT')
    loans.set(a.loanId, loan)
  }
  return loans
}
async function advanceLoans(connection, uid, loans) {
  for (const loan of loans.values()) await connection.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?', [uid,loan.loanId])
  return [...loans.values()].map(l => ({ loanId: l.loanId, version: Number(l.version) + 1 }))
}
const PAYMENT_SELECT = `SELECT payment_id AS paymentId,kind,origin_mode AS mode,status,asset_account_id AS assetAccountId,
  total_minor AS totalMinor,occurred_local_at AS occurredLocalAt,timezone_offset_minutes AS timezoneOffsetMinutes,version
  FROM catledger_loan_payments`
function publicPayment(row) { return { ...row, totalMinor: String(row.totalMinor), version: Number(row.version), timezoneOffsetMinutes: Number(row.timezoneOffsetMinutes) } }
async function selectPayment(connection, uid, paymentId, forUpdate = false) {
  const [[row]] = await connection.execute(PAYMENT_SELECT + ' WHERE uid=? AND payment_id=?' + (forUpdate ? ' FOR UPDATE' : ''), [uid,validateId(paymentId)])
  if (!row) throw ledgerError('NOT_FOUND')
  return publicPayment(row)
}
async function selectAllocations(connection, uid, paymentId) {
  const [rows] = await connection.execute(`SELECT a.loan_id AS loanId,l.name AS loanName,l.version,
    a.principal_minor AS principalMinor,a.interest_minor AS interestMinor,a.fee_minor AS feeMinor,
    a.interest_treatment AS interestTreatment,a.fee_treatment AS feeTreatment,
    a.interest_category_id AS interestCategoryId,a.fee_category_id AS feeCategoryId,a.confirmed_loan_version AS confirmedLoanVersion
    FROM catledger_loan_payment_allocations a JOIN catledger_loans l ON l.uid=a.uid AND l.loan_id=a.loan_id
    WHERE a.uid=? AND a.payment_id=? ORDER BY a.loan_id LIMIT 21`, [uid,paymentId])
  if (rows.length > MAX_ALLOCATIONS) throw ledgerError('CONFLICT')
  return rows.map(r => ({ ...r, version: Number(r.version), confirmedLoanVersion: Number(r.confirmedLoanVersion),
    principalMinor: String(r.principalMinor), interestMinor: String(r.interestMinor), feeMinor: String(r.feeMinor) }))
}
module.exports = { populatePrincipal, assertPrincipalTimeline, lockLoanVersions, advanceLoans, PAYMENT_SELECT, publicPayment, selectPayment, selectAllocations }
