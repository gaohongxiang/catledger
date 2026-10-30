const assert = require('node:assert/strict')
const test = require('node:test')

const { createFinanceUpdatePending, IN_FLIGHT_UPDATE_SQL } = require('../src/finance-update-pending')

function connection({ count = 0, onCount } = {}) {
  const state = { released: 0, queries: [], statements: [] }
  return {
    state,
    async query(sql) { state.queries.push(sql) },
    async commit() {},
    async execute(sql, values) {
      if (/COUNT\(\*\) AS count/u.test(sql)) {
        state.statements.push({ sql, values })
        if (onCount) return onCount()
        return [[{ count }], []]
      }
      return [[{ uid: 'user-1' }], []]
    },
    release() { state.released += 1 }
  }
}

function run(conn, data = {}) {
  return createFinanceUpdatePending({ getPool: () => ({ getConnection: async () => conn }) })({
    provider: 'wechat-mini',
    subjectHash: 'subject-1',
    data
  })
}

test('待核对笔数按当前用户统计，返回数字', async () => {
  const conn = connection({ count: 7 })
  assert.deepEqual(await run(conn), { count: 7 })
  const { sql, values } = conn.state.statements[0]
  assert.deepEqual(values, ['user-1'], '只按可信服务端身份过滤，不吃客户端参数')
  assert.match(sql, /FROM catledger_economic_events e/u)
  assert.match(sql, /WHERE e\.uid = \?/u)
  assert.equal(conn.state.released, 1)
})

test('待核对笔数只数还没结果的导入批次', async () => {
  const conn = connection({ count: 1 })
  await run(conn)
  const { sql } = conn.state.statements[0]
  assert.ok(sql.includes(IN_FLIGHT_UPDATE_SQL), '复用未完成更新的范围')
  for (const status of ['posted', 'undone', 'abandoned']) {
    assert.ok(!IN_FLIGHT_UPDATE_SQL.includes("'" + status + "'"), status + ' 不该计入待核对')
  }
  // 与工作台「待核对」页签同一套判定：有关键问题，或需要动作且不是待分类。
  assert.match(sql, /catledger_review_issue_members/u)
  assert.match(sql, /e\.status = 'needs_action'/u)
  assert.match(sql, /issue_type <> 'category_assignment'/u)
})

test('没有待核对交易时返回 0 而不是空值', async () => {
  const conn = connection({ count: null })
  assert.deepEqual(await run(conn), { count: 0 })
})
