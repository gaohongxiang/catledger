const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const tap = (dataset = {}) => ({ currentTarget: { dataset } })
const original = source => JSON.stringify([
  { name: '合成来源', value: source }, { name: '备注', value: '' },
  { name: '备注', value: '完整的合成补充说明' }, { name: '合成零值', value: 0 }
])

function completeOriginals(h) {
  h.intercept = (action, input) => action === 'economicEvents.detail'
    ? { protocolVersion: 2, viewVersion: h.summary.viewVersion, part: original(input.evidenceId), nextCursor: null } : undefined
}

test('非资金记录与其他已排除分组可以展开、收起，同页刷新不丢展开状态', async () => {
  const data = fixture(44)
  const reasons = ['source_non_financial', 'account_mapping_excluded', 'transaction_closed', 'transaction_failed', 'manual_exclusion', 'other_exclusion']
  data.events.forEach((row, index) => { row.status = 'excluded'; row.reasonCodes = [reasons[index % reasons.length]] })
  const h = runtime(data), page = h.page
  page.data.activeReviewStatus = 'excluded'
  await page.setStep({ currentStep: 3 })
  const requests = h.calls.length
  for (const group of [...page.data.excludedReviewGroups]) {
    page.toggleExcludedGroup(tap({ key: group.key }))
    await flush()
    const opened = page.data.excludedReviewGroups.find(row => row.key === group.key)
    assert.equal(opened.expanded, true, group.label)
    assert.equal(opened.events.length, opened.count)
  }
  assert.equal(h.calls.length, requests, '展开只使用已取得的当前页')
  assert.equal(page.data.excludedReviewGroups.reduce((sum, group) => sum + group.events.length, 0), 40)
  await page.loadActivePage(false, 0, true)
  assert.ok(page.data.excludedReviewGroups.every(group => group.expanded))
  const first = page.data.excludedReviewGroups[0]
  page.toggleExcludedGroup(tap({ key: first.key }))
  assert.equal(page.data.excludedReviewGroups[0].events.length, 0)
  await page.changeReviewPage(tap({ direction: 1 }))
  assert.ok(page.data.excludedReviewGroups.every(group => !group.expanded && !group.events.length))
  page.onUnload()
})

test('已核对交易进入查看即显示完整原始字段，换来源也自动读取', async () => {
  const h = runtime(fixture(1)), page = h.page
  completeOriginals(h)
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  await page.openEvidence(tap({ id: page.data.reviewedEvents[0].eventId }))
  assert.deepEqual(Array.from(page.data.evidenceSheet.partFields || [], field => [field.name, field.value]),
    [['合成来源', 'synthetic-evidence-0'], ['备注', ''], ['备注', '完整的合成补充说明'], ['合成零值', '0']])
  assert.equal(page.data.evidenceSheet.evidence.length, 1)
  await page.changeEvidencePage(tap({ direction: 1 }))
  assert.equal(page.data.evidenceSheet.partFields[0].value, 'synthetic-evidence-1')
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'synthetic-evidence-1')
  assert.equal(page.data.evidenceSheet.page.count, 17)
  assert.equal(h.calls.some(row => /resolve|\.post$/.test(row.action)), false)
  page.closeEvidence()
  assert.equal(page.data.evidenceSheet, null)
  page.onUnload()
})

for (const kind of ['待分类', '已分类', '无需分类', '已排除', '重复']) test(kind + '的共用查看入口直接展示原文', async () => {
  const data = fixture(1, kind === '待分类')
  if (kind === '待分类') data.issues[0].issueType = 'category_assignment'
  if (kind === '已排除') { data.events[0].status = 'excluded'; data.events[0].reasonCodes = ['source_non_financial'] }
  const h = runtime(data), page = h.page
  completeOriginals(h)
  const detail = h.intercept
  h.intercept = (action, input) => action === 'economicEvents.list' && input.status === 'duplicate'
    ? { protocolVersion: 2, viewVersion: 'v1', items: data.events, total: 1, nextCursor: null } : detail(action, input)
  if (['待分类', '已分类', '无需分类'].includes(kind)) {
    page.data.activeReviewTab = 'category'
    page.data.activeCategoryStatus = { 待分类: 'pending', 已分类: 'completed', 无需分类: 'none' }[kind]
  } else page.data.activeReviewStatus = kind === '已排除' ? 'excluded' : 'duplicate'
  await page.setStep({ currentStep: 3 })
  let row
  if (kind === '待分类') row = page.data.categoryCards[0].subjects[0]
  else if (kind === '已分类') row = page.data.categorizedEvents[0]
  else if (kind === '无需分类') row = page.data.noCategoryEvents[0]
  else if (kind === '重复') row = page.data.duplicateReviewEvents[0]
  else {
    page.toggleExcludedGroup(tap({ key: page.data.excludedReviewGroups[0].key }))
    row = page.data.excludedReviewGroups[0].events[0]
  }
  if (kind === '已分类' || kind === '无需分类') assert.ok(row.natureLabel && row.natureLabel !== 'undefined', kind + ' 行要展示性质标签')
  if (kind === '已分类') assert.ok(row.categoryName && row.categoryName !== 'undefined', '已分类行要展示分类名')
  await page.openEvidence(tap({ id: row.eventId }))
  assert.equal(page.data.evidenceSheet.partFields[0].value, 'synthetic-evidence-0')
  assert.equal(page.data.errorMessage, '')
  assert.equal(h.calls.some(row => /resolve|\.post$/.test(row.action)), false)
  page.onUnload()
})

test('重复标签切换只读取一次当前列表，完成后可以进入原文', async () => {
  const h = runtime(fixture(1)), page = h.page
  completeOriginals(h)
  const detail = h.intercept
  h.intercept = (action, input) => action === 'economicEvents.list' && input.status === 'duplicate'
    ? { protocolVersion: 2, viewVersion: 'v1', items: h.events, total: 1, nextCursor: null } : detail(action, input)
  await page.setStep({ currentStep: 3 })
  let reads = 0
  const load = page.loadActivePage
  page.loadActivePage = function (...args) { reads++; return load.apply(this, args) }
  await page.switchReviewStatus(tap({ status: 'duplicate' }))
  assert.equal(reads, 1)
  await page.openEvidence(tap({ id: page.data.duplicateReviewEvents[0].eventId }))
  assert.equal(page.data.evidenceSheet.partFields.length, 4)
  page.closeEvidence()
  await page.switchReviewTab(tap({ tab: 'category' }))
  reads = 0
  await page.switchReviewTab(tap({ tab: 'review' }))
  assert.equal(reads, 1)
  assert.equal(page.data.duplicateReviewEvents.length, 1)
  page.onUnload()
})

test('待核对第十份长原文在弹层保留来源位置，弹层翻页不移动卡片来源', async () => {
  const h = runtime(fixture(1, true)), page = h.page
  await flush()
  await page.openIssue(tap({ id: 'synthetic-issue' }))
  for (let i = 0; i < 9; i++) await page.changeInlineSource(tap({ scope: 'issue', id: 'synthetic-event-0', direction: 1 }))
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].evidenceId, 'synthetic-evidence-9')
  await page.openEvidence(tap({ id: 'synthetic-event-0', evidenceId: 'synthetic-evidence-9' }))
  assert.equal(page.data.evidenceSheet.page.start, 10)
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'synthetic-evidence-9')
  assert.ok(page.data.evidenceSheet.part)
  await page.changeEvidencePage(tap({ direction: 1 }))
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'synthetic-evidence-10')
  await page.changeEvidencePage(tap({ direction: -1 }))
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'synthetic-evidence-9')
  await page.changeEvidencePage(tap({ direction: 'first' }))
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'synthetic-evidence-0')
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].evidenceId, 'synthetic-evidence-9')
  assert.ok(page._evidencePager.historySize <= 8)
  page.closeEvidence()
  await page.changeInlineSource(tap({ scope: 'issue', id: 'synthetic-event-0', direction: 1 }))
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].evidenceId, 'synthetic-evidence-10')
  page.onUnload()
})

test('长原文逐段可读无遗漏，不把原文全集累积进页面', async () => {
  const h = runtime(fixture(1)), page = h.page
  const text = JSON.stringify([{ name: '合成长备注', value: '完整合成内容'.repeat(1000) }])
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.detail') return
    const offset = Number(input.cursor || 0), end = offset + 2048
    return { protocolVersion: 2, viewVersion: 'v1', part: text.slice(offset, end), nextCursor: end < text.length ? String(end) : null }
  }
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  await page.openEvidence(tap({ id: 'synthetic-event-0' }))
  const parts = [page.data.evidenceSheet.part]
  assert.equal(page.data.evidenceSheet.partFields.length, 0)
  while (page.data.evidenceSheet.partPage.hasNext) {
    await page.changeEvidencePart(tap({ direction: 1 }))
    assert.ok(page.data.evidenceSheet.part.length <= 2048)
    parts.push(page.data.evidenceSheet.part)
  }
  assert.equal(parts.join(''), text)
  assert.ok(h.maxDataBytes <= 262144)
  assert.ok(Math.max(...h.patches) <= 65536)
  await page.changeEvidencePart(tap({ direction: 'first' }))
  assert.equal(page.data.evidenceSheet.part, parts[0])
  page.onUnload()
})

test('原文与来源失败分别可原位重试，重试保持来源并且不写入决定', async () => {
  const h = runtime(fixture(1)), page = h.page
  let detailAttempts = 0, sourceAttempts = 0
  h.intercept = (action, input) => {
    if (action === 'economicEvents.detail') {
      if (++detailAttempts === 1) throw new Error('合成原文读取失败')
      return { protocolVersion: 2, viewVersion: 'v1', part: original(input.evidenceId), nextCursor: null }
    }
    if (action === 'economicEvents.evidence' && input.cursor === '1' && ++sourceAttempts === 1) throw new Error('合成来源读取失败')
  }
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  await page.openEvidence(tap({ id: 'synthetic-event-0' }))
  assert.match(page.data.evidenceSheet.partError, /合成原文读取失败/)
  assert.equal(page.data.evidenceSheet.partLoading, false)
  await page.changeEvidencePart(tap())
  assert.equal(page.data.evidenceSheet.partFields[0].value, 'synthetic-evidence-0')
  assert.equal(page.data.evidenceSheet.partError, '')
  await page.changeEvidencePage(tap({ direction: 1 }))
  assert.match(page.data.evidenceSheet.error, /合成来源读取失败/)
  assert.equal(page.data.evidenceSheet.part, '')
  await page.changeEvidencePage(tap())
  assert.equal(page.data.evidenceSheet.evidence[0].evidenceId, 'synthetic-evidence-1')
  assert.equal(page.data.evidenceSheet.partFields[0].value, 'synthetic-evidence-1')
  assert.equal(page.data.evidenceSheet.error, '')
  assert.equal(h.calls.some(row => /resolve|\.post$/.test(row.action)), false)
  page.onUnload()
})

test('换来源时旧原文的迟到响应不能覆盖新来源或显示旧错误', async () => {
  const h = runtime(fixture(1)), page = h.page
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  let release
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.detail') return
    if (input.evidenceId === 'synthetic-evidence-0') return new Promise(resolve => { release = resolve })
    return { protocolVersion: 2, viewVersion: 'v1', part: original(input.evidenceId), nextCursor: null }
  }
  const pending = page.openEvidence(tap({ id: 'synthetic-event-0' }))
  await flush()
  await page.changeEvidencePage(tap({ direction: 1 }))
  const before = JSON.stringify(page.data.evidenceSheet)
  release({ protocolVersion: 2, viewVersion: 'v1', part: original('synthetic-evidence-0'), nextCursor: null })
  await pending
  assert.equal(JSON.stringify(page.data.evidenceSheet), before)
  assert.equal(page.data.evidenceSheet.partFields[0].value, 'synthetic-evidence-1')
  assert.equal(page.data.errorMessage, '')
  page.onUnload()
})

for (const leave of ['closeEvidence', 'onHide', 'onUnload', 'session', 'version']) test(leave + '后迟到原文不回填也不报旧错误', async () => {
  const h = runtime(fixture(1)), page = h.page
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  let release
  h.intercept = action => action === 'economicEvents.detail' ? new Promise(resolve => { release = resolve }) : undefined
  const pending = page.openEvidence(tap({ id: 'synthetic-event-0' }))
  await flush()
  if (leave === 'session') h.cache.reset()
  else if (leave === 'version') page._viewSession.accept({ ...h.summary, viewVersion: 'v2' })
  else page[leave]()
  const patches = h.patches.length, before = JSON.stringify(page.data.evidenceSheet)
  release({ protocolVersion: 2, viewVersion: 'v1', part: original('synthetic-evidence-0'), nextCursor: null })
  await pending
  assert.equal(h.patches.length, patches)
  assert.equal(JSON.stringify(page.data.evidenceSheet), before)
  assert.equal(page.data.errorMessage, '')
  if (leave !== 'onUnload') page.onUnload()
})

test('查看原文期间后台摘要延迟应用，关闭后才更新列表版本', async () => {
  const h = runtime(fixture(1)), page = h.page
  completeOriginals(h)
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  await page.openEvidence(tap({ id: 'synthetic-event-0' }))
  h.summary = { ...h.summary, viewVersion: 'v2' }
  page.applyUpdateView(h.summary, true)
  assert.equal(page._viewSession.summary.viewVersion, 'v1')
  assert.equal(page.data.evidenceSheet.partFields[0].value, 'synthetic-evidence-0')
  page.closeEvidence()
  await flush()
  assert.equal(page._viewSession.summary.viewVersion, 'v2')
  assert.equal(page.data.evidenceSheet, null)
  assert.equal(page.data.reviewedEvents.length, 1)
  page.onUnload()
})
