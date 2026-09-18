const { createLoanPaymentService } = require('./loan-payment-service')
const { populatePrincipal } = require('./loan-payment-repository')
const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { validateId, parseVersion } = require('./transaction-domain')
const { loanMetadata, publicLoan } = require('./loan-domain')
const { decodeCursor, encodeCursor } = require('./cursor')
const LOAN_SELECT = `SELECT l.loan_id AS loanId, l.account_id AS accountId, l.name, l.institution, l.kind,
  l.baseline_principal_minor AS baselinePrincipalMinor, l.baseline_principal_minor AS remainingPrincipalMinor,
  l.baseline_date AS baselineDate, l.start_date AS startDate, l.end_date AS endDate,
  l.repayment_method AS repaymentMethod, l.version, l.created_at AS createdAt,
  a.name AS accountName, a.archived_at AS accountArchived FROM catledger_loans l
  JOIN catledger_accounts a ON a.uid=l.uid AND a.account_id=l.account_id`
async function selectLoan(connection, uid, loanId, forUpdate = false) {
  const [[row]] = await connection.execute(LOAN_SELECT + ' WHERE l.uid=? AND l.loan_id=?' + (forUpdate ? ' FOR UPDATE' : ''), [uid, validateId(loanId)])
  if (!row) throw ledgerError('NOT_FOUND')
  return row
}
async function validateLiability(connection, uid, accountId) {
  const [[account]] = await connection.execute(`SELECT type,currency,archived_at AS archivedAt FROM catledger_accounts
    WHERE uid=? AND account_id=? FOR UPDATE`, [uid, accountId])
  if (!account) throw ledgerError('NOT_FOUND')
  if (account.archivedAt != null) throw ledgerError('ACCOUNT_INACTIVE')
  if (!['credit','other_liability'].includes(account.type)) throw ledgerError('VALIDATION_ERROR')
  if (account.currency !== 'CNY') throw ledgerError('UNSUPPORTED_CURRENCY')
}
function createLoanService({ getPool }) {
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  const write = (context, action, operation) => executeIdempotentMutation({ getPool, ...context, currentReads: true, action, operation })
  async function list(context) {
    const data = context.data || {}, accountId = data.accountId == null ? null : validateId(data.accountId), pageSize = data.pageSize == null ? 20 : data.pageSize
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 40) throw ledgerError('VALIDATION_ERROR')
    return read(context, async (connection, uid) => {
      let cursor = null
      if (data.cursor) {
        cursor = decodeCursor(context.subjectHash, data.cursor)
        if (cursor.action !== 'loans.list' || cursor.uid !== uid || (cursor.accountId || null) !== accountId || typeof cursor.at !== 'string' || typeof cursor.id !== 'string') throw ledgerError('VALIDATION_ERROR')
      }
      const [rows] = await connection.execute(LOAN_SELECT + ` WHERE l.uid=?${accountId ? ' AND l.account_id=?' : ''}${cursor ? ' AND (l.created_at < ? OR (l.created_at=? AND l.loan_id < ?))' : ''}
        ORDER BY l.created_at DESC, l.loan_id DESC LIMIT ?`, [uid, ...(accountId ? [accountId] : []), ...(cursor ? [cursor.at,cursor.at,cursor.id] : []), pageSize + 1])
      const items = rows.slice(0, pageSize), last = items.at(-1)
      return { items: (await populatePrincipal(connection, uid, items)).map(publicLoan), nextCursor: rows.length > pageSize ? encodeCursor(context.subjectHash,
        { action: 'loans.list', uid, accountId, at: String(last.createdAt), id: last.loanId }) : null }
    })
  }
  async function get(context) { return read(context, async (connection, uid) => ({ loan: publicLoan((await populatePrincipal(connection, uid, [await selectLoan(connection, uid, context.data.loanId)]))[0]) })) }
  async function create(context) {
    return write(context, 'loans.create', async (connection, uid, data) => {
      const value = loanMetadata(data), loanId = randomUUID()
      await validateLiability(connection, uid, value.accountId)
      await connection.execute(`INSERT INTO catledger_loans
        (uid,loan_id,account_id,name,institution,kind,baseline_principal_minor,baseline_date,start_date,end_date,repayment_method)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [uid,loanId,value.accountId,value.name,value.institution,value.kind,value.baselinePrincipalMinor,
        value.baselineDate,value.startDate,value.endDate,value.repaymentMethod])
      return { loanId, version: 1 }
    })
  }
  async function update(context) {
    return write(context, 'loans.update', async (connection, uid, data) => {
      const current = await selectLoan(connection, uid, data.loanId, true)
      if (Number(current.version) !== parseVersion(data.version)) throw ledgerError('CONFLICT')
      const value = loanMetadata(data)
      if (value.accountId !== current.accountId || value.kind !== current.kind || value.baselinePrincipalMinor !== (current.baselinePrincipalMinor == null ? null : String(current.baselinePrincipalMinor)) || value.baselineDate !== current.baselineDate) {
        const [[active]] = await connection.execute(`SELECT a.payment_id FROM catledger_loan_payment_allocations a
          JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
          WHERE a.uid=? AND a.loan_id=? AND p.status='active' LIMIT 1`, [uid,current.loanId])
        if (active) throw ledgerError('LOAN_BASELINE_LOCKED')
      }
      await validateLiability(connection, uid, value.accountId)
      const [result] = await connection.execute(`UPDATE catledger_loans SET account_id=?,name=?,institution=?,kind=?,baseline_principal_minor=?,
        baseline_date=?,start_date=?,end_date=?,repayment_method=?,version=version+1 WHERE uid=? AND loan_id=? AND version=?`,
      [value.accountId,value.name,value.institution,value.kind,value.baselinePrincipalMinor,value.baselineDate,value.startDate,value.endDate,
        value.repaymentMethod,uid,current.loanId,data.version])
      if (result.affectedRows !== 1) throw ledgerError('CONFLICT')
      return { loanId: current.loanId, version: data.version + 1 }
    })
  }
  return { list, get, create, update, ...require('./repayment-query-service').createRepaymentQueryService({ getPool }), ...createLoanPaymentService({ getPool, selectLoan }), ...require('./loan-period-service').createLoanPeriodService({ getPool, selectLoan }) }
}
module.exports = { createLoanService, selectLoan, validateLiability }
