const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')

async function setup(lab) {
  const subject = 'recovery-fence-' + randomUUID(), objects = new Map()
  const services = localServices({ apiPool: lab.owner, importPool: lab.owner, subject, objects })
  const { uid } = await call(services.api, 'bootstrap')
  await call(services.api, 'accounts.create', { requestId: randomUUID(), name: '微信零钱', type: 'wallet' })
  const update = await prepareSyntheticUpdate(services, 1, randomUUID())
  const prepared = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
  const state = { protocolVersion: 3, snapshotId: prepared.snapshot.objectId, updateId: update.updateId,
    baseVersion: prepared.snapshot.baseVersion, ruleVersion: prepared.snapshot.ruleVersion,
    decisions: { accounts: [], events: [], pairings: [], reviews: [], duplicates: [] } }
  const packed = protocol.split(JSON.stringify(state), 'decisions'), uploadId = randomUUID()
  for (const part of packed.parts) await call(services.import, 'financeUpdates.stageDecisions', { requestId: randomUUID(), updateId: state.updateId,
    snapshotId: state.snapshotId, uploadId, baseVersion: state.baseVersion, ruleVersion: state.ruleVersion, chunkCount: packed.chunkCount, index: part.index, content: part.content })
  const sealed = await call(services.import, 'financeUpdates.sealDecisions', { requestId: randomUUID(), updateId: state.updateId, snapshotId: state.snapshotId, uploadId })
  return { services, subject, objects, uid, updateId: state.updateId, version: state.baseVersion,
    post: { requestId: randomUUID(), protocolVersion: 3, updateId: state.updateId, version: state.baseVersion, snapshotId: state.snapshotId, uploadId, payloadDigest: sealed.digest } }
}

// 停在公共写锁之前。post/force的只读事实捕获此时已经完成，覆盖锁外读取的竞态。
function mutationGate(pool) {
  let reached, release, used = false
  const ready = new Promise(resolve => { reached = resolve }), resume = new Promise(resolve => { release = resolve })
  return { ready, release, pool: { async getConnection() {
    const connection = await pool.getConnection(), execute = connection.execute.bind(connection), originalRelease = connection.release.bind(connection)
    connection.execute = async (sql, values) => {
      if (!used && /SELECT uid FROM catledger_users.*FOR UPDATE/.test(sql)) { used = true; reached(); await resume }
      return execute(sql, values)
    }
    connection.release = () => { connection.execute = execute; connection.release = originalRelease; originalRelease() }
    return connection
  } } }
}
async function ledger(pool, uid) {
  const [[row]] = await pool.execute('SELECT COUNT(*) AS count,COALESCE(SUM(amount_minor),0) AS amount FROM catledger_transactions WHERE uid=?', [uid])
  return { count: Number(row.count), amount: String(row.amount) }
}

test('损坏草稿恢复的服务端版本栅栏：force/abandon与旧post串行裁决且回执可重放', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
  const lab = await isolatedMysql()
  try {
    for (const scenario of ['force-first','post-before-force','abandon-first','post-before-abandon']) await t.test(scenario, async () => {
      const c = await setup(lab), gate = mutationGate(lab.owner)
      const slow = localServices({ apiPool: lab.owner, importPool: gate.pool, subject: c.subject, objects: c.objects })
      const force = { requestId: randomUUID(), updateId: c.updateId, version: c.version, force: true }
      const abandon = { requestId: randomUUID(), updateId: c.updateId, version: c.version }
      const losingAction = scenario.endsWith('first') ? 'financeUpdates.post' : scenario === 'post-before-force' ? 'financeUpdates.prepareSnapshot' : 'financeUpdates.abandon'
      const losingData = losingAction === 'financeUpdates.post' ? c.post : losingAction === 'financeUpdates.prepareSnapshot' ? force : abandon
      const losing = call(slow.import, losingAction, losingData).then(value => ({ value }), error => ({ error }))
      let winner
      try {
        await Promise.race([gate.ready, losing.then(result => {
          if (result.error) throw result.error
          throw new Error('测试请求未到写锁便已返回')
        })])
        if (scenario === 'force-first') winner = await call(c.services.import, 'financeUpdates.prepareSnapshot', force)
        else if (scenario === 'abandon-first') winner = await call(c.services.import, 'financeUpdates.abandon', abandon)
        else winner = await call(c.services.import, 'financeUpdates.post', c.post)
      } finally { gate.release() }
      const result = await losing
      assert.equal(result.error?.publicCode, 'CONFLICT', '已捕获旧事实的请求也必须在写锁内重新裁决')
      const summary = await call(c.services.import, 'financeUpdates.summary', { updateId: c.updateId })
      if (scenario === 'force-first') {
        assert.equal(summary.update.status, 'review'); assert.equal(summary.update.version, c.version + 1)
        assert.deepEqual(await ledger(lab.owner, c.uid), { count: 0, amount: '0' })
        const replay = await call(c.services.import, 'financeUpdates.prepareSnapshot', force)
        assert.deepEqual(replay, winner, 'force响应丢失后同请求恢复同一快照')
        const repeated = await call(c.services.import, 'financeUpdates.summary', { updateId: c.updateId })
        assert.equal(repeated.update.version, c.version + 1)
        const [[snapshots]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_import_review_objects WHERE uid=? AND update_id=? AND object_kind='snapshot'", [c.uid, c.updateId])
        assert.equal(Number(snapshots.count), 2)
      } else if (scenario === 'abandon-first') {
        assert.equal(summary.update.status, 'abandoned'); assert.equal(summary.update.version, c.version + 1)
        assert.deepEqual(await ledger(lab.owner, c.uid), { count: 0, amount: '0' })
        const [[objects]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_import_review_objects WHERE uid=? AND update_id=?', [c.uid, c.updateId])
        assert.equal(Number(objects.count), 0)
      } else {
        assert.equal(winner.status, 'posted'); assert.equal(summary.update.status, 'posted')
        assert.deepEqual(await ledger(lab.owner, c.uid), { count: 1, amount: '100' })
        assert.deepEqual(await call(c.services.import, 'financeUpdates.post', c.post), winner)
      }
    })
  } finally { await lab.close() }
})
