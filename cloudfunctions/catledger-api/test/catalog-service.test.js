const assert = require('node:assert/strict')
const test = require('node:test')
const { createCatalogService, queryCatalog } = require('../src/catalog-service')

test('目录投影仅含元数据，按可信用户读活动分类，不读取交易或初始化', async () => {
  const statements = []
  const result = await queryCatalog({ async execute(sql, values) {
    statements.push(sql)
    assert.deepEqual(values, ['synthetic-user'])
    if (sql.includes('catledger_accounts')) return [[{ accountId: 'a', type: 'wallet', nature: 'asset',
      name: '合成账户', currency: 'CNY', version: '2', archivedAt: null }]]
    return [[{ id: 'c', kind: 'expense', systemKey: null, name: '合成分类', sortOrder: '1', version: '3' }]]
  } }, 'synthetic-user')
  assert.equal(result.uid, 'synthetic-user')
  assert.equal(result.accounts[0].version, 2)
  assert.equal(result.categories[0].version, 3)
  assert.deepEqual(Object.keys(result.accounts[0]).sort(), ['accountId', 'archived', 'currency', 'name', 'nature', 'type', 'version'])
  assert.ok(statements[1].includes('archived_at IS NULL'))
  assert.doesNotMatch(statements.join('\n'), /catledger_transactions|INSERT|UPDATE|DELETE|SUM\(/)
})

test('目录拒绝非空参数与伪造身份参数，不触及数据库', async () => {
  const service = createCatalogService({ getPool() { throw new Error('unexpected pool') } })
  for (const data of [null, [], { uid: 'other' }, { includeBalances: true }]) {
    await assert.rejects(service.get({ provider: 'wechat-mini', subjectHash: 'synthetic', data }), { publicCode: 'VALIDATION_ERROR' })
  }
})
