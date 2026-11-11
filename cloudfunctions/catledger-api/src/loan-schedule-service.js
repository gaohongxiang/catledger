const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { parseVersion } = require('./transaction-domain')
const { storedScheduleInput,remainingSchedule,fullScheduleWithPaid,normalizeSetup } = require('./loan-installment')
const { fullPlan } = require('./installment-view')
const { advanceLoans } = require('./loan-payment-repository')
function anchorOf(loan) {
  return { baselineDate: loan.baselineDate, startDate: loan.startDate, createdDate: String(loan.createdAt).slice(0, 10) }
}
function publicPreview(periods, summary) {
  return { periods: periods.map(row => ({ periodNumber: row.periodNumber, dueDate: row.dueDate,
      principalMinor: String(row.principalMinor), interestMinor: String(row.interestMinor), feeMinor: String(row.feeMinor), ...(row.paid === true ? { paid: true } : {}) })),
    summary: { totalPaymentMinor: String(summary.totalPaymentMinor), totalInterestMinor: String(summary.totalInterestMinor),
      totalFeeMinor: String(summary.totalFeeMinor), ...(summary.derivedRatePpm == null ? {} : { derivedRatePpm: String(summary.derivedRatePpm) }),
      ...(summary.remainingPrincipalMinor == null ? {} : { remainingPrincipalMinor:summary.remainingPrincipalMinor,historicalPaidTerms:summary.historicalPaidTerms,totalTerms:summary.totalTerms,upfrontFeeMinor:summary.upfrontFeeMinor }) } }
}
async function insertSchedulePeriods(connection, uid, loanId, periods) {
  for (let at = 0; at < periods.length; at += 100) {
    const part = periods.slice(at, at + 100).map(row => ({ ...row, periodId: randomUUID() }))
    await connection.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled)
      VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,0)').join(',')}`,
    part.flatMap(row => [uid,row.periodId,loanId,row.periodNumber,row.dueDate,row.principalMinor,row.interestMinor,row.feeMinor]))
    await connection.execute(`INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES ${part.map(() => '(?,?,1,?)').join(',')}`,
    part.flatMap(row => [uid,row.periodId,JSON.stringify({ periodNumber:row.periodNumber,dueDate:row.dueDate,
      principalMinor:String(row.principalMinor),interestMinor:String(row.interestMinor),feeMinor:String(row.feeMinor),cancelled:false })]))
  }
}
function createLoanScheduleService({ getPool, selectLoan }) {
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  const write = (context, action, operation) => executeIdempotentMutation({ getPool, ...context, currentReads: true, action, operation })
  async function previewPlan(context) {
    return read(context, async (connection, uid) => {
      const data = context.data || {}
      let input = data, options = {}
      if (data.loanId != null) {
        const loan = await selectLoan(connection, uid, data.loanId)
        input = storedScheduleInput(loan)
        options = anchorOf(loan)
      } else {
        // 新建预览：起息日随 installmentSetup 一并传入（顶层不再平铺，避免 loans.create 的 loanMetadata 拒绝），
        // 这里读出来补到 buildSchedule 的输入，供日利率按实际天数计息。
        const setup = data.installmentSetup == null ? null : (typeof data.installmentSetup === 'string' ? JSON.parse(data.installmentSetup) : data.installmentSetup)
        input = { ...data, interestStartDate: data.interestStartDate ?? (setup && setup.interestStartDate) ?? null }
      }
      const { periods, summary } = fullScheduleWithPaid(input, options)
      return publicPreview(periods, summary)
    })
  }
  async function generatePlan(context) {
    return write(context, 'loans.generatePlan', async (connection, uid, data) => {
      if (data.confirmed !== true) throw ledgerError('VALIDATION_ERROR')
      const loan = await selectLoan(connection, uid, data.loanId, true)
      loan.version = Number(loan.version)
      if (loan.version !== parseVersion(data.version)) throw ledgerError('CONFLICT')
      const input = storedScheduleInput(loan)
      const [[existing]] = await connection.execute('SELECT period_id FROM catledger_loan_periods WHERE uid=? AND loan_id=? LIMIT 1', [uid, loan.loanId])
      if (existing) throw ledgerError('LOAN_PLAN_EXISTS')
      const { periods } = remainingSchedule(input, anchorOf(loan))
      if (!periods.length) throw ledgerError('VALIDATION_ERROR')
      await insertSchedulePeriods(connection,uid,loan.loanId,periods)
      await advanceLoans(connection, uid, new Map([[loan.loanId, loan]]))
      return { loanId: loan.loanId, loanVersion: loan.version + 1, generatedPeriods: periods.length }
    })
  }
  // 编辑分期「地基」参数（本金/总期数/已还期数/还款方式/利率等）后重算并原子替换期次。
  // 安全边界：该计划若已有真实还款分摊、或已挂生效的费用项/来源项，则拒绝重算（这些是既成事实/资金，不得静默抹掉），
  // 提示改用逐期「调整期次金额与日期」或先解除关联。只重建计划骨架，不写任何交易、不动余额与历史还款。
  async function rebuildPlan(context) {
    return write(context, 'loans.rebuildPlan', async (connection, uid, data) => {
      if (data.confirmed !== true) throw ledgerError('VALIDATION_ERROR')
      const loan = await selectLoan(connection, uid, data.loanId, true)
      loan.version = Number(loan.version)
      if (loan.version !== parseVersion(data.version)) throw ledgerError('CONFLICT')
      // 地基字段来自 data，允许覆盖；未提供的沿用现值。
      // 目标测算依据先定，再据此只取本口径那组字段、另一组强制 null（避免"沿用旧值"把互斥字段带进 UPDATE 撞 CHECK）。
      const targetKind = data.measurementKind == null ? loan.measurementKind : data.measurementKind
      const pick = (key, fallback) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback)
      const next = {
        scheduleMethod: data.scheduleMethod == null ? loan.scheduleMethod : data.scheduleMethod,
        scheduleTerms: data.scheduleTerms == null ? loan.scheduleTerms : Number(data.scheduleTerms),
        measurementKind: targetKind,
        quoteType: targetKind === 'rate' ? (pick('quoteType', loan.quoteType)) : null,
        ratePpm: targetKind === 'rate' ? (data.ratePpm == null ? loan.ratePpm : String(data.ratePpm)) : null,
        repaymentMinor: targetKind === 'repayment' ? (data.repaymentMinor == null ? loan.repaymentMinor : String(data.repaymentMinor)) : null,
        feePerTermMinor: data.feePerTermMinor == null ? loan.feePerTermMinor : String(data.feePerTermMinor),
        feeUpfrontMinor: data.feeUpfrontMinor == null ? loan.feeUpfrontMinor : String(data.feeUpfrontMinor),
        firstPaymentDate: data.firstPaymentDate === undefined ? loan.firstPaymentDate : data.firstPaymentDate,
        principalRounding: data.principalRounding == null || data.principalRounding === '' ? (loan.principalRounding || 'yuan') : data.principalRounding,
        installmentSetup: data.installmentSetup === undefined ? loan.installmentSetup : data.installmentSetup,
        // 名称/机构可选随同修改，省一次单独 update。
        name: data.name == null ? loan.name : String(data.name).trim(),
        institution: data.institution === undefined ? loan.institution : data.institution
      }
      if (!next.name) throw ledgerError('VALIDATION_ERROR')
      // 真实资金/来源存在时禁止重算，避免抹掉已核对的还款或费用依据。
      const [[alloc]] = await connection.execute(
        'SELECT allocation_id FROM catledger_loan_period_allocations WHERE uid=? AND loan_id=? AND active=1 LIMIT 1', [uid, loan.loanId])
      if (alloc) throw ledgerError('LOAN_PLAN_HAS_PAYMENTS')
      const [[item]] = await connection.execute(
        'SELECT item_id FROM catledger_installment_items WHERE uid=? AND loan_id=? AND active=1 LIMIT 1', [uid, loan.loanId])
      if (item) throw ledgerError('LOAN_PLAN_HAS_ITEMS')
      // 校验新 setup（本金/已还期数/总期数一致性等），非法直接拒绝，避免落库脏参数。
      const setupForWrite = next.installmentSetup == null ? null : normalizeSetup(next.installmentSetup, Number(next.scheduleTerms))
      // 用户改了参数就按新参数「重新生成整份期次」：全期 1..总期数都落成正常期次（cancelled=0），
      // 已还到第几期由 historicalPaidTerms 锚点驱动显示（1..N 自动显示已还），不制造「已取消」窟窿。
      const probe = { ...loan, ...next, installmentSetup: setupForWrite }
      const periods = fullPlan(probe)
      if (!periods.length) throw ledgerError('VALIDATION_ERROR')
      // 无 DELETE 权限（期次不删、保留审计）：对账——全期按 period_number 对齐，命中则恢复为正常并改值，缺则插入；
      // 超出总期数的历史期次（总期数变小）才置 cancelled。目标内期次一律 cancelled=0。
      const [existingRows] = await connection.execute(
        'SELECT period_id,period_number,principal_minor,interest_minor,fee_minor,cancelled,version FROM catledger_loan_periods WHERE uid=? AND loan_id=?', [uid, loan.loanId])
      const existing = new Map(existingRows.map(r => [Number(r.period_number), r]))
      const targetNumbers = new Set()
      for (const row of periods) {
        targetNumbers.add(Number(row.periodNumber))
        const cur = existing.get(Number(row.periodNumber))
        if (!cur) {
          const periodId = randomUUID()
          await connection.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled)
            VALUES (?,?,?,?,?,?,?,?,0)`, [uid, periodId, loan.loanId, row.periodNumber, row.dueDate, row.principalMinor, row.interestMinor, row.feeMinor])
          await connection.execute('INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES (?,?,1,?)',
            [uid, periodId, JSON.stringify({ periodNumber: row.periodNumber, dueDate: row.dueDate, principalMinor: String(row.principalMinor), interestMinor: String(row.interestMinor), feeMinor: String(row.feeMinor), cancelled: false })])
        } else {
          const changed = cur.cancelled === 1 || String(cur.principal_minor) !== String(row.principalMinor) ||
            String(cur.interest_minor) !== String(row.interestMinor) || String(cur.fee_minor) !== String(row.feeMinor) ||
            String(cur.due_date).slice(0, 10) !== String(row.dueDate)
          if (changed) {
            const nextVersion = Number(cur.version) + 1
            await connection.execute('UPDATE catledger_loan_periods SET due_date=?,principal_minor=?,interest_minor=?,fee_minor=?,cancelled=0,version=? WHERE uid=? AND period_id=?',
              [row.dueDate, row.principalMinor, row.interestMinor, row.feeMinor, nextVersion, uid, cur.period_id])
            await connection.execute('INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES (?,?,?,?)',
              [uid, cur.period_id, nextVersion, JSON.stringify({ periodNumber: row.periodNumber, dueDate: row.dueDate, principalMinor: String(row.principalMinor), interestMinor: String(row.interestMinor), feeMinor: String(row.feeMinor), cancelled: false })])
          }
        }
      }
      // 仅当总期数变小（存在超出新总期数的历史期次）时才把它们置 cancelled，保留唯一期号与审计。
      for (const [num, cur] of existing) {
        if (!targetNumbers.has(num) && cur.cancelled !== 1) {
          const nextVersion = Number(cur.version) + 1
          await connection.execute('UPDATE catledger_loan_periods SET cancelled=1,version=? WHERE uid=? AND period_id=?', [nextVersion, uid, cur.period_id])
          await connection.execute('INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES (?,?,?,?)',
            [uid, cur.period_id, nextVersion, JSON.stringify({ periodNumber: num, dueDate: String(cur.due_date).slice(0,10), principalMinor: String(cur.principal_minor), interestMinor: String(cur.interest_minor), feeMinor: String(cur.fee_minor), cancelled: true })])
        }
      }
      // 同步写回贷款行的地基字段与进度锚点并推进版本（一次 UPDATE 内 version+1，不再额外 advanceLoans）。
      // 重点：progress_json.through 必须与新 historicalPaidTerms 对齐，否则旧 progress 会让“已还锚点”失效、剩余本金算成全额。
      const newThrough = setupForWrite ? Number(setupForWrite.historicalPaidTerms) : Number(loan.progress && JSON.parse(loan.progress || '{}').through || 0)
      const newProgress = JSON.stringify({ schema: 2, through: newThrough, exceptions: {} })
      const [result] = await connection.execute(`UPDATE catledger_loans SET name=?,institution=?,schedule_method=?,schedule_terms=?,measurement_kind=?,quote_type=?,rate_ppm=?,
        repayment_minor=?,fee_per_term_minor=?,fee_upfront_minor=?,first_payment_date=?,principal_rounding=?,installment_setup_json=?,progress_json=?,version=version+1
        WHERE uid=? AND loan_id=? AND version=?`,
      [next.name, next.institution, next.scheduleMethod, next.scheduleTerms, next.measurementKind, next.quoteType, next.ratePpm, next.repaymentMinor,
        next.feePerTermMinor, next.feeUpfrontMinor, next.firstPaymentDate, next.principalRounding ?? 'yuan',
        setupForWrite ? JSON.stringify(setupForWrite) : null, newProgress,
        uid, loan.loanId, data.version])
      if (result.affectedRows !== 1) throw ledgerError('CONFLICT')
      return { loanId: loan.loanId, loanVersion: loan.version + 1, generatedPeriods: periods.length }
    })
  }
  return { previewPlan, generatePlan, rebuildPlan }
}
module.exports = { createLoanScheduleService,insertSchedulePeriods }
