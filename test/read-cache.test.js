const test = require('node:test')
const assert = require('node:assert/strict')
const { createReadCache, stableKey } = require('../miniprogram/services/read-cache')
const { READ_POLICIES, mutationTags } = require('../miniprogram/services/read-policy')
const policy = { ttl: 100, tags: ['accounts'] }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

test('目录独立失效：普通交易和余额校正复用，结构与导入写入刷新', async () => {
  const cache = createReadCache(), key = stableKey('catalog.get'), policy = READ_POLICIES['catalog.get']
  const load = () => cache.read(key, policy, async () => ({ accounts: ['a'], categories: ['c'] }))
  await load()
  for (const action of ['transactions.create', 'transactions.update', 'transactions.delete', 'transactions.linkRefund', 'transactions.setCategory', 'accounts.correctBalance']) {
    await cache.mutate(mutationTags(action), async () => {})
    assert.ok(cache.peek(key), action)
  }
  for (const action of ['accounts.create', 'accounts.createBatch', 'accounts.update', 'accounts.archive', 'categories.create', 'categories.archive', 'categories.restore', 'categories.update', 'categories.reorder', 'financeUpdates.post', 'financeUpdates.undo', 'economicEvents.correct']) {
    await load()
    await cache.mutate(mutationTags(action), async () => {})
    assert.equal(cache.peek(key), null, action)
  }
})

test('目录peek在相关写入时不可用，过期和reset后不返回旧数据', async () => {
  let now = 0
  const cache = createReadCache({ now: () => now }), key = stableKey('catalog.get'), policy = READ_POLICIES['catalog.get']
  await cache.read(key, policy, async () => ({ accounts: ['a'] }))
  const copy = cache.peek(key); copy.accounts.push('local')
  assert.deepEqual(cache.peek(key), { accounts: ['a'] })
  const write = deferred()
  const writing = cache.mutate(['accountDirectory'], () => write.promise)
  assert.equal(cache.peek(key), null)
  let loaded = false
  const reading = cache.read(key, policy, async () => { loaded = true; return 'fresh' })
  await Promise.resolve()
  assert.equal(loaded, false)
  write.resolve(); await writing; await reading
  assert.equal(cache.peek(key), 'fresh')
  now = 300000
  assert.equal(cache.peek(key), null)
  await cache.read(key, policy, async () => 'next')
  cache.reset()
  assert.equal(cache.peek(key), null)
})

test('相同参数合并并发读取，缓存命中不联网且调用方修改不污染缓存', async () => {
  const cache = createReadCache()
  const pending = deferred()
  let calls = 0
  const load = () => { calls++; return pending.promise }
  const first = cache.read('accounts', policy, load)
  const second = cache.read('accounts', policy, load)
  pending.resolve({ accounts: [{ name: '合成账户' }] })
  const [a, b] = await Promise.all([first, second])
  a.accounts[0].name = '已修改'
  assert.equal(b.accounts[0].name, '合成账户')
  assert.equal((await cache.read('accounts', policy, load)).accounts[0].name, '合成账户')
  assert.equal(calls, 1)
  assert.equal(stableKey('list', { b: 2, a: 1 }), stableKey('list', { a: 1, b: 2 }))
  assert.notEqual(stableKey('list', { month: '2026-08' }), stableKey('list', { month: '2026-09' }))
})

test('有效期和主动刷新控制联网，失败不缓存且可重试', async () => {
  let now = 0, calls = 0
  const cache = createReadCache({ now: () => now })
  const load = async () => ++calls
  await cache.read('a', policy, load)
  now = 99
  assert.equal(await cache.read('a', policy, load), 1)
  now = 100
  assert.equal(cache.token('a'), null)
  assert.equal(await cache.read('a', policy, load), 2)
  assert.equal(await cache.read('a', policy, load, { force: true }), 3)
  await assert.rejects(cache.read('b', policy, () => Promise.reject(new Error('合成失败'))))
  assert.equal(await cache.read('b', policy, load), 4)
})

test('写入期间等待相关读取，旧响应不会覆盖写入后结果；无关分类缓存保留', async () => {
  const cache = createReadCache()
  await cache.read('categories', { ttl: 100, tags: ['categories'] }, async () => '分类')
  const old = deferred(), write = deferred()
  let calls = 0
  const load = () => ++calls === 1 ? old.promise : Promise.resolve('新余额')
  const reading = cache.read('accounts', policy, load)
  await Promise.resolve()
  const writing = cache.mutate(['accounts'], () => write.promise)
  const during = cache.read('accounts', policy, load)
  old.resolve('旧余额')
  await Promise.resolve()
  assert.ok(cache.token('categories'))
  write.resolve('已写入')
  await writing
  assert.deepEqual(await Promise.all([reading, during]), ['新余额', '新余额'])
  assert.equal(calls, 2)
})

test('写入失败也失效缓存，退出后旧请求不能进入新会话', async () => {
  const cache = createReadCache()
  await cache.read('a', policy, async () => 1)
  await assert.rejects(cache.mutate(['accounts'], async () => { throw new Error('写入结果未知') }))
  assert.equal(cache.token('a'), null)
  const old = deferred()
  const reading = cache.read('a', policy, () => old.promise)
  cache.reset()
  const fresh = await cache.read('a', policy, async () => 2)
  old.resolve(1)
  await assert.rejects(reading, { code: 'SESSION_CHANGED' })
  assert.equal(fresh, 2)
  assert.equal(await cache.read('a', policy, async () => 3), 2)
})

test('缓存有数量上限，首页账户复用不延长原结果有效期', async () => {
  let now = 0
  const cache = createReadCache({ now: () => now, maxEntries: 2 })
  await cache.read('dashboard', policy, async () => ({ accounts: [1] }))
  now = 90
  cache.seedFrom('dashboard', 'accounts', policy, result => ({ accounts: result.accounts }))
  assert.deepEqual(await cache.read('accounts', policy, async () => null), { accounts: [1] })
  now = 100
  assert.equal(cache.token('accounts'), null)
  await cache.read('a', policy, async () => 1)
  await cache.read('b', policy, async () => 2)
  await cache.read('c', policy, async () => 3)
  assert.equal(cache.token('a'), null)
})
