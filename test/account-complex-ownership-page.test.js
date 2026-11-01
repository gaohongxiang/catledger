const test = require('node:test')
const assert = require('node:assert/strict')
const h = require('./helpers/editor-workbench')
const editor = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const ownership = require('../cloudfunctions/catledger-import/src/account-ownership')
const { transactionDrafts } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
const model = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const uid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const payer = uid(1), other = uid(2), credit = uid(3)
const accounts = [{ accountId: payer, name: '合成我的银行卡', type: 'bank', currency: 'CNY' },
  { accountId: other, name: '合成零钱', type: 'wallet', currency: 'CNY' }, { accountId: credit, name: '合成信用卡', type: 'credit', currency: 'CNY' }]
function source(patch = {}) { return { eventId: uid(10), version: 1, status: 'needs_action', economicNature: 'expense',
  flowDirection: 'outflow', sourceDirection: 'expense', ledgerAccountId: payer, counterpartyLedgerAccountId: null,
  amountMinor: '10000', currency: 'CNY', localAt: '2026-09-03 12:00:00', utcAt: '2026-09-03 04:00:00', timezoneOffsetMinutes: -480,
  reasonCodes: [], fieldSources: {}, ...patch } }
function row(event) { return { ...event, accountOrder: event.fieldSources.fundsProjection?.accountOrder,
  accountOwnership: ownership.read(event), editorFacts: editor.capability(event), paymentComponents: event.fieldSources.paymentComponents,
  paymentAccounts: event.fieldSources.paymentAccounts, paymentResolution: event.fieldSources.paymentResolution,
  repaymentAllocations: event.fieldSources.repaymentAllocations } }

test('真实Page可选择外部份额、保持金额并输出服务端可校验的组成', async t => {
  const original = source({ fieldSources: { paymentSourceDirection: 'expense', semanticBlockers: ['payment_components_ambiguous'],
    paymentComponents: [{ componentKind: 'financial', amountMinor: '6000' }, { componentKind: 'financial', amountMinor: '4000' }],
    paymentAccounts: [{ componentIndex: 0, accountId: payer }, { componentIndex: 1, accountId: other }] } })
  const { page } = await h.open(t, row(original), { accounts })
  page.changeFundsOwnership(h.tap({ index: 1, kind: 'external' }))
  h.edit(page, 'evidenceNote', '合成详情已核对')
  assert.equal(h.draft(page).parts[1].accountId, '')
  assert.equal(h.draft(page).parts[1].amountInput, '40.00')
  const view = h.view(page), payload = h.plain(view.payload)
  assert.equal(view.errors.length, 0)
  assert.deepEqual(payload.composition.parts[1], { accountId: null, amountMinor: '4000', kind: 'external', referenceRole: 'payment_component_1' })
  assert.deepEqual(transactionDrafts(editor.prepare(original, payload)).map(item => [item.type, item.amountMinor]), [['expense', '6000']])
  page.changeFundsOwnership(h.tap({ index: 1, kind: 'ledger' }))
  h.select(page, 'editorPart1', accounts[1])
  assert.equal(h.view(page).payload.composition.parts[1].kind, undefined)
})

test('全部外部消费在保存前明确说明无账本影响，完整金额及外部归属可恢复', async t => {
  const original = source({ fieldSources: { editorOverrides: { version: 1, composition: 'payment', incompleteComposition: {
    kind: 'payment', evidenceNote: '合成全额外部', parts: [{ kind: 'external', accountId: null, amountMinor: '6000' },
      { kind: 'external', accountId: null, amountMinor: '4000' }] } } } })
  const { page } = await h.open(t, row(original), { accounts })
  const view = h.view(page), payload = h.plain(view.payload)
  assert.match(view.compositionEffect, /全部在账本外.*对本账本无影响/)
  assert.equal(editor.prepare(original, payload).status, 'excluded')
  const restored = model.restore(row(original), payload)
  assert.deepEqual(restored.parts.map(part => [part.kind, part.accountId, part.amountInput]),
    [['external', '', '60.00'], ['external', '', '40.00']])
})

test('真实Page恢复外部份额冻结请求，保留原ID、金额、归属并原样重试保存', async t => {
  const data = fixture(1, true), original = source()
  Object.assign(data.events[0], row(original))
  const r = runtime(data), page = r.page
  t.after(() => page.onUnload())
  const frozen = { requestId: uid(99), updateId: r.summary.update.updateId, updateVersion: 1,
    eventId: original.eventId, eventVersion: 1, editorVersion: 1, fields: {}, acknowledgedChanges: [],
    composition: { kind: 'payment', evidenceNote: '合成外部份额原请求', parts: [{ accountId: payer, amountMinor: '6000' },
      { kind: 'external', accountId: null, amountMinor: '4000', referenceRole: 'payment_component_1' }] } }
  const envId = require('../miniprogram/config/cloudbase').envId
  r.storage.set('catledger_pending_ledger_v1:' + envId + ':1234567890',
    { schema: 1, target: 'import', action: 'financeUpdates.setReview', payload: frozen })
  r.intercept = action => {
    if (action === 'imports.commandResult') throw Object.assign(Error('合成结果待确认'), { code: 'OPERATION_UNCONFIRMED' })
    if (action !== 'financeUpdates.setReview') return
    r.summary = { ...r.summary, viewVersion: 'v2', update: { ...r.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', update: r.summary.update, event: { status: 'ready' } }
  }
  await flush(); await page.openReviewEdit(h.tap({ id: original.eventId }))
  assert.equal(page.data.reviewEditSheet.pending, true)
  assert.equal(page.data.reviewEditSheet.draft.parts[1].kind, 'external')
  page.changeFundsOwnership(h.tap({ index: 1, kind: 'ledger' }))
  assert.equal(page.data.reviewEditSheet.draft.parts[1].kind, 'external')
  page.closeReviewEdit(); await page.openReviewEdit(h.tap({ id: original.eventId })); await page.saveReviewEdit()
  assert.deepEqual(r.calls.filter(call => call.action === 'financeUpdates.setReview').map(call => call.input), [frozen])
})

test('朋友借入改按收入：pending保留原付款端语义，Page保留真实收款账户', async t => {
  const start = source({ economicNature: 'borrow', flowDirection: 'neutral', ledgerAccountId: credit,
    counterpartyLedgerAccountId: other, fieldSources: { ledgerAccountReference: { sourceType: 'bank', paymentMethodKey: 'synthetic-lender' } } })
  const original = require('../cloudfunctions/catledger-import/src/account-reference-decision').apply(start, 'subject', 'external')
  assert.equal(original.fieldSources.accountOwnershipRecheck.entries[0].side, 'source')
  const { page } = await h.open(t, row(original), { accounts })
  h.nature(page, 'income')
  assert.equal(h.draft(page).ledgerAccountId, other)
  const next = editor.prepare(original, h.plain(h.view(page).payload))
  assert.equal(require('../cloudfunctions/catledger-import/src/account-ownership-review-policy').pending(next).length, 0)
  assert.deepEqual(transactionDrafts(next).map(item => [item.type, item.sourceAccountId, item.destinationAccountId, item.amountMinor]),
    [['income', null, other, '10000']])
})

for (const sourceDirection of ['income', 'expense']) test('真实Page银行actual ' + sourceDirection + '转账→收入→本人转账，序列化保持真实方向', async t => {
  const original = source({ sourceDirection, economicNature: 'internal_transfer', flowDirection: 'neutral',
    counterpartyLedgerAccountId: other, fieldSources: { fundsProjection: { accountOrder: 'actual', kind: 'bank_transfer' } } })
  const first = await h.open(t, row(original), { accounts })
  const fields = h.view(first.page).accountFields
  assert.equal(fields.find(item => item.label === '转出账户').accountId, payer)
  assert.equal(fields.find(item => item.label === '转入账户').accountId, other)
  h.mode(first.page, 'sourceKind', 'external')
  const income = editor.prepare(original, h.plain(h.view(first.page).payload))
  assert.equal(income.economicNature, 'income')
  assert.equal(transactionDrafts(income)[0].destinationAccountId, other)
  const secondPage = await h.open(t, row(income), { accounts })
  h.mode(secondPage.page, 'sourceKind', 'ledger')
  h.select(secondPage.page, 'reviewAccount', accounts[0])
  const restored = editor.prepare(income, h.plain(h.view(secondPage.page).payload))
  assert.equal(restored.economicNature, 'internal_transfer')
  assert.deepEqual(transactionDrafts(restored).map(item => [item.sourceAccountId, item.destinationAccountId]), [[payer, other]])
})
