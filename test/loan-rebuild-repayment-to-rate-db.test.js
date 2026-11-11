const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

// 回归：一个原本按「还款额」建的计划，编辑改成「利率」时，rebuildPlan 必须把旧的 repayment_minor 清空，
// 不能沿用旧值带进 UPDATE 撞 ck_catledger_loans_schedule_v2（rate 口径要求 repayment_minor IS NULL）。
test('rebuildPlan 从还款额改利率：清空 repayment_minor，不撞 CHECK', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const s = localServices({ apiPool, importPool, subject: 'synthetic-rebuild-rate' })
    const api = (a, d) => call(s.api, a, d)
    const identity = await api('bootstrap')
    const debt = (await api('accounts.create', { requestId: randomUUID(), type: 'other_liability', name: '卡', currency: 'CNY',
      openingDisplayBalanceMinor: '1962890', occurredLocalAt: '2025-10-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    // 直接 SQL 造一行 repayment 计划（绕过 create 其它校验，专注 rebuild）
    const loanId = randomUUID()
    const setup = JSON.stringify({ schema: 1, originalPrincipalMinor: '1962890', historicalPaidTerms: 6, recordType: 'credit_card', customRecordType: '', discountKind: null, discountValue: null })
    await lab.owner.execute(`INSERT INTO catledger_loans (uid,loan_id,account_id,name,kind,baseline_principal_minor,baseline_date,schedule_method,schedule_terms,measurement_kind,repayment_minor,first_payment_date,principal_rounding,installment_setup_json,progress_json,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [identity.uid, loanId, debt, '组合1.96w', 'installment', '1962890', '2025-10-01', 'flat', 6, 'repayment', '342018', '2025-10-25', 'yuan', setup, JSON.stringify({ schema: 2, through: 6, exceptions: {} }), 1])

    const rebuilt = await api('loans.rebuildPlan', { requestId: randomUUID(), loanId, version: 1, confirmed: true,
      name: '组合1.96w', institution: null, scheduleMethod: 'flat', scheduleTerms: 6, measurementKind: 'rate',
      quoteType: 'monthly', ratePpm: '7600', repaymentMinor: null, feePerTermMinor: null, feeUpfrontMinor: null,
      firstPaymentDate: '2025-10-25', principalRounding: 'yuan', installmentSetup: JSON.parse(setup) })
    assert.equal(rebuilt.loanVersion, 2)
    const loan = (await api('loans.get', { loanId })).loan
    assert.equal(loan.measurementKind, 'rate')
    assert.equal(loan.quoteType, 'monthly')
    assert.equal(loan.ratePpm, '7600')
    assert.equal(loan.repaymentMinor, null, '旧的每期还款额必须被清空')
    // 逐期按 0.76% 月利率：首期利息 149.18
    const periods = await api('loans.previewPlan', { loanId })
    assert.equal(periods.periods[0].interestMinor, '14918')
  } finally { await lab.close() }
})
