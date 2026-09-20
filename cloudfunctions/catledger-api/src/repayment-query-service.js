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
const booking = require('./repayment-booking').createRepaymentBooking(ledgerError)
function candidate(row, accounts, repayment = null) {
  if (!repayment) return null
  const source = accounts.find(a => a.accountId === row.sourceAccountId)
  const target = accounts.find(a => a.accountId === repayment.liabilityAccountId)
  // 信用账户整单还款只是转账；分期不能从这笔总额支付推断。
  if (!['transfer','expense'].includes(row.type) || !source || !target || !ASSETS.includes(source.type) || target.type !== 'other_liability') return null
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
    const repayment = await booking.detail(connection, uid, paymentId)
    const allocations = await selectAllocations(connection, uid, paymentId)
    if (repayment && !allocations.length) {
      const payment = await selectPayment(connection, uid, paymentId)
      const [accounts] = await connection.execute('SELECT account_id AS accountId,name,type,archived_at AS archivedAt FROM catledger_accounts WHERE uid=? AND account_id IN (?,?)', [uid,payment.assetAccountId,repayment.liabilityAccountId])
      const targetAccount = candidate(row, accounts, repayment)
      if (!targetAccount) throw ledgerError('CONFLICT')
      return { state:'candidate',transaction:transactionToPublic(row),targetAccount,payment,repayment,allocations:[],evidence:await repaymentEvidence(connection,uid,eventId) }
    }
    const [[source]] = await connection.execute('SELECT event_id AS eventId FROM catledger_loan_payment_sources WHERE uid=? AND payment_id=? AND active=1', [uid,paymentId])
    eventId = source && source.eventId || eventId
    return { state: row.deletedAt != null ? 'replaced' : 'linked', transaction: transactionToPublic(row),
      targetAccount: null, ...await paymentSummary(connection, uid, paymentId), evidence: await repaymentEvidence(connection, uid, eventId) }
  }
  return { state:'none',transaction:transactionToPublic(row),targetAccount:null,payment:null,allocations:[],evidence:{ items:[],hasMore:false } }
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
      const from = `FROM catledger_loan_payments p
        JOIN catledger_loan_repayment_details d ON d.uid=p.uid AND d.payment_id=p.payment_id
        JOIN catledger_accounts sa ON sa.uid=p.uid AND sa.account_id=p.asset_account_id
        JOIN catledger_accounts da ON da.uid=d.uid AND da.account_id=d.liability_account_id
        WHERE p.uid=? AND p.status='active'
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_payment_allocations a WHERE a.uid=p.uid AND a.payment_id=p.payment_id)
          AND NOT EXISTS (SELECT 1 FROM catledger_loan_payment_transactions m JOIN catledger_transactions t ON t.uid=m.uid AND t.transaction_id=m.transaction_id
            WHERE m.uid=p.uid AND m.payment_id=p.payment_id AND (m.active<>1 OR t.deleted_at IS NOT NULL OR t.version<>m.transaction_version))
          ${filters.range ? 'AND p.occurred_local_at>=? AND p.occurred_local_at<?' : ''}
          ${filters.accountId ? 'AND d.liability_account_id=?' : ''}`
      const values = [uid,...(filters.range ? [filters.range.startDate,filters.range.endDate] : []),...(filters.accountId ? [filters.accountId] : [])]
      const [[count]] = await connection.execute('SELECT COUNT(*) AS total ' + from, values)
      const [rows] = await connection.execute(`SELECT p.payment_id AS paymentId,p.total_minor AS repaymentTotalMinor,
        p.occurred_local_at AS occurredLocalAt,da.type AS targetType,sa.archived_at AS sourceArchived,da.archived_at AS targetArchived,
        (SELECT m.transaction_id FROM catledger_loan_payment_transactions m JOIN catledger_transactions t ON t.uid=m.uid AND t.transaction_id=m.transaction_id
          WHERE m.uid=p.uid AND m.payment_id=p.payment_id AND m.active=1 ORDER BY (t.type='transfer') DESC,m.transaction_id LIMIT 1) AS transactionId
        ${from} ${cursor ? 'AND (p.occurred_local_at<? OR (p.occurred_local_at=? AND p.payment_id<?))' : ''}
        ORDER BY p.occurred_local_at DESC,p.payment_id DESC LIMIT ?`,
        [...values,...(cursor ? [cursor.at,cursor.at,cursor.id] : []),filters.pageSize+1])
      const page = rows.slice(0,filters.pageSize), last = page.at(-1), items = []
      for (const row of page) items.push({ ...transactionToPublic(await selectTransaction(connection,uid,row.transactionId)),
        paymentId:row.paymentId,repaymentTotalMinor:String(row.repaymentTotalMinor),targetType:row.targetType,
        inactive:row.sourceArchived != null || row.targetArchived != null })
      return { month:filters.month,accountId:filters.accountId,total:Number(count.total),items,nextCursor:rows.length > filters.pageSize ? encodeCursor(context.subjectHash,
        { action:'loans.unassigned',uid,month:filters.month,accountId:filters.accountId,at:String(last.occurredLocalAt),id:last.paymentId }) : null }
    })
  }
  return { transaction, unassigned }
}
module.exports = { createRepaymentQueryService, transactionContext, candidate, candidateFilters, paymentSummary }
