const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { facts, packed, filesystem } = require('./helpers/local-review')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const { workbenchSummary } = require('../cloudfunctions/catledger-import/src/workbench-summary')
const fileStore = require('../miniprogram/packages/finance/services/import-local-files')
const base = path.resolve(__dirname, '../miniprogram')
const env = require('../miniprogram/config/cloudbase').envId
const SCOPE = env + ':1234567890'
const HOUR = 60 * 60 * 1000
async function until(check, label = 'the expected page state was reached') {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await flush()
  assert.ok(check(), label)
}
function pageRuntime(lab, options = {}) {
  return runtime(options.data || { summary: options.summary || { update: {} }, events: [], issues: [] }, {
    ...options.runtime, realLocalManager: true, realDraftManager: true, realImportApi: options.realImportApi === true, initialView: false,
    pageOptions: options.pageOptions || {},
    beforePage(h) { if (options.intercept) h.intercept = options.intercept },
    wx: { env: { USER_DATA_PATH: lab.root }, getFileSystemManager: () => lab.fs }
  })
}
async function localSnapshot(lab, { count = 2, mutate, activeAt = Date.now() } = {}) {
  const value = await facts({ count, mapped: false })
  if (mutate) mutate(value)
  const wire = packed(value)
  const store = fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE,
    updateId: value.update.updateId })
  await store.download(wire.header, wire.call)
  store.touch({ lastActiveAt: activeAt, serverTouchedAt: Date.now() })
  return { value, wire, store }
}

test('真实 Page：本机 12 小时门禁明确提示，继续后打开账户页并刷新活动时间', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const activeAt = Date.now() - 13 * HOUR
  const { value, store } = await localSnapshot(lab, { activeAt })
  const h = pageRuntime(lab, { summary: { update: value.update }, realImportApi: true, pageOptions: { updateId: value.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), '12h gate should render')
  assert.match(h.page.data.resumeNotice.title, /12 小时/)
  assert.equal(h.page.data.resumeNotice.canContinue, true)
  assert.equal(h.page.data.restoreUpdateId, value.update.updateId)
  assert.equal(h.page.data.phase, 'resume')
  assert.equal(h.calls.length, 0, '门禁本身不应该访问网络')

  await h.page.continueBlockedResume()
  await until(() => h.page.data.phase === 'review', '继续后应进入核对页')
  await h.page.setStep({ currentStep: 2 })
  await until(() => h.page.data.accountMappings.length > 0, '继续后账户页应可渲染')
  assert.ok(h.page.data.accountMappingsIncluded.length, '账户页不能白屏')
  assert.equal(h.page.data.resumeNotice, null)
  assert.ok(store.activity().lastActiveAt > activeAt)
  t.diagnostic('真实 Page 12h 门禁：继续后账户页非空')
})

test('真实 Page：24 小时已清理门禁无继续入口，放弃后回到选文件', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const activeAt = Date.now() - 25 * HOUR
  const { value, store } = await localSnapshot(lab, { activeAt })
  const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), '24h gate should render')
  assert.match(h.page.data.resumeNotice.title, /24 小时/)
  assert.equal(h.page.data.resumeNotice.canContinue, false)
  assert.equal(fs.existsSync(store.directory), false)
  const markup = fs.readFileSync(path.join(base, 'packages/finance/pages/import-workbench/index.wxml'), 'utf8')
  assert.match(markup, /data-ui="resume-gate"/)
  assert.match(markup, /bindtap="continueBlockedResume"/)
  assert.match(markup, /bindtap="abandonRestoringUpdate"/)
  assert.match(markup, /abandon-spinner/)
  assert.match(markup, /放弃中/)

  h.intercept = action => action === 'financeUpdates.summary'
    ? { ...h.summary, update: { ...h.summary.update, status: 'abandoned' } } : undefined
  await h.page.abandonRestoringUpdate()
  await until(() => h.page.data.phase === 'idle', '放弃后应回到第一步')
  assert.equal(h.page.data.resumeNotice, null)
  assert.equal(h.page.data.update, null)
})

test('真实 Page：解析规则变化要求重新上传，原件已清理时提示更明确', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  for (const missing of [false, true]) {
    const { value } = await localSnapshot(lab, { activeAt: Date.now(), mutate: factsValue => {
      factsValue.sources[0].parserVersion = 'legacy-parser-v0'
      if (missing) factsValue.sources[0].contentDeletedAt = '2026-10-18 00:00:00.000'
    } })
    const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId } })
    await until(() => Boolean(h.page.data.resumeNotice), 'parse gate should render')
    assert.match(h.page.data.resumeNotice.title, /解析规则已更新/)
    assert.equal(h.page.data.resumeNotice.canContinue, false)
    assert.equal(h.page.data.resumeNotice.originalMissing, missing)
    assert.match(h.page.data.resumeNotice.message, /重新上传/)
    if (missing) assert.match(h.page.data.resumeNotice.message, /原件已清理/)
    assert.equal(h.calls.length, 0)
    h.page.onUnload()
  }
})

test('真实 Page：语义规则变化提示重新整理并保留待继续入口', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const { value } = await localSnapshot(lab, { activeAt: Date.now(), mutate: factsValue => {
    factsValue.ruleVersion = 'organizer-plan-v0'
  } })
  const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), 'semantic gate should render')
  assert.match(h.page.data.resumeNotice.title, /整理规则已更新/)
  assert.equal(h.page.data.resumeNotice.canContinue, true)
  assert.equal(h.page.data.resumeNotice.state, 'semantic')
  assert.match(h.page.data.resumeNotice.continueLabel, /重新整理/)
  assert.equal(h.calls.length, 0)
})


test('真实 Page：语义规则变化继续时先 organize，再强制新快照并迁移已保存决定', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const oldValue = await facts({ count: 2, mapped: false })
  oldValue.ruleVersion = 'organizer-plan-v0'
  const oldWire = packed(oldValue)
  const store = fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE, updateId: oldValue.update.updateId })
  await store.download(oldWire.header, oldWire.call)
  store.touch({ lastActiveAt: Date.now(), serverTouchedAt: Date.now() })
  store.save([{ kind: 'draft', key: 'legacy', value: { note: '保留的旧选择' } }])
  const nextValue = await facts({ count: 2, mapped: false })
  nextValue.update.updateId = oldValue.update.updateId
  nextValue.update.version = 4
  const nextWire = packed(nextValue)
  const h = pageRuntime(lab, { summary: { update: { ...oldValue.update, reviewMode: 'local_v3' } },
    pageOptions: { updateId: oldValue.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), 'semantic gate should render')
  assert.equal(h.page.data.resumeNotice.state, 'semantic')
  h.intercept = (action, input) => {
    if (action === 'financeUpdates.summary') return { ...h.summary, update: { ...h.summary.update, status: 'review',
      reviewMode: 'local_v3', requiresReorganization: true, version: 2, ageMs: 0 } }
    if (action === 'financeUpdates.organize') return { update: { ...h.summary.update, status: 'review',
      reviewMode: 'local_v3', requiresReorganization: false, version: 3, ageMs: 0 } }
    if (action === 'financeUpdates.prepareSnapshot') return { update: { ...h.summary.update, status: 'review',
      reviewMode: 'local_v3', requiresReorganization: false, version: 4, ageMs: 0 }, snapshot: nextWire.header }
    if (action.startsWith('financeUpdates.snapshot')) return nextWire.call(action, input)
  }
  await h.page.continueBlockedResume()
  await until(() => h.page.data.phase === 'review', 'semantic continue should open review')
  assert.ok(h.calls.some(call => call.action === 'financeUpdates.organize'))
  const prepared = h.calls.find(call => call.action === 'financeUpdates.prepareSnapshot')
  assert.equal(prepared.input.force, true)
  assert.equal(h.page._draftSession.state.drafts.legacy.note, '保留的旧选择')
  assert.equal(h.page.data.resumeNotice, null)
})


test('真实 Page：本机新鲜但服务端租约超过 24h 时只在恢复边界续期，随后照常打开', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const { value, store } = await localSnapshot(lab, { activeAt: Date.now() })
  store.touch({ serverTouchedAt: Date.now() - 25 * HOUR })
  const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId },
    intercept: (action) => action === 'financeUpdates.prepareSnapshot' ? { update: { ...value.update, ageMs: 0 } } : undefined })
  t.after(() => h.page.onUnload())
  await until(() => h.page.data.phase === 'review', 'lease refresh should still open the local session')
  const prepared = h.calls.find(call => call.action === 'financeUpdates.prepareSnapshot')
  assert.ok(prepared)
  assert.equal(prepared.input.updateId, value.update.updateId)
  assert.equal(prepared.input.force, undefined)
  assert.ok(store.activity().serverTouchedAt > Date.now() - 1000)
})

test('真实 Page：服务端 24 小时不自动打开，继续后可恢复；48 小时不可继续', async t => {
  for (const [ageMs, state, canContinue, title] of [
    [25 * HOUR, 'idle', true, /24 小时/],
    [49 * HOUR, 'expired', false, /48 小时/]
  ]) {
    const data = fixture(2)
    data.summary.update = { ...data.summary.update, status: 'review', reviewMode: 'local_v3', ageMs }
    const h = runtime(data, { initialView: false, pageOptions: { updateId: data.summary.update.updateId } })
    const page = h.page
    await until(() => Boolean(page.data.resumeNotice), 'server gate should render')
    assert.match(page.data.resumeNotice.title, title)
    assert.equal(page.data.resumeNotice.source, 'server')
    assert.equal(page.data.resumeNotice.state, state)
    assert.equal(page.data.resumeNotice.canContinue, canContinue)
    if (canContinue) {
      await page.continueBlockedResume()
      await until(() => page.data.phase === 'review', 'manual server resume should open')
      assert.equal(page.data.resumeNotice, null)
    }
    page.onUnload()
  }
})

function accountFixture() {
  const data = fixture(2)
  data.issues = data.events.map((event, index) => ({ issueId: 'resume-account-' + index, issueType: 'account_mapping',
    status: 'open', version: 1, blocking: true, memberCount: 1, subject: event,
    accountContext: { recognized: true, sourceType: 'wechat', label: '合成钱包', currency: 'CNY' } }))
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 2 }], 0, 0)
  return data
}

test('账户页滚动恢复在真实 Page 上记录并恢复位置，不因后台刷新丢失账户列表', async t => {
  const data = accountFixture()
  const scrolls = []
  const h = runtime(data, { wx: { pageScrollTo: options => scrolls.push(options.scrollTop) } })
  const page = h.page
  await page.setStep({ currentStep: 2 })
  await until(() => page.data.accountMappings.length > 0, '账户页应有内容')
  page.onPageScroll({ scrollTop: 486 })
  assert.equal(page._pageScrollTop, 486)
  page._accountScrollTarget = 486
  page.restoreAccountScroll()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(scrolls.includes(486), '应恢复账户页滚动位置')
  page.applyUpdateView({ ...h.summary, viewVersion: 'v2' }, true)
  await flush()
  assert.ok(page.data.accountMappingsIncluded.length, '后台刷新后账户页不能变成 0/0 白屏')
  page._accountScrollTarget = 486
  page.restoreAccountScroll()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(scrolls.includes(486))
  page.onUnload()
})
