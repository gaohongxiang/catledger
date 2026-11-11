const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

// 方案A：本金整元平摊（principal_rounding=yuan）。26000/18 每期费率 0.9% → 本金 1444×17 + 1452、利息 234/期。
test('分期本金整元平摊：迁移列与约束、创建落库、试算与生成逐期对上银行账单', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const first = localServices({ apiPool, importPool, subject: 'synthetic-rounding-a' })
    const other = localServices({ apiPool, importPool, subject: 'synthetic-rounding-b' })
    const api = (action, data) => call(first.api, action, data)
    const identity = await api('bootstrap'); await call(other.api, 'bootstrap')
    const debt = (await api('accounts.create', { requestId: randomUUID(), type: 'other_liability', name: '合成负债', currency: 'CNY',
      openingDisplayBalanceMinor: '2600000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    // flat 等本等息 + 每期费率 0.9%（installment）= 26000×0.9% = 234/期
    const schedule = { scheduleMethod: 'flat', scheduleTerms: 18, measurementKind: 'rate', quoteType: 'installment', ratePpm: '9000',
      firstPaymentDate: '2026-12-09' }
    const base = { name: '合成整元分期', kind: 'installment', accountId: debt, baselinePrincipalMinor: '2600000', baselineDate: '2026-09-01' }

    await t.test('0041 列存在；CHECK 拒绝非法 principal_rounding 值', async () => {
      const [[row]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='catledger_loans' AND COLUMN_NAME='principal_rounding'`)
      assert.equal(Number(row.count), 1)
      await assert.rejects(lab.owner.execute(`INSERT INTO catledger_loans
        (uid,loan_id,account_id,name,kind,schedule_method,schedule_terms,measurement_kind,quote_type,rate_ppm,principal_rounding)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [identity.uid, randomUUID(), debt, '合成非法', 'installment',
        'flat', 18, 'rate', 'installment', 9000, 'half']), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
    })

    let loanId, centsPeriods
    await t.test('创建带 principalRounding=yuan，读取回填到资料接口', async () => {
      const created = await api('loans.create', { requestId: randomUUID(), ...base, ...schedule, principalRounding: 'yuan' })
      loanId = created.loanId
      const view = (await api('loans.get', { loanId })).loan
      assert.equal(view.principalRounding, 'yuan')
      // 对照：cent 口径的同一笔
      const centLoan = (await api('loans.create', { requestId: randomUUID(), ...base, ...schedule, principalRounding: 'cent', name: '合成到分分期' })).loanId
      assert.equal((await api('loans.get', { loanId: centLoan })).loan.principalRounding, 'cent')
      centsPeriods = await api('loans.previewPlan', { loanId: centLoan })
      // 新建默认到元（不传 principalRounding 时写 yuan）
      const defaultLoan = (await api('loans.create', { requestId: randomUUID(), ...base, ...schedule, name: '合成缺省分期' })).loanId
      const [[stored]] = await lab.owner.execute('SELECT principal_rounding FROM catledger_loans WHERE uid=? AND loan_id=?', [identity.uid, defaultLoan])
      assert.equal(stored.principal_rounding, 'yuan')
      assert.equal((await api('loans.get', { loanId: defaultLoan })).loan.principalRounding, 'yuan')
    })

    await t.test('试算：到元 1444×17+1452，利息 234/期×18=4212；到分为 1444.44/1444.52', async () => {
      const yuan = await api('loans.previewPlan', { loanId })
      assert.equal(yuan.periods.length, 18)
      for (let i = 0; i < 17; i += 1) assert.equal(yuan.periods[i].principalMinor, '144400', `yuan period ${i + 1}`)
      assert.equal(yuan.periods.at(-1).principalMinor, '145200')
      assert.ok(yuan.periods.every(p => p.interestMinor === '23400'))
      assert.equal(yuan.summary.totalInterestMinor, String(23400 * 18))
      // 到分对照：本金带分位、末期 1444.52
      assert.equal(centsPeriods.periods[0].principalMinor, '144444')
      assert.equal(centsPeriods.periods.at(-1).principalMinor, '144452')
      assert.ok(centsPeriods.periods.every(p => p.interestMinor === '23400'))
    })

    await t.test('生成落库：本金合计守恒、末期本金 1452、每期利息 234', async () => {
      const gen = await api('loans.generatePlan', { requestId: randomUUID(), loanId, version: 1, confirmed: true })
      assert.equal(gen.generatedPeriods, 18)
      const [[agg]] = await lab.owner.execute(`SELECT COUNT(*) AS count, COALESCE(SUM(principal_minor),0) AS p, COALESCE(SUM(interest_minor),0) AS i,
        MAX(CASE WHEN period_number=18 THEN principal_minor END) AS lastP FROM catledger_loan_periods WHERE uid=? AND loan_id=?`, [identity.uid, loanId])
      assert.equal(Number(agg.count), 18)
      assert.equal(String(agg.p), '2600000')
      assert.equal(String(agg.i), String(23400 * 18))
      assert.equal(String(agg.lastP), '145200')
      // 逐期读回同源
      const view = await api('loans.periods', { loanId, pageSize: 40 })
      assert.equal(view.items.length, 18)
      assert.equal(view.items[0].principalMinor, '144400')
      assert.equal(view.items.at(-1).principalMinor, '145200')
      assert.equal(view.summary.unpaidPrincipalMinor, '2600000')
    })

    await t.test('非法 principalRounding 被拒；用户隔离', async () => {
      await assert.rejects(api('loans.create', { requestId: randomUUID(), ...base, ...schedule, principalRounding: 'half' }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(call(other.api, 'loans.previewPlan', { loanId }), { publicCode: 'NOT_FOUND' })
    })
  } finally { await lab.close() }
})
