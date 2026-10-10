const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const { create, MAX_PAGES, MAX_BYTES } = require('../miniprogram/services/import-view-session')

const tap = (id = 'synthetic-issue', direction = 0) => ({ currentTarget: { dataset: { id, direction } } })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(check) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await flush()
  assert.ok(check(), 'the expected asynchronous boundary was reached')
}
function dataFor(type = 'same_event') {
  const data = fixture(1, true)
  data.issues[0].issueType = type
  return data
}
function compactEvidence(h, action, input) {
  if (action === 'economicEvents.evidence') return { protocolVersion: 2, viewVersion: h.summary.viewVersion,
    items: [{ evidenceId: input.eventId + '-source', fileName: '合成账单.csv', rowNumber: 2 }], total: 1, nextCursor: null }
  if (action === 'economicEvents.detail') return { protocolVersion: 2, viewVersion: h.summary.viewVersion,
    part: JSON.stringify([{ name: '合成字段', value: '合成内容' }]), nextCursor: null }
}

test('点击先显示对应摘要且可关闭，详情未验证时直接调用保存也不会入队', async () => {
  const h = runtime(dataFor()), page = h.page, gate = deferred()
  await flush()
  h.intercept = (action, input) => action === 'reviewIssues.get' ? gate.promise : compactEvidence(h, action, input)
  const opening = page.openIssue(tap())
  assert.equal(page.data.currentIssue.issueId, 'synthetic-issue')
  assert.equal(page.data.issueDetailsLoading, true)
  assert.equal(page.data.busy, false)
  assert.equal(page.data.issueCanSubmit, false)
  await page.resolveIssue('confirm_distinct', {})
  assert.equal(page._draftSession.state.entries.length, 0)
  page.closeIssue()
  const patches = h.patches.length
  gate.resolve()
  await opening
  assert.equal(page.data.currentIssue, null)
  assert.equal(h.patches.length, patches)
  page.onUnload()
})

test('主要内容与原文不等待分类目录；只取必需目录且 get 首成员被复用', async () => {
  const h = runtime(dataFor('category_assignment')), page = h.page, gate = deferred()
  await flush()
  h.intercept = (action, input) => action === 'financeUpdates.options' ? gate.promise : compactEvidence(h, action, input)
  const opening = page.openIssue(tap())
  await until(() => page.data.issueVisibleEvents[0] && page.data.issueVisibleEvents[0].evidence.length)
  assert.equal(page.data.issueDetailsReady, false)
  assert.equal(page.data.issueCanSubmit, false)
  assert.equal(page.data.issueEvents[0].eventId, 'synthetic-event-0')
  assert.deepEqual(h.calls.filter(row => row.action === 'financeUpdates.options').map(row => row.input.kind), ['categories'])
  assert.equal(h.calls.filter(row => row.action === 'reviewIssues.get').length, 1)
  assert.equal(h.calls.filter(row => row.action === 'reviewIssues.members').length, 0)
  await page.resolveIssue('apply_fields', { fields: { categoryId: 'synthetic-category' } })
  assert.equal(page._draftSession.state.entries.length, 0)
  gate.resolve()
  await opening
  assert.equal(page.data.issueDetailsReady, true)
  assert.equal(page.data.issueCanSubmit, true)
  page.onUnload()
})

test('普通同笔核对不读账户、分类或无用关系，同版本重开复用详情和自动原文', async () => {
  const h = runtime(dataFor()), page = h.page
  await flush()
  h.intercept = (action, input) => {
    if (action === 'financeUpdates.options') throw new Error('不应读取无用目录')
    return compactEvidence(h, action, input)
  }
  await page.openIssue(tap())
  assert.equal(page.data.issueCanSubmit, true)
  assert.equal(h.calls.filter(row => row.action === 'reviewIssues.members').length, 0)
  assert.equal(h.calls.filter(row => row.action === 'financeUpdates.options').length, 0)
  page.closeIssue()
  const calls = h.calls.length
  await page.openIssue(tap())
  assert.equal(h.calls.length, calls)
  assert.equal(page.data.issueVisibleEvents[0].evidence[0].fields[0].value, '合成内容')
  page.onUnload()
})

test('A 未完成即可打开 B，A 迟到不覆盖 B 的表单或可操作状态', async () => {
  const data = dataFor('shared_fields')
  data.issues.push({ ...data.issues[0], issueId: 'synthetic-other' })
  const h = runtime(data), page = h.page, gate = deferred()
  await flush()
  h.intercept = (action, input) => action === 'reviewIssues.get' && input.issueId === 'synthetic-issue'
    ? gate.promise : compactEvidence(h, action, input)
  const a = page.openIssue(tap())
  await flush()
  await page.openIssue(tap('synthetic-other'))
  page.changeDraftAccountName({ detail: { value: '保留用户输入' } })
  const state = JSON.stringify(page.data)
  gate.resolve(); await a
  assert.equal(JSON.stringify(page.data), state)
  assert.equal(page.data.currentIssue.issueId, 'synthetic-other')
  assert.equal(page.data.issueCanSubmit, true)
  page.onUnload()
})

for (const boundary of ['onHide', 'onUnload', 'scope', 'version']) test('详情等待期间 ' + boundary + ' 后不回填旧问题', async () => {
  const h = runtime(dataFor()), page = h.page, gate = deferred()
  await flush()
  h.intercept = action => action === 'reviewIssues.get' ? gate.promise : undefined
  const opening = page.openIssue(tap())
  await flush()
  if (boundary === 'scope') h.cache.reset()
  else if (boundary === 'version') page._viewSession.accept({ ...h.summary, viewVersion: 'v2' })
  else page[boundary]()
  const patches = h.patches.length
  gate.resolve(); await opening
  assert.equal(h.patches.length, patches)
  assert.equal(page.data.issueCanSubmit, false)
  if (boundary !== 'onUnload') page.onUnload()
})

test('目录局部失败只重试目录，不重取详情、成员或原文', async () => {
  const h = runtime(dataFor('category_assignment')), page = h.page
  let fail = true
  await flush()
  h.intercept = (action, input) => {
    if (action === 'financeUpdates.options' && fail) throw new Error('合成目录失败')
    return compactEvidence(h, action, input)
  }
  await page.openIssue(tap())
  assert.match(page.data.issueDetailsError, /合成目录失败/)
  assert.equal(page.data.issueCanSubmit, false)
  const before = h.calls.length
  fail = false
  await page.retryIssueDetails()
  assert.equal(page.data.issueCanSubmit, true)
  assert.deepEqual(h.calls.slice(before).map(row => row.action), ['financeUpdates.options'])
  page.onUnload()
})

test('退款候选失败不冒充无候选，局部重试后只修改当前决定', async t => {
  const editor = require('./helpers/editor-workbench')
  const { h, page } = await editor.open(t, { economicNature: 'refund', ledgerAccountId: 'account-0' })
  h.refundCandidates = { event: [{ kind: 'event', id: 'original', version: 1, amountMinor: '100', remainingMinor: '100' }], transaction: [] }
  let fail = true
  h.intercept = action => { if (action === 'economicEvents.refundCandidates' && fail) throw Error('合成关系失败') }
  await page.loadEditorRefunds(editor.tap({ kind: 'event' }))
  assert.match(page.data.reviewEditSheet.refundError, /合成关系失败/)
  assert.notEqual(page.data.reviewEditSheet.refundCanPending, true)
  page.selectEditorRefund(editor.tap({ mode: 'pending' }))
  assert.equal(editor.draft(page).refund, null)
  fail = false
  await page.loadEditorRefunds(editor.tap({ kind: 'event' }))
  page.selectEditorRefund(editor.tap({ id: 'original' }))
  assert.equal(editor.draft(page).refund.id, 'original')
  assert.equal(editor.writes(h).length, 0)
})

test('账户映射后台版本变化停止提交，重核后保留账户与文字输入', async () => {
  const h = runtime(dataFor('account_mapping')), page = h.page
  h.intercept = (action, input) => compactEvidence(h, action, input)
  await page.openIssue(tap())
  page.changeDraftAccountName({ detail: { value: '保留核对备注' } })
  page.setData({ 'issueDraft.note': '保留用户补充' })
  const previous = JSON.stringify(page.data.issueDraft)
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  h.issues[0].version = 2
  page.applyUpdateView(h.summary, true)
  assert.equal(page.data.issueStale, true)
  assert.equal(page.data.issueCanSubmit, false)
  assert.equal(JSON.stringify(page.data.issueDraft), previous)
  await page.resolveIssue('confirm_distinct', {})
  assert.equal(page._draftSession.state.entries.length, 0)
  await page.retryIssueDetails()
  assert.equal(page.data.issueDraft.newAccountName, '保留核对备注')
  assert.equal(page.data.issueDraft.note, '保留用户补充')
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'synthetic-account')
  assert.equal(page.data.currentIssue.version, 2)
  assert.equal(page.data.issueCanSubmit, true)
  page.onUnload()
})

test('重核后失效账户保留原选择且禁止按新建默认项保存', async () => {
  const h = runtime(dataFor('account_mapping')), page = h.page
  let remove = false
  h.intercept = (action, input) => {
    if (remove && action === 'financeUpdates.options' && input.kind === 'accounts') return { protocolVersion: 2, viewVersion: 'v2', items: [], total: 0 }
    return compactEvidence(h, action, input)
  }
  await page.openIssue(tap())
  page.changeDraftAccountName({ detail: { value: '不能变成误建的账户' } })
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  h.issues[0].version = 2; remove = true
  page.applyUpdateView(h.summary, true)
  await page.retryIssueDetails()
  const account = page.data.accountChoices[page.data.issueDraft.accountIndex]
  assert.equal(account.accountId, 'synthetic-account')
  assert.equal(account.unavailable, true)
  assert.equal(page.data.issueFieldsCanSave, false)
  page.resolveWithFields()
  assert.equal(page._draftSession.state.entries.length, 0)
  page.onUnload()
})

test('后补原文发现服务端版本变化立即停用保存，重核读取摘要后恢复同一表单', async () => {
  const h = runtime(dataFor('shared_fields')), page = h.page, gate = deferred()
  let stale = true
  h.intercept = (action, input) => {
    if (action === 'economicEvents.detail' && stale) return gate.promise.then(() => { throw Object.assign(new Error('整理结果变化'), { code: 'STALE_VIEW' }) })
    return compactEvidence(h, action, input)
  }
  const opening = page.openIssue(tap())
  await until(() => page.data.issueDetailsReady)
  page.changeDraftAccountName({ detail: { value: '仍要保留的输入' } })
  gate.resolve(); await opening
  assert.equal(page.data.issueStale, true)
  assert.equal(page.data.issueCanSubmit, false)
  assert.equal(page._viewSession.active, false)
  assert.equal(page._viewSession.cachedBytes, 0)
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  h.issues[0].version = 2; stale = false
  const start = h.calls.length
  await page.retryIssueDetails()
  assert.equal(h.calls[start].action, 'financeUpdates.summary')
  assert.equal(page.data.issueCanSubmit, true)
  assert.equal(page.data.issueDraft.newAccountName, '仍要保留的输入')
  assert.equal(page._viewSession.active, true)
  page.onUnload()
})

test('历史重核保留原选择，迟到候选先核验是否仍可用，不把失效记录入队', async () => {
  const data = dataFor(), gate = deferred()
  Object.assign(data.issues[0], { primaryReasonCode: 'historical_duplicate_candidate', candidateCount: 1 })
  const h = runtime(data), page = h.page
  let rechecking = false
  h.intercept = async (action, input) => {
    if (action === 'reviewIssues.members' && input.memberKind === 'transaction') {
      if (rechecking) await gate.promise
      const id = rechecking ? 'history-new' : 'history-selected'
      return { protocolVersion: 2, viewVersion: h.summary.viewVersion, total: 1, nextCursor: null,
        items: [{ objectId: id, objectVersion: 1, transaction: { transactionId: id, version: 1, amountMinor: '100' } }] }
    }
    return compactEvidence(h, action, input)
  }
  await page.openIssue(tap())
  page.selectHistoricalTransaction(tap('history-selected'))
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  h.issues[0].version = 2; rechecking = true
  page.applyUpdateView(h.summary, true)
  const retry = page.retryIssueDetails()
  await until(() => page.data.currentIssue.version === 2 && page.data.issueDetailsReady)
  assert.equal(page.data.historicalSelection, 'history-selected')
  assert.equal(page.data.historicalSelectionVerified, false)
  await page.linkHistoricalTransaction()
  assert.equal(page._draftSession.state.entries.length, 0)
  gate.resolve(); await retry
  assert.equal(page.data.historicalSelection, 'history-selected')
  assert.equal(page.data.historicalSelectionVerified, false)
  await page.linkHistoricalTransaction()
  assert.equal(page._draftSession.state.entries.length, 0)
  page.selectHistoricalTransaction(tap('history-new'))
  await page.linkHistoricalTransaction()
  assert.equal(page._draftSession.state.entries[0].decision.transactionId, 'history-new')
  page.onUnload()
})

test('阶段指标在数据桥回调后记录；分别记录反馈、内容、可操作与原文完成', async () => {
  const h = runtime(dataFor()), page = h.page, gate = deferred(), callbacks = []
  await flush()
  h.observer.enable(true)
  h.intercept = (action, input) => action === 'reviewIssues.get' ? gate.promise : compactEvidence(h, action, input)
  const original = page.setData.bind(page)
  page.setData = (patch, callback) => original(patch, callback && (() => {
    const record = patch['issueVisibleEvents[0]']
    if (patch.issueDetailsLoading === true || record && record.evidenceLoading === false) callbacks.push(callback)
    else callback()
  }))
  const opening = page.openIssue(tap())
  assert.equal(h.observer.snapshot().some(row => row.phase === 'review_feedback'), false)
  callbacks.shift()()
  assert.equal(h.observer.snapshot().filter(row => row.phase === 'review_feedback').length, 1)
  gate.resolve()
  await until(() => callbacks.length)
  assert.equal(h.observer.snapshot().some(row => row.phase === 'review_evidence'), false)
  callbacks.shift()(); await opening
  const phases = h.observer.snapshot().filter(row => row.event === 'interactive').map(row => row.phase)
  for (const phase of ['review_feedback', 'review_content', 'review_ready', 'review_evidence']) assert.ok(phases.includes(phase), phase)
  const metrics = JSON.stringify(h.observer.snapshot())
  assert.equal(metrics.includes('synthetic-'), false)
  assert.equal(metrics.includes('合成内容'), false)
  assert.ok(h.observer.snapshot().some(row => row.event === 'cache' && row.action === 'reviewIssues.members' && row.hit))
  h.observer.enable(false)
  page.onUnload()
})

test('会话缓存同时限制页数和字节，版本变化、关闭与账号切换不能复用旧页', async () => {
  let calls = 0
  const summary = dataFor().summary
  const session = create(async (_, input) => { calls++; return { viewVersion: input.viewVersion, items: [], part: '合成'.repeat(10000) } }, summary)
  for (let index = 0; index < 50; index++) await session.read('economicEvents.detail', { eventId: 'synthetic-' + index })
  assert.ok(session.pageCount <= MAX_PAGES)
  assert.ok(session.cachedBytes <= MAX_BYTES)
  const before = calls
  await session.read('economicEvents.detail', { eventId: 'synthetic-49' })
  assert.equal(calls, before)
  await assert.rejects(session.read('economicEvents.detail', { eventId: 'synthetic-49' }, () => false), { code: 'STALE_VIEW' })
  session.accept({ ...summary, viewVersion: 'v2' })
  assert.equal(session.cachedBytes, 0)
  await session.read('economicEvents.detail', { eventId: 'synthetic-49' })
  assert.equal(calls, before + 1)
  session.close()
  assert.equal(session.pageCount, 0)
  await assert.rejects(session.read('economicEvents.detail', { eventId: 'synthetic-49' }), { code: 'STALE_SESSION' })
})
