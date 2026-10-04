const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const input = value => ({ detail: { value }, currentTarget: { dataset: {} } })
async function enter(page, handler, value) {
  assert.equal(page[handler](input(value)), undefined, '原生输入事件不能返回异步读取结果来替换输入文本')
  await flush()
}

for (const status of ['pending', 'completed', 'excluded', 'duplicate']) {
  test('交易核对 ' + status + ' 搜索读取整批匹配、重置分页并保留总数', async () => {
    const data = fixture(125, status === 'pending')
    if (status === 'pending') data.issues = data.events.map((event, index) => ({ ...data.issues[0], issueId: 'synthetic-issue-' + index, subject: event, memberCount: 1 }))
    if (status === 'excluded') data.events.forEach(event => { event.status = 'excluded'; event.reasonCodes = ['manual_exclusion'] })
    const h = runtime(data), page = h.page
    page.setData({ activeReviewStatus: status, categoryQuery: '分类独立词' })
    await page.setStep({ currentStep: 3 })
    const totals = JSON.stringify(page.data.recordSummary)
    await page.changeReviewPage({ currentTarget: { dataset: { direction: '1' } } })
    const target = status === 'pending' ? h.issues.at(-1) : status === 'excluded'
      ? { groupId: 'synthetic-search-group', label: '合成账户已排除', count: 1, note: '合成搜索结果' } : h.events.at(-1)
    h.intercept = (action, query) => query.query === '2026-10-03' ? {
      protocolVersion: 2, viewVersion: 'v1', items: [target], total: 1, nextCursor: null
    } : undefined
    await enter(page, 'searchReviewIssues', '2026-10-03')
    assert.equal(page.data.reviewPage.index, 0)
    assert.equal(page.data.reviewPage.count, 1)
    const request = h.calls.at(-1)
    assert.equal(request.input.query, '2026-10-03')
    assert.ok(!request.input.cursor)
    if (status === 'pending') {
      assert.equal(request.action, 'reviewIssues.list')
      assert.equal(request.input.group, 'review')
      assert.equal(page.data.reviewGroups[0].issues[0].issueId, target.issueId)
    } else {
      assert.equal(request.action, 'economicEvents.list')
      assert.equal(['completed', 'excluded'].includes(status) ? request.input.view : request.input.status,
        status === 'completed' ? 'review_completed' : status === 'excluded' ? 'excluded_groups' : status)
    }
    assert.equal(JSON.stringify(page.data.recordSummary), totals)
    assert.equal(page.data.categoryQuery, '分类独立词')
    await enter(page, 'searchReviewIssues', '')
    assert.equal(page.data.reviewPage.index, 0)
    assert.equal(page.data.reviewQuery, '')
    page.onUnload()
  })
}

test('核对与分类搜索互不串词，旧搜索迟到不能覆盖新结果', async () => {
  const h = runtime(fixture(125)), page = h.page
  page.setData({ activeReviewStatus: 'completed' })
  await page.setStep({ currentStep: 3 })
  let release
  h.intercept = (action, query) => query.query === '旧词' ? new Promise(resolve => { release = resolve })
    : query.query === '新词' ? { protocolVersion: 2, viewVersion: 'v1', items: [h.events[124]], total: 1, nextCursor: null } : undefined
  await enter(page, 'searchReviewIssues', '旧词')
  await enter(page, 'searchReviewIssues', '新词')
  release({ protocolVersion: 2, viewVersion: 'v1', items: [h.events[0]], total: 1, nextCursor: null }); await flush()
  assert.equal(page.data.reviewedEvents[0].eventId, h.events[124].eventId)
  await page.switchReviewTab({ currentTarget: { dataset: { tab: 'category' } } })
  await enter(page, 'searchCategoryIssues', '10月3日')
  assert.equal(h.calls.at(-1).input.query, '10月3日')
  await page.switchReviewTab({ currentTarget: { dataset: { tab: 'review' } } })
  assert.equal(page.data.reviewQuery, '新词')
  assert.equal(page.data.categoryQuery, '10月3日')
  assert.equal(page.data.reviewedEvents[0].eventId, h.events[124].eventId)
  page.onUnload()
})

test('搜索中的背景更新保留输入；隐藏、卸载和会话变化隔离迟到响应', async () => {
  for (const leave of ['onHide', 'onUnload', 'session']) {
    const h = runtime(fixture(2)), page = h.page
    page.setData({ activeReviewStatus: 'completed' }); await page.setStep({ currentStep: 3 })
    page.beginInputEditing({ currentTarget: { dataset: { inputKey: 'searchReviewIssues' } } })
    await enter(page, 'searchReviewIssues', '2026-10')
    await page.applyUpdateView({ ...h.summary, viewVersion: 'v2' }, true)
    assert.equal(page._viewSession.summary.viewVersion, 'v1')
    assert.equal(page.data.reviewQuery, '2026-10')
    let release
    h.intercept = () => new Promise(resolve => { release = resolve })
    await enter(page, 'searchReviewIssues', '10-03')
    if (leave === 'session') h.cache.reset()
    else page[leave]()
    const before = JSON.stringify(page.data)
    release({ protocolVersion: 2, viewVersion: 'v1', items: [], total: 0, nextCursor: null }); await flush()
    assert.equal(JSON.stringify(page.data), before)
    page.onUnload()
  }
})

for (const tab of ['review', 'category']) {
  test(tab + ' 原生搜索连续输入、退格和清空保持文本与筛选一致', async t => {
    const h = runtime(fixture(2)), page = h.page
    t.after(() => page.onUnload())
    page.setData({ activeReviewTab: tab, activeReviewStatus: 'completed', activeCategoryStatus: 'completed' })
    await page.setStep({ currentStep: 3 })
    h.intercept = (action, query) => action === 'economicEvents.list' ? {
      protocolVersion: 2, viewVersion: 'v1', items: query.query ? [h.events[1]] : h.events,
      total: query.query ? 1 : 2, nextCursor: null
    } : undefined
    const handler = tab === 'review' ? 'searchReviewIssues' : 'searchCategoryIssues'
    const field = tab === 'review' ? 'reviewQuery' : 'categoryQuery'
    for (const value of ['2', '20', '2026-10-03', '2026-10-0', '', '美', '美食', '美', '']) {
      await enter(page, handler, value)
      assert.equal(page.data[field], value)
      assert.ok(h.calls.some(call => call.action === 'economicEvents.list' && (call.input.query || '') === value))
      assert.equal(page.data.reviewPage.count, value ? 1 : 2)
      assert.equal(page.data.pageLoading, false)
      assert.equal(page.data.pageError, '')
    }
  })
}

for (const kind of ['accountChoice', 'directory']) {
  test(kind + ' 弹层搜索输入不被异步结果替换，迟到响应不回填', async t => {
    const h = runtime(fixture(2)), page = h.page
    t.after(() => page.onUnload())
    await flush()
    const handler = kind === 'accountChoice' ? 'bindAccountChoiceSearch' : 'searchDirectory'
    let release
    const matching = { accountId: 'synthetic-result', categoryId: 'synthetic-result', name: '合成名称', kind: 'expense', type: 'wallet' }
    h.intercept = (action, query) => action !== 'financeUpdates.options' ? undefined : query.query === '旧词'
      ? new Promise(resolve => { release = resolve })
      : { protocolVersion: 2, viewVersion: 'v1', items: query.query ? [matching] : [], total: query.query ? 1 : 0, nextCursor: null }
    if (kind === 'accountChoice') page.setData({ accountChoiceSheet: { issueId: 'synthetic-issue' }, choiceKind: 'accounts' })
    else await page.openDirectory({ currentTarget: { dataset: { target: 'category' } } })
    await enter(page, handler, '旧词')
    for (const value of ['合', '合成', '合', '']) {
      await enter(page, handler, value)
      assert.equal(kind === 'accountChoice' ? page.data.accountChoiceQuery : page.data.directorySheet.query, value)
      assert.ok(h.calls.some(call => call.action === 'financeUpdates.options' && (call.input.query || '') === value))
      const rows = kind === 'accountChoice' ? page.data.accountChoiceResults : page.data.directorySheet.items
      assert.equal(rows.length, value ? 1 : 0)
      if (value) assert.equal(rows[0].name, matching.name)
      if (kind === 'accountChoice') assert.equal(page.data.choiceLoading, false)
      else assert.equal(page.data.directorySheet.loading, false)
    }
    const before = JSON.stringify(page.data)
    release({ protocolVersion: 2, viewVersion: 'v1', items: [matching], total: 1, nextCursor: null }); await flush()
    assert.equal(JSON.stringify(page.data), before)
  })
}
