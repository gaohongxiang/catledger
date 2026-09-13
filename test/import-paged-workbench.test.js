const test = require('node:test')
const assert = require('node:assert/strict')
const { create, MAX_PAGES, MAX_HISTORY } = require('../miniprogram/services/import-view-session')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const event = (direction, id) => ({ currentTarget: { dataset: { direction, id } } })

test('24990条：先摘要、按页读取，活动状态与缓存不保留批次全集', async () => {
  const h = runtime(fixture(24990)), page = h.page
  assert.equal(h.calls.length, 0)
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  assert.equal(page.data.reviewedEvents.length, 40)
  assert.equal(page.data.recordSummary.totalCount, 24990)
  for (let i = 0; i < 20; i++) await page.changeReviewPage(event(1))
  assert.equal(page.data.reviewPage.index, 20)
  assert.ok(page._viewSession.pageCount <= MAX_PAGES)
  assert.ok(page._mainPager.historySize <= MAX_HISTORY)
  assert.ok(page._viewSession.cachedItems <= 120)
  assert.equal(page.businessData().events.length, 40)
  assert.equal(page._draftSession.view.events, undefined)
  const before = JSON.stringify(h.derives), reads = h.calls.length
  page._draftSession.enqueue([{ kind: 'review', issueId: 'synthetic-issue', issueVersion: 1, decision: { decision: 'confirm_distinct' } }])
  assert.equal(JSON.stringify(h.derives), before)
  assert.equal(h.calls.length, reads)
  assert.ok(Math.max(...h.patches) <= 65536)
  assert.ok(h.maxDataBytes <= 262144)
  await page.changeReviewPage(event('first'))
  assert.equal(page.data.reviewPage.start, 1)
  page.onUnload()
})

test('121条跨页无遗漏；最后一页仍显示整批数量和金额', async () => {
  const h = runtime(fixture()), page = h.page
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  const ids = page.data.reviewedEvents.map(row => row.eventId)
  while (page.data.reviewPage.hasNext) { await page.changeReviewPage(event(1)); ids.push(...page.data.reviewedEvents.map(row => row.eventId)) }
  assert.equal(new Set(ids).size, 121)
  assert.equal(page.data.reviewPage.end, 121)
  await page.setStep({ currentStep: 4 })
  assert.equal(page.data.finalSummary.expenseText, '¥121.00')
  await page.openFinalDetail({ currentTarget: { dataset: { kind: 'expense' } } })
  while (page.data.finalDetailSheet.page.hasNext) await page.changeFinalPage(event(1))
  assert.equal(page.data.finalDetailSheet.records.length, 1)
  assert.equal(page.data.finalDetailSheet.count, 121)
  page.onUnload()
})

test('隐藏成员控制门禁；组操作独立于可见成员，证据与原文分段有界', async () => {
  const h = runtime(fixture(121, true)), page = h.page
  await flush()
  assert.equal(page.data.openIssueCount, 1)
  assert.equal(page.data.reviewStatusTabs[0].count, 121)
  await page.openIssue(event(0, 'synthetic-issue'))
  assert.ok(page.data.currentIssue, page.data.errorMessage)
  assert.equal(page.data.issueVisibleEvents.length, 8)
  assert.equal(page.data.memberPage.count, 121)
  await page.changeIssueMembers(event(1))
  assert.equal(page.data.issueVisibleEvents[0].eventId, 'synthetic-event-8')
  await page.openEvidence(event(0, 'synthetic-event-8'))
  await page.changeEvidencePage(event(1))
  assert.equal(page.data.evidenceSheet.evidence.length, 8)
  await page.openEvidencePart(event(0, 'synthetic-evidence-8'))
  for (let i = 0; i < 12; i++) await page.changeEvidencePart(event(1))
  assert.ok(page.data.evidenceSheet.part.length < 4096)
  assert.ok(page._detailPager.historySize <= MAX_HISTORY)
  page.closeEvidence()
  await page.excludeIssueEvents()
  const entry = page._draftSession.state.entries[0]
  assert.deepEqual(entry.decision.selection, { mode: 'all' })
  assert.equal(entry.decision.eventIds, undefined)
  assert.equal(entry.issueVersion, 1)
  assert.equal(page.data.openIssueCount, 1)
  assert.ok(h.maxDataBytes <= 262144)
  page.onUnload()
})

test('关闭弹层、离开页面、版本变化后迟到响应不回填或混页', async () => {
  const h = runtime(), page = h.page
  let release
  h.intercept = action => action === 'economicEvents.evidence' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = page.openEvidence(event(0, 'synthetic-event-0'))
  await flush(); page.closeEvidence()
  release({ protocolVersion: 2, viewVersion: 'v1', items: [], total: 0, nextCursor: null })
  await pending
  assert.equal(page.data.evidenceSheet, null)
  const session = create(async () => ({ protocolVersion: 2, viewVersion: 'v1', items: [], total: 0 }), h.summary)
  const pager = session.pager('economicEvents.list', {})
  session.accept({ ...h.summary, viewVersion: 'v2' })
  await assert.rejects(pager.load(1), { code: 'STALE_VIEW' })
  page.onUnload()
  assert.equal(page._viewSession, null)
})

test('提交成功后摘要失败保留已入账；不生成第二次入账命令', async () => {
  const h = runtime(), page = h.page
  let posted = false
  h.intercept = (action, input) => {
    if (action === 'financeUpdates.post') { posted = true; assert.equal(input.resultMode, 'receipt'); return { kind: 'operation-receipt', update: { ...h.summary.update, status: 'posted', version: 2 } } }
    if (action === 'financeUpdates.summary' && posted) throw new Error('合成读取超时')
  }
  await page.postUpdate()
  assert.equal(page.data.phase, 'done')
  assert.equal(page.data.errorMessage, '已入账，明细待刷新')
  await page.postUpdate()
  assert.equal(h.calls.filter(call => call.action === 'financeUpdates.post').length, 1)
  page.onUnload()
})

test('目录可搜索到首页之外的账户，改变选择后保持对象ID；长字段预览不撑大弹层', async () => {
  const data = fixture(121, true)
  data.events.forEach(row => { row.primaryEvidence.item = '合成超长文本'.repeat(1500) })
  const h = runtime(data), page = h.page
  await flush()
  await page.openIssue(event(0, 'synthetic-issue'))
  assert.ok(page.data.currentIssue, page.data.errorMessage)
  assert.ok(h.maxDataBytes <= 262144)
  assert.ok(Math.max(...h.patches) <= 65536)
  h.intercept = (action, input) => action === 'financeUpdates.options' && input.query === '后页账户'
    ? { protocolVersion: 2, viewVersion: 'v1', items: [{ accountId: 'synthetic-last-account', name: '后页账户', type: 'bank' }], total: 1 } : undefined
  await page.openDirectory({ currentTarget: { dataset: { target: 'account' } } })
  await page.searchDirectory({ detail: { value: '后页账户' }, currentTarget: { dataset: {} } })
  page.selectDirectory({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'synthetic-last-account')
  const chosen = page.data.issueDraft.accountIndex
  await page.changeIssueMembers(event(1))
  assert.equal(page.data.issueDraft.accountIndex, chosen)
  assert.equal(page.data.accountChoices[chosen].accountId, 'synthetic-last-account')
  page.onUnload()
})
