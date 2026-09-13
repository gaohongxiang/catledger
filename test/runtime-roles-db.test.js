const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])

test('API/import separate runtime roles: V2 paging, atomic chunks, replay, balances, refund and undo without admin grants', { skip: !hasDatabase, timeout: 60000 }, async () => {
  const { isolatedMysql } = require('../scripts/isolated-mysql'), grants = require('../scripts/runtime-role-grants')
  const db = await isolatedMysql()
  try {
    assert.equal(db.migrations, 12)
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    for (const pool of [apiPool, importPool]) {
      await assert.rejects(pool.query('CREATE TABLE forbidden_probe (id INT)'), { code: 'ER_TABLEACCESS_DENIED_ERROR' })
      await assert.rejects(pool.query('DELETE FROM catledger_transactions WHERE 1 = 0'), { code: 'ER_TABLEACCESS_DENIED_ERROR' })
    }
    await assert.rejects(apiPool.query('UPDATE catledger_finance_updates SET version = version WHERE 1 = 0'), { code: 'ER_TABLEACCESS_DENIED_ERROR' })
    await assert.rejects(importPool.query('UPDATE catledger_review_issue_members SET object_id = object_id WHERE 1 = 0'), { code: 'ER_COLUMNACCESS_DENIED_ERROR' })
    await assert.rejects(importPool.query('UPDATE catledger_import_rows SET raw_fields_json = raw_fields_json WHERE 1 = 0'), { code: 'ER_COLUMNACCESS_DENIED_ERROR' })
    const [grantRows] = await importPool.query('SHOW GRANTS')
    require('../cloudfunctions/catledger-import/src/runtime-permission-contract').assertRuntimePermissions(grantRows.flatMap(row => Object.values(row)))
    let failChunk = false, linkChunks = 0, deniedQuery = ''
    const faultPool = { async getConnection() {
      const connection = await importPool.getConnection()
      return new Proxy(connection, { get(target, key) {
        if (key === 'execute') return async (sql, values) => {
          if (failChunk && /INSERT INTO catledger_economic_event_transactions/.test(sql) && ++linkChunks === 2) throw new Error('synthetic second chunk failure')
          try { return await target.execute(sql, values) } catch (error) {
            deniedQuery = (error.code || 'database-error') + ':' + (String(error.sqlMessage || '').match(/for table ['`]([a-z_]+)['`]/) || [null, [...new Set(sql.match(/catledger_[a-z_]+/g) || [])].join(',')])[1]
            throw error
          }
        }
        return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
      } })
    } }
    const services = localServices({ apiPool, importPool: faultPool })
    const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
    const identity = await api('bootstrap')
    const category = identity.categories.find(item => item.kind === 'expense')
    const account = await api('accounts.create', { requestId: randomUUID(), type: 'wallet', name: '合成角色账户', openingDisplayBalanceMinor: '20000',
      occurredLocalAt: '2026-09-01T10:00:00', timezoneOffsetMinutes: -480 })
    const update = await prepareSyntheticUpdate(services, 121, 'SYNTHETIC-ROLE'), updateId = update.updateId
    const first = await imp('economicEvents.list', { updateId })
    assert.equal(first.items.length, 40); assert.equal(first.total, 121)
    const other = localServices({ apiPool, importPool, subject: 'synthetic-other-role' })
    await call(other.api, 'bootstrap')
    assert.equal((await other.import({ action: 'economicEvents.list', data: { updateId, cursor: first.nextCursor } })).error.code, 'NOT_FOUND')
    const issuePage = await imp('reviewIssues.list', { protocolVersion: 2, updateId, group: 'accounts' }), issue = issuePage.items[0]
    const mapped = await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), resultMode: 'receipt', updateId, updateVersion: update.appliedVersion,
      decisions: [{ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: account.accountId } }] })
    const request = { requestId: randomUUID(), resultMode: 'receipt', updateId, version: mapped.appliedVersion }
    failChunk = true
    assert.equal((await services.import({ action: 'financeUpdates.post', data: request })).error.code, 'INTERNAL_ERROR')
    assert.equal((await api('accounts.list')).accounts[0].bookBalanceMinor, '20000')
    assert.equal((await imp('financeUpdates.summary', { updateId })).update.version, mapped.appliedVersion)
    failChunk = false
    const results = await Promise.all([imp('financeUpdates.post', request), imp('financeUpdates.post', request)]).catch(error => { throw new Error(error.message + ' ' + deniedQuery) })
    assert.deepEqual(results[0], results[1]); assert.equal(results[0].posting.createdTransactionCount, 121)
    assert.equal((await api('accounts.list')).accounts[0].bookBalanceMinor, '7900')
    const stats = await api('statistics.get', { month: '2026-09', trendEndMonth: '2026-10' })
    assert.equal(stats.summary.expenseMinor, '12100'); assert.equal(stats.cashFlowTrend.at(-1).month, '2026-10')
    const postedPage = await imp('economicEvents.list', { updateId })
    const evidence = await imp('economicEvents.evidence', { protocolVersion: 2, eventId: postedPage.items[0].eventId })
    assert.equal(evidence.total, 1)
    const impact = await imp('financeUpdates.undoImpact', { updateId })
    const undo = { requestId: randomUUID(), resultMode: 'receipt', updateId, version: results[0].appliedVersion, previewToken: impact.previewToken }
    const undone = await imp('financeUpdates.undo', undo)
    assert.deepEqual(await imp('financeUpdates.undo', undo), undone)
    assert.deepEqual(await imp('financeUpdates.post', request), results[0])
    assert.equal((await api('accounts.list')).accounts[0].bookBalanceMinor, '20000')
    const manual = await api('transactions.create', { requestId: randomUUID(), type: 'expense', amountMinor: '800', sourceAccountId: account.accountId,
      categoryId: category.id, occurredLocalAt: '2026-09-02T12:00:00', timezoneOffsetMinutes: -480 })
    const refund = await api('transactions.create', { requestId: randomUUID(), type: 'refund', amountMinor: '300', destinationAccountId: account.accountId,
      originalTransactionId: manual.transactionId, occurredLocalAt: '2026-09-03T12:00:00', timezoneOffsetMinutes: -480 })
    assert.equal(refund.originalTransaction.transactionId, manual.transactionId)
    assert.equal((await api('accounts.list')).accounts[0].bookBalanceMinor, '19500')
    assert.equal((await api('statistics.get', { month: '2026-09' })).summary.expenseMinor, '500')
    const abandoned = await prepareSyntheticUpdate(services, 2, 'SYNTHETIC-ABANDON')
    await imp('financeUpdates.abandon', { requestId: randomUUID(), resultMode: 'receipt', updateId: abandoned.updateId, version: abandoned.appliedVersion })
    const [[graph]] = await importPool.execute('SELECT COUNT(*) AS count FROM catledger_economic_events WHERE update_id = ?', [abandoned.updateId])
    assert.equal(Number(graph.count), 0)
    const [[sources]] = await importPool.execute('SELECT COUNT(*) AS count FROM catledger_import_rows')
    assert.equal(Number(sources.count), 123)
  } finally { await db.close() }
})
