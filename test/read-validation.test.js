const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const { createReadCache, stableKey } = require('../miniprogram/services/read-cache')
const { READ_POLICIES } = require('../miniprogram/services/read-policy')
const { KEY, MAX_ENTRIES, MAX_BYTES, MAX_ENTRY_BYTES, MAX_AGE } = require('../miniprogram/services/read-snapshot-store')
const { bytes } = require('../miniprogram/services/read-observer')
const { envId } = require('../miniprogram/config/cloudbase')
const flush = () => new Promise(resolve => setImmediate(resolve))
const meta = (value = {}, dataRevision = '1', uid = '1234567890') => ({ readVersion: 1, uid, dataRevision, unchanged: false, ...value })

test('回前台多页面共用一次轻量校验，同版本复用原值与分页令牌', async () => {
  const h = runtime()
  await Promise.all([h.api.callApi('dashboard.get'), h.api.callApi('statistics.get'), h.api.callApi('catalog.get')])
  const token = h.api.cacheToken('dashboard.get'), before = h.calls.length
  let release
  h.intercept = action => action === 'reads.validate' ? new Promise(resolve => { release = resolve }) : undefined
  const validation = h.api.revalidateForeground(), joined = h.api.revalidateForeground()
  assert.equal(validation, joined)
  assert.equal(h.api.isFresh('dashboard.get'), false)
  const read = h.api.callApi('dashboard.get')
  await flush(); assert.equal(h.calls.length, before + 1)
  release(); await Promise.all([validation, read])
  assert.equal(h.calls.length, before + 1)
  assert.equal(h.api.cacheToken('dashboard.get'), token)
  assert.equal(h.api.isFresh('statistics.get'), true)
  assert.equal(h.api.isFresh('catalog.get'), true)
})

test('远端变化保留旧快照，校验失败不标新鲜；再次校验后只重读所需数据', async () => {
  const h = runtime(); await h.api.callApi('dashboard.get')
  h.respond = action => action === 'reads.validate' ? { ok: false, error: { code: 'FORBIDDEN', message: '合成失败' } } : undefined
  await assert.rejects(h.api.revalidateForeground())
  assert.equal(h.api.isFresh('dashboard.get'), false)
  assert.ok(h.cache.snapshot(stableKey('dashboard.get')))
  h.respond = null; h.revision = '2'
  await h.api.revalidateForeground()
  assert.equal(h.api.isFresh('dashboard.get'), false)
  let shown
  const value = await h.api.callApi('dashboard.get', {}, { onSnapshot: old => { shown = old } })
  assert.equal(shown.dataRevision, '1'); assert.equal(value.dataRevision, '2')
  assert.equal(h.calls.at(-1).knownRevision, '1')
})

test('写屏障与校验交错时等待正式写结果，旧校验不能恢复新鲜标记', async () => {
  const h = runtime(); await h.api.callApi('accounts.list')
  let writeDone
  h.intercept = action => action === 'accounts.update' ? new Promise(resolve => { writeDone = resolve }) : undefined
  const write = h.api.callApi('accounts.update', { requestId: 'synthetic' })
  const validation = h.api.revalidateForeground(), read = h.api.callApi('accounts.list')
  await flush(); assert.equal(h.calls.some(c => c.action === 'reads.validate'), false)
  writeDone(); await Promise.all([write, validation]); const value = await read
  assert.equal(value.dataRevision, '2'); assert.equal(h.api.isFresh('accounts.list'), true)
})

test('条件读取只接受匹配的完整快照，缺快照时重取同接口；协议错误绝不降级', async () => {
  const h = runtime(); h.rawResponse = true
  h.respond = (_, __) => ({ ok: true, data: { ...meta({}), unchanged: true } })
  await assert.rejects(h.api.callApi('accounts.list'), { code: 'INVALID_RESPONSE' })
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(c => c.action === 'accounts.list' && c.knownRevision === undefined))
  for (const data of [{ accounts: [] }, meta({ uid: '2234567890' }), meta({}, '01'), meta({}, '18446744073709551616')]) {
    h.respond = () => ({ ok: true, data })
    await assert.rejects(h.api.callApi('accounts.list'), { code: 'INVALID_RESPONSE' })
  }
  assert.equal(h.api.peek('accounts.list'), null)
})

test('较早一致性快照迟到时重读，不覆盖已观察到的大版本', async () => {
  const h = runtime(); h.revision = '9007199254740994'
  let release, statisticsCalls = 0
  h.respond = async action => {
    if (action !== 'statistics.get') return
    if (++statisticsCalls === 1) { await new Promise(resolve => { release = resolve }); return { ok: true, data: meta({ summary: {}, cashFlowTrend: [] }, '9007199254740993') } }
    return { ok: true, data: meta({ summary: {}, cashFlowTrend: [] }, h.revision) }
  }
  const old = h.api.callApi('statistics.get'); await flush()
  await h.api.callApi('accounts.list'); release()
  assert.equal((await old).dataRevision, h.revision); assert.equal(statisticsCalls, 2)
})

test('重启仅在当前身份确认后恢复完整快照，校验前仍为脏；用户及环境隔离', async () => {
  const first = runtime(); await first.api.callApi('dashboard.get')
  assert.ok(first.storage.get(KEY))
  const h = runtime(first.storage); h.app.approved = false; h.app.globalData.uid = ''
  let shown = 0
  await assert.rejects(h.api.callApi('dashboard.get', {}, { onSnapshot: () => shown++ }), { code: 'LOGIN_REQUIRED' })
  assert.equal(shown, 0)
  await h.api.identifyWechatAccount(); h.app.approved = true; h.app.globalData.uid = h.uid
  h.respond = action => action === 'dashboard.get' ? { ok: false, error: { code: 'FORBIDDEN', message: '合成失败' } } : undefined
  await assert.rejects(h.api.callApi('dashboard.get', {}, { onSnapshot: () => shown++ }))
  assert.equal(shown, 1); assert.equal(h.api.isFresh('dashboard.get'), false)
  const other = runtime(first.storage); other.uid = '2234567890'; other.app.globalData.uid = other.uid
  await other.api.callApi('dashboard.get', {}, { onSnapshot: () => shown++ }); assert.equal(shown, 1)
  const envCache = createReadCache({ now: () => 0, storage: { get: k => first.storage.get(k) } })
  envCache.bindScope('different-env', first.uid)
  assert.equal(envCache.snapshot(stableKey('dashboard.get')), null)
})

test('缓存只淘汰展示快照，容量/24小时/损坏/schema与退出都不误删原请求', async () => {
  let now = 0
  const storage = new Map([['catledger_pending_ledger_v1:synthetic', { requestId: 'original' }]])
  const io = { get: k => storage.get(k), set: (k,v) => storage.set(k,v), remove: k => storage.delete(k) }
  const make = () => createReadCache({ now: () => now, storage: io })
  const cache = make(); cache.bindScope(envId, '1234567890')
  for (let i = 0; i < 20; i++) await cache.read(stableKey('accounts.list', { i }), READ_POLICIES['accounts.list'], async () => meta({ accounts: [{ note: '合'.repeat(18000) }] }))
  for (let i = 0; i < 6; i++) await cache.read(stableKey('transactions.list', { cursor: i }), READ_POLICIES['transactions.list'], async () => meta({ transactions: [], nextCursor: null }))
  await cache.read(stableKey('accounts.list', { huge: true }), READ_POLICIES['accounts.list'], async () => meta({ accounts: [{ note: 'x'.repeat(MAX_ENTRY_BYTES) }] }))
  const raw = storage.get(KEY), disk = JSON.parse(raw)
  assert.ok(bytes(disk) <= MAX_BYTES); assert.ok(disk.entries.length <= MAX_ENTRIES)
  assert.equal(disk.entries.filter(e => e.key.startsWith('transactions.list')).length, 3)
  assert.ok(disk.entries.every(e => bytes(e) <= MAX_ENTRY_BYTES))
  assert.ok(storage.has('catledger_pending_ledger_v1:synthetic'))
  for (const corrupted of ['{', JSON.stringify({ ...disk, schema: 99 }), JSON.stringify({ ...disk, entries: [{ key: 'accounts.list:{}', updatedAt: 0, value: meta({}) }] })]) {
    storage.set(KEY, corrupted); const fresh = make(); fresh.bindScope(envId, '1234567890'); assert.equal(fresh.snapshot('accounts.list:{}'), null)
  }
  storage.set(KEY, raw); now = MAX_AGE
  const expired = make(); expired.bindScope(envId, '1234567890'); assert.equal(expired.snapshot(disk.entries[0].key), null)
  expired.reset(); assert.equal(storage.has(KEY), false); assert.ok(storage.has('catledger_pending_ledger_v1:synthetic'))
})

test('存储不可用和禁用持久化均不影响正式写入，也不允许旧会话迟到落盘', async () => {
  const cache = createReadCache({ storage: { get() { throw Error('full') }, set() { throw Error('full') }, remove() { throw Error('full') } } })
  cache.bindScope(envId, '1234567890')
  assert.equal(await cache.mutate(['accounts'], async () => 'confirmed'), 'confirmed')
  await cache.read('accounts.list:{}', READ_POLICIES['accounts.list'], async () => meta({ accounts: [] }))
  const h = runtime(); let release
  h.intercept = () => new Promise(resolve => { release = resolve })
  const old = h.api.callApi('dashboard.get'); await flush(); h.cache.reset(); h.app.approved = false; release()
  await assert.rejects(old, { code: 'SESSION_CHANGED' }); assert.equal(h.storage.has(KEY), false)
  let storageCalls = 0
  const disabled = createReadCache({ persistence: false, storage: { get() { storageCalls++ }, set() { storageCalls++ } } })
  disabled.bindScope(envId, '1234567890'); await disabled.read('accounts.list:{}', READ_POLICIES['accounts.list'], async () => meta({ accounts: [] }))
  assert.equal(storageCalls, 0)
})

test('贷款返回复用当前版本；目录慢载时资料独立恢复，失效资料不能提交', async () => {
  const h = runtime(), page = h.page('loan-detail'); page._loanId = 'synthetic-loan'
  h.respond = action => action === 'loans.get' ? { ok: true, data: meta({ loan: { loanId: page._loanId, accountId: 'account-a', name: '合成贷款', baselineDate: '2026-09-01', baselinePrincipalMinor: '0', remainingPrincipalMinor: '0', status: 'settled' } }) } : undefined
  await page.load(); const count = h.calls.length; await page.load(); assert.equal(h.calls.length, count)
  h.cache.invalidate(['accountDirectory', 'loans'])
  let release
  h.intercept = action => action === 'catalog.get' ? new Promise(resolve => { release = resolve }) : undefined
  h.respond = () => ({ ok: false, error: { code: 'FORBIDDEN', message: '合成失败' } })
  const reload = page.load(); assert.ok(page.data.loan); await flush(); assert.ok(page.data.loan); release(); await reload
  assert.match(page.data.errorMessage, /上次结果/)
  page.edit(); assert.equal(page.data.formOpen, false)
})

test('前台轻量读取瞬时失败重试一次，最终失败不承诺最新', async () => {
  const h = runtime(); await h.api.callApi('dashboard.get')
  h.intercept = action => { if (action === 'reads.validate') throw { errMsg: 'request:fail timeout' } }
  await assert.rejects(h.api.revalidateForeground(), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' })
  assert.equal(h.calls.filter(c => c.action === 'reads.validate').length, 2)
  assert.equal(h.api.isFresh('dashboard.get'), false)
})

test('快照恢复先标更新中，确认新鲜才清提示；排队持久化不能穿越退出', async () => {
  const h = runtime(), home = h.page('index'); await home.loadDashboard()
  h.cache.invalidate(['accounts'])
  let release
  h.intercept = () => new Promise(resolve => { release = resolve })
  const pending = home.loadDashboard()
  assert.match(home.data.errorMessage, /正在更新.*上次结果/)
  await flush(); release(); await pending
  assert.equal(home.data.errorMessage, '')
  // 同步派生多个缓存的写盘合并到下一微任务；退出作废队列。
  let writes = 0
  const cache = createReadCache({ storage: { get() {}, set() { writes++ }, remove() {} } })
  cache.bindScope(envId, '1234567890')
  await cache.read('accounts.list:{}', READ_POLICIES['accounts.list'], async () => meta({ accounts: [] }))
  const before = writes
  cache.seedFrom('accounts.list:{}', 'accounts.list:{"one":1}', READ_POLICIES['accounts.list'], x => x)
  cache.seedFrom('accounts.list:{}', 'accounts.list:{"two":2}', READ_POLICIES['accounts.list'], x => x)
  cache.reset(); await flush()
  assert.equal(writes, before)
})

test('贷款写后返回补齐并行读取中失效的旧目录，不要求用户再手动重读', async () => {
  const h = runtime(), page = h.page('loan-detail'); page._loanId = 'synthetic-loan'
  h.respond = action => action === 'loans.get' ? { ok: true, data: { loan: { loanId: page._loanId, accountId: 'account-a', name: '合成贷款', baselineDate: '2026-09-01', baselinePrincipalMinor: '0', remainingPrincipalMinor: '0', status: 'settled' } } } : undefined
  await page.load(); assert.equal(page.contextFresh(), true)
  await h.api.callApi('loans.update', { requestId: 'synthetic' })
  await page.load(); assert.equal(page.contextFresh(), true); assert.equal(page.data.errorMessage, '')
  const count = h.calls.length; await page.load(); assert.equal(h.calls.length, count)
})
