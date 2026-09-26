const { populateTracking } = require('./installment-service')
const { createLoanPaymentService } = require('./loan-payment-service')
const { populatePrincipal } = require('./loan-payment-repository')
const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { validateId, parseVersion } = require('./transaction-domain')
const { loanMetadata, publicLoan } = require('./loan-domain')
const { decodeCursor, encodeCursor } = require('./cursor')
const { parseSetup,storedScheduleInput,remainingSchedule } = require('./loan-installment')
const { insertSchedulePeriods } = require('./loan-schedule-service')
const LOAN_SELECT = `SELECT l.loan_id AS loanId, l.account_id AS accountId, l.name, l.institution, l.kind,
  l.baseline_principal_minor AS baselinePrincipalMinor, l.baseline_principal_minor AS remainingPrincipalMinor,
  l.baseline_date AS baselineDate, l.start_date AS startDate, l.end_date AS endDate,
  l.repayment_method AS repaymentMethod, l.schedule_method AS scheduleMethod, l.schedule_terms AS scheduleTerms,
  l.measurement_kind AS measurementKind, l.quote_type AS quoteType, l.rate_ppm AS ratePpm, l.repayment_minor AS repaymentMinor,
  l.fee_per_term_minor AS feePerTermMinor, l.fee_upfront_minor AS feeUpfrontMinor, l.first_payment_date AS firstPaymentDate,
  l.installment_setup_json AS installmentSetup,l.progress_json AS progress,l.archived_at AS archivedAt,l.version, l.created_at AS createdAt,
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
      const [rows] = await connection.execute(LOAN_SELECT + ` WHERE l.uid=? AND l.archived_at IS NULL${accountId ? ' AND l.account_id=?' : ''}${cursor ? ' AND (l.created_at < ? OR (l.created_at=? AND l.loan_id < ?))' : ''}
        ORDER BY l.created_at DESC, l.loan_id DESC LIMIT ?`, [uid, ...(accountId ? [accountId] : []), ...(cursor ? [cursor.at,cursor.at,cursor.id] : []), pageSize + 1])
      const items = rows.slice(0, pageSize), last = items.at(-1)
      const [[pending]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_loan_payments p JOIN catledger_loan_repayment_details d ON d.uid=p.uid AND d.payment_id=p.payment_id
        WHERE p.uid=? ${accountId ? 'AND d.liability_account_id=?' : ''} AND p.status='active' AND NOT EXISTS (SELECT 1 FROM catledger_loan_payment_allocations a WHERE a.uid=p.uid AND a.payment_id=p.payment_id)`,[uid,...(accountId ? [accountId] : [])])
      return { pendingRepaymentCount:Number(pending.count),items: (await populateTracking(connection,uid,await populatePrincipal(connection, uid, items))).map(publicLoan), nextCursor: rows.length > pageSize ? encodeCursor(context.subjectHash,
        { action: 'loans.list', uid, accountId, at: String(last.createdAt), id: last.loanId }) : null }
    })
  }
  async function get(context) { return read(context, async (connection, uid) => ({ loan: publicLoan((await populateTracking(connection,uid,await populatePrincipal(connection, uid, [await selectLoan(connection, uid, context.data.loanId)])))[0]) })) }
  async function create(context) {
    return write(context, 'loans.create', async (connection, uid, data) => {
      const value = loanMetadata(data), loanId = randomUUID()
      if (value.installmentSetup && (data.generatePlan !== true || value.kind !== 'installment')) throw ledgerError('VALIDATION_ERROR')
      await validateLiability(connection, uid, value.accountId)
      const plan = data.generatePlan ? remainingSchedule(storedScheduleInput(value)) : null
      if (plan && value.baselinePrincipalMinor !== plan.summary.remainingPrincipalMinor) throw ledgerError('VALIDATION_ERROR')
      await connection.execute(`INSERT INTO catledger_loans
        (uid,loan_id,account_id,name,institution,kind,baseline_principal_minor,baseline_date,start_date,end_date,repayment_method,
        schedule_method,schedule_terms,measurement_kind,quote_type,rate_ppm,repayment_minor,fee_per_term_minor,fee_upfront_minor,first_payment_date,installment_setup_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [uid,loanId,value.accountId,value.name,value.institution,value.kind,value.baselinePrincipalMinor,
        value.baselineDate,value.startDate,value.endDate,value.repaymentMethod,
        value.scheduleMethod,value.scheduleTerms,value.measurementKind,value.quoteType,value.ratePpm,value.repaymentMinor,
        value.feePerTermMinor,value.feeUpfrontMinor,value.firstPaymentDate,value.installmentSetup ? JSON.stringify(value.installmentSetup) : null])
      if (plan) await insertSchedulePeriods(connection,uid,loanId,plan.periods)
      if (data.sourceItemId) await require('./installment-link').attachSource(connection,uid,{...value,loanId},data.sourceItemId)
      return { loanId, version: 1,...(plan ? { generatedPeriods:plan.periods.length } : {}) }
    })
  }
  async function update(context) {
    return write(context, 'loans.update', async (connection, uid, data) => {
      const current = await selectLoan(connection, uid, data.loanId, true)
      if (Number(current.version) !== parseVersion(data.version)) throw ledgerError('CONFLICT')
      const chargeContract = await require('./loan-charge-store').contract(connection, uid, current.loanId)
      if (chargeContract) throw ledgerError('LOAN_BASELINE_LOCKED')
      const previousSetup = parseSetup(current.installmentSetup)
      const value = loanMetadata({ ...data,...(data.installmentSetup === undefined && previousSetup ? { installmentSetup:previousSetup } : {}) })
      if (data.generatePlan !== undefined || data.sourceItemId !== undefined) throw ledgerError('VALIDATION_ERROR')
      if (previousSetup) {
        const core = setup => setup && [setup.originalPrincipalMinor,setup.historicalPaidTerms,setup.discountKind,setup.discountValue]
        const changed = JSON.stringify(core(previousSetup)) !== JSON.stringify(core(value.installmentSetup)) ||
          ['scheduleMethod','scheduleTerms','measurementKind','quoteType','ratePpm','repaymentMinor','feePerTermMinor','feeUpfrontMinor','firstPaymentDate']
            .some(key => String(value[key]) !== String(current[key])) || value.baselinePrincipalMinor !== String(current.baselinePrincipalMinor) || value.baselineDate !== current.baselineDate
        if (changed) {
          const [[planned]] = await connection.execute('SELECT period_id FROM catledger_loan_periods WHERE uid=? AND loan_id=? LIMIT 1',[uid,current.loanId])
          if (planned) throw ledgerError('LOAN_BASELINE_LOCKED')
        }
      }
      if (value.accountId !== current.accountId || value.kind !== current.kind || value.baselinePrincipalMinor !== (current.baselinePrincipalMinor == null ? null : String(current.baselinePrincipalMinor)) || value.baselineDate !== current.baselineDate) {
        const [[active]] = await connection.execute(`SELECT a.payment_id FROM catledger_loan_payment_allocations a
          JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
          WHERE a.uid=? AND a.loan_id=? AND p.status='active' LIMIT 1`, [uid,current.loanId])
        if (active) throw ledgerError('LOAN_BASELINE_LOCKED')
      }
      await validateLiability(connection, uid, value.accountId)
      const [result] = await connection.execute(`UPDATE catledger_loans SET account_id=?,name=?,institution=?,kind=?,baseline_principal_minor=?,
        baseline_date=?,start_date=?,end_date=?,repayment_method=?,schedule_method=?,schedule_terms=?,measurement_kind=?,quote_type=?,rate_ppm=?,
        repayment_minor=?,fee_per_term_minor=?,fee_upfront_minor=?,first_payment_date=?,installment_setup_json=?,version=version+1 WHERE uid=? AND loan_id=? AND version=?`,
      [value.accountId,value.name,value.institution,value.kind,value.baselinePrincipalMinor,value.baselineDate,value.startDate,value.endDate,
        value.repaymentMethod,value.scheduleMethod,value.scheduleTerms,value.measurementKind,value.quoteType,value.ratePpm,value.repaymentMinor,
        value.feePerTermMinor,value.feeUpfrontMinor,value.firstPaymentDate,value.installmentSetup ? JSON.stringify(value.installmentSetup) : null,uid,current.loanId,data.version])
      if (result.affectedRows !== 1) throw ledgerError('CONFLICT')
      return { loanId: current.loanId, version: data.version + 1 }
    })
  }
  return { list, get, create, update, ...require('./loan-charge-service').createLoanChargeService({ getPool,selectLoan }), ...require('./installment-service').createInstallmentService({ getPool,selectLoan }), ...require('./explicit-repayment-service').createExplicitRepaymentService({ getPool }), ...require('./repayment-query-service').createRepaymentQueryService({ getPool }), ...createLoanPaymentService({ getPool, selectLoan }), ...require('./loan-period-service').createLoanPeriodService({ getPool, selectLoan }), ...require('./loan-schedule-service').createLoanScheduleService({ getPool, selectLoan }) }
}
module.exports = { createLoanService, selectLoan, validateLiability }
