const test = require('node:test')
const assert = require('node:assert/strict')
const { facts } = require('./helpers/local-review')
const local = require('../miniprogram/packages/finance/services/import-local-model')

// 用合成账单复现微信 8 月账单里的三种行：美团商户消费、美团差价退款、无关的手机充值。
// 结构与真实导出相同（交易对方/商品/状态/单号列），编号与金额为合成值。
const HEAD = ['微信支付账单明细,,,,,,,,,,,',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注']
const rowsOf = lines => Buffer.from(HEAD.concat(lines).join('\n'))

const PURCHASE_REFUNDED = '2026-08-13 14:06:01,商户消费,合成平台商户,合成平台订单-0001,支出,64.00,合成信用卡(0001),已退款(¥0.17),SYNTH-TX-0001,SYNTH-ORDER-0001,SYNTH-MERCHANT-0001,'
const REFUND_SMALL = '2026-08-13 14:27:05,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.17,合成信用卡(0001),已退款¥0.17,SYNTH-TX-0002,28,28,'
const UNRELATED = '2026-08-12 16:02:43,商户消费,合成手机充值,50元话费-00000000000,支出,50.00,合成信用卡(0001),支付成功,SYNTH-TX-0003,SYNTH-ORDER-0003,SYNTH-MERCHANT-0003,'

function refundEvent(model) {
  return [...model.events.values()].find(event => event.economicNature === 'refund')
}
function titleOf(model, id) {
  const row = model.rows.get((model.byEvent && model.byEvent.get(id) || [])[0]?.rowId)
  return row ? row.counterparty : ''
}

test('本批退款候选只保留说得通的消费，不再列出无关商户', async () => {
  const value = await facts({ content: rowsOf([PURCHASE_REFUNDED, REFUND_SMALL, UNRELATED]) })
  const model = local.create(value), refund = refundEvent(model)
  assert.ok(refund, '合成账单应产生一笔退款事件')
  const candidates = model.refundCandidates(refund, 'event')
  const rows = candidates.map(row => row.id)
  assert.equal(rows.length, 1, '原单写明已退 ¥0.17，只有这一笔对得上')
  const detail = candidates[0]
  assert.equal(detail.merchant, '合成平台商户')
  assert.equal(detail.amountMinor, '6400')
  assert.equal(detail.matchKind, 'explicit_refund_evidence')
  // 无关商户即使时间更近、金额更大，也不能进候选。
  const unrelated = [...model.events.values()].find(event => event.economicNature === 'expense' && event.amountMinor === '5000')
  assert.ok(unrelated, '手机充值应作为独立支出存在')
  assert.equal(rows.includes(unrelated.eventId), false)
})

test('没有强证据时退回同商户候选，仍不混入其他商户；全量兜底要显式请求', async () => {
  const plainPurchase = '2026-08-13 13:20:00,商户消费,合成平台商户,合成平台订单-0002,支出,58.00,合成信用卡(0001),支付成功,SYNTH-TX-0004,SYNTH-ORDER-0004,SYNTH-MERCHANT-0004,'
  const value = await facts({ content: rowsOf([plainPurchase, REFUND_SMALL, UNRELATED]) })
  const model = local.create(value), refund = refundEvent(model)
  const matched = model.refundCandidates(refund, 'event')
  assert.equal(matched.length, 1, '只有同商户那笔说得通')
  assert.equal(matched[0].matchKind, 'merchant_evidence')
  assert.equal(matched[0].amountMinor, '5800')
  const all = model.refundCandidates(refund, 'event', { scope: 'all' })
  assert.ok(all.length > matched.length, '兜底范围包含本批全部可用支出')
  assert.equal(all[0].id, matched[0].id, '兜底时匹配项仍排在最前')
  assert.equal(all.filter(row => row.matchKind).length, 1)
})

test('不同支付方式的消费不算同一笔候选', async () => {
  const otherCard = '2026-08-13 13:00:00,商户消费,合成平台商户,合成平台订单-0003,支出,40.00,合成储蓄卡(0002),支付成功,SYNTH-TX-0005,SYNTH-ORDER-0005,SYNTH-MERCHANT-0005,'
  const value = await facts({ content: rowsOf([otherCard, REFUND_SMALL]) })
  const model = local.create(value), refund = refundEvent(model)
  assert.equal(model.refundCandidates(refund, 'event').length, 0, '换了一张卡就不是这一笔')
})
