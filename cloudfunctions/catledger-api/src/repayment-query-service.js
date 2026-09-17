const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { validateId, transactionToPublic } = require('./transaction-domain')
const { selectTransaction } = require('./transaction-command-service')
const { selectPayment, selectAllocations } = require('./loan-payment-repository')
const { decodeCursor, encodeCursor } = require('./cursor')
const { parseMonth } = require('./local-time')
const { repaymentEvidence } = require('./repayment-evidence')
const ASSETS = ['cash','bank','wallet','other_asset']
const LIABILITIES = ['credit','other_liability']
const FIELDS = ['principal','interest','fee']
function candidate(row, accounts) {
  const source = accounts.find(a => a.accountId === row.sourceAccountId)
  const target = accounts.find(a => a.accountId === row.destinationAccountId)
  if (row.type !== 'transfer' || !source || !target || !ASSETS.includes(source.type) || !LIABILITIES.includes(target.type)) return null
  return { accountId: target.accountId, name: target.name, type: target.type,
    inactive: source.archivedAt != null || target.archivedAt != null }
}
function candidateFilters(data = {}) {
  const month = data.month == null || data.month === '' ? null : data.month
  const accountId = data.accountId == null || data.accountId === '' ? null : validateId(data.accountId)
  const pageSize = data.pageSize == null ? 20 : data.pageSize
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 40) throw ledgerError('VALIDATION_ERROR')
  return { month, accountId, pageSize, range: month !== null ? parseMonth(month) : null }
}
async function linkedPayment(connection, uid, transactionId) {
  const [rows] = await connection.execute(`SELECT DISTINCT p.payment_id AS paymentId FROM catledger_loan_payments p
    JOIN (SELECT payment_id FROM catledger_loan_payment_transactions WHERE uid=? AND active_transaction_id=?
      UNION SELECT payment_id FROM catledger_loan_replaced_transactions WHERE uid=? AND transaction_id=?) hit
      ON hit.payment_id=p.payment_id WHERE p.uid=? AND p.status='active' LIMIT 2`,
  [uid,transactionId,uid,transactionId,uid])
  if (rows.length > 1) throw ledgerError('CONFLICT')
  return rows[0] && rows[0].paymentId
}
async function paymentSummary(connection, uid, paymentId) {
  const payment = await selectPayment(connection, uid, paymentId)
  const allocations = await selectAllocations(connection, uid, paymentId)
  if (!allocations.length) throw ledgerError('CONFLICT')
  const [loans] = await connection.execute(`SELECT loan_id AS loanId,kind,account_id AS accountId FROM catledger_loans
    WHERE uid=? AND loan_id IN (${allocations.map(() => '?').join(',')})`, [uid,...allocations.map(a => a.loanId)])
  // 每笔贷款最多40期、最多20贷款；完整读取用于分项守恒，响应只给前三期及明确总数。
  const [periods] = await connection.execute(`SELECT a.loan_id AS loanId,p.period_id AS periodId,p.period_number AS periodNumber,p.due_date AS dueDate,
    a.principal_minor AS principalMinor,a.interest_minor AS interestMinor,a.fee_minor AS feeMinor
    FROM catledger_loan_period_allocations a JOIN catledger_loan_periods p ON p.uid=a.uid AND p.period_id=a.period_id
    WHERE a.uid=? AND a.payment_id=? AND a.active=1 ORDER BY p.due_date,p.period_number,p.period_id LIMIT 801`, [uid,paymentId])
  if (periods.length > 800) throw ledgerError('CONFLICT')
  return { payment, allocations: allocations.map(a => {
    const own = periods.filter(p => p.loanId === a.loanId)
    const unallocated = Object.fromEntries(FIELDS.map(f => [f + 'Minor', String(BigInt(a[f + 'Minor']) - own.reduce((sum,p) => sum + BigInt(p[f + 'Minor']), 0n))]))
    if (FIELDS.some(f => BigInt(unallocated[f + 'Minor']) < 0n)) throw ledgerError('CONFLICT')
    return { ...a, ...loans.find(l => l.loanId === a.loanId), unallocated, periodCount: own.length,
      periods: own.slice(0,3).map(p => ({ periodId:p.periodId,periodNumber:Number(p.periodNumber),dueDate:p.dueDate,
        ...Object.fromEntries(FIELDS.map(f => [f + 'Minor',String(p[f + 'Minor'])])) })) }
  }) }
}
async function transactionContext(connection, uid, transactionId) {
  const row = await selectTransaction(connection, uid, validateId(transactionId))
  const paymentId = await linkedPayment(connection, uid, row.transactionId)
  if (row.deletedAt != null && !paymentId) throw ledgerError('NOT_FOUND')
  const [links] = await connection.execute(`SELECT event_id AS eventId FROM catledger_economic_event_transactions
    WHERE uid=? AND transaction_id=? AND superseded_at IS NULL AND role<>'refund_original' ORDER BY event_id LIMIT 2`, [uid,transactionId])
  let eventId = links.length === 1 ? links[0].eventId : null
  if (paymentId) {
    const [[source]] = await connection.execute('SELECT event_id AS eventId FROM catledger_loan_payment_sources WHERE uid=? AND payment_id=? AND active=1', [uid,paymentId])
    eventId = source && source.eventId || eventId
    return { state: row.deletedAt != null ? 'replaced' : 'linked', transaction: transactionToPublic(row),
      targetAccount: null, ...await paymentSummary(connection, uid, paymentId), evidence: await repaymentEvidence(connection, uid, eventId) }
  }
  const ids = [...new Set([row.sourceAccountId,row.destinationAccountId].filter(Boolean))]
  const [accounts] = ids.length ? await connection.execute(`SELECT account_id AS accountId,name,type,archived_at AS archivedAt FROM catledger_accounts
    WHERE uid=? AND account_id IN (${ids.map(() => '?').join(',')})`, [uid,...ids]) : [[]]
  const targetAccount = candidate(row, accounts)
  return { state: targetAccount ? 'candidate' : 'none', transaction: transactionToPublic(row), targetAccount,
    payment: null, allocations: [], evidence: targetAccount ? await repaymentEvidence(connection, uid, eventId) : { items: [], hasMore: false } }
}
function createRepaymentQueryService({ getPool }) {
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  async function transaction(context) { return read(context, (connection,uid) => transactionContext(connection,uid,context.data.transactionId)) }
  async function unassigned(context) {
    const data = context.data || {}, filters = candidateFilters(data)
    return read(context, async (connection,uid) => {
      if (filters.accountId) {
        const [[account]] = await connection.execute('SELECT type FROM catledger_accounts WHERE uid=? AND account_id=?', [uid,filters.accountId])
        if (!account) throw ledgerError('NOT_FOUND')
        if (!LIABILITIES.includes(account.type)) throw ledgerError('VALIDATION_ERROR')
      }
      let cursor = null
      if (data.cursor) {
        cursor = decodeCursor(context.subjectHash, data.cursor)
        if (cursor.action !== 'loans.unassigned' || cursor.uid !== uid || cursor.month !== filters.month || cursor.accountId !== filters.accountId ||
            typeof cursor.at !== 'string' || typeof cursor.id !== 'string') throw ledgerError('VALIDATION_ERROR')
      }
      const [rows] = await connection.execute(`SELECT t.transaction_id AS transactionId,t.type,t.source_account_id AS sourceAccountId,sa.name AS sourceAccountName,
        t.destination_account_id AS destinationAccountId,da.name AS destinationAccountName,t.amount_minor AS amountMinor,
        t.occurred_local_at AS occurredLocalAt,t.timezone_offset_minutes AS timezoneOffsetMinutes,t.note,t.origin,t.version,
        da.type AS targetType,sa.archived_at AS sourceArchived,da.archived_at AS targetArchived
        FROM catledger_transactions t JOIN catledger_accounts sa ON sa.uid=t.uid AND sa.account_id=t.source_account_id
        JOIN catledger_accounts da ON da.uid=t.uid AND da.account_id=t.destination_account_id
        WHERE t.uid=? AND t.deleted_at IS NULL AND t.type='transfer'
          AND sa.type IN ('cash','bank','wallet','other_asset') AND da.type IN ('credit','other_liability')
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_payment_transactions bound WHERE bound.uid=t.uid AND bound.active_transaction_id=t.transaction_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_economic_event_transactions e JOIN catledger_loan_payment_sources s
            ON s.uid=e.uid AND s.active_event_id=e.event_id WHERE e.uid=t.uid AND e.transaction_id=t.transaction_id AND e.superseded_at IS NULL)
          ${filters.range ? 'AND t.occurred_local_date>=? AND t.occurred_local_date<?' : ''}
          ${filters.accountId ? 'AND t.destination_account_id=?' : ''}
          ${cursor ? 'AND (t.occurred_local_at<? OR (t.occurred_local_at=? AND t.transaction_id<?))' : ''}
        ORDER BY t.occurred_local_at DESC,t.transaction_id DESC LIMIT ?`, [uid,
      ...(filters.range ? [filters.range.startDate,filters.range.endDate] : []), ...(filters.accountId ? [filters.accountId] : []),
      ...(cursor ? [cursor.at,cursor.at,cursor.id] : []),filters.pageSize+1])
      const page = rows.slice(0,filters.pageSize), last = page.at(-1)
      return { month:filters.month,accountId:filters.accountId,items:page.map(row => ({ ...transactionToPublic(row),targetType:row.targetType,
        inactive:row.sourceArchived != null || row.targetArchived != null })), nextCursor: rows.length > filters.pageSize ? encodeCursor(context.subjectHash,
        { action:'loans.unassigned',uid,month:filters.month,accountId:filters.accountId,at:String(last.occurredLocalAt),id:last.transactionId }) : null }
    })
  }
  return { transaction, unassigned }
}
module.exports = { createRepaymentQueryService, transactionContext, candidate, candidateFilters, paymentSummary }
