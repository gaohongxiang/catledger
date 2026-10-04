const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const model = require('../miniprogram/pages/import-workbench/model')
const tap = data => ({ currentTarget: { dataset: data } })

function fragment(h, rows, input, cap) {
  const start = Number(input.cursor || 0), end = Math.min(rows.length, start + Math.min(input.pageSize, cap))
  return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: rows.slice(start, end),
    total: rows.length, nextCursor: end < rows.length ? String(end) : null }
}

const lists = [
  ['待核对', 'review', 'pending', 30], ['已核对', 'review', 'completed', 40],
  ['重复交易', 'review', 'duplicate', 32],
  ['待分类', 'category', 'pending', 34], ['已分类', 'category', 'completed', 40],
  ['无需分类', 'category', 'none', 31]
]
for (const [label, tab, status, cap] of lists) test(label + '短响应补足50项，往返翻页无重复遗漏，末页保留余数', async () => {
  const data = fixture(137)
  const issues = status === 'pending'
  if (issues) data.issues = data.events.map((event, index) => ({ issueId: 'synthetic-issue-' + index,
    issueType: tab === 'category' ? 'category_assignment' : 'same_event', status: 'open', version: 1,
    blocking: tab === 'review', memberCount: 1, candidateCount: 0, subject: event }))
  if (status === 'excluded') data.events.forEach(row => { row.status = 'excluded'; row.reasonCodes = ['manual_exclusion'] })
  const h = runtime(data), page = h.page, rows = data.events.map((event, index) => ({ ...event,
    pendingIssue: issues ? { ...data.issues[index], subject: undefined } : null }))
  page.data.activeReviewTab = tab
  page.data[tab === 'review' ? 'activeReviewStatus' : 'activeCategoryStatus'] = status
  h.intercept = (action, input) => action === 'economicEvents.list'
    ? fragment(h, rows, input, cap) : undefined
  const current = () => page.businessData().events
  const id = row => row.eventId
  await page.setStep({ currentStep: 3 })
  const firstRead = h.calls.find(c => c.action === 'economicEvents.list')
  assert.equal(firstRead.input.pageSize, 50)
  assert.equal(current().length, 50)
  assert.equal(page.data.reviewPage.start, 1)
  assert.equal(page.data.reviewPage.end, 50)
  const received = Array.from(current(), id)
  await page.changeReviewPage(tap({ direction: 1 }))
  assert.equal(current().length, 50)
  assert.equal(page.data.reviewPage.start, 51)
  assert.equal(page.data.reviewPage.end, 100)
  received.push(...Array.from(current(), id))
  await page.changeReviewPage(tap({ direction: 1 }))
  assert.equal(current().length, 37)
  assert.equal(page.data.reviewPage.start, 101)
  assert.equal(page.data.reviewPage.end, 137)
  assert.equal(page.data.reviewPage.count, 137)
  assert.equal(page.data.reviewPage.hasNext, false)
  received.push(...Array.from(current(), id))
  assert.deepEqual(received, rows.map(id))
  await page.changeReviewPage(tap({ direction: -1 }))
  assert.equal(page.data.reviewPage.start, 51)
  assert.deepEqual(Array.from(current(), id), rows.slice(50, 100).map(id))
  await page.changeReviewPage(tap({ direction: 'first' }))
  assert.deepEqual(Array.from(current(), id), rows.slice(0, 50).map(id))
  assert.ok(h.patches.every(bytes => bytes <= 65536))
  assert.ok(page._viewSession.cachedBytes <= 262144)
  page.onUnload()
})

for (const tab of ['review', 'category']) test(tab + '的74笔分属46个问题时仍显示50+24笔，不把组数当笔数', async () => {
  const data = fixture(74, true)
  const base = data.issues[0]
  data.issues = [{ ...base, issueType: tab === 'category' ? 'category_assignment' : 'same_event',
    memberCount: 29, subjectEventIds: data.events.slice(0, 29).map(row => row.eventId) }]
    .concat(data.events.slice(29).map((event, i) => ({ ...base, issueId: 'synthetic-single-' + i,
      issueType: tab === 'category' ? 'category_assignment' : 'same_event', memberCount: 1,
      subjectEventIds: [event.eventId], subject: event })))
  assert.equal(data.issues.length, 46)
  const h = runtime(data), page = h.page
  page.data.activeReviewTab = tab
  await page.setStep({ currentStep: 3 })
  const cards = () => tab === 'review' ? page.data.reviewGroups.flatMap(group => group.issues) : page.data.categoryCards
  assert.equal(cards().length, 50)
  assert.equal(page.data.reviewPage.count, 74)
  assert.equal(page.data.reviewPage.hasNext, true)
  assert.equal(page.data.reviewPage.unit, '笔')
  const seen = Array.from(cards(), card => card.eventId)
  assert.equal(new Set(seen).size, 50)
  assert.equal(cards()[28].issueId, data.issues[0].issueId, '第29笔仍能进入同一原始问题')
  assert.match(cards()[28].batchDecision, /关联 29 笔/)
  let selected
  page.openIssue = event => { selected = event.currentTarget.dataset.id }
  await page.openPendingRecord(tap({ id: cards()[28].eventId, issueId: cards()[28].issueId }))
  assert.equal(selected, data.issues[0].issueId, '分页不改变决定范围')
  await page.changeReviewPage(tap({ direction: 1 }))
  assert.equal(cards().length, 24)
  assert.equal(page.data.reviewPage.start, 51)
  assert.equal(page.data.reviewPage.end, 74)
  assert.equal(page.data.reviewPage.hasNext, false)
  seen.push(...Array.from(cards(), card => card.eventId))
  assert.deepEqual(seen, data.events.map(row => row.eventId))
  await page.changeReviewPage(tap({ direction: 'first' }))
  assert.equal(cards().length, 50)
  page.onUnload()
})

test('没有问题入口的待核对交易也显示并可看详情，不被过滤成已完成', async () => {
  const data = fixture(3, true)
  data.issues = []
  const h = runtime(data), page = h.page
  await page.setStep({ currentStep: 3 })
  const cards = page.data.reviewGroups[0].issues
  assert.equal(cards.length, 3)
  assert.ok(cards.every(card => !card.issueId && card.batchDecision === '查看详情'))
  let selected
  page.openReviewDetails = event => { selected = event.currentTarget.dataset.id }
  await page.openPendingRecord(tap({ id: cards[2].eventId }))
  assert.equal(selected, data.events[2].eventId)
  page.onUnload()
})

test('下一页补读失败不提交半页或推进页码，重试仍读取同一页', async () => {
  const h = runtime(fixture(121)), page = h.page
  page.data.activeReviewStatus = 'completed'
  let fail = true
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.list') return
    if (input.cursor === '80' && fail) throw new Error('合成补读失败')
    return fragment(h, h.events, input, 30)
  }
  await page.setStep({ currentStep: 3 })
  const previous = JSON.stringify(page.data.reviewedEvents)
  await page.changeReviewPage(tap({ direction: 1 }))
  assert.match(page.data.pageError, /合成补读失败/)
  assert.equal(page.data.reviewPage.start, 1)
  assert.equal(JSON.stringify(page.data.reviewedEvents), previous)
  fail = false
  await page.changeReviewPage(tap({ direction: 1 }))
  assert.equal(page.data.reviewPage.start, 51)
  assert.equal(page.data.reviewPage.end, 100)
  assert.deepEqual(Array.from(page.businessData().events, row => row.eventId), h.events.slice(50, 100).map(row => row.eventId))
  page.onUnload()
})

test('补读期间隐藏页面，迟到片段不显示、不继续请求', async () => {
  const h = runtime(fixture(121)), page = h.page
  page.data.activeReviewStatus = 'completed'
  let release
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.list') return
    if (input.cursor) return new Promise(resolve => { release = () => resolve(fragment(h, h.events, input, 10)) })
    return fragment(h, h.events, input, 30)
  }
  const pending = page.setStep({ currentStep: 3 })
  await flush()
  assert.equal(typeof release, 'function')
  page.onHide()
  const calls = h.calls.length, patches = h.patches.length
  release(); await pending
  assert.equal(h.calls.length, calls)
  assert.equal(h.patches.length, patches)
  assert.equal(page.data.reviewedEvents.length, 0)
  page.onUnload()
})

test('空片段带后续游标不能无限补读或伪造完整页', async () => {
  const h = runtime(fixture(121)), page = h.page
  page.data.activeReviewStatus = 'completed'
  h.intercept = action => action === 'economicEvents.list'
    ? { protocolVersion: 2, viewVersion: 'v1', items: [], total: 121, nextCursor: 'unchanged' } : undefined
  await page.setStep({ currentStep: 3 })
  assert.match(page.data.pageError, /分页结果不完整/)
  assert.equal(h.calls.filter(c => c.action === 'economicEvents.list').length, 1)
  assert.equal(page.data.reviewedEvents.length, 0)
  page.onUnload()
})

test('同一账户不同排除原因仍合组，首笔变化后组标识稳定', () => {
  const rows = fixture(41).events.map((row, index) => ({ ...row, status: 'excluded',
    localAt: '2026-09-01 12:' + String(index).padStart(2, '0') + ':00',
    reasonCodes: [index >= 32 && index < 34 ? 'source_non_financial' : 'account_mapping_excluded'],
    primaryEvidence: { ...row.primaryEvidence, sourceType: 'alipay',
      paymentMethod: index === 40 ? '合成小荷包乙' : '合成小荷包甲' } }))
  const groups = model.excludedEventGroups(rows)
  assert.deepEqual(groups.map(group => group.count), [40, 1])
  const expanded = model.excludedEventGroups(rows.slice(1), [groups[0].key])
  assert.equal(expanded[0].key, groups[0].key)
  assert.equal(expanded[0].expanded, true)
  assert.equal(expanded[0].count, 39)
  assert.deepEqual(expanded[0].events.map(row => row.eventId), rows.slice(1, 40).map(row => row.eventId))
})

function excludedFixture(count = 137) {
  const data = fixture(count)
  data.events.forEach((row, index) => { row.status = 'excluded'; row.reasonCodes = ['account_mapping_excluded']
    row.primaryEvidence.paymentMethod = index % 7 === 0 ? '合成小荷包乙' : '合成小荷包甲' })
  return data
}

test('整批同账户只有一张卡；总笔数跨过50条，组内分页不拆卡且末页保留余数', async () => {
  const h = runtime(excludedFixture()), page = h.page
  page.data.activeReviewStatus = 'excluded'
  await page.setStep({ currentStep: 3 })
  assert.equal(page.data.excludedReviewGroups.length, 2)
  assert.deepEqual(Array.from(page.data.excludedReviewGroups, group => group.count), [20, 117])
  assert.equal(page.data.reviewPage.count, 2)
  assert.equal(page.data.reviewPage.unit, '组')
  assert.equal(page.businessData().events.length, 0)
  assert.ok(h.calls.filter(call => call.action === 'economicEvents.list').every(call => call.input.view === 'excluded_groups'))
  const group = page.data.excludedReviewGroups.find(group => group.count === 117), key = group.key
  await page.toggleExcludedGroup(tap({ key }))
  const opened = () => page.data.excludedReviewGroups.find(group => group.key === key)
  const seen = Array.from(opened().events, row => row.eventId)
  assert.equal(opened().events.length, 50)
  await page.changeExcludedGroupPage(tap({ key, direction: 1 }))
  assert.equal(opened().page.start, 51)
  assert.equal(opened().events.length, 50)
  seen.push(...Array.from(opened().events, row => row.eventId))
  await page.changeExcludedGroupPage(tap({ key, direction: 1 }))
  assert.equal(opened().page.start, 101)
  assert.equal(opened().events.length, 17)
  seen.push(...Array.from(opened().events, row => row.eventId))
  assert.equal(new Set(seen).size, 117)
  assert.equal(page.data.excludedReviewGroups.length, 2)
  assert.equal(opened().count, 117)
  await page.changeExcludedGroupPage(tap({ key, direction: 'first' }))
  assert.equal(opened().page.start, 1)
  assert.ok(h.patches.every(bytes => bytes <= 65536))
  page.onUnload()
})

test('组内短响应补齐50条，下一页失败保留原页，重试不跳过；换组或隐藏丢弃迟到响应', async () => {
  const h = runtime(excludedFixture(200)), page = h.page
  page.data.activeReviewStatus = 'excluded'
  await page.setStep({ currentStep: 3 })
  const target = page.data.excludedReviewGroups.find(group => group.count > 50), key = target.key
  const rows = h.events.filter(row => row.primaryEvidence.paymentMethod === '合成小荷包甲')
  let failure = true, release, delayed = false
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.list' || input.excludedGroupId !== key) return
    if (input.cursor === '80' && failure) throw new Error('合成账户内分页失败')
    if (delayed) return new Promise(resolve => { release = () => resolve(fragment(h, rows, input, 30)) })
    return fragment(h, rows, input, 30)
  }
  await page.toggleExcludedGroup(tap({ key }))
  const opened = () => page.data.excludedReviewGroups.find(group => group.key === key)
  assert.equal(opened().page.end, 50)
  await page.changeExcludedGroupPage(tap({ key, direction: 1 }))
  assert.match(opened().error, /合成账户内分页失败/)
  assert.equal(opened().page.start, 1)
  failure = false
  await page.changeExcludedGroupPage(tap({ key, direction: 'retry' }))
  assert.equal(opened().page.start, 51)
  delayed = true
  const pending = page.changeExcludedGroupPage(tap({ key, direction: 1 }))
  await flush()
  const other = page.data.excludedReviewGroups.find(group => group.key !== key)
  await page.toggleExcludedGroup(tap({ key: other.key }))
  release(); await pending
  assert.equal(opened().expanded, false)
  assert.equal(opened().events.length, 0)
  const again = page.toggleExcludedGroup(tap({ key }))
  await flush()
  page.onHide()
  const patches = h.patches.length, calls = h.calls.length
  release(); await again
  assert.equal(h.patches.length, patches)
  assert.equal(h.calls.length, calls)
  page.onUnload()
})

test('50项长标题和商户摘要不突破原生更新预算，完整来源保留在业务数据', async () => {
  for (const kind of ['completed', 'pending', 'category']) {
    const data = fixture(55), title = '合成长商品'.repeat(80), merchant = '合成长商户'.repeat(80)
    data.events.forEach(row => { row.primaryEvidence.item = title; row.primaryEvidence.counterparty = merchant })
    if (kind !== 'completed') data.issues = data.events.map((event, index) => ({ issueId: 'synthetic-long-' + index,
      issueType: kind === 'category' ? 'category_assignment' : 'same_event', status: 'open', version: 1,
      blocking: true, memberCount: 1, candidateCount: 0, subject: event }))
    const h = runtime(data), page = h.page
    page.data.activeReviewStatus = kind === 'completed' ? 'completed' : 'pending'
    if (kind === 'category') page.data.activeReviewTab = 'category'
    await page.setStep({ currentStep: 3 })
    assert.equal(page.data.pageError, '', kind)
    assert.equal(page.data.reviewPage.end, 50, kind)
    assert.ok(h.patches.every(bytes => bytes <= 65536), kind)
    const record = page.businessData().events[0]
    assert.equal(record.primaryEvidence.item, title)
    assert.equal(record.primaryEvidence.counterparty, merchant)
    page.onUnload()
  }
})
