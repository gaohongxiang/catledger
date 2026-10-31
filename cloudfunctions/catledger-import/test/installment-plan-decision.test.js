const assert = require('node:assert/strict')
const test = require('node:test')

const fingerprint = require('../src/installment-plan-fingerprint')
const { applyFields } = require('../src/review/policy')
const editorPolicy = require('../src/review/editor-policy')

const decision = overrides => ({ action: 'link', loanId: 'loan-1', planLabel: '电销现金分期', totalTerms: 12,
  principalMinor: '500000', startMonth: '2026-03', accountId: 'account-1', ...overrides })
const loan = overrides => ({ accountId: 'account-1', name: '电销现金分期', scheduleTerms: 12,
  startDate: '2026-03-01', baselinePrincipalMinor: '500000',
  installmentSetup: { schema: 1, originalPrincipalMinor: '500000', historicalPaidTerms: 0 }, ...overrides })
const disbursementEvent = overrides => ({ eventId: 'event-1', ledgerAccountId: 'account-1', amountMinor: '500000',
  localDate: '2026-03-05', item: '电销现金分期第1期共12期',
  fieldSources: { disbursement: { role: 'disbursement', planLabel: '电销现金分期', totalTerms: 12 } }, ...overrides })

test('计划名去掉摘要里的期次后缀', function () {
  assert.equal(fingerprint.planLabelFromItem('电销现金分期第12期共12期'), '电销现金分期')
  assert.equal(fingerprint.planLabelFromItem('电销现金分期 · 12期'), '电销现金分期')
})

test('起始月 = 账单月 −（期次 − 1），跨年不进位到 13 月', function () {
  assert.equal(fingerprint.startMonthFromPeriod('2026-03-05', 3), '2026-01')
  assert.equal(fingerprint.startMonthFromPeriod('2026-02-05', 3), '2025-12')
  assert.equal(fingerprint.startMonthFromPeriod('2026-04-05', 1), '2026-04')
})

test('放款日期不冒充首期月，确认首期月后才能比较完整候选', function () {
  const event = disbursementEvent()
  const unknown = fingerprint.fromDisbursement(event)
  assert.equal(unknown.startMonth, '')
  assert.equal(fingerprint.matches(unknown, loan()), false)
  const value = fingerprint.fromDisbursement({ ...event, fieldSources: { ...event.fieldSources, installmentPlan: decision() } })
  assert.equal(value.startMonth, '2026-03')
  assert.equal(fingerprint.matches(value, loan()), true)
  assert.equal(fingerprint.matches(value, loan({ baselinePrincipalMinor: '300000',
    installmentSetup: { schema: 1, originalPrincipalMinor: '300000', historicalPaidTerms: 0 } })), false)
  assert.equal(fingerprint.matches(value, loan({ startDate: '2025-09-01' })), false)
})

test('期次行没有本金：其余四项相同的两笔都能命中，只能由调用方按唯一命中放行', function () {
  const periodEvent = { ledgerAccountId: 'account-1', localDate: '2026-04-05', item: '电销现金分期第2期共12期',
    fieldSources: { installment: { creditStatement: true, component: 'principal', periodNumber: 2, totalTerms: 12 } } }
  const value = fingerprint.fromInstallment(periodEvent)
  assert.equal(value.principalMinor, null)
  assert.equal(value.startMonth, '2026-03')
  // 同起始月、同名称、同总期数：两笔都命中，说明“分不出来”是来源事实的边界，不按金额补猜。
  assert.equal(fingerprint.matches(value, loan()), true)
  assert.equal(fingerprint.matches(value, loan({ baselinePrincipalMinor: '300000' })), true)
})

test('绑定键可复现，本金或起始月不同就不同', function () {
  const key = fingerprint.bindingKey('电销现金分期', '2026-03', '500000')
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(key, fingerprint.bindingKey('电销现金分期', '2026-03', '500000'))
  assert.notEqual(key, fingerprint.bindingKey('电销现金分期', '2026-04', '500000'))
  assert.notEqual(key, fingerprint.bindingKey('电销现金分期', '2026-03', '300000'))
})

test('决定结构校验：未知动作、缺计划 ID、坏起始月都拒绝', function () {
  assert.equal(fingerprint.inspectDecision(decision()).action, 'link')
  assert.equal(fingerprint.inspectDecision({ action: 'skip', planLabel: '电销现金分期' }).action, 'skip')
  assert.equal(fingerprint.inspectDecision(decision({ action: 'merge' })), null)
  assert.equal(fingerprint.inspectDecision(decision({ loanId: '' })), null)
  assert.equal(fingerprint.inspectDecision(decision({ startMonth: '2026-13' })), null)
  assert.equal(fingerprint.inspectDecision(decision({ totalTerms: 0 })), null)
})

test('applyFields 把决定单独存进 fieldSources，不挤进分期来源事实', function () {
  const next = applyFields(disbursementEvent(), { installmentPlan: decision() })
  assert.equal(next.fieldSources.installmentPlan.action, 'link')
  assert.equal(next.fieldSources.installmentPlan.loanId, 'loan-1')
  assert.equal(next.fieldSources.disbursement.role, 'disbursement')
  assert.throws(() => applyFields(disbursementEvent(), { installmentPlan: decision({ action: 'merge' }) }),
    error => error.publicCode === 'VALIDATION_ERROR')
})

const editorEvent = overrides => ({ eventId: 'event-1', updateId: 'update-1', status: 'ready', currency: 'CNY',
  economicNature: 'borrow', flowDirection: 'inflow', ledgerAccountId: 'account-1', counterpartyLedgerAccountId: 'account-2',
  amountMinor: '500000', localAt: '2026-03-05 10:00:00', timezoneOffsetMinutes: -480, reasonCodes: [],
  fieldSources: { disbursement: { role: 'disbursement', planLabel: '电销现金分期', totalTerms: 12 } }, ...overrides })
const editorData = fields => ({ editorVersion: 1, fields, decisions: {}, acknowledgedChanges: [] })

test('核对保存：放款行的决定挂在用户为本行选的账户上', function () {
  const next = editorPolicy.prepare(editorEvent(), editorData({ installmentPlan: decision({ accountId: 'stale' }) }))
  assert.equal(next.fieldSources.installmentPlan.action, 'link')
  assert.equal(next.fieldSources.installmentPlan.accountId, 'account-1')
})

test('核对保存：只有放款行能建立或归入计划，且账户必选', function () {
  const offset = editorEvent({ fieldSources: { disbursement: { role: 'offset', planLabel: '电销现金分期' } } })
  assert.throws(() => editorPolicy.prepare(offset, editorData({ installmentPlan: decision() })),
    error => error.publicCode === 'VALIDATION_ERROR')
  const noAccount = editorEvent({ ledgerAccountId: null })
  assert.throws(() => editorPolicy.prepare(noAccount, editorData({ installmentPlan: decision() })),
    error => error.publicCode === 'VALIDATION_ERROR')
})

test('核对保存：改别的字段不会把已保存的计划决定冲掉', function () {
  const event = editorEvent({ fieldSources: { ...editorEvent().fieldSources, installmentPlan: decision() } })
  const next = editorPolicy.prepare(event, editorData({ note: '只改备注' }))
  assert.equal(next.fieldSources.installmentPlan.loanId, 'loan-1')
  assert.equal(next.fieldSources.installmentPlan.accountId, 'account-1')
})
