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

test('选中原消费后退款事项收尾，事件不再停在待核对', async () => {
  const value = await facts({ content: rowsOf([PURCHASE_REFUNDED, REFUND_SMALL, UNRELATED]), mapped: true })
  const model = local.create(value)
  const refund = [...model.events.values()].find(event => event.economicNature === 'refund')
  // 服务端遇到多个候选会写成 proposed 关系并开一条“退款关系待确认”的硬阻断事项，
  // 这里用同一形状复原，验证选定原消费后这条事项能收尾。
  refund.reasonCodes = [...new Set([...(refund.reasonCodes || []), 'refund_relation_ambiguous'])]
  refund.status = 'needs_action'
  const issue = model.addIssue(refund, 'refund_relation', 'refund_relation_ambiguous', 'synthetic-refund-issue', [refund.eventId])
  issue.localDerived = false // 服务端下发的事项不是本机派生，不会被 derive 直接作废
  const candidate = model.refundCandidates(refund, 'event')[0]
  assert.ok(candidate, '应有可确认的原消费')
  model.edit({ eventId: refund.eventId, editorVersion: 1, decisions: { refund: { mode: 'link', kind: 'event', id: candidate.id, version: candidate.version } } })
  const after = model.events.get(refund.eventId)
  assert.equal(after.reasonCodes.includes('refund_relation_ambiguous'), false, '选定后不再保留待确认阻断')
  assert.equal(after.reasonCodes.filter(code => code.startsWith('refund_relation') || code === 'refund_amount_exceeded').length, 0)
  const settled = model.issues.get(issue.issueId)
  assert.equal(settled.status, 'resolved')
  assert.equal(settled.blocking, false)
})

test('本批没有匹配项时自动列出全部消费，仍只有两个范围按钮', async () => {
  const data = require('./helpers/paged-workbench').fixture(1, true)
  Object.assign(data.events[0], { economicNature: 'refund', flowDirection: 'inflow', amountMinor: '11' })
  const { runtime } = require('./helpers/paged-workbench')
  const editor = require('./helpers/editor-workbench')
  const h = runtime(data), page = h.page
  // 先返回空（本批无匹配），再返回全部消费。
  let call = 0
  h.intercept = action => {
    if (action !== 'economicEvents.refundCandidates') return
    call++
    return call === 1
      ? { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [], total: 0, nextCursor: null }
      : { protocolVersion: 2, viewVersion: h.summary.viewVersion, total: 1, nextCursor: null, items: [{ id: 'fallback', version: 1,
          kind: 'event', amountMinor: '6400', remainingMinor: '6400', localAt: '2026-08-13 14:06', merchant: '合成平台商户' }] }
  }
  await page.openReviewEdit(editor.tap({ id: data.events[0].eventId }))
  await page._reviewEditToken.refundRead
  const sheet = page.data.reviewEditSheet
  assert.equal(sheet.refundScope, 'all', '没有匹配项时自动退到全部消费')
  assert.equal(sheet.refundChoices.length, 1)
  assert.equal(h.calls.filter(row => row.action === 'economicEvents.refundCandidates').length, 2)
  page.onUnload()
})

test('原消费是“交易关闭”时给出解释，而不是只说没有候选', async () => {
  const closed = '2026-08-05 15:40:58,商户消费,合成平台商户,合成平台订单-0009,支出,0.90,合成信用卡(0001),交易关闭,SYNTH-TX-0009,SYNTH-ORDER-0009,SYNTH-MERCHANT-0009,'
  const refund = '2026-08-12 11:48:01,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.90,合成信用卡(0001),已退款¥0.90,SYNTH-TX-0010,SYNTH-ORDER-0009,SYNTH-MERCHANT-0009,'
  const value = await facts({ content: rowsOf([closed, refund]) })
  const model = local.create(value)
  const event = [...model.events.values()].find(row => row.economicNature === 'refund')
  const result = model.refundCandidates(event, 'event')
  assert.equal(result.length, 0, '已关闭的消费不能作为原消费')
  assert.ok(result.closedOriginal, '要指出同订单消费已关闭，界面才能解释为什么没候选')
  assert.equal(result.closedOriginal.amountMinor, '90')
})

test('退款冲突这笔：默认按已退回处理，写进本批决定且不联网', async t => {
  const { facts } = require('./helpers/local-review')
  const { localWorkbench } = require('./helpers/local-workbench')
  const HEAD = ['微信支付账单明细,,,,,,,,,,,', '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注']
  const value = await facts({ content: Buffer.from(HEAD.concat([
    '2026-08-05 15:40:58,商户消费,合成平台商户,合成订单-A,支出,0.90,合成信用卡(0001),交易关闭,SYNTH-TX-A1,SYNTH-ORDER-A,SYNTH-M-A,',
    '2026-08-12 11:48:01,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.90,合成信用卡(0001),已退款¥0.90,SYNTH-TX-A2,SYNTH-ORDER-A,SYNTH-M-A,'
  ]).join('\n')) })
  const h = await localWorkbench(t, value), page = h.page
  const refund = [...value.events].find(event => event.economicNature === 'refund')
  await page.openReviewEdit({ currentTarget: { dataset: { id: refund.eventId } } })
  assert.equal(page.data.reviewEditSheet.editor.refundConflict, true, '应识别为原单已关闭')
  await page.excludeRefundAsReversed()
  assert.equal(h.local.model.choices.reviews.size, 1, '写入一条人工决定')
  const after = h.local.model.events.get(refund.eventId)
  assert.equal(after.status, 'excluded')
  assert.equal(h.network.length, 0, '处理全程不联网')
})

test('支付宝那种订单号加后缀的关闭单，算状态四', async t => {
  const { facts } = require('./helpers/local-review')
  const { localWorkbench } = require('./helpers/local-workbench')
  const HEAD = ['微信支付账单明细,,,,,,,,,,,', '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注']
  const value = await facts({ content: Buffer.from(HEAD.concat([
    '2026-08-05 15:40:58,商户消费,合成平台商户,合成订单-A,支出,0.90,合成信用卡(0001),交易关闭,SYNTH-TX-A1,SYNTH-ORDER-A,SYNTH-M-A,',
    // 退款行订单号带后缀，只有商家单号与原件一致——真实支付宝账单就是这样。
    '2026-08-12 11:48:01,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.90,合成信用卡(0001),已退款¥0.90,SYNTH-TX-A2,SYNTH-ORDER-A_1234,SYNTH-M-A,'
  ]).join('\n')) })
  const h = await localWorkbench(t, value), page = h.page
  const refund = [...value.events].find(event => event.economicNature === 'refund')
  await page.openReviewEdit({ currentTarget: { dataset: { id: refund.eventId } } })
  await page._reviewEditToken.refundRead
  const sheet = page.data.reviewEditSheet
  // 平台订单号加 "_<流水>" 是同一单的派生编号：按状态四处理。
  assert.equal(sheet.refundClosed, true, '订单号前缀一致要认出“原单已关闭”')
  assert.equal(sheet.refundChoices.length, 0, '这种状态不再自动列出全部消费')
  assert.equal(h.network.length, 0, '识别与展示全程不联网')
})

test('旧草稿也在本机识别“原单已关闭”，不必重新整理', async () => {
  const { facts } = require('./helpers/local-review')
  const HEAD = ['微信支付账单明细,,,,,,,,,,,', '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注']
  const value = await facts({ content: Buffer.from(HEAD.concat([
    '2026-08-05 15:40:58,商户消费,合成平台商户,合成订单-A,支出,0.90,合成信用卡(0001),交易关闭,SYNTH-TX-A1,SYNTH-ORDER-A,SYNTH-M-A,',
    // 支付宝式：退款行订单号是原单号加后缀。
    '2026-08-12 11:48:01,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.90,合成信用卡(0001),已退款¥0.90,SYNTH-TX-A2,SYNTH-ORDER-A_1234,SYNTH-M-A,'
  ]).join('\n')) })
  // 模拟规则更新前整理的旧草稿：快照里没有冲突标记。
  for (const event of value.events) event.reasonCodes = (event.reasonCodes || []).filter(code => code !== 'refund_source_conflict')
  const model = local.create(value)
  const refund = [...model.events.values()].find(event => event.economicNature === 'refund')
  assert.ok(refund.reasonCodes.includes('refund_source_conflict'), '本机应按同一规则补上冲突状态')
  assert.equal(refund.fieldSources.refundSourceConflict.originalEventIds.length, 1)
  const issue = [...model.issues.values()].find(row => row.subjectEventIds.includes(refund.eventId) && row.issueType === 'refund_relation')
  assert.equal(issue.primaryReasonCode, 'refund_source_conflict', '事项原因也要跟着改，列表标题才一致')
})
