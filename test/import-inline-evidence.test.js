const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const event = (id, direction = 0, scope = 'issue') => ({ currentTarget: { dataset: { id, direction, scope } } })
const fields = [{ name: '交易摘要', value: '合成商户' }, { name: '备注', value: '' }, { name: '备注', value: '重复列保留' }, { name: '金额', value: '0' }]

function evidence(h, sourceFields = [fields]) {
  return (action, input) => {
    if (action === 'economicEvents.evidence') {
      const start = Number(input.cursor || 0), size = input.pageSize
      const all = sourceFields.map((_, index) => ({ evidenceId: 'synthetic-source-' + index, fileName: '合成原始账单.xls', rowNumber: index + 2 }))
      return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: all.slice(start, start + size),
        total: all.length, nextCursor: start + size < all.length ? String(start + size) : null }
    }
    if (action === 'economicEvents.detail') {
      const text = JSON.stringify(sourceFields[Number(input.evidenceId.split('-').at(-1))]), offset = Number(input.cursor || 0)
      return { protocolVersion: 2, viewVersion: h.summary.viewVersion, part: text.slice(offset, offset + 2048),
        nextCursor: offset + 2048 < text.length ? String(offset + 2048) : null }
    }
  }
}
const rendered = row => JSON.parse(JSON.stringify(row.evidence[0].fields)).map(({ name, value }) => ({ name, value }))

test('打开核对即显示原始列和值，重复列、空值、零值完整保留；列表不预读原文', async () => {
  const h = runtime(fixture(1, true)), page = h.page
  h.intercept = evidence(h)
  await flush()
  assert.equal(h.calls.some(row => row.action === 'economicEvents.evidence'), false)
  await page.openIssue(event('synthetic-issue'))
  assert.deepEqual(rendered(page.data.issueVisibleEvents[0]), fields)
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].incomplete, false)
  assert.equal(page.data.issueVisibleEvents[0].evidenceLoading, false)
  assert.equal(page.data.issueSourceExpanded, true)
  assert.equal(page.data.evidenceSheet, null)
  assert.equal(page._draftSession.state.entries.length, 0)
  assert.equal(h.calls.some(row => /resolve|post|organize/.test(row.action)), false)
  page.onUnload()
})

test('一条原始行跨两个片段仍自动完整展示，多份来源原位切换不混字段', async () => {
  const h = runtime(fixture(1, true)), page = h.page
  const long = [{ name: '摘要', value: '合成文字'.repeat(650) }, ...fields]
  h.intercept = evidence(h, [fields, long])
  await page.openIssue(event('synthetic-issue'))
  assert.equal(page.data.issueVisibleEvents[0].evidencePage.count, 2)
  await page.changeInlineSource(event('synthetic-event-0', 1))
  assert.equal(page.data.issueVisibleEvents[0].evidencePage.start, 2)
  assert.deepEqual(rendered(page.data.issueVisibleEvents[0]), long)
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].incomplete, false)
  await page.changeInlineSource(event('synthetic-event-0', -1))
  assert.deepEqual(rendered(page.data.issueVisibleEvents[0]), fields)
  page.onUnload()
})

test('超长行只展示完整字段并标记未展示内容；八笔成员仍守住请求和页面体积', async () => {
  const h = runtime(fixture(121, true)), page = h.page
  const prefix = [{ name: '原始备注', value: '括号 } 与引号 "、空白 \n 保留' }]
  h.intercept = evidence(h, [[...prefix, { name: '长说明', value: '合成'.repeat(8000) }]])
  await page.openIssue(event('synthetic-issue'))
  assert.equal(page.data.issueVisibleEvents.length, 8)
  for (const row of page.data.issueVisibleEvents) {
    assert.deepEqual(rendered(row), prefix)
    assert.equal(row.evidence[0].incomplete, true)
  }
  assert.equal(h.calls.filter(row => row.action === 'economicEvents.detail').length, 16)
  assert.equal(h.calls.filter(row => row.action === 'economicEvents.evidence').length, 8)
  assert.ok(h.maxDataBytes <= 262144)
  assert.ok(Math.max(...h.patches) <= 65536)
  await page.changeIssueMembers(event('', 1))
  assert.equal(page.data.issueVisibleEvents[0].eventId, 'synthetic-event-8')
  assert.equal(page._viewSession.pageCount, 3)
  page.onUnload()
})

test('原文失败单笔原位重试，已选择的历史记录和整理决定不受影响', async () => {
  const h = runtime(fixture(1, true)), page = h.page
  const read = evidence(h)
  let fails = true
  h.intercept = (action, input) => { if (action === 'economicEvents.detail' && fails) throw new Error('synthetic failure'); return read(action, input) }
  await page.openIssue(event('synthetic-issue'))
  assert.equal(page.data.issueVisibleEvents[0].evidenceError, '原始记录读取失败，请重试')
  page.setData({ historicalSelection: 'synthetic-existing', 'issueDraft.primaryEventId': 'synthetic-event-0' })
  fails = false
  await page.retryIssueRecordEvidence(event('synthetic-event-0'))
  assert.deepEqual(rendered(page.data.issueVisibleEvents[0]), fields)
  assert.equal(page.data.issueVisibleEvents[0].evidenceError, '')
  assert.equal(page.data.historicalSelection, 'synthetic-existing')
  assert.equal(page.data.issueDraft.primaryEventId, 'synthetic-event-0')
  assert.equal(page._draftSession.state.entries.length, 0)
  page.onUnload()
})

for (const close of ['closeIssue', 'onHide', 'onUnload']) test(close + '后迟到原文不回填且不继续读取隐藏成员', async () => {
  const h = runtime(fixture(121, true)), page = h.page
  const read = evidence(h), releases = []
  h.intercept = (action, input) => action === 'economicEvents.detail' ? new Promise(resolve => releases.push(() => resolve(read(action, input)))) : read(action, input)
  const pending = page.openIssue(event('synthetic-issue'))
  while (!releases.length) await flush()
  page[close]()
  const patches = h.patches.length
  releases.forEach(release => release())
  await pending
  assert.equal(h.patches.length, patches)
  if (close !== 'onUnload') {
    assert.equal(page.data.currentIssue, null)
    assert.equal(page.data.issueVisibleEvents.length, 0)
  }
  assert.equal(h.calls.filter(row => row.action === 'economicEvents.evidence').length, 2)
  if (close !== 'onUnload') page.onUnload()
})

test('账户核对同样自动展示原始记录，关闭后清空；重新进入只读当前页', async () => {
  const h = runtime(fixture(9, true)), page = h.page
  h.intercept = evidence(h)
  page.setData({ accountMappings: [{ issueId: 'synthetic-issue', label: '合成账户' }] })
  await page.openAccountRecords(event('synthetic-issue'))
  assert.equal(page.data.accountRecordsSheet.records.length, 8)
  assert.deepEqual(rendered(page.data.accountRecordsSheet.records[0]), fields)
  await page.changeAccountMembers(event('', 1))
  assert.equal(page.data.accountRecordsSheet.records.length, 1)
  assert.equal(page.data.accountRecordsSheet.records[0].eventId, 'synthetic-event-8')
  page.closeAccountRecords()
  assert.equal(page.data.accountRecordsSheet, null)
  assert.equal(page._accountInlineEvidence, null)
  page.onUnload()
})

test('成员翻页后旧页原文迟到不串入新页，视图版本变化也不回填', async () => {
  const h = runtime(fixture(9, true)), page = h.page
  const read = evidence(h), releases = []
  let delay = true
  h.intercept = (action, input) => action === 'economicEvents.detail' && delay
    ? new Promise(resolve => releases.push(() => resolve(read(action, input)))) : read(action, input)
  const opening = page.openIssue(event('synthetic-issue'))
  while (!releases.length) await flush()
  delay = false
  await page.changeIssueMembers(event('', 1))
  const expected = JSON.stringify(page.data.issueVisibleEvents)
  releases.forEach(release => release())
  await opening
  assert.equal(JSON.stringify(page.data.issueVisibleEvents), expected)
  assert.equal(page.data.issueVisibleEvents[0].eventId, 'synthetic-event-8')
  page.onUnload()

  const next = runtime(fixture(1, true)), nextRead = evidence(next), nextReleases = []
  next.intercept = (action, input) => action === 'economicEvents.detail'
    ? new Promise(resolve => nextReleases.push(() => resolve(nextRead(action, input)))) : nextRead(action, input)
  const loading = next.page.openIssue(event('synthetic-issue'))
  for (let i = 0; i < 100 && !nextReleases.length; i++) await flush()
  assert.equal(nextReleases.length, 1)
  next.page._viewSession.accept({ ...next.summary, viewVersion: 'v2' })
  const patches = next.patches.length
  nextReleases.forEach(release => release())
  await loading
  assert.equal(next.patches.length, patches)
  next.page.onUnload()
})

test('八笔接近展示上限的完整中文行仍符合页面预算', async () => {
  const h = runtime(fixture(8, true)), page = h.page
  const original = [{ name: '原始说明', value: '合成说明'.repeat(960) }, ...fields]
  h.intercept = evidence(h, [original])
  await page.openIssue(event('synthetic-issue'))
  assert.equal(page.data.issueVisibleEvents.length, 8)
  page.data.issueVisibleEvents.forEach(row => assert.deepEqual(rendered(row), original))
  assert.ok(h.maxDataBytes <= 262144)
  assert.ok(Math.max(...h.patches) <= 65536)
  page.onUnload()
})
