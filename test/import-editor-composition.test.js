const assert = require('node:assert/strict')
const test = require('node:test')
const composition = require('../cloudfunctions/catledger-import/src/review/editor-composition')

const event = () => ({ eventId: 'e1', amountMinor: '10000', economicNature: 'expense', status: 'needs_action',
  reasonCodes: ['payment_components_ambiguous', 'ledger_account_required', 'account_source_required'],
  fieldSources: { semanticBlockers: ['payment_components_ambiguous'] } })

// 账单说「这笔有几个付款方式、金额分不清」时，用户在编辑器里确认资金路径就是答复。
// 不清这条硬阻断，事件保存多少次都还是待核对。
test('确认成单账户即解除付款组成歧义', () => {
  const next = composition.apply(event(), { kind: 'single' }, [])
  assert.equal(next.fieldSources.semanticBlockers, undefined)
  assert.equal(next.reasonCodes.includes('payment_components_ambiguous'), false)
  assert.equal(next.fieldSources.editorOverrides.composition, 'single')
})

test('确认成完整组合同样解除付款组成歧义', () => {
  const next = composition.apply(event(), { kind: 'payment', evidenceNote: '两个账户各付一半',
    parts: [{ accountId: '6f9619ff-8b86-4d01-b42d-00cf4fc964ff', amountMinor: '6000' },
      { accountId: '7a3b9c2e-1f4d-4e5a-9b6c-8d7e6f5a4b3c', amountMinor: '4000' }] }, [])
  assert.equal(next.fieldSources.semanticBlockers, undefined)
  assert.equal(next.reasonCodes.includes('payment_components_ambiguous'), false)
})

// 只存未完成草稿时组成还没定，歧义仍在，不能提前清掉。
test('未完成的组合草稿不解除付款组成歧义', () => {
  const next = composition.apply(event(), { kind: 'payment', evidenceNote: '待补',
    incomplete: true, parts: [{ accountId: null, amountMinor: null }] }, [])
  assert.deepEqual(next.fieldSources.semanticBlockers, ['payment_components_ambiguous'])
  assert.equal(next.reasonCodes.includes('payment_components_ambiguous'), true)
})
