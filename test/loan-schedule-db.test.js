const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

test('还款计划参数、试算与生成：迁移约束、幂等、对账衔接和隔离', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const first = localServices({ apiPool, importPool, subject: 'synthetic-schedule-a' })
    const other = localServices({ apiPool, importPool, subject: 'synthetic-schedule-b' })
    const api = (action, data) => call(first.api, action, data)
    const identity = await api('bootstrap'); await call(other.api, 'bootstrap')
    const categoryId = identity.categories.find(c => c.kind === 'expense').id
    const account = async (type, amount, name) => (await api('accounts.create', { requestId: randomUUID(), type, name, currency: 'CNY',
      openingDisplayBalanceMinor: amount, occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const debt = await account('other_liability', '2000000', '合成负债')
    const schedule = { scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'annual', ratePpm: '100000',
      feePerTermMinor: '100', feeUpfrontMinor: '500', firstPaymentDate: '2026-10-01' }
    const base = { name: '合成分期', kind: 'installment', accountId: debt, baselinePrincipalMinor: '1000000', baselineDate: '2026-09-01' }
    let loanId

    await t.test('0018 新增列存在且 CHECK 拒绝配对缺失、部分参数与过高一次性费用', async () => {
      const [[row]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME IN
        ('schedule_method','schedule_terms','measurement_kind','quote_type','rate_ppm','repayment_minor','fee_per_term_minor','fee_upfront_minor','first_payment_date')`)
      assert.equal(Number(row.count), 9)
      const insert = (columns, values) => lab.owner.execute(`INSERT INTO catledger_loans (uid,loan_id,account_id,name,kind,${columns}) VALUES (?,?,?,?,?,${values})`,
        [identity.uid, randomUUID(), debt, '合成约束', 'borrowing'])
      await assert.rejects(insert('schedule_method,schedule_terms,measurement_kind,quote_type', `'flat',12,'rate','annual'`), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      await assert.rejects(insert('schedule_method', `'flat'`), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      await assert.rejects(insert('schedule_method,schedule_terms', `'flat',601`), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      await assert.rejects(insert('schedule_method,schedule_terms,measurement_kind,quote_type,rate_ppm', `'equal_payment',12,'rate','installment',1000`), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      await assert.rejects(lab.owner.execute(`INSERT INTO catledger_loans (uid,loan_id,account_id,name,kind,baseline_principal_minor,baseline_date,fee_upfront_minor)
        VALUES (?,?,?,?,?,?,'2026-09-01',?)`, [identity.uid, randomUUID(), debt, '合成约束', 'borrowing', 1000, 1000]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
    })

    await t.test('创建与更新按全有全无和配对规则校验，资料接口返回新字段', async () => {
      const created = await api('loans.create', { requestId: randomUUID(), ...base, ...schedule })
      loanId = created.loanId
      const view = (await api('loans.get', { loanId })).loan
      assert.equal(view.scheduleMethod, 'flat'); assert.equal(view.scheduleTerms, 12); assert.equal(view.measurementKind, 'rate')
      assert.equal(view.quoteType, 'annual'); assert.equal(view.ratePpm, '100000'); assert.equal(view.repaymentMinor, null)
      assert.equal(view.feePerTermMinor, '100'); assert.equal(view.feeUpfrontMinor, '500'); assert.equal(view.firstPaymentDate, '2026-10-01')
      const invalid = [
        { scheduleMethod: 'flat' },
        { scheduleMethod: 'flat', scheduleTerms: 12 },
        { ...schedule, quoteType: null },
        { ...schedule, ratePpm: null },
        { ...schedule, repaymentMinor: '90000' },
        { ...schedule, scheduleMethod: 'equal_payment', quoteType: 'installment' },
        { ...schedule, feeUpfrontMinor: '1000000' },
        { ...schedule, scheduleTerms: 601 },
        { scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'repayment', repaymentMinor: null }
      ]
      for (const patch of invalid) {
        await assert.rejects(api('loans.create', { requestId: randomUUID(), ...base, ...patch }), { publicCode: 'VALIDATION_ERROR' })
      }
      const updated = await api('loans.update', { requestId: randomUUID(), loanId, version: 1, ...base, ...schedule, feePerTermMinor: '200' })
      assert.equal(updated.version, 2)
      assert.equal((await api('loans.get', { loanId })).loan.feePerTermMinor, '200')
      await assert.rejects(api('loans.update', { requestId: randomUUID(), loanId, version: 1, ...base, ...schedule }), { publicCode: 'CONFLICT' })
    })

    await t.test('试算不落库：读库存参数或直接传参都只返回逐期与汇总', async () => {
      const direct = await api('loans.previewPlan', { principalMinor: '1000000', scheduleMethod: 'flat', scheduleTerms: 12,
        measurementKind: 'rate', quoteType: 'annual', ratePpm: '100000', firstPaymentDate: '2026-10-01' })
      assert.equal(direct.periods.length, 12)
      assert.equal(direct.summary.totalInterestMinor, '100000')
      assert.equal(direct.summary.derivedRatePpm, undefined)
      const stored = await api('loans.previewPlan', { loanId })
      assert.equal(stored.periods.length, 12)
      assert.equal(stored.periods[0].dueDate, '2026-10-01')
      assert.equal(stored.periods[0].feeMinor, '200')
      assert.equal(stored.summary.totalFeeMinor, String(200 * 12 + 500))
      const inferred = await api('loans.previewPlan', { principalMinor: '1000000', scheduleMethod: 'flat', scheduleTerms: 12,
        measurementKind: 'repayment', repaymentMinor: '90000' })
      assert.equal(inferred.summary.derivedRatePpm, '80000')
      const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_loan_periods WHERE uid=?', [identity.uid])
      assert.equal(Number(count.count), 0)
      const noParams = (await api('loans.create', { requestId: randomUUID(), ...base, name: '合成无参数' })).loanId
      await assert.rejects(api('loans.previewPlan', { loanId: noParams }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(call(other.api, 'loans.previewPlan', { loanId }), { publicCode: 'NOT_FOUND' })
    })

    let generated, generatedInput
    await t.test('生成写入连续期次与修订并推进贷款版本，不产生任何正式交易', async () => {
      const [[before]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [identity.uid])
      const input = { requestId: randomUUID(), loanId, version: 2, confirmed: true }
      generatedInput = input
      generated = await api('loans.generatePlan', input)
      assert.equal(generated.generatedPeriods, 12); assert.equal(generated.loanVersion, 3)
      const [[periods]] = await lab.owner.execute('SELECT COUNT(*) AS count, COALESCE(SUM(principal_minor),0) AS principal FROM catledger_loan_periods WHERE uid=? AND loan_id=?', [identity.uid, loanId])
      assert.equal(Number(periods.count), 12); assert.equal(String(periods.principal), '1000000')
      const [[revisions]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_loan_period_revisions WHERE uid=?', [identity.uid])
      assert.equal(Number(revisions.count), 12)
      const [[after]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [identity.uid])
      assert.equal(Number(after.count), Number(before.count))
      const view = await api('loans.periods', { loanId, pageSize: 40 })
      assert.equal(view.items.length, 12)
      assert.equal(view.summary.unpaidPrincipalMinor, '1000000')
      assert.equal(view.items[0].dueDate, '2026-10-01')
      const history = await api('loans.periodHistory', { periodId: view.items[0].periodId, kind: 'plan' })
      assert.equal(history.items.length, 1); assert.equal(history.items[0].snapshot.principalMinor, '83333')
    })

    await t.test('同请求重放冻结回执，已有期次（含已取消）拒绝再生成', async () => {
      assert.deepEqual(await api('loans.generatePlan', generatedInput), generated)
      const stale = { requestId: randomUUID(), loanId, version: 2, confirmed: true }
      await assert.rejects(api('loans.generatePlan', stale), { publicCode: 'CONFLICT' })
      const again = await api('loans.generatePlan', { requestId: randomUUID(), loanId, version: 3, confirmed: true }).then(() => null, error => error)
      assert.equal(again.publicCode, 'LOAN_PLAN_EXISTS')
      const cancelledLoan = (await api('loans.create', { requestId: randomUUID(), ...base, ...schedule, name: '合成已取消' })).loanId
      const saved = await api('loans.savePeriod', { requestId: randomUUID(), loanId: cancelledLoan, loanVersion: 1,
        periodNumber: 1, dueDate: '2026-10-01', principalMinor: '100', interestMinor: '0', feeMinor: '0' })
      await api('loans.savePeriod', { requestId: randomUUID(), loanId: cancelledLoan, loanVersion: saved.loanVersion, periodId: saved.periodId, version: 1,
        periodNumber: 1, dueDate: '2026-10-01', principalMinor: '100', interestMinor: '0', feeMinor: '0', cancelled: true })
      const current = (await api('loans.get', { loanId: cancelledLoan })).loan
      await assert.rejects(api('loans.generatePlan', { requestId: randomUUID(), loanId: cancelledLoan, version: current.version, confirmed: true }), { publicCode: 'LOAN_PLAN_EXISTS' })
      const noBaseline = (await api('loans.create', { requestId: randomUUID(), name: '合成无基准', kind: 'installment', accountId: debt, ...schedule })).loanId
      await assert.rejects(api('loans.generatePlan', { requestId: randomUUID(), loanId: noBaseline, version: 1, confirmed: true }), { publicCode: 'LOAN_PRINCIPAL_UNCONFIRMED' })
      await assert.rejects(api('loans.generatePlan', { requestId: randomUUID(), loanId, version: 3, confirmed: false }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(call(other.api, 'loans.generatePlan', { requestId: randomUUID(), loanId, version: 3, confirmed: true }), { publicCode: 'NOT_FOUND' })
    })

    await t.test('同一请求ID重放返回冻结结果且不重复写入', async () => {
      const replayLoan = (await api('loans.create', { requestId: randomUUID(), ...base, ...schedule, name: '合成重放' })).loanId
      const input = { requestId: randomUUID(), loanId: replayLoan, version: 1, confirmed: true }
      const once = await api('loans.generatePlan', input)
      assert.deepEqual(await api('loans.generatePlan', input), once)
      const receipt = await api('transactions.commandResult', { requestId: input.requestId, commandAction: 'loans.generatePlan' })
      assert.deepEqual(receipt.result, once)
      const [[periods]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_loan_periods WHERE uid=? AND loan_id=?', [identity.uid, replayLoan])
      assert.equal(Number(periods.count), 12)
    })

    await t.test('600 期批量生成一次完成且全部带修订', async () => {
      const longLoan = (await api('loans.create', { requestId: randomUUID(), ...base, name: '合成长期',
        scheduleMethod: 'equal_payment', scheduleTerms: 600, measurementKind: 'rate', quoteType: 'annual', ratePpm: '100000', firstPaymentDate: '2026-10-01' })).loanId
      const result = await api('loans.generatePlan', { requestId: randomUUID(), loanId: longLoan, version: 1, confirmed: true })
      assert.equal(result.generatedPeriods, 600)
      const [[check]] = await lab.owner.execute(`SELECT
        (SELECT COUNT(*) FROM catledger_loan_periods WHERE uid=? AND loan_id=?) AS periods,
        (SELECT COUNT(*) FROM catledger_loan_period_revisions r JOIN catledger_loan_periods p ON p.uid=r.uid AND p.period_id=r.period_id WHERE r.uid=? AND p.loan_id=?) AS revisions,
        (SELECT COALESCE(SUM(principal_minor),0) FROM catledger_loan_periods WHERE uid=? AND loan_id=?) AS principal`, [identity.uid, longLoan, identity.uid, longLoan, identity.uid, longLoan])
      assert.equal(Number(check.periods), 600); assert.equal(Number(check.revisions), 600); assert.equal(String(check.principal), '1000000')
    })

    await t.test('生成的期次直接进入既有对账：登记还款后逐期分配', async () => {
      const asset = await account('bank', '5000000', '合成资金')
      const loan = (await api('loans.get', { loanId })).loan
      const firstPeriod = (await api('loans.periods', { loanId, pageSize: 1 })).items[0]
      const payment = await api('loans.record', { requestId: randomUUID(), mode: 'new', kind: 'repayment', assetAccountId: asset,
        totalMinor: '91866', occurredLocalAt: '2026-10-01T12:00:00', timezoneOffsetMinutes: -480, confirmed: true,
        allocations: [{ loanId, version: loan.version, principalMinor: '83333', interestMinor: '8333', feeMinor: '200',
          interestTreatment: 'expense', feeTreatment: 'expense', interestCategoryId: categoryId, feeCategoryId: categoryId }] })
      const allocated = await api('loans.allocatePeriods', { requestId: randomUUID(), loanId, loanVersion: payment.loans[0].version,
        paymentId: payment.paymentId, version: 1, confirmed: true,
        items: [{ periodId: firstPeriod.periodId, version: firstPeriod.version, principalMinor: '83333', interestMinor: '8333', feeMinor: '200' }] })
      assert.equal(allocated.allocatedPeriods, 1)
      const view = await api('loans.periods', { loanId, pageSize: 40 })
      assert.equal(view.items[0].status, 'paid')
      assert.equal(view.summary.unpaidPrincipalMinor, '916667')
    })
  } finally { await lab.close() }
})
