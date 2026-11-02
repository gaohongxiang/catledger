const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { fixture, runtime, flush } = require('./helpers/paged-workbench')
const { workbenchSummary } = require('../cloudfunctions/catledger-import/src/workbench-summary')

const clone = value => JSON.parse(JSON.stringify(value))
const tap = id => ({ currentTarget: { dataset: { id } } })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(check) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await flush()
  assert.ok(check(), 'the expected asynchronous boundary was reached')
}
function accounts(updateId = 'synthetic-update') {
  const data = fixture(2, true)
  data.summary.update.updateId = updateId
  data.issues = data.events.map((event, index) => ({ issueId: updateId + '-account-' + index, issueType: 'account_mapping',
    status: 'open', version: 1, blocking: true, memberCount: 1, subject: event,
    accountContext: { recognized: true, sourceType: 'wechat', label: '合成钱包', currency: 'CNY' } }))
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 2 }], 0, 0)
  return data
}

test('放弃旧批次后在同一 Page 重新整理，新批次账户确认仍可入队', async t => {
  const h = runtime(accounts(), { realDraftManager: true }), page = h.page
  t.after(async () => { if (page._draftSession) await page._draftSession.pause(); page.onUnload() })
  await until(() => page.data.accountMappings.length === 2)
  const oldSession = page._viewSession
  page.beginInputEditing({ currentTarget: { dataset: { inputKey: 'synthetic-old-input' } } })
  page.applyUpdateView({ ...h.summary, viewVersion: 'synthetic-old-pending' }, true)
  assert.ok(page._pendingBackgroundView)
  h.intercept = action => action === 'financeUpdates.abandon' ? { update: { ...h.summary.update, status: 'abandoned' } } : undefined
  await page.performAbandonUpdate()
  assert.equal(page.data.phase, 'idle')
  assert.equal(page._pendingBackgroundView, null)
  assert.equal(page._editingInput, '')
  const next = accounts('synthetic-next-update')
  Object.assign(h, next)
  h.intercept = action => action === 'financeUpdates.prepare' ? { update: h.summary.update } : undefined
  page.setData({ files: [{ state: 'ready', batchId: 'synthetic-next-batch' }] })
  await page.createFinanceUpdate()
  await until(() => page.data.accountMappings.length === 2)
  page.finishInputEditing()
  assert.notEqual(page._viewSession, oldSession)
  assert.equal(oldSession.active, false)
  assert.equal(page._viewSession.active, true)
  await page.completeAccountMapping(tap(h.issues[0].issueId))
  assert.equal(page.data.accountStepError, '')
  assert.equal(page._draftSession.state.entries.length, 1)
  assert.equal(page._draftSession.state.updateId, next.summary.update.updateId)
})

test('账户步骤按字节预算切页后自动补齐，账户列表不再翻页', async t => {
  const data = fixture(11, true)
  data.issues = data.events.map((event, index) => ({ issueId: 'synthetic-account-' + index, issueType: 'account_mapping',
    status: 'open', version: 1, blocking: true, memberCount: 1, subject: event,
    accountContext: { recognized: true, sourceType: 'wechat', label: '合成钱包' + index, currency: 'CNY' } }))
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 11 }], 0, 0)
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 11)
  // 服务端每页按 48KB 截断，账户组多时只回 8 项；客户端要续读补足整页。
  h.intercept = (action, input) => {
    if (action !== 'reviewIssues.list') return undefined
    const offset = Number(input.cursor || 0), items = data.issues.slice(offset, offset + 8)
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, update: h.summary.update, items,
      total: data.issues.length, nextCursor: offset + items.length < data.issues.length ? String(offset + items.length) : null }
  }
  await page.loadActivePage(true)
  assert.equal(page.data.accountMappings.length, 11)
  assert.equal(page.data.reviewPage.end, 11)
  assert.equal(page.data.reviewPage.hasNext, false)
})

test('放弃后新选账单不被旧放弃视图覆盖，第一步操作按钮仍可用', async t => {
  const h = runtime(accounts(), { realDraftManager: true }), page = h.page
  t.after(async () => { if (page._draftSession) await page._draftSession.pause(); page.onUnload() })
  await until(() => page.data.accountMappings.length === 2)
  h.intercept = action => action === 'financeUpdates.abandon' ? { update: { ...h.summary.update, status: 'abandoned' } } : undefined
  await page.performAbandonUpdate()
  assert.equal(page.data.phase, 'idle')
  const stale = { ...h.summary, workbench: undefined, update: { ...h.summary.update, status: 'abandoned' } }
  page.applyUpdateView(stale)
  assert.equal(page.data.phase, 'idle')
  page.setData({ phase: 'selected', files: [{ clientId: 'new-file', name: '新账单.csv', size: 20, state: 'queued', progress: 0 }] })
  page.applyUpdateView(stale)
  assert.equal(page.data.phase, 'selected')
  assert.equal(page.data.currentStep, 1)
  assert.equal(page.data.files.length, 1)
})

test('放弃本批后刷新入口与首页待核对进度一起清掉', async t => {
  const h = runtime(accounts(), { realDraftManager: true }), page = h.page
  t.after(async () => { if (page._draftSession) await page._draftSession.pause(); page.onUnload() })
  await until(() => page.data.accountMappings.length === 2)
  // 首页按本机草稿进度显示「待核对 / 待分类」；上一次保存失败还会在导入页留下刷新入口。
  const drafts = h.load(path.join(__dirname, '../miniprogram/services/import-draft-session.js'))
  drafts.rememberProgress('synthetic-update', { pending: 2, categories: 1 })
  assert.ok(drafts.savedProgress(), '首页此刻有进度可显示')
  page.setData({ refreshRequired: true, pageError: '明细待刷新', errorMessage: '操作已保存，明细待刷新' })
  h.intercept = action => action === 'financeUpdates.abandon' ? { update: { ...h.summary.update, status: 'abandoned' } } : undefined
  await page.performAbandonUpdate()
  assert.equal(page.data.phase, 'idle')
  // 放弃之后这一批已经不存在，刷新按钮和红色错误条都不该继续留着。
  assert.equal(page.data.refreshRequired, false)
  assert.equal(page.data.pageError, '')
  assert.equal(page.data.errorMessage, '')
  assert.equal(drafts.savedProgress(), null, '首页提醒随草稿一起消失')
})

test('放弃本批请求在途时按钮显示处理中，完成后复位', async t => {
  const h = runtime(accounts(), { realDraftManager: true }), page = h.page
  t.after(async () => { if (page._draftSession) await page._draftSession.pause(); page.onUnload() })
  await until(() => page.data.accountMappings.length === 2)
  let release
  h.intercept = action => action === 'financeUpdates.abandon'
    ? new Promise(resolve => { release = () => resolve({ update: { ...h.summary.update, status: 'abandoned' } }) })
    : undefined
  const pending = page.performAbandonUpdate()
  await until(() => Boolean(release))
  assert.equal(page.data.abandoningUpdate, true)
  assert.equal(page.data.busy, true)
  release()
  await pending
  assert.equal(page.data.abandoningUpdate, false)
  assert.equal(page.data.busy, false)
})

test('账户确认后同一批次内摘要仍投影开放事项，也不重复要求确认修改', async t => {
  const h = runtime(accounts()), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 2)
  const issue = h.issues[0]
  await page.openAccountChoice(tap(issue.issueId))
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'account:synthetic-account' } } })
  await page.completeAccountMapping(tap(issue.issueId))
  assert.equal(page.data.accountStepError, '')
  const confirmed = page.data.accountMappings.find(mapping => mapping.issueId === issue.issueId)
  assert.equal(confirmed.needsConfirmation, false)
  assert.equal(page.data.accountStepSummary.pending, 1)
  page.applyUpdateView({ ...h.summary, viewVersion: 'v2' }, true)
  await flush()
  const refreshed = page.data.accountMappings.find(mapping => mapping.issueId === issue.issueId)
  assert.equal(refreshed.needsConfirmation, false, '同一批次的已确认账户不应再次要求确认修改')
  assert.equal(page._accountUiDrafts.get(issue.issueId).localConfirmed, true)
})

test('接续期间目标账户问题实质变化，不替换旧 issueVersion 自动保存', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation({ afterCommit(h) { h.issues[1].version++ } })
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.match(page.data.accountStepError, /核对后再次确认/)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).accountId, 'synthetic-account')
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).localConfirmed, false)
})

test('接续期间已选账户失效，保留原选择并阻止确认', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation({ read(h, action) {
    if (action === 'financeUpdates.options') return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [], total: 0, nextCursor: null }
  } })
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.match(page.data.accountStepError, /所选账户已不可用/)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).accountId, 'synthetic-account')
})

test('原保存成功但摘要失败，不重复原写入或误确认下一项', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation({ failSummary: true })
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.ok(page.data.accountStepError)
  assert.equal(page.data.accountStepBusy, false)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
  assert.equal(page._draftSession.state.entries[0].status, 'saved')
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).localConfirmed, false)
})

for (const leave of ['hide', 'unload', 'switch']) test('接续确认期间' + leave + '，迟到同步不提交旧用户或旧页面的选择', async () => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation()
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  if (leave === 'hide') page.onHide()
  else if (leave === 'unload') page.onUnload()
  else { h.app.globalData.uid = '2345678901'; h.cache.reset(); page.onShow() }
  const before = clone(page.data)
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.deepEqual(clone(page.data), before)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
  if (leave !== 'unload') page.onUnload()
})

test('没有本机保存导致的外部过期仍须重核，不自动绕过版本保护', async t => {
  const h = runtime(accounts()), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 2)
  await page.openAccountChoice(tap(h.issues[0].issueId))
  // 目录进入账户步骤时已一次读完并缓存；换搜索词触发真实读取，模拟外部过期。
  h.intercept = action => {
    if (action === 'financeUpdates.options') throw Object.assign(new Error('整理结果已变化'), { code: 'STALE_VIEW' })
  }
  await page.bindAccountChoiceSearch({ currentTarget: { dataset: {} }, detail: { value: '合成' } })
  await h.flush()
  page.closeAccountChoice()
  const count = h.calls.length
  await page.completeAccountMapping(tap(h.issues[0].issueId))
  assert.match(page.data.accountStepError, /刷新本页后核验/)
  assert.equal(h.calls.length, count)
  assert.equal(page._draftSession.state.entries.length, 0)
})

async function overlappingConfirmation(options = {}) {
  const h = runtime(accounts()), page = h.page, summaryGate = deferred()
  const readDirectory = (action, input) => {
    if (options.directory && action === 'financeUpdates.options' && input.kind === 'accounts') {
      const rows = input.ids ? options.directory.filter(row => input.ids.includes(row.accountId))
        : options.directory.filter(row => !input.query || row.name.includes(input.query))
      return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: rows.slice(0, input.pageSize), total: rows.length, nextCursor: null }
    }
  }
  h.intercept = readDirectory
  await until(() => page.data.accountMappings.length === 2)
  for (const issue of h.issues) {
    await page.openAccountChoice(tap(issue.issueId))
    const selectedId = issue === h.issues[1] && options.secondAccountId || 'synthetic-account'
    if (options.directory && !(page._choiceRows || []).some(row => row.accountId === selectedId)) {
      const selected = options.directory.find(row => row.accountId === selectedId)
      page.bindAccountChoiceSearch({ currentTarget: { dataset: {} }, detail: { value: selected.name } })
      await until(() => !page.data.choiceLoading && (page._choiceRows || []).some(row => row.accountId === selectedId))
    }
    page.selectAccountChoice({ currentTarget: { dataset: { value: 'account:' + selectedId } } })
  }
  let committed = false, writes = 0
  h.intercept = (action, input) => {
    if (action === 'reviewIssues.resolveAccountMappings') {
      committed = true; writes++
      for (const decision of input.decisions) {
        const issue = h.issues.find(item => item.issueId === decision.issueId)
        issue.status = 'resolved'; issue.version++
        issue.accountContext.accountId = decision.fields.mappingAccountId
      }
      h.summary = { ...h.summary, update: { ...h.summary.update, version: writes + 1 }, viewVersion: 'v' + (writes + 1) }
      if (options.afterCommit) options.afterCommit(h)
      return { protocolVersion: 2, update: h.summary.update }
    }
    if (action === 'financeUpdates.summary' && committed) return summaryGate.promise.then(() => {
      if (options.failSummary) throw new Error('合成摘要读取失败')
      return h.summary
    })
    if (action === 'financeUpdates.options' && input.viewVersion !== h.summary.viewVersion) throw Object.assign(new Error('整理结果已变化'), { code: 'STALE_VIEW' })
    if (options.read) return options.read(h, action, input)
    return readDirectory(action, input)
  }
  await page.completeAccountMapping(tap(h.issues[0].issueId))
  const saving = page._draftSession.flush().catch(error => error)
  await until(() => committed)
  await page.openAccountChoice(tap(h.issues[1].issueId))
  let choosing
  const changeChoicePage = page.changeChoicePage
  page.changeChoicePage = function (event) { choosing = changeChoicePage.call(this, event); return choosing }
  assert.equal(page.bindAccountChoiceSearch({ currentTarget: { dataset: {} }, detail: { value: '合成' } }), undefined)
  page.changeChoicePage = changeChoicePage
  await flush()
  page.closeAccountChoice()
  assert.equal(page._viewSession.active, false)
  return { h, page, summaryGate, saving, choosing }
}

test('前一个账户已保存但摘要未返回时，下一项等待原保存后继续确认且不重复提交', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation()
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  assert.equal(page.data.accountStepBusy, true)
  summaryGate.resolve()
  await Promise.all([saving, choosing, confirming])
  await page._draftSession.flush()
  assert.equal(page._viewSession.active, true)
  assert.equal(page.data.accountStepError, '')
  assert.equal(page.data.accountStepBusy, false)
  const writes = h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings')
  assert.deepEqual(writes.map(call => call.input.decisions.map(decision => decision.issueId)), h.issues.map(issue => [issue.issueId]))
  assert.deepEqual(writes.map(call => call.input.updateVersion), [1, 2])
  assert.equal(page._draftSession.state.entries.length, 0)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.post'), false)
})

test('接续期间重复点击确认，下一项只入队并保存一次', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation()
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  await page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  await page._draftSession.flush()
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 2)
  assert.equal(page.data.accountStepBusy, false)
})

test('接续期间目录读取失败，不沿用旧目录确认下一项', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation({ read(h, action) {
    if (action === 'financeUpdates.options') throw new Error('合成目录读取失败')
  } })
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.ok(page.data.accountStepError)
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).accountId, 'synthetic-account')
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).localConfirmed, false)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
})

test('接续期间批次已结束，不再确认下一项且退出忙碌状态', async t => {
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation({ afterCommit(h) {
    h.summary.update.status = 'abandoned'
  } })
  t.after(() => page.onUnload())
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.equal(page.data.update.status, 'abandoned')
  assert.match(page.data.accountStepError, /当前导入已结束/)
  assert.equal(page.data.accountStepBusy, false)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
})

test('补查已选账户后收到新问题版本，入队前仍核验原决定而不自动改成修订', async t => {
  // 账户目录一次读 100 条；第 101 个账户只能靠补查，才走得到补查后的版本核验。
  const directory = Array.from({ length: 101 }, (_, index) => ({ accountId: index ? 'synthetic-option-' + index : 'synthetic-account',
    name: '合成账户' + index, type: 'wallet', currency: 'CNY' }))
  const selectedId = directory[100].accountId
  const { h, page, summaryGate, saving, choosing } = await overlappingConfirmation({ directory, secondAccountId: selectedId })
  t.after(() => page.onUnload())
  const loadDirectories = page.loadDirectories
  let injected = false
  page.loadDirectories = async function (events, ids, kinds) {
    const result = await loadDirectories.call(this, events, ids, kinds)
    if (!injected && ids && ids.includes(selectedId)) {
      injected = true
      h.issues[1].version++; h.issues[1].status = 'resolved'
      h.issues[1].accountContext.accountId = 'synthetic-account'
      h.summary = { ...h.summary, update: { ...h.summary.update, version: 3 }, viewVersion: 'v3' }
      await page.applyUpdateView(h.summary, true)
    }
    return result
  }
  const confirming = page.completeAccountMapping(tap(h.issues[1].issueId))
  summaryGate.resolve(); await Promise.all([saving, choosing, confirming])
  assert.equal(injected, true)
  assert.match(page.data.accountStepError, /核对后再次确认/)
  assert.equal(page._draftSession.state.entries.some(entry => entry.issueId === h.issues[1].issueId), false)
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).accountId, selectedId)
  assert.equal(page._accountUiDrafts.get(h.issues[1].issueId).localConfirmed, false)
  assert.equal(h.calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
})

function createOnly(label = '不存在的卡') {
  const data = fixture(1, true)
  data.issues = [{ issueId: 'create-issue', issueType: 'account_mapping', status: 'open', version: 1, blocking: true,
    memberCount: 40, subject: data.events[0],
    accountContext: { recognized: true, sourceType: 'wechat', label, currency: 'CNY' } }]
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 1 }], 0, 0)
  return data
}

test('确认按钮说明本批会新建账户，并带上这些账户吃下的笔数', async t => {
  const h = runtime(createOnly()), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 1)
  assert.equal(page.data.accountMappings[0].choiceValue, 'create')
  assert.equal(page.data.accountStepSummary.plannedCreate, 1)
  assert.equal(page.data.accountStepSummary.batchNote, '本批将新建 1 个账户')
  // 这一项已经确认过、不用再点，但按钮仍要说明它会被建出来——新建是入账后果，不是待办。
  page._accountConfirmed.set('create-issue', { revision: 0 })
  page.refreshAccountMappings()
  assert.equal(page.data.accountStepSummary.batchable, 0)
  assert.equal(page.data.accountStepSummary.plannedCreate, 1)
  assert.equal(page.data.accountStepSummary.batchNote, '本批将新建 1 个账户')
  // 改选「不计入」后不再宣称新建，改口径为排除。
  page._accountConfirmed.delete('create-issue')
  const draft = page._accountUiDrafts.get('create-issue')
  draft.mode = 'ignore'; draft.dirty = true; draft.revision = 1; draft.localConfirmed = false
  page.refreshAccountMappings()
  assert.equal(page.data.accountStepSummary.plannedCreate, 0)
  assert.equal(page.data.accountStepSummary.batchNote, '1 项不计入')
})

test('来源名缺失时留空，不拿问题类型名冒充来源', async t => {
  const data = accounts()
  data.issues = [{ ...data.issues[0], issueId: 'no-source',
    accountContext: { recognized: false, sourceType: 'wechat', currency: 'CNY' } }]
  data.summary.workbench = workbenchSummary(data.events.slice(0, 1), [], [{ issueType: 'account_mapping', status: 'open', count: 1 }], 0, 0)
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 1)
  const mapping = page.data.accountMappings[0]
  assert.equal(mapping.label, '确认账户归属', '标题仍要有可读的兜底')
  assert.equal(mapping.sourceLabel, '', '但来源不能复用这个兜底')
  assert.equal(page.data.accountMappingsIncluded.map(row => row.sourceLabel).join(','), '')
})

test('分别确认拆开的同组卡在列表里按组挨在一起', async t => {
  const data = fixture(3, true)
  const labels = ['兴业银行信用卡(6106)', '微信零钱', '主卡6106']
  data.issues = data.events.map((event, index) => ({ issueId: 's-' + index, issueType: 'account_mapping',
    status: 'open', version: 1, blocking: true, memberCount: 1, subject: event,
    accountContext: { recognized: true, sourceType: 'wechat', label: labels[index], currency: 'CNY' } }))
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 3 }], 0, 0)
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  await until(() => page.data.accountMappings.length === 3)
  assert.equal(page.data.accountMappings.map(row => row.issueId).join(','), 's-0,s-1,s-2')
  // s-0 与 s-2 原本是同一张卡，点了「分别确认」后被拆成两张，中间还隔着别的账户。
  for (const id of ['s-0', 's-2']) page._accountUiDrafts.get(id).confirmationSeparate = true
  page._accountUiDrafts.set('joint:s-0', { separated: true, separatedMembers: ['s-0', 's-2'], anchorIssueId: 's-0' })
  page.refreshAccountMappings()
  assert.equal(page.data.accountMappings.map(row => row.issueId).join(','), 's-0,s-2,s-1')
})
