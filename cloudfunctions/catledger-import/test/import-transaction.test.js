const assert = require('node:assert/strict')
const test = require('node:test')

const { executeUserRead } = require('../src/import-transaction')

function connection(options = {}) {
  const state = { released: 0 }
  return {
    state,
    async execute() {
      if (options.error) throw options.error
      return [[{ uid: 'user-1' }], []]
    },
    release() {
      state.released += 1
    }
  }
}

test('导入读取在瞬时断连后使用新连接恢复一次', async () => {
  const error = new Error('connection reset')
  error.code = 'ECONNRESET'
  const first = connection({ error })
  const second = connection()
  const connections = [first, second]

  const result = await executeUserRead({
    getPool: () => ({ getConnection: async () => connections.shift() }),
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    operation: async () => 'recovered'
  })

  assert.equal(result, 'recovered')
  assert.equal(first.state.released, 1)
  assert.equal(second.state.released, 1)
  assert.equal(connections.length, 0)
})

test('导入读取不会重放非瞬时数据库错误', async () => {
  const error = new Error('bad query')
  error.code = 'ER_BAD_FIELD_ERROR'
  const first = connection({ error })
  let requests = 0

  await assert.rejects(executeUserRead({
    getPool: () => ({
      getConnection: async () => {
        requests += 1
        return first
      }
    }),
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    operation: async () => 'must not run'
  }), error)

  assert.equal(requests, 1)
  assert.equal(first.state.released, 1)
})
