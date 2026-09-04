const assert = require('node:assert/strict')
const test = require('node:test')

const { executeLedgerRead } = require('../src/ledger-read')

function createHarness() {
  const calls = []
  const connection = {
    async query(sql) {
      calls.push(['query', sql])
      return [[], []]
    },
    async execute(sql) {
      calls.push(['execute', sql])
      return [[{ uid: 'user-1' }], []]
    },
    async commit() {
      calls.push(['commit'])
    },
    async rollback() {
      calls.push(['rollback'])
    },
    release() {
      calls.push(['release'])
    }
  }
  return {
    calls,
    connection,
    getPool: () => ({ getConnection: async () => connection })
  }
}

test('consistent ledger reads use one repeatable read-only transaction', async () => {
  const harness = createHarness()
  const result = await executeLedgerRead({
    getPool: harness.getPool,
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    consistentSnapshot: true,
    operation: async (connection, uid) => {
      assert.equal(connection, harness.connection)
      assert.equal(uid, 'user-1')
      return { ok: true }
    }
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(harness.calls.map((call) => call[0]), [
    'query', 'query', 'execute', 'commit', 'release'
  ])
  assert.equal(harness.calls[0][1], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  assert.equal(harness.calls[1][1], 'START TRANSACTION READ ONLY')
})

test('failed consistent ledger reads roll back and always release the connection', async () => {
  const harness = createHarness()
  await assert.rejects(
    executeLedgerRead({
      getPool: harness.getPool,
      provider: 'wechat-mini',
      subjectHash: 'subject-1',
      consistentSnapshot: true,
      operation: async () => {
        throw new Error('read failed')
      }
    }),
    /read failed/
  )

  assert.deepEqual(harness.calls.map((call) => call[0]), [
    'query', 'query', 'execute', 'rollback', 'release'
  ])
})

test('single-statement ledger reads avoid an unnecessary transaction', async () => {
  const harness = createHarness()
  await executeLedgerRead({
    getPool: harness.getPool,
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    operation: async () => 'ok'
  })

  assert.deepEqual(harness.calls.map((call) => call[0]), ['execute', 'release'])
})

test('transient connection failure retries once with a fresh connection', async () => {
  const first = createHarness()
  const second = createHarness()
  const originalExecute = first.connection.execute
  first.connection.execute = async function () {
    const error = new Error('connection reset')
    error.code = 'ECONNRESET'
    throw error
  }
  const connections = [first.connection, second.connection]

  const result = await executeLedgerRead({
    getPool: () => ({ getConnection: async () => connections.shift() }),
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    operation: async () => 'recovered'
  })

  first.connection.execute = originalExecute
  assert.equal(result, 'recovered')
  assert.equal(connections.length, 0)
  assert.deepEqual(first.calls.map((call) => call[0]), ['release'])
  assert.deepEqual(second.calls.map((call) => call[0]), ['execute', 'release'])
})
