const test = require('node:test')
const assert = require('node:assert/strict')
const { selectRefundCandidates, createRefundCandidateIndex } = require('../src/refund-relation-policy')
const original = (id, extra = {}) => ({ eventId: id, economicNature: 'expense', status: 'ready', currency: 'CNY', amountMinor: '1000',
  ledgerAccountId: 'account', utcAt: '2026-09-01 10:00:00', sourceType: 'wechat', display: { counterparty: '合成商户' },
  relationEvidence: { scopedStableReferences: ['wechat|order:' + id], rows: [] }, ...extra })
test('退款候选索引保持强引用、跨用户账户隔离、弱候选与超时/超额回退语义', () => {
  const events = [original('a'), original('b'), original('c', { status: 'excluded' }), original('d', { ledgerAccountId: 'foreign' }),
    original('tiny', { amountMinor: '1' }), original('future', { utcAt: '2026-10-01 00:00:00' }), original('fee', { economicNature: 'fee' })]
  const index = createRefundCandidateIndex()
  events.forEach(event => index.add(event))
  for (const refs of [['wechat|order:a'], ['wechat|order:c'], ['wechat|order:tiny'], ['wechat|order:future'], [], ['wechat|order:a','wechat|order:b']]) {
    const refund = original('refund', { economicNature: 'refund', amountMinor: '100', utcAt: '2026-09-02 00:00:00', relationEvidence: { scopedStableReferences: refs, rows: [] } })
    assert.deepEqual(index.select(refund), selectRefundCandidates(refund, events))
  }
})
