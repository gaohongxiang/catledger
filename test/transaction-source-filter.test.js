const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const { normalizeListFilters } = require('../cloudfunctions/catledger-api/src/transaction-query-service')

test('来源只接受明确枚举，省略表示全部，不能把其他值静默当全部', () => {
  assert.equal(normalizeListFilters({ month: '2026-09' }).source, null)
  for (const source of ['manual', 'import']) assert.equal(normalizeListFilters({ month: '2026-09', source }).source, source)
  for (const source of ['', 'all', 'system', 'loan', 0, false, {}, ['manual']]) {
    assert.throws(() => normalizeListFilters({ month: '2026-09', source }), { publicCode: 'VALIDATION_ERROR' })
  }
})

test('明细来源查询：组合、真实分页、身份隔离及贷款生成和关联的区别', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-source-filter' })
    const api = (action, data) => call(services.api, action, data)
    const identity = await api('bootstrap'), categoryId = identity.categories.find(row => row.kind === 'expense').id
    const makeAccount = async (name, type = 'bank') => (await api('accounts.create', { requestId: randomUUID(), name, type,
      openingDisplayBalanceMinor: '10000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const accountId = await makeAccount('合成来源账户'), otherAccountId = await makeAccount('合成另一账户')
    const debt = await makeAccount('合成来源负债', 'other_liability')
    const makeTransaction = overrides => api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: accountId,
      categoryId, amountMinor: '100', occurredLocalAt: '2026-09-05T12:00:00', timezoneOffsetMinutes: -480, note: '午饭', ...overrides })
    const manual = [await makeTransaction(), await makeTransaction(), await makeTransaction({ sourceAccountId: otherAccountId,
      occurredLocalAt: '2026-09-04T12:00:00', note: '100%_餐费' })]
    const imported = [await makeTransaction(), await makeTransaction({ occurredLocalAt: '2026-09-04T12:00:00' })]
    // 查询专用合成来源夹具；导入入账协议由已有导入集成测试覆盖。
    for (const row of imported) await lab.owner.execute("UPDATE catledger_transactions SET origin='import' WHERE uid=? AND transaction_id=?", [identity.uid, row.transactionId])
    await lab.owner.execute('UPDATE catledger_transactions SET category_id=NULL WHERE uid=? AND transaction_id=?', [identity.uid, imported[1].transactionId])
    const deleted = await makeTransaction()
    await api('transactions.delete', { requestId: randomUUID(), transactionId: deleted.transactionId, version: deleted.version })
    const loan = await api('loans.create', { requestId: randomUUID(), name: '合成来源贷款', kind: 'borrowing', accountId: debt,
      baselinePrincipalMinor: '10000', baselineDate: '2026-09-01' })
    const allocation = version => [{ loanId: loan.loanId, version, principalMinor: '100', interestMinor: '0', feeMinor: '0', interestTreatment: 'expense', feeTreatment: 'expense' }]
    const paymentData = { kind: 'repayment', assetAccountId: accountId, occurredLocalAt: '2026-09-06T12:00:00', timezoneOffsetMinutes: -480, totalMinor: '100', confirmed: true }
    const generatedPayment = await api('loans.record', { ...paymentData, requestId: randomUUID(), mode: 'new', allocations: allocation(1) })
    const generated = (await api('loans.payment', { paymentId: generatedPayment.paymentId })).transactions
    const associated = await makeTransaction({ type: 'transfer', destinationAccountId: debt, categoryId: null, occurredLocalAt: paymentData.occurredLocalAt })
    const selection = (await api('loans.source', { transactionIds: [associated.transactionId] })).source
    await api('loans.record', { ...paymentData, requestId: randomUUID(), mode: 'associate', source: selection, allocations: allocation(2) })
    const list = data => api('transactions.list', { month: '2026-09', ...data })
    const ids = rows => new Set(rows.map(row => row.transactionId))
    const all = await list(), manualIds = ids([...manual, associated]), importIds = ids(imported)

    await t.test('全部含余额校正和贷款生成；记一笔保留已有手工关联，排除贷款生成、导入和已删除', async () => {
      assert.ok(all.transactions.some(row => row.type === 'balance_adjustment'))
      for (const row of generated) assert.ok(ids(all.transactions).has(row.transactionId))
      assert.equal(ids(all.transactions).has(deleted.transactionId), false)
      const manualPage = await list({ source: 'manual' }), importPage = await list({ source: 'import' })
      assert.equal(all.source, null); assert.equal(manualPage.source, 'manual'); assert.equal(importPage.source, 'import')
      assert.deepEqual(ids(manualPage.transactions), manualIds)
      assert.deepEqual(ids(importPage.transactions), importIds)
      assert.deepEqual(manualPage.summary, all.summary); assert.deepEqual(importPage.summary, all.summary)
    })
    await t.test('来源与日期、账户、分类、未分类及字面备注组合；无结果不扩大查询', async () => {
      assert.deepEqual(ids((await list({ source: 'import', accountId, categoryId, date: '2026-09-05', search: ' 午饭 ' })).transactions), ids([imported[0]]))
      assert.deepEqual(ids((await list({ source: 'import', uncategorized: true })).transactions), ids([imported[1]]))
      assert.deepEqual(ids((await list({ source: 'manual', accountId: otherAccountId, search: '%_' })).transactions), ids([manual[2]]))
      const empty = await list({ source: 'import', accountId: otherAccountId })
      assert.deepEqual(empty.transactions, []); assert.equal(empty.nextCursor, null)
    })
    await t.test('先筛来源再分页，同时间交易不重不漏，来源改变或换用户拒绝旧游标', async () => {
      for (const [source, expected] of [['manual', manualIds], ['import', importIds]]) {
        let cursor, firstCursor
        const received = []
        do {
          const page = await list({ source, pageSize: 1, ...(cursor ? { cursor } : {}) })
          assert.equal(page.transactions.length, 1)
          received.push(page.transactions[0].transactionId)
          cursor = page.nextCursor
          if (!firstCursor) firstCursor = cursor
        } while (cursor)
        assert.equal(received.length, expected.size); assert.deepEqual(new Set(received), expected)
        for (const nextSource of [undefined, source === 'manual' ? 'import' : 'manual']) {
          await assert.rejects(list({ source: nextSource, cursor: firstCursor }), { publicCode: 'VALIDATION_ERROR' })
        }
        const other = localServices({ apiPool, importPool, subject: 'synthetic-source-filter-other' })
        await call(other.api, 'bootstrap')
        assert.deepEqual((await call(other.api, 'transactions.list', { month: '2026-09', source })).transactions, [])
        await assert.rejects(call(other.api, 'transactions.list', { month: '2026-09', source, cursor: firstCursor }), { publicCode: 'VALIDATION_ERROR' })
      }
    })
  } finally { await lab.close() }
})
