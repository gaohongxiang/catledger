const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { facts, packed, filesystem } = require('./helpers/local-review')
const { runtime } = require('./helpers/paged-workbench')
const resume = require('../miniprogram/packages/finance/services/import-local-resume')
const fileStore = require('../miniprogram/packages/finance/services/import-local-files')
const base = path.resolve(__dirname, '../miniprogram')
const env = require('../miniprogram/config/cloudbase').envId
const SCOPE = env + ':1234567890'
const HOUR = 60 * 60 * 1000

test('本机与服务端续接边界：12/24 与 24/48 小时按越过边界处理', () => {
  const now = Date.parse('2026-10-19T00:00:00Z')
  assert.equal(resume.localActivityState(now - 12 * HOUR + 1, now).state, 'fresh')
  assert.equal(resume.localActivityState(now - 12 * HOUR, now).state, 'idle')
  assert.equal(resume.localActivityState(now - 12 * HOUR, now).auto, false)
  assert.equal(resume.localActivityState(now - 24 * HOUR + 1, now).state, 'idle')
  assert.equal(resume.localActivityState(now - 24 * HOUR, now).state, 'expired')
  assert.equal(resume.localActivityState(now - 24 * HOUR, now).continueAllowed, false)
  assert.equal(resume.localActivityState(null, now).state, 'fresh')
  assert.equal(resume.localActivityState(undefined, now).state, 'fresh')

  assert.equal(resume.serverActivityState(24 * HOUR - 1).state, 'fresh')
  assert.equal(resume.serverActivityState(24 * HOUR).state, 'idle')
  assert.equal(resume.serverActivityState(24 * HOUR).auto, false)
  assert.equal(resume.serverActivityState(48 * HOUR - 1).state, 'idle')
  assert.equal(resume.serverActivityState(48 * HOUR).state, 'expired')
  assert.equal(resume.serverActivityState(null).state, 'fresh')
})

test('规则版本不一致：解析类要求重解析，纯语义变化允许重新整理', async () => {
  const value = await facts({ count: 2 })
  assert.equal(resume.versionState(value), null)

  const semantic = JSON.parse(JSON.stringify(value))
  semantic.ruleVersion = 'organizer-plan-v0'
  const semanticState = resume.versionState(semantic)
  assert.equal(semanticState.state, 'semantic')
  assert.equal(semanticState.canContinue, true)
  assert.equal(semanticState.requiresReorganize, true)

  for (const [field, old] of [['parserVersion', 'old-parser'], ['normalizationVersion', 'old-normalization'], ['identityVersion', 'old-identity']]) {
    const changed = JSON.parse(JSON.stringify(value))
    changed.sources[0][field] = old
    const state = resume.versionState(changed)
    assert.equal(state.state, 'reparse', field)
    assert.equal(state.canContinue, false)
    assert.equal(state.originalMissing, false)
    changed.sources[0].contentDeletedAt = '2026-10-18 00:00:00.000'
    assert.equal(resume.versionState(changed).originalMissing, true)
    changed.sources[0].contentDeletedAt = null
    changed.sources[0].contentState = 'discarded'
    assert.equal(resume.versionState(changed).originalMissing, true)
  }
})

test('本机活动时间：12h 不自动打开，继续后刷新；24h 清理；保存决定也续期', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts({ count: 2 }), wire = packed(value)
  let clock = Date.now()
  const store = fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE, updateId: value.update.updateId, now: () => clock })
  await store.download(wire.header, wire.call)
  const h = runtime({ summary: { update: value.update }, events: [], issues: [] }, {
    realLocalManager: true, realDraftManager: true, initialView: false, pageOptions: { fresh: '1' },
    wx: { env: { USER_DATA_PATH: lab.root }, getFileSystemManager: () => lab.fs }
  })
  t.after(() => h.page.onUnload())
  const manager = h.load(path.join(base, 'packages/finance/services/import-local-manager.js'))
  const createdAt = store.activity().lastActiveAt

  clock = createdAt + 13 * HOUR
  const idle = manager.restore(value.update.updateId, { now: () => clock })
  assert.equal(idle.resume.state, 'idle')
  assert.equal(idle.resume.canContinue, true)
  assert.match(idle.resume.title, /12 小时/)
  assert.equal(store.activity().lastActiveAt, createdAt, '仅检查不能刷新活动时间')

  clock = createdAt + 14 * HOUR
  const continued = manager.restore(value.update.updateId, { now: () => clock, force: true })
  assert.equal(continued.isLocal, true)
  assert.ok(continued.touch)
  assert.equal(store.activity().lastActiveAt, createdAt + 14 * HOUR)

  clock = createdAt + 15 * HOUR
  store.save([{ kind: 'draft', key: 'synthetic', value: { note: 'saved' } }])
  assert.equal(store.activity().lastActiveAt, createdAt + 15 * HOUR)

  clock = createdAt + 40 * HOUR
  h.load(path.join(base, 'services/import-local-router.js')).unbind(value.update.updateId)
  continued.close()
  const expired = manager.restore(value.update.updateId, { now: () => clock })
  assert.equal(expired.resume.state, 'expired')
  assert.equal(expired.resume.canContinue, false)
  assert.match(expired.resume.title, /24 小时/)
  assert.equal(fs.existsSync(store.directory), false)
})

test('24h 清扫有界处理其他无活动草稿，不删除仍在使用的当前草稿', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const first = await facts({ count: 1 }), second = await facts({ count: 1 })
  let clock = Date.now()
  const make = value => fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE, updateId: value.update.updateId, now: () => clock })
  const a = make(first), b = make(second)
  await a.download(packed(first).header, packed(first).call)
  clock += 1000
  await b.download(packed(second).header, packed(second).call)
  a.touch({ lastActiveAt: Date.now() - 25 * HOUR })

  const h = runtime({ summary: { update: second.update }, events: [], issues: [] }, {
    realLocalManager: true, realDraftManager: true, initialView: false, pageOptions: { fresh: '1' },
    wx: { env: { USER_DATA_PATH: lab.root }, getFileSystemManager: () => lab.fs }
  })
  t.after(() => h.page.onUnload())
  const manager = h.load(path.join(base, 'packages/finance/services/import-local-manager.js'))
  const current = manager.restore(second.update.updateId, { now: () => clock })
  assert.equal(current.isLocal, true)
  assert.equal(fs.existsSync(a.directory), false)
  assert.equal(fs.existsSync(b.directory), true)
})

test('未知入账结果优先于 24h 本机清理：先提示核实，强制继续仍保留冻结请求', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts({ count: 1 }); value.ruleVersion = 'organizer-plan-v0'
  const wire = packed(value)
  const createdAt = Date.now()
  const store = fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE, updateId: value.update.updateId, now: () => createdAt })
  await store.download(wire.header, wire.call)
  store.save([{ kind: 'ui', key: 'postFlight', value: { action: 'financeUpdates.post',
    payload: { requestId: '11111111-1111-4111-8111-111111111111', updateId: value.update.updateId } } }])

  const h = runtime({ summary: { update: value.update }, events: [], issues: [] }, {
    realLocalManager: true, realDraftManager: true, initialView: false, pageOptions: { fresh: '1' },
    wx: { env: { USER_DATA_PATH: lab.root }, getFileSystemManager: () => lab.fs }
  })
  t.after(() => h.page.onUnload())
  const manager = h.load(path.join(base, 'packages/finance/services/import-local-manager.js'))
  const clock = createdAt + 25 * HOUR
  const notice = manager.restore(value.update.updateId, { now: () => clock })
  assert.equal(notice.resume.state, 'post_pending')
  assert.equal(notice.resume.canContinue, true)
  assert.equal(fs.existsSync(store.directory), true)

  const frozen = manager.restore(value.update.updateId, { now: () => clock, force: true })
  assert.equal(frozen.isLocal, true)
  assert.equal(frozen.state.postFlight.payload.requestId, '11111111-1111-4111-8111-111111111111')
})
