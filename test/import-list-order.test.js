const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/import-workbench/model')
const { runtime, fixture } = require('./helpers/paged-workbench')
const at = day => '2026-09-' + String(day).padStart(2, '0') + ' 10:00:00.000'
const event = (id, day) => ({ eventId: id, localAt: day ? at(day) : null, status: 'ready', economicNature: 'expense',
  amountMinor: '100', flowDirection: 'outflow', primaryEvidence: { item: '合成商品', counterparty: id } })

test('待核对按时间穿插类型，一组取最早成员，组内排序且重复类型有唯一键', () => {
  const rows = [
    { issueId: 'late', issueType: 'refund_relation', subject: event('late', 8) },
    { issueId: 'middle', issueType: 'same_event', subjects: [event('m2', 7), event('m1', 3)] },
    { issueId: 'early', issueType: 'refund_relation', subject: event('early', 1) },
    { issueId: 'unknown', issueType: 'field_conflict', subject: event('unknown') }
  ]
  const groups = model.reviewIssueGroups(rows)
  assert.deepEqual(groups.flatMap(g => g.issues.map(i => i.issueId)), ['early', 'middle', 'late', 'unknown'])
  assert.equal(new Set(groups.map(g => g.key)).size, groups.length)
  assert.deepEqual(groups[1].issues[0].subjects.map(e => e.eventId), ['m1', 'm2'])
  assert.equal(rows[1].subjects[0].eventId, 'm2', '排序不改变用于保存的原成员集合')
})

test('待分类按时间而不是商户；已排除同原因合并，组内日期递增', () => {
  const cards = model.categoryIssueCards([
    { issueId: 'first', issueType: 'category_assignment', subject: event('Z商户', 1) },
    { issueId: 'second', issueType: 'category_assignment', subject: event('A商户', 2) }
  ], '')
  assert.deepEqual(cards.map(c => c.issueId), ['first', 'second'])
  const events = [event('late', 3), event('middle', 2), event('early', 1)].map(e => ({ ...e, status: 'excluded',
    reasonCodes: [e.eventId === 'middle' ? 'transaction_failed' : 'manual_exclusion'] }))
  const groups = model.excludedEventGroups(events)
  const expanded = model.excludedEventGroups(events, groups.map(g => g.key))
  assert.deepEqual(expanded.map(g => g.events.map(e => e.eventId)), [['early', 'late'], ['middle']])
  assert.equal(new Set(groups.map(g => g.key)).size, 2)
  assert.ok(expanded.every(g => g.expanded))
})

test('已分类直接显示服务端具体分类路径，不依赖前一页加载分类目录', async () => {
  const data = fixture(2)
  data.events[0].categoryName = '餐饮 / 早餐'
  data.events[1].categoryName = '居家 / 自定义用品'
  const h = runtime(data), page = h.page
  page.data.categories = []
  page.data.activeReviewTab = 'category'; page.data.activeCategoryStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  assert.deepEqual(Array.from(page.data.categorizedEvents, e => e.categoryName), ['餐饮 / 早餐', '居家 / 自定义用品'])
  assert.ok(!h.calls.some(c => c.action === 'financeUpdates.options' && c.input.kind === 'categories'))
  page.onUnload()
})

test('旧视图各事件列表日期升序，分类使用父子路径，缺失名称不伪装为已加载', () => {
  const rows = [event('b', 3), event('a', 1), event('z')].map(e => ({ ...e, categoryId: 'child' }))
  const categories = [{ categoryId: 'root', name: '餐饮' }, { categoryId: 'child', parentId: 'root', name: '早餐' }]
  const state = model.organizerRecordState(rows, [], categories)
  assert.deepEqual(state.reviewedEvents.map(e => e.eventId), ['a', 'b', 'z'])
  assert.deepEqual(state.categorizedEvents.map(e => e.eventId), ['a', 'b', 'z'])
  assert.ok(state.categorizedEvents.every(e => e.categoryName === '餐饮 / 早餐'))
  assert.equal(model.categorizedEventRows(rows, [])[0].categoryName, '')
})
