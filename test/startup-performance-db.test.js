// 本机隔离 MySQL + 真实 handler/Page；数据桥回调代理不等于云冷启动或手机可见帧。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { execFileSync } = require('node:child_process')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { api: API_GRANTS } = require('../scripts/runtime-role-grants')
const { createObserver } = require('../scripts/performance-observer')
const { splitSqlStatements } = require('../migrations/runner')
const root = path.resolve(__dirname, '..')
const moduleAt = (source, name) => require(path.join(source, 'cloudfunctions/catledger-api/src', name))
const identity = { provider: 'wechat-mini', subjectHash: moduleAt(root, 'handler').hashWechatSubject('synthetic-startup-readiness') }
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const round = value => Math.round(value * 100) / 100
const enabled = Boolean(process.env.CATLEDGER_TEST_DB_HOST)

function apiFor(source, pool, subject = 'synthetic-startup-readiness') {
  const bootstrapTimings = []
  const getPool = () => pool
  const repository = moduleAt(source, 'user-repository').createUserRepository({ getPool })
  const transactions = moduleAt(source, 'transaction-service').createTransactionService({ getPool })
  const catalog = moduleAt(source, 'catalog-service').createCatalogService({ getPool })
  const charges = moduleAt(source, 'loan-charge-sync').createLoanChargeSync({ getPool })
  const handler = moduleAt(source, 'handler').createHandler({ getWxContext: () => ({ OPENID: subject }), repository,
    services: { 'dashboard.get': transactions.dashboard, 'transactions.list': transactions.list,
      'statistics.get': transactions.statistics, 'catalog.get': catalog.get, 'reads.validate': catalog.validate,
      'loans.dueCharges': charges.dueCharges, 'loans.syncCharges': charges.syncCharges },
    logger: { info(entry) {
      if (entry.event !== 'catledger-bootstrap-timing') return
      bootstrapTimings.push(Object.fromEntries(Object.entries(entry).filter(([key, value]) =>
        /^(connection|readTransaction|identity|initialization|categories|commit|rollback|retry|elapsed)Ms$/.test(key) && Number.isFinite(value))))
    }, warn() {}, error() {} } })
  handler.bootstrapTimings = bootstrapTimings
  return handler
}

test('0030初始化标记可重入；老用户只读、并发补齐、失效身份和失败事务保持正确', { skip: !enabled, timeout: 120000 }, async () => {
  const lab = await isolatedMysql()
  try {
    const pool = await lab.role('api', API_GRANTS)
    const { createUserRepository } = moduleAt(root, 'user-repository')
    const repository = createUserRepository({ getPool: () => pool })
    const first = await repository.bootstrap(identity)
    assert.equal(first.isNewUser, true)
    const child = first.categories.find(row => row.parentId)
    const missing = first.categories.find(row => row.parentId && row.id !== child.id)
    const colliding = first.categories.find(row => row.parentId && ![child.id, missing.id].includes(row.id))
    await lab.owner.execute('UPDATE catledger_categories SET archived_at=CURRENT_TIMESTAMP(3),name=?,normalized_name=? WHERE uid=? AND category_id=?', ['已归档自定义', '已归档自定义', first.uid, child.id])
    await lab.owner.execute('DELETE FROM catledger_categories WHERE uid=? AND category_id IN (?,?)', [first.uid, missing.id, colliding.id])
    const customId = randomUUID()
    await lab.owner.execute('INSERT INTO catledger_categories(category_id,uid,kind,parent_id,name,normalized_name) VALUES(?,?,?,?,?,?)',
      [customId, first.uid, colliding.kind, colliding.parentId, colliding.name, moduleAt(root, 'category-name').normalizeCategoryName(colliding.name).normalizedName])
    await lab.owner.execute('UPDATE catledger_users SET initialization_version=0 WHERE uid=?', [first.uid])
    const results = await Promise.all(Array.from({ length: 8 }, () => repository.bootstrap(identity)))
    assert.ok(results.every(row => row.uid === first.uid && row.dataRevision === String(BigInt(first.dataRevision) + 1n)))
    const [[state]] = await lab.owner.execute('SELECT initialization_version AS initVersion,CAST(data_revision AS CHAR) AS dataRevision FROM catledger_users WHERE uid=?', [first.uid])
    assert.equal(Number(state.initVersion), 1)
    const [categories] = await lab.owner.execute('SELECT category_id AS id,system_key AS systemKey,name,archived_at AS archivedAt FROM catledger_categories WHERE uid=?', [first.uid])
    assert.equal(categories.filter(row => row.systemKey === missing.systemKey).length, 1)
    assert.equal(categories.filter(row => row.systemKey === colliding.systemKey).length, 0)
    assert.equal(categories.find(row => row.id === child.id).name, '已归档自定义')
    assert.ok(categories.find(row => row.id === child.id).archivedAt)
    assert.equal(categories.find(row => row.id === customId).name, colliding.name)
    const observer = createObserver(pool), fast = createUserRepository({ getPool: () => observer.pool })
    const repeated = await fast.bootstrap(identity)
    assert.equal(repeated.dataRevision, state.dataRevision)
    assert.equal(observer.snapshot().sqlCount, 5)
    assert.equal(observer.snapshot().userLockHoldMs, 0)
    assert.equal(repeated.categories.some(row => row.id === child.id), false)

    const migration = fs.readFileSync(path.join(root, 'migrations/0030_user_initialization_version.sql'), 'utf8')
    const connection = await lab.owner.getConnection()
    try { for (let run = 0; run < 2; run++) for (const sql of splitSqlStatements(migration)) await connection.query(sql) } finally { connection.release() }
    assert.deepEqual((await lab.owner.execute('SELECT initialization_version AS initVersion,CAST(data_revision AS CHAR) AS dataRevision FROM catledger_users WHERE uid=?', [first.uid]))[0][0], state)

    await lab.owner.execute("UPDATE catledger_users SET status='disabled' WHERE uid=?", [first.uid])
    await assert.rejects(repository.bootstrap(identity), { publicCode: 'INITIALIZATION_REQUIRED' })
    const failedSubject = moduleAt(root, 'handler').hashWechatSubject('synthetic-startup-rollback')
    const failurePool = { async getConnection() {
      const target = await pool.getConnection()
      return new Proxy(target, { get(connection, key) {
        if (key === 'execute') return async (sql, values) => {
          const result = await connection.execute(sql, values)
          if (sql.startsWith('UPDATE catledger_users SET initialization_version')) throw new Error('synthetic post-marker failure')
          return result
        }
        return typeof connection[key] === 'function' ? connection[key].bind(connection) : connection[key]
      } })
    } }
    await assert.rejects(createUserRepository({ getPool: () => failurePool }).bootstrap({ provider: 'wechat-mini', subjectHash: failedSubject }), /synthetic post-marker failure/)
    assert.equal((await lab.owner.execute('SELECT uid FROM catledger_user_identities WHERE subject_hash=?', [failedSubject]))[0].length, 0)
    assert.equal(Number((await lab.owner.query('SELECT COUNT(*) AS count FROM catledger_users'))[0][0].count), 1)
  } finally { await lab.close() }
})

test('费用检查有效期由服务端上海业务日期控制，跨零点立即换截止且不写库', { skip: !enabled, timeout: 120000 }, async () => {
  const lab = await isolatedMysql()
  try {
    const pool = await lab.role('api', API_GRANTS), getPool = () => pool
    const first = await moduleAt(root, 'user-repository').createUserRepository({ getPool }).bootstrap(identity)
    let now = Date.parse('2026-10-01T15:59:59.500Z')
    const service = moduleAt(root, 'loan-charge-sync').createLoanChargeSync({ getPool, now: () => now })
    const firstDue = await service.dueCharges({ ...identity, data: {}, read: {} })
    assert.equal(firstDue.cutoff, '2026-10-01'); assert.equal(firstDue.recheckAfterMs, 500)
    now += 600
    const next = await service.dueCharges({ ...identity, data: {}, read: {} })
    assert.equal(next.cutoff, '2026-10-02'); assert.equal(next.recheckAfterMs, 30000)
    assert.equal(next.dataRevision, first.dataRevision)
    assert.equal(Number((await lab.owner.query('SELECT COUNT(*) AS count FROM catledger_transactions'))[0][0].count), 0)
  } finally { await lab.close() }
})

async function measurePage(source, api, observer, savedStorage, mode) {
  const { runtime } = require(path.join(source, 'test/helpers/read-runtime'))
  const ui = runtime(savedStorage)
  ui.rawResponse = true; ui.app.approved = false; ui.app.globalData.uid = ''
  let responseBytes = 0, handlerPhases = []
  ui.respond = async (action, data) => {
    const call = ui.calls[ui.calls.length - 1]
    const started = performance.now()
    const result = await api({ action, data, ...(call.knownRevision === undefined ? {} : { knownRevision: call.knownRevision }) })
    handlerPhases.push({ action, serverMs: round(performance.now() - started) })
    responseBytes += bytes(result); return result
  }
  observer.reset()
  const startedAt = performance.now()
  const user = await ui.api.identifyWechatAccount()
  const identityMs = performance.now() - startedAt
  ui.app.globalData.uid = user.uid; ui.uid = user.uid; ui.app.approved = true
  const page = ui.page('index'), setData = page.setData
  let firstContentMs = null, sets = 0, setDataBytes = 0
  page.setData = function (patch, callback) {
    sets++; setDataBytes += bytes(patch)
    return setData.call(this, patch, function () {
      if (firstContentMs === null && page.data.hasDashboard) firstContentMs = performance.now() - startedAt
      if (callback) callback.call(page)
    })
  }
  page.onLoad(); await page.loadDashboard()
  assert.equal(page.data.hasDashboard, true, '失败读取不能算成更快的首页')
  assert.notEqual(firstContentMs, null)
  if (Object.hasOwn(page.data, 'dashboardFresh')) assert.equal(page.data.dashboardFresh, true)
  const latestMs = performance.now() - startedAt
  await ui.cache.settleStorage()
  const measured = observer.snapshot()
  const first = { mode, requests: ui.calls.length, sqlCount: measured.sqlCount, lockMs: round(measured.userLockHoldMs),
    identityMs: round(identityMs), firstContentMs: round(firstContentMs), identityToContentMs: round(firstContentMs - identityMs),
    latestMs: round(latestMs), responseBytes, sets, setDataBytes, handlerPhases }
  observer.reset(); ui.calls.length = 0; responseBytes = 0; handlerPhases = []
  const warmStart = performance.now(); await page.loadDashboard()
  const warm = { mode: 'repeat-home', requests: ui.calls.length, sqlCount: observer.snapshot().sqlCount, ms: round(performance.now() - warmStart), responseBytes, handlerPhases }
  page.onHide()
  return { first, warm, storage: ui.storage }
}

test('同机同库合成1000笔启动链路计量，可选基线检出与当前各3轮', { skip: !enabled, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const pool = await lab.role('api', API_GRANTS), getPool = () => pool
    const user = await moduleAt(root, 'user-repository').createUserRepository({ getPool }).bootstrap(identity)
    const account = await moduleAt(root, 'account-service').createAccountService({ getPool }).create({ ...identity, data: {
      requestId: randomUUID(), type: 'bank', name: '合成性能账户', currency: 'CNY', openingDisplayBalanceMinor: '1000000', occurredLocalAt: '2026-10-01T12:00:00', timezoneOffsetMinutes: -480 } })
    const month = new Date().toISOString().slice(0, 7), day = month + '-01'
    const values = Array.from({ length: 1000 }, () => [user.uid, randomUUID(), account.accountId, '100', user.categories.find(row => row.kind === 'expense').id, day, day + ' 12:00:00', -480, day + ' 04:00:00'])
    await lab.owner.query(`INSERT INTO catledger_transactions(uid,transaction_id,type,source_account_id,amount_minor,category_id,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,origin)
      VALUES ${values.map(() => "(?,?,'expense',?,?,?,?,?,?,?,'manual')").join(',')}`, values.flat())
    await lab.owner.execute('UPDATE catledger_users SET data_revision=data_revision+1,nickname=? WHERE uid=?', ['合成用户',user.uid])
    const sources = process.env.CATLEDGER_PERF_BASELINE_ROOT ? [{ label: 'baseline', directory: path.resolve(process.env.CATLEDGER_PERF_BASELINE_ROOT) }, { label: 'current', directory: root }] : [{ label: 'current', directory: root }]
    const samples = []
    for (const source of sources) {
      const observer = createObserver(pool), api = apiFor(source.directory, observer.pool)
      for (let run = 1; run <= 3; run++) {
        observer.reset(); api.bootstrapTimings.length = 0
        const start = performance.now(), result = await api({ action: 'bootstrap' }), metrics = observer.snapshot()
        assert.equal(result.ok, true); assert.equal(result.data.uid, user.uid)
        samples.push({ source: source.label, run, mode: 'initialized-bootstrap', requests: 1, sqlCount: metrics.sqlCount,
          lockMs: round(metrics.userLockHoldMs), connectionMs: round(metrics.connectionMs), ms: round(performance.now() - start), responseBytes: bytes(result),
          bootstrapPhases: api.bootstrapTimings.at(-1) || null })
        const initial = await measurePage(source.directory, api, observer, undefined, 'no-snapshot')
        const restored = await measurePage(source.directory, api, observer, initial.storage, 'stored-snapshot')
        for (const sample of [initial.first, restored.first, restored.warm]) samples.push({ source: source.label, run, ...sample })
      }
    }
    const sourceHash = directory => createHash('sha256').update(fs.readFileSync(path.join(directory, 'cloudfunctions/catledger-api/src/user-repository.js'))).update(fs.readFileSync(path.join(directory, 'miniprogram/pages/index/index.js'))).update(fs.readFileSync(path.join(directory, 'miniprogram/services/loan-charge-sync.js'))).digest('hex')
    const report = { environment: { node: process.version, mysql: (await lab.owner.query('SELECT VERSION() AS version'))[0][0].version, cpu: os.cpus()[0].model,
      runs: 3, transactions: 1000, timing: 'local handler/real Page VM setData callback proxy; excludes phone rendering, cloud cold-start and network',
      sources: sources.map(source => ({ label: source.label, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source.directory, encoding: 'utf8' }).trim(), measuredSourcesSha256: sourceHash(source.directory) })) }, samples }
    if (process.env.CATLEDGER_STARTUP_PERF_OUTPUT) fs.writeFileSync(process.env.CATLEDGER_STARTUP_PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n')
    t.diagnostic(JSON.stringify(report))
    assert.ok(samples.filter(row => row.source === 'current' && row.mode === 'initialized-bootstrap').every(row => row.sqlCount === 5 && row.lockMs === 0))
    assert.ok(samples.filter(row => row.source === 'current' && row.mode === 'repeat-home').every(row => row.requests === 0 && row.sqlCount === 0))
  } finally { await lab.close() }
})
