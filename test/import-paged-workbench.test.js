const test = require('node:test')
const assert = require('node:assert/strict')
const { create, MAX_PAGES, MAX_HISTORY } = require('../miniprogram/services/import-view-session')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const event = (direction, id) => ({ currentTarget: { dataset: { direction, id } } })

test('原文整段按源字段展示，重复列与空值不丢；不拼接或解析跨页片段', () => {
  const { evidencePartFields } = require('../miniprogram/pages/import-workbench/presentation')
  const part = JSON.stringify([{ name: '备注', value: '', column: 1 }, { name: '备注', value: '第二列原文', column: 2 }, { name: '金额', value: '0', column: 3 }])
  const fields = evidencePartFields(part, { index: 0, hasNext: false })
  assert.deepEqual(fields.map(field => field.value), ['', '第二列原文', '0'])
  assert.equal(new Set(fields.map(field => field.key)).size, 3)
  assert.deepEqual(evidencePartFields(part, { index: 0, hasNext: true }), [])
  assert.deepEqual(evidencePartFields(part, { index: 1, hasNext: false }), [])
  assert.deepEqual(evidencePartFields('{', { index: 0, hasNext: false }), [])
})

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
    if (action === 'financeUpdates.post') { posted = true; assert.equal(Object.hasOwn(input, 'resultMode'), false); return { kind: 'operation-receipt', update: { ...h.summary.update, status: 'posted', version: 2 } } }
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

test('准备直接提交当前命令再读摘要，不探测能力或发送模式字段', async () => {
  const h = runtime()
  h.intercept = action => action === 'financeUpdates.prepare' ? { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update } : undefined
  await h.page.request('financeUpdates.prepare', { requestId: 'synthetic-prepare', batchIds: ['synthetic-batch'] })
  assert.deepEqual(h.calls.map(row => row.action), ['financeUpdates.prepare', 'financeUpdates.summary'])
  assert.equal(Object.hasOwn(h.calls[0].input, 'resultMode'), false)
  h.page.onUnload()
})

test('准备成功但摘要失败仍保留批次与成功事实，不重新prepare', async () => {
  const h = runtime()
  h.intercept = action => {
    if (action === 'financeUpdates.prepare') return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update }
    if (action === 'financeUpdates.summary') throw new Error('合成摘要失败')
  }
  const result = await h.page.request('financeUpdates.prepare', { requestId: 'synthetic-prepare', batchIds: ['synthetic-batch'] })
  h.page.applyUpdateView(result)
  assert.equal(h.page.data.update.updateId, h.summary.update.updateId)
  assert.equal(h.page.data.refreshRequired, true)
  assert.equal(h.calls.filter(row => row.action === 'financeUpdates.prepare').length, 1)
  h.page.onUnload()
})

for (const close of ['closeIssue', 'onHide', 'onUnload']) test(close + '后迟到的问题成员不回填或恢复弹层', async () => {
  const h = runtime(fixture(121, true)), page = h.page
  await page.openIssue(event(0, 'synthetic-issue'))
  let release
  h.intercept = (action, input) => action === 'reviewIssues.members' && input.memberKind === 'event'
    ? new Promise(resolve => { release = resolve }) : undefined
  const next = page.changeIssueMembers(event(1))
  await flush(); page[close]()
  release({ protocolVersion: 2, viewVersion: 'v1', items: [{ event: h.events[8] }], total: 121 })
  await next
  if (close === 'onUnload') {
    assert.equal(page._viewSession, null)
    assert.equal(page.data.issueVisibleEvents.some(row => row.eventId === 'synthetic-event-8'), false)
  } else {
    assert.equal(page.data.currentIssue, null)
    assert.equal(page.data.issueVisibleEvents.length, 0)
  }
  if (close !== 'onUnload') page.onUnload()
})

test('后台摘要更新在输入和核对弹层期间延迟应用，不重新下发表单', async () => {
  const h = runtime(fixture(2, true)), page = h.page
  await page.openIssue(event(0, 'synthetic-issue'))
  page.beginInputEditing({ currentTarget: { dataset: { id: 'note' } } })
  page.data.issueDraft.note = '刚输入的合成备注'
  const before = JSON.stringify(page.data.issueDraft), patches = h.patches.length
  page.applyUpdateView({ ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }, true)
  assert.equal(JSON.stringify(page.data.issueDraft), before)
  assert.equal(h.patches.length, patches)
  page.finishInputEditing()
  assert.equal(JSON.stringify(page.data.issueDraft), before)
  page.closeIssue()
  await flush()
  assert.equal(page.data.update.version, 2)
  page.onUnload()
})

test('成员翻页只换展示集合，已填表单、组版本与完整组选择保持', async () => {
  const h = runtime(fixture(121, true)), page = h.page
  await page.openIssue(event(0, 'synthetic-issue'))
  page.data.issueDraft.note = '合成待保存输入'
  const issueVersion = page.data.currentIssue.version
  await page.changeIssueMembers(event(1))
  assert.equal(page.data.issueDraft.note, '合成待保存输入')
  assert.equal(page.data.currentIssue.version, issueVersion)
  await page.excludeIssueEvents()
  assert.deepEqual(page._draftSession.state.entries[0].decision.selection, { mode: 'all' })
  assert.equal(page._draftSession.state.entries[0].issueVersion, issueVersion)
  page.onUnload()
})

test('当前页读取失败可重试，失败不伪造空批次或修改整批计数', async () => {
  const h = runtime(fixture(121)), page = h.page
  page.data.activeReviewStatus = 'completed'
  h.intercept = action => { if (action === 'economicEvents.list') throw new Error('合成暂时失败') }
  await page.setStep({ currentStep: 3 })
  assert.match(page.data.pageError, /合成暂时失败/)
  assert.equal(page.data.recordSummary.totalCount, 121)
  h.intercept = null
  await page.loadActivePage(true)
  assert.equal(page.data.reviewedEvents.length, 40)
  assert.equal(page.data.recordSummary.totalCount, 121)
  page.onUnload()
})

for (const status of ['pending', 'completed', 'none']) test('分类' + status + '按当前筛选请求，搜索不重算整批数量', async () => {
  const h = runtime(fixture(121)), page = h.page
  page.data.activeReviewTab = 'category'; page.data.activeCategoryStatus = status; page.data.categoryQuery = '合成后页'
  const before = JSON.stringify(page.data.categoryStatusTabs)
  await page.setStep({ currentStep: 3 })
  const request = h.calls.find(row => row.input.query === '合成后页')
  assert.ok(request)
  assert.equal(request.action, status === 'pending' ? 'reviewIssues.list' : 'economicEvents.list')
  if (status !== 'pending') assert.equal(request.input.view, 'category_' + status)
  assert.equal(JSON.stringify(page.data.categoryStatusTabs), before)
  page.onUnload()
})

test('原始证据读取失败可原位重试，不修改决定，关闭后不保留原文', async () => {
  const h = runtime(), page = h.page
  let attempts = 0
  h.intercept = action => {
    if (action === 'economicEvents.evidence' && ++attempts === 1) throw new Error('合成证据超时')
  }
  await page.openEvidence(event(0, 'synthetic-event-0'))
  assert.ok(page.data.evidenceSheet)
  await page.changeEvidencePage(event(0))
  assert.equal(page.data.evidenceSheet.evidence.length, 8)
  assert.equal(h.calls.some(row => /^reviewIssues.resolve|financeUpdates.post/.test(row.action)), false)
  page.closeEvidence()
  assert.equal(page.data.evidenceSheet, null)
  page.onUnload()
})

test('活动工作台重入回第一步，已入账结果保持完成页', async () => {
  for (const status of ['review', 'posted']) {
    const data = fixture(121)
    data.summary.update.status = status
    const h = runtime(data), page = h.page
    page.applyUpdateView(h.summary, false, true)
    assert.equal(page.data.currentStep, status === 'review' ? 1 : 4)
    assert.equal(page.data.phase, status === 'posted' ? 'done' : 'review')
    page.onUnload()
  }
})
