const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture } = require('./helpers/paged-workbench')
const model = require('../miniprogram/pages/import-workbench/model')
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
  test('银行渠道同笔候选保留' + sourceType + '的' + economicNature + '语义，拦截银行主记录并允许改回后保存', async () => {
    const data = channelFixture(2, sourceType, economicNature, reasonField)
    const h = runtime(data), page = h.page
    await page.openIssue(tap('synthetic-issue'))
    assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-1')
    assert.equal(page.data.issueVisibleEvents.length, 2)
    assert.equal(page.data.currentIssue.canConfirmSame, true)
    assert.match(page.data.currentIssue.reasonText, /同一账户、同金额、同一分钟且银行渠道吻合/)
    assert.equal(page._draftSession.state.entries.length, 0, '默认选中不会自动确认同一笔')
    page.selectPrimaryMember(tap('synthetic-event-0'))
    page.confirmSame()
    assert.equal(page._draftSession.state.entries.length, 0, '无效选择不进入待同步草稿')
    assert.equal(page.data.currentIssue.issueId, 'synthetic-issue')
    assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-0', '错误时保留当前选择')
    assert.match(page.data.errorMessage, /微信或支付宝.*支出或退款/)
    assert.equal(page.data.issueFieldsReason, page.data.errorMessage, '当前弹层的保存提示必须显示校验错误')
    assert.equal(page.data.issueFieldsCanSave, false)
    page.selectPrimaryMember(tap('synthetic-event-1'))
    page.confirmSame()
    assert.equal(page._draftSession.state.entries[0].decision.primaryEventId, 'synthetic-event-1')
    assert.equal(page.data.errorMessage, '', '修正后保存成功不残留错误')
    await page.openIssue(tap('synthetic-issue'))
    assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-1', '重新打开保留有效用户草稿')
    page.onUnload()
  })
}

for (const [sourceType, economicNature] of [['wechat', 'unknown'], ['alipay', 'income'], ['other', 'expense']]) {
  test('银行渠道同笔候选拒绝语义不合适的主记录：' + sourceType + '/' + economicNature, async () => {
    const h = runtime(channelFixture(2, sourceType, economicNature)), page = h.page
    await page.openIssue(tap('synthetic-issue'))
    page.selectPrimaryMember(tap('synthetic-event-1'))
    page.confirmSame()
    assert.equal(page._draftSession.state.entries.length, 0)
    assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-1')
    assert.match(page.data.errorMessage, /微信或支付宝.*支出或退款/)
    page.onUnload()
  })
}

test('银行渠道多笔候选不能整组合并，手动选择仍按已有草稿恢复', async () => {
  const h = runtime(channelFixture(3)), page = h.page
  await page.openIssue(tap('synthetic-issue'))
  assert.equal(page.data.currentIssue.canConfirmSame, false)
  assert.match(page.data.currentIssue.reasonText, /多笔候选.*核对/)
  page.selectPrimaryMember(tap('synthetic-event-2'))
  page.confirmSame()
  assert.equal(page._draftSession.state.entries.length, 0)
  assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-2')
  assert.match(page.data.errorMessage, /多笔候选.*核对/)
  page.confirmDistinct()
  await page.openIssue(tap('synthetic-issue'))
  assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-2', '已有用户草稿优先于默认平台记录')
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
  page.confirmSame()
  assert.equal(page._draftSession.state.entries[0].decision.primaryEventId, 'synthetic-event-0')
  page.onUnload()
})
