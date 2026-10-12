const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture } = require('./helpers/paged-workbench')
const { setup, pair, tap: choosePair } = require('./helpers/pairing-workbench')
const model = require('../miniprogram/packages/finance/pages/import-workbench/model')
const tap = id => ({ currentTarget: { dataset: { id } } })

function channelFixture(count = 2, sourceType = 'wechat', economicNature = 'expense', reasonField = 'primaryReasonCode') {
  const data = fixture(count, true)
  data.issues[0][reasonField] = reasonField === 'reasonCodes' ? ['bank_channel_same_event_candidate'] : 'bank_channel_same_event_candidate'
  data.issues[0].candidateCount = count - 1
  data.events[0].economicNature = 'unknown'
  data.events[0].primaryEvidence.sourceType = 'bank'
  data.events[1].economicNature = economicNature
  data.events[1].primaryEvidence.sourceType = sourceType
  return data
}

for (const [sourceType, economicNature, reasonField] of [['wechat', 'expense', 'primaryReasonCode'], ['alipay', 'refund', 'reasonCodes']]) {
  test('银行渠道候选直接进入具体配对，保留' + sourceType + '的' + economicNature + '语义且不要求选择主记录', async () => {
    const data = channelFixture(2, sourceType, economicNature, reasonField)
    const h = setup(1, data), page = h.page
    h.pairs[0].platform.sourceType = sourceType; h.pairs[0].economicNature = economicNature
    await page.setStep({ currentStep: 3 })
    const card = page.data.reviewGroups[0].issues[0]
    const detailReads = h.calls.filter(call => call.action === 'reviewIssues.get').length
    await page.openPendingRecord({ currentTarget: { dataset: { id: card.eventId, issueId: card.issueId } } })
    assert.equal(page.data.reviewEditSheet, null, '点待核对卡片不经过普通编辑页或二次入口')
    assert.equal(page.data.currentIssue, null)
    assert.equal(page.data.pairingSheet.title, '判断是否同一笔')
    assert.equal(page.data.pairingSheet.issueId, card.issueId)
    assert.equal(page.data.pairingSheet.mode, 'ambiguous')
    assert.equal(page.data.pairingRows[0].natureLabel, economicNature === 'refund' ? '退款' : '消费')
    assert.equal(h.calls.filter(call => call.action === 'reviewIssues.get').length, detailReads, '已有摘要直接路由，不先拉旧整组详情')
    assert.equal(page._draftSession.state.entries.length, 0)
    page.selectPairing(choosePair('pair-0', 'same'))
    await page.confirmPairings()
    const command = h.calls.find(call => call.action === 'reviewIssues.resolvePairings')
    assert.deepEqual(command.input.selection.pairs, [{ pairKey: 'pair-0', decision: 'same' }])
    assert.equal('primaryEventId' in command.input, false)
    page.onUnload()
  })
}

for (const [sourceType, economicNature] of [['wechat', 'unknown'], ['alipay', 'income'], ['other', 'expense']]) {
  test('旧调用边界仍拒绝语义不合适的银行渠道主记录：' + sourceType + '/' + economicNature, async () => {
    const data = channelFixture(2, sourceType, economicNature), h = runtime(data), page = h.page
    page.setData({ currentIssue: model.issueView(data.issues[0]), currentMembers: data.events.map(event => ({ event })),
      'issueDraft.primaryEventId': 'synthetic-event-1' })
    await page.confirmSame()
    assert.equal(page._draftSession.state.entries.length, 0)
    assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-1')
    assert.match(page.data.errorMessage, /微信或支付宝.*支出或退款/)
    page.onUnload()
  })
}

test('银行渠道多候选必须选具体边，关闭后保留未提交的跨页选择', async () => {
  const h = setup(2, channelFixture(3)), page = h.page
  h.pairs = [pair('a'), pair('b')]
  h.pairs.forEach(row => { row.bank.eventId = 'synthetic-event-0' })
  await page.openIssue(tap('synthetic-issue'))
  assert.equal(page.data.currentIssue, null)
  assert.equal(page.data.pairingSelectedCount, 0)
  await page.confirmSame()
  assert.equal(page._draftSession.state.entries.length, 0)
  page.selectPairing(choosePair('pair-a', 'same'))
  await page.changePairingPage({ currentTarget: { dataset: { direction: 1 } } })
  assert.equal(page.data.pairingRows[0].occupied, true)
  page.closePairingReview()
  await page.openIssue(tap('synthetic-issue'))
  assert.equal(page.data.pairingRows[0].decision, 'same')
  await page.changePairingPage({ currentTarget: { dataset: { direction: 1 } } })
  assert.equal(page.data.pairingRows[0].occupied, true)
  assert.equal(page._draftSession.state.entries.length, 0, '关闭不是确认、拒绝或排除')
  page.onUnload()
})

test('两笔渠道候选附带退款关系时，不把关系成员当作第三笔交易', () => {
  const data = channelFixture(2, 'alipay', 'refund')
  data.issues[0].memberCount = 3
  const issue = model.issueView(data.issues[0])
  assert.equal(issue.canConfirmSame, true)
  assert.match(issue.reasonText, /同一账户、同金额、同一分钟且银行渠道吻合/)
  assert.doesNotMatch(issue.reasonText, /多笔候选/)
})

test('其他同笔问题保持原有主记录默认选择', async () => {
  const data = fixture(2, true)
  data.events[0].economicNature = 'unknown'
  data.events[0].primaryEvidence.sourceType = 'bank'
  const h = runtime(data), page = h.page
  await page.openIssue(tap('synthetic-issue'))
  assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-0')
  assert.equal(page.data.issueEvents.length, 1)
  assert.equal(page.data.currentIssue.canConfirmSame, true)
  await page.confirmSame()
  assert.equal(page._draftSession.state.entries[0].decision.primaryEventId, 'synthetic-event-0')
  page.onUnload()
})

test('同笔关系页的查看并修改本笔仍进入选中事件的编辑页', async t => {
  const h = runtime(fixture(2, true)), page = h.page
  t.after(() => page.onUnload())
  await page.setStep({ currentStep: 3 })
  const card = page.data.reviewGroups[0].issues[1]
  await page.openPendingRecord({ currentTarget: { dataset: { id: card.eventId, issueId: card.issueId } } })
  assert.equal(page.data.currentIssue.issueId, card.issueId)
  assert.equal(page.data.reviewEditSheet, null)
  await page.openPendingRecord({ currentTarget: { dataset: { id: card.eventId, issueId: card.issueId } } })
  assert.equal(page.data.currentIssue, null)
  assert.equal(page.data.reviewEditSheet.eventId, card.eventId)
  assert.equal(page.data.reviewEditSheet.loading, false)
  assert.equal(page.data.reviewEditSheet.error, '')
})
