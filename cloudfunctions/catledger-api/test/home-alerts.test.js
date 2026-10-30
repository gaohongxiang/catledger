const assert = require('node:assert/strict')
const test = require('node:test')

const { createHomeAlertsService, DUE_THIS_MONTH_SQL } = require('../src/home-alerts')

function harness(row = { periodCount: 2, dueMinor: '120000' }) {
  const calls = { execute: [], query: [], commit: 0, released: 0 }
  const connection = {
    async query(sql) { calls.query.push(sql) },
    async execute(sql, values) {
      calls.execute.push({ sql, values })
      if (/COUNT\(\*\) AS periodCount/u.test(sql)) return [[row], []]
      return [[{ uid: 'user-1' }], []]
    },
    async commit() { calls.commit += 1 },
    async rollback() {},
    release() { calls.released += 1 }
  }
  const service = createHomeAlertsService({ getPool: () => ({ getConnection: async () => connection }) })
  return { calls, service }
}

const run = (h, data = { month: '2026-10' }) => h.service.dueThisMonth({ provider: 'wechat-mini', subjectHash: 'subject-1', data })

test('本月待还按用户和当月区间只读聚合', async () => {
  const h = harness({ periodCount: 2, dueMinor: '120000' })
  assert.deepEqual(await run(h), { month: '2026-10', periodCount: 2, dueMinor: '120000' })
  const aggregate = h.calls.execute.find(call => /COUNT\(\*\) AS periodCount/u.test(call.sql))
  assert.deepEqual(aggregate.values, ['user-1', '2026-10-01', '2026-11-01'], '按可信 uid 与当月区间取数')
  assert.ok(h.calls.query.some(sql => /READ ONLY/u.test(sql)), '只读事务')
  assert.equal(h.calls.commit, 1)
  assert.equal(h.calls.released, 1)
})

test('本月待还只算当月未结清的期次，已还部分要扣掉', () => {
  assert.match(DUE_THIS_MONTH_SQL, /t\.due_date >= \? AND t\.due_date < \?/u)
  assert.match(DUE_THIS_MONTH_SQL, /t\.cancelled = 0/u)
  assert.match(DUE_THIS_MONTH_SQL, /l\.archived_at IS NULL AND l\.deleted_at IS NULL/u)
  assert.match(DUE_THIS_MONTH_SQL, /a\.active = 1/u)
  assert.match(DUE_THIS_MONTH_SQL, /p\.status = 'active'/u)
  assert.match(DUE_THIS_MONTH_SQL, /WHERE x\.outstanding > 0/u, '结清的期次不进笔数也不进金额')
  assert.doesNotMatch(DUE_THIS_MONTH_SQL, /INSERT|UPDATE|DELETE/u, '只读聚合不带写')
})

test('没有待还时返回 0 而不是空值', async () => {
  const h = harness({ periodCount: null, dueMinor: null })
  assert.deepEqual(await run(h), { month: '2026-10', periodCount: 0, dueMinor: '0' })
})

test('月份不合法时拒绝，不静默取错区间', async () => {
  const h = harness()
  await assert.rejects(async () => run(h, { month: '2026-13' }))
  await assert.rejects(async () => run(h, { month: '2026/10' }))
  assert.equal(h.calls.execute.length, 0)
})
