const test = require('node:test')
const assert = require('node:assert/strict')
const { createTransactionCategoryService } = require('../src/transaction-category')
const { createTransactionQueryService } = require('../src/transaction-query-service')
const { normalizeListFilters } = require('../src/transaction-service')

function fixture(options = {}) {
  let state = { row: { transactionId: 'entry-a', type: 'expense', categoryId: 'old-category', version: 2, amountMinor: '1234', accountId: 'original-account' }, refundCategory: 'old-category', receipts: {} }
  const h = { commits: 0, rollbacks: 0, writes: [], sql: [] }
  const connection = {
    async beginTransaction() { this.snapshot = structuredClone(state) },
    async commit() { h.commits += 1 },
    async rollback() { state = this.snapshot; h.rollbacks += 1 }, release() {}, async query() {},
    async execute(sql, values) {
      h.sql.push(sql)
      if (sql.includes('catledger_user_identities')) return [[{ uid: options.uid || 'user-a' }]]
      if (sql.includes('INSERT INTO catledger_mutation_receipts')) {
        const [uid,key,action,requestDigest] = values
        if (state.receipts[key]) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
        state.receipts[key] = { uid, action, requestDigest, result: null }; return [{}]
      }
      if (sql.includes('UPDATE catledger_mutation_receipts')) { state.receipts[values[2]].result = JSON.parse(values[0]); return [{}] }
      if (sql.includes('FROM catledger_mutation_receipts')) return [[state.receipts[values[1]]].filter(Boolean)]
      if (sql.includes('FROM catledger_categories')) {
        assert.match(sql, /uid = \? AND category_id = \? AND archived_at IS NULL/)
        return [options.noCategory || values[0] !== 'user-a' ? [] : [{ kind: options.kind || 'expense' }]]
      }
      if (sql.includes('SELECT transaction_id')) {
        assert.match(sql, /uid = \? AND transaction_id = \? AND deleted_at IS NULL.*FOR UPDATE/)
        return [options.missing || values[0] !== 'user-a' || values[1] !== 'entry-a' ? [] : [{ ...state.row, type: options.type || state.row.type }]]
      }
      if (sql.includes('UPDATE catledger_transactions')) {
        assert.match(sql, /SET category_id = \?, version = version \+ 1/)
        assert.doesNotMatch(sql, /SET (?:amount_minor|source_account_id|destination_account_id|note)/)
        h.writes.push(values)
        if (sql.includes('original_transaction_id')) {
          if (options.refundFailure) throw new Error('synthetic refund failure')
          state.refundCategory = values[0]; return [{ affectedRows: 1 }]
        }
        if (options.staleWrite) return [{ affectedRows: 0 }]
        state.row.categoryId = values[0]; state.row.version += 1; return [{ affectedRows: 1 }]
      }
      throw new Error('unexpected SQL')
    }
  }
  h.state = () => state
  h.run = createTransactionCategoryService({ getPool: () => ({ getConnection: async () => connection }) })
  return h
}
const data = { requestId: '00000000-0000-4000-8000-000000000043', transactionId: 'entry-a', version: 2, categoryId: 'new-category' }
const context = body => ({ provider: 'wechat', subjectHash: 'synthetic', data: body })

test('单笔分类更新包含已分类交易，同步关联退款且不改变资金字段；同请求重试不重复写入', async () => {
  const h = fixture()
  const first = await h.run(context(data))
  assert.equal(first.version, 3)
  assert.equal(h.state().row.categoryId, 'new-category')
  assert.equal(h.state().refundCategory, 'new-category')
  assert.equal(h.state().row.amountMinor, '1234')
  assert.equal(h.state().row.accountId, 'original-account')
  assert.deepEqual(await h.run(context(data)), first)
  assert.equal(h.state().row.version, 3)
  assert.equal(h.writes.length, 2)
})

test('分类更新拒绝跨用户、失效分类、类型冲突、旧版本和额外资金字段', async () => {
  for (const [options, body, code] of [
    [{ uid: 'user-b' }, data, 'NOT_FOUND'], [{ noCategory: true }, data, 'NOT_FOUND'],
    [{ kind: 'income' }, data, 'VALIDATION_ERROR'], [{ type: 'transfer' }, data, 'VALIDATION_ERROR'],
    [{}, { ...data, version: 1 }, 'CONFLICT'], [{}, { ...data, amountMinor: '9999' }, 'VALIDATION_ERROR'],
    [{ staleWrite: true }, data, 'CONFLICT']
  ]) {
    const h = fixture(options)
    await assert.rejects(h.run(context(body)), { publicCode: code })
    assert.equal(h.commits, 0)
    assert.equal(h.rollbacks, 1)
    assert.equal(h.state().row.categoryId, 'old-category')
  }
})

test('关联退款更新失败时正式交易和幂等收据一同回滚', async () => {
  const h = fixture({ refundFailure: true })
  await assert.rejects(h.run(context(data)), /synthetic refund failure/)
  assert.equal(h.state().row.version, 2)
  assert.equal(Object.keys(h.state().receipts).length, 0)
  assert.equal(h.rollbacks, 1)
})

test('单笔分类可清空为未分类，同请求号改变选择会冲突', async () => {
  const h = fixture()
  await h.run(context({ ...data, categoryId: null }))
  assert.equal(h.state().row.categoryId, null)
  await assert.rejects(h.run(context(data)), { publicCode: 'IDEMPOTENCY_CONFLICT' })
})

test('未分类筛选校验布尔类型，且与具体分类互斥', () => {
  assert.equal(normalizeListFilters({ month: '2026-07', uncategorized: true }).uncategorized, true)
  assert.throws(() => normalizeListFilters({ month: '2026-07', uncategorized: 'true' }), { publicCode: 'VALIDATION_ERROR' })
  assert.throws(() => normalizeListFilters({ month: '2026-07', uncategorized: true, categoryId: 'a' }), { publicCode: 'VALIDATION_ERROR' })
})

test('未分类在SQL中筛选且绑定游标范围，账户/日期/搜索条件继续组合', async () => {
  const queries = []
  const connection = { query: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    execute: async (sql, values) => {
      queries.push({ sql, values })
      if (sql.includes('catledger_user_identities')) return [[{ uid: 'user-a' }]]
      if (sql.includes('AS incomeMinor')) return [[{ incomeMinor: '0', expenseMinor: '0' }]]
      return [[1, 2].map(i => ({ transactionId: 't' + i, type: 'expense', origin: 'manual', amountMinor: '100', occurredLocalAt: '2026-07-01T10:00:00', version: 1, timezoneOffsetMinutes: -480 }))]
    } }
  const service = createTransactionQueryService({ getPool: () => ({ getConnection: async () => connection }) })
  const input = { month: '2026-07', date: '2026-07-01', accountId: 'account-a', search: 'test', uncategorized: true, pageSize: 1 }
  const first = await service.list(context(input))
  const query = queries.find(row => row.sql.includes('ORDER BY t.occurred_local_at DESC'))
  assert.match(query.sql, /t.category_id IS NULL AND t.type IN \('income', 'expense'\)/)
  assert.match(query.sql, /t.source_account_id = \? OR t.destination_account_id = \?/)
  assert.equal(query.values[0], 'user-a')
  assert.ok(first.nextCursor)
  await service.list(context({ ...input, cursor: first.nextCursor }))
  await assert.rejects(service.list(context({ ...input, uncategorized: false, cursor: first.nextCursor })), { publicCode: 'VALIDATION_ERROR' })
})
