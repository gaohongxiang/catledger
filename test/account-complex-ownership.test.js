const test = require('node:test')
const assert = require('node:assert/strict')
const root = '../cloudfunctions/catledger-import/src/'
const decision = require(root + 'account-reference-decision')
const facts = require(root + 'account-ownership-recheck')
const review = require(root + 'account-ownership-review-policy')
const groups = require(root + 'account-issue-grouping')
const editor = require(root + 'review/editor-policy')
const { evaluatePostability } = require(root + 'organizer-model')
const { eventAllocation, allocationAccountsValid } = require(root + 'funds-allocation')
const { transactionDrafts } = require(root + 'finance-update-posting')
const { workbenchSummary } = require(root + 'workbench-summary')
const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const payer = uid(1), credit = uid(2), second = uid(3)
const accounts = new Map([[payer, { accountId: payer, type: 'bank', currency: 'CNY' }],
  [second, { accountId: second, type: 'wallet', currency: 'CNY' }], [credit, { accountId: credit, type: 'credit', currency: 'CNY' }]])
const ref = (key, role = 'subject') => ({ sourceType: 'alipay', paymentMethodKey: key, paymentMethodHint: key, memberRole: role })
function event(patch = {}) { return { eventId: uid(10), status: 'needs_action', economicNature: 'expense', flowDirection: 'outflow',
  sourceDirection: 'expense', ledgerAccountId: payer, counterpartyLedgerAccountId: null, amountMinor: '10000', currency: 'CNY',
  localAt: '2026-09-03 12:00:00', utcAt: '2026-09-03 04:00:00', timezoneOffsetMinutes: -480,
  reasonCodes: [], manualFieldMask: 0, fieldSources: { ledgerAccountReference: ref('payer') }, ...patch } }
function payment() { return event({ fieldSources: { ledgerAccountReference: ref('payer'), paymentSourceDirection: 'expense',
  semanticBlockers: ['payment_components_ambiguous'], paymentComponents: [
    { componentKind: 'financial', amountMinor: '6000' }, { componentKind: 'financial', amountMinor: '4000' }],
  paymentAccountReferences: [{ ...ref('payer', 'payment_component_0'), componentIndex: 0 },
    { ...ref('other', 'payment_component_1'), componentIndex: 1 }],
  paymentAccounts: [{ componentIndex: 0, accountId: payer }, { componentIndex: 1, accountId: second }] } }) }
const compose = (current, kind, parts, fields = {}) => editor.prepare(current, { editorVersion: 1, fields,
  composition: { kind, parts, evidenceNote: '合成金额已核对' } })

test('共享账户组允许保存外部事实，复杂成员不阻止普通成员且不整笔排除', () => {
  const ordinary = event(), refund = event({ eventId: uid(11), economicNature: 'refund', flowDirection: 'inflow' }), combo = payment()
  combo.eventId = uid(12)
  const rows = [ordinary, refund, combo], members = rows.map(row => ({ objectType: 'event', objectId: row.eventId, memberRole: 'subject' }))
  assert.equal(groups.canUseExternal(rows, members), true)
  const simple = decision.apply(ordinary, 'subject', 'external')
  assert.equal(simple.status, 'excluded')
  for (const source of [refund, combo]) {
    const original = JSON.stringify(source.fieldSources), next = decision.apply(source, 'subject', 'external')
    assert.equal(next.status, 'needs_action'); assert.equal(next.amountMinor, source.amountMinor)
    assert.equal(next.ledgerAccountId, source.ledgerAccountId)
    assert.equal(JSON.stringify(source.fieldSources), original)
    assert.equal(groups.memberDecision(next, { memberRole: 'subject' }).kind, 'external')
    assert.equal(evaluatePostability({ ...next, reasonCodes: [] }).status, 'needs_action')
    assert.throws(() => transactionDrafts({ ...next, reasonCodes: [] }), { publicCode: 'UNRESOLVED_IMPORT' })
  }
})

test('我的60+外部40只记60支出，保留总额100及两份原输入', () => {
  const source = payment(), saved = decision.apply(source, 'payment_component_1', 'external')
  const next = compose(saved, 'payment', [{ accountId: payer, amountMinor: '6000' },
    { kind: 'external', accountId: null, amountMinor: '4000', referenceRole: 'payment_component_1' }])
  assert.equal(review.pending(next).length, 0)
  assert.equal(next.amountMinor, '10000'); assert.deepEqual(next.fieldSources.paymentComponents, source.fieldSources.paymentComponents)
  assert.equal(allocationAccountsValid(next, eventAllocation(next), accounts), true)
  assert.deepEqual(transactionDrafts(next).map(row => [row.type, row.sourceAccountId, row.destinationAccountId, row.amountMinor]),
    [['expense', payer, null, '6000']])
  const ready = { ...next, ...evaluatePostability(next) }
  assert.equal(ready.status, 'ready')
  assert.equal(workbenchSummary([ready], [], [], 0, 0).finalSummary.expenseText, '¥60.00')
})

test('我的1000还本人600及外部400，扣款总额1000且只400为支出', () => {
  const next = compose(event({ economicNature: 'repayment', flowDirection: 'neutral', amountMinor: '100000', counterpartyLedgerAccountId: credit }),
    'repayment', [{ accountId: credit, amountMinor: '60000' }, { kind: 'external', accountId: null, amountMinor: '40000' }])
  assert.equal(allocationAccountsValid(next, eventAllocation(next), accounts), true)
  assert.deepEqual(transactionDrafts(next).map(row => [row.type, row.sourceAccountId, row.destinationAccountId, row.amountMinor]).sort(),
    [['expense', payer, null, '40000'], ['transfer', payer, credit, '60000']].sort())
  const summary = workbenchSummary([{ ...next, status: 'ready' }], [], [], 0, 0)
  assert.equal(summary.finalSummary.expenseText, '¥400.00'); assert.equal(summary.finalSummary.transferCount, 1)
  assert.equal(summary.fundsFlowGroups.find(row => row.nature === 'repayment').amountText, '¥600.00')
})

test('外部替我共同还款按收入入本人负债，空付款账户只接受已验证组成', () => {
  const next = compose(event({ economicNature: 'repayment', flowDirection: 'neutral', counterpartyLedgerAccountId: credit }), 'payment',
    [{ kind: 'external', accountId: null, amountMinor: '6000' }, { kind: 'external', accountId: null, amountMinor: '4000' }])
  assert.equal(next.ledgerAccountId, null); assert.equal(evaluatePostability(next).status, 'ready')
  assert.equal(allocationAccountsValid(next, eventAllocation(next), accounts), true)
  assert.ok(transactionDrafts(next).every(row => row.type === 'income' && row.sourceAccountId === null && row.destinationAccountId === credit))
  assert.equal(workbenchSummary([{ ...next, status: 'ready' }], [], [], 0, 0).finalSummary.incomeText, '¥100.00')
  assert.ok(evaluatePostability(event({ ledgerAccountId: null })).reasonCodes.includes('ledger_account_required'))
})

test('未知不是外部，金额不守恒、外部伪造账户或以旧版本注入外部都拒绝', () => {
  const source = payment()
  for (const parts of [[{ accountId: payer, amountMinor: '6000' }, { accountId: null, amountMinor: '4000' }],
    [{ accountId: payer, amountMinor: '6000' }, { kind: 'external', accountId: null, amountMinor: '5000' }],
    [{ accountId: payer, amountMinor: '6000' }, { kind: 'external', accountId: second, amountMinor: '4000' }]]) {
    assert.throws(() => compose(source, 'payment', parts), { publicCode: 'VALIDATION_ERROR' })
  }
  const next = compose(source, 'payment', [{ accountId: payer, amountMinor: '6000' }, { kind: 'external', amountMinor: '4000' }])
  next.fieldSources.paymentResolution.version = 'payment-resolution-v3'
  assert.equal(eventAllocation(next).valid, false)
})

test('配对/分期/贷款原关系不被外部选择改写，删除原因码不能放行', () => {
  for (const fields of [{ repaymentChannelResolution: { synthetic: true } }, { installment: { creditStatement: true, component: 'principal' } },
    { loanRepayment: { confirmed: true } }, { disbursement: { role: 'disbursement' } }]) {
    const source = event({ fieldSources: { ...fields, ledgerAccountReference: ref('payer') } })
    const next = decision.apply(source, 'subject', 'external')
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(next.fieldSources[key], value)
    assert.ok(evaluatePostability({ ...next, reasonCodes: [] }).reasonCodes.includes(facts.REASON))
    assert.throws(() => transactionDrafts(next), { publicCode: 'UNRESOLVED_IMPORT' })
  }
})

test('拆开同笔时外部事实按引用回到对应来源，不能污染其他来源或消失', () => {
  const platform = event({ fieldSources: { ledgerAccountReference: ref('platform') } })
  const bank = event({ eventId: uid(11), fieldSources: { ledgerAccountReference: ref('bank') } })
  let merged = event({ fieldSources: { ledgerAccountReference: ref('platform'), mergeOrigins: [{ synthetic: true }] } })
  merged = decision.apply(merged, 'subject', 'external', null, { reference: ref('bank') })
  const [a, b] = review.restoreAfterSplit(merged, [platform, bank], platform.eventId)
  assert.equal(a.ledgerAccountId, payer); assert.equal(a.fieldSources.accountOwnership, undefined)
  assert.equal(b.status, 'excluded'); assert.equal(b.ledgerAccountId, null)
  const unmatched = review.restoreAfterSplit(merged, [platform], platform.eventId)[0]
  assert.ok(review.pending(unmatched).length); assert.equal(unmatched.status, 'needs_action')
})

test('退款外部归属先阻断，确认无账本影响必须同时显式解除原关联', () => {
  const current = decision.apply(event({ economicNature: 'refund', flowDirection: 'inflow' }), 'subject', 'external')
  const data = { editorVersion: 1, fields: {}, decisions: { accountOwnership: {
    source: { kind: 'external' }, destination: { kind: 'external' }, noLedgerImpact: true } } }
  assert.throws(() => editor.prepare(current, data), { publicCode: 'VALIDATION_ERROR' })
  const next = editor.prepare(current, { ...data, decisions: { ...data.decisions, refund: { mode: 'unlinked' } } })
  assert.equal(next.status, 'excluded'); assert.equal(next.ledgerAccountId, null)
})

test('银行实际双端在派生收入后仍保持原账单subject侧别', () => {
  const source = event({ economicNature: 'internal_transfer', flowDirection: 'neutral', counterpartyLedgerAccountId: second,
    fieldSources: { fundsProjection: { accountOrder: 'actual', kind: 'bank_transfer', from: ref('from'), to: ref('to') } } })
  const income = decision.apply(source, 'subject', 'external')
  assert.equal(income.economicNature, 'income'); assert.equal(decision.sideFor(income, 'subject'), 'source')
  const restored = decision.apply(income, 'subject', 'ledger', payer)
  assert.equal(restored.economicNature, 'internal_transfer')
  assert.deepEqual(transactionDrafts(restored).map(row => [row.sourceAccountId, row.destinationAccountId]), [[payer, second]])
})

test('已确认外部份额改回本人账户先重开组成，不沿用漏记外部的旧决定', () => {
  const source = decision.apply(payment(), 'payment_component_1', 'external')
  const composed = compose(source, 'payment', [{ accountId: payer, amountMinor: '6000' },
    { kind: 'external', accountId: null, amountMinor: '4000', referenceRole: 'payment_component_1' }])
  const next = require(root + 'review/account-mapping-policy').applyMappedAccount(composed, 'payment_component_1', second, new Map())
  assert.equal(next.fieldSources.paymentResolution, undefined)
  assert.deepEqual(next.fieldSources.editorOverrides.incompleteComposition.parts.map(item => [item.accountId, item.amountMinor]),
    [[payer, '6000'], [second, '4000']])
  assert.equal(facts.entries(next).length, 0)
  assert.equal(evaluatePostability(next).status, 'needs_action')
  const confirmed = compose(next, 'payment', next.fieldSources.editorOverrides.incompleteComposition.parts.map(({ componentIndex, ...part }) => part))
  assert.equal(transactionDrafts(confirmed).reduce((sum, row) => sum + BigInt(row.amountMinor), 0n), 10000n)
})
