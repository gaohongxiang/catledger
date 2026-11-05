const test = require('node:test')
const assert = require('node:assert/strict')
const root = '../cloudfunctions/catledger-import/src/'
const evidence = require(root + 'funds-evidence')
const recheck = require(root + 'account-ownership-recheck')
const { effectiveSemanticReasons, inspectPaymentAccounts } = require(root + 'payment-resolution')
const { referenceFailure, referencedAccountIds } = require(root + 'review/event-references')

const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const payer = uid(1), target = uid(2)
const catalog = { accounts: new Map([[payer, { accountId: payer, type: 'bank', currency: 'CNY' }],
  [target, { accountId: target, type: 'credit', currency: 'CNY' }]]), categories: new Map() }

// 组合付款改成单账户后，旧的两条成分映射与旧的再拆分 paymentResolution 都会残留。
// 复核通过、入账却被 payment_accounts / payment 拦住，正是两套标准不一致的表现。
function ambiguousEvent(extra = {}) {
  return { eventId: uid(10), status: 'needs_action', economicNature: 'repayment', flowDirection: 'neutral',
    currency: 'CNY', amountMinor: '151217', ledgerAccountId: payer, counterpartyLedgerAccountId: target,
    manualFieldMask: 0, reasonCodes: ['payment_components_ambiguous'],
    fieldSources: {
      semanticBlockers: ['payment_components_ambiguous'],
      paymentComponents: [{ componentKind: 'financial' }, { componentKind: 'financial' }],
      paymentAccountReferences: [{ memberRole: 'payment_component_0', accountIdentityKey: 'k0' },
        { memberRole: 'payment_component_1', accountIdentityKey: 'k1' }],
      paymentAccounts: [{ componentIndex: 0, accountId: payer }, { componentIndex: 1, accountId: payer }],
      paymentResolution: { version: 'payment-resolution-v3', nature: 'repayment', confirmedFromDetails: true,
        targetAccountId: target, evidenceNote: '旧拆分',
        allocations: [{ componentIndex: 0, accountId: payer, amountMinor: '100000' },
          { componentIndex: 1, accountId: payer, amountMinor: '51217' }] },
      ...extra
    } }
}
const withSingle = event => ({ ...event, fieldSources: { ...event.fieldSources,
  editorOverrides: { version: 1, composition: 'single', evidenceNote: '合并成一个账户' } } })

// funds-evidence：单账户决定优先于残留的逐成分证据。
test('funds-evidence：单账户决定有效，残留成分证据一律失效', () => {
  const single = withSingle(ambiguousEvent())
  assert.equal(evidence.single(single), true)
  assert.equal(evidence.componentEvidenceActive(single), false)
  assert.equal(evidence.pending(single), false)
  // 未选单账户时证据仍然有效、组成仍待定。
  const raw = ambiguousEvent()
  assert.equal(evidence.single(raw), false)
  assert.equal(evidence.componentEvidenceActive(raw), true)
  assert.equal(evidence.pending(raw), true)
})

// 复核与入账共用同一份有效证据：入账阶段不再判 payment_accounts / payment。
test('组合改单账户后，入账引用校验与复核结论一致通过', () => {
  const single = withSingle(ambiguousEvent())
  assert.equal(referenceFailure(single, catalog), null)
  assert.equal(recheck.requiresReview(single), false)
  // 语义歧义在同一事实下被解除。
  assert.deepEqual(effectiveSemanticReasons(single, ['payment_components_ambiguous']), [])
  // 只引用事实上的两端账户，不再把作废的成分映射算进去。
  assert.deepEqual(referencedAccountIds(single).filter(Boolean).sort(), [payer, target].sort())
})

// 回归：没有单账户决定时，对不上账的组成证据仍须被拦下，不能因放宽而放行。
test('未确认单账户时，失效的组成证据仍按原规则拦截', () => {
  const raw = ambiguousEvent()
  assert.notEqual(referenceFailure(raw, catalog), null)
  assert.equal(recheck.requiresReview(raw), true)
})

// 索引缺陷回归：paymentAccountReferences 只带 memberRole、缺 componentIndex 时，
// 同一可信身份的两条成分仍应通过；身份不同时必须拒绝。
test('成分引用只按 memberRole 描述序号时仍能正确比对这些身份', () => {
  const event = ambiguousEvent({ editorOverrides: undefined, paymentAccounts: undefined, paymentResolution: undefined })
  // 去掉 componentIndex，只留 memberRole 的 payment_component_N。
  event.fieldSources.paymentAccountReferences = [
    { memberRole: 'payment_component_0', accountIdentityKey: 'same-family' },
    { memberRole: 'payment_component_1', accountIdentityKey: 'same-family' }]
  const choices = [0, 1].map(componentIndex => ({ componentIndex, accountId: payer }))
  assert.equal(inspectPaymentAccounts(event, choices).valid, true)
  event.fieldSources.paymentAccountReferences[1].accountIdentityKey = 'different-family'
  assert.equal(inspectPaymentAccounts(event, choices).valid, false)
})
