const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { splitSqlStatements } = require('../migrations/runner')
const { localServices, call } = require('./helpers/local-services')
const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])

test('负债账单设置：隔离 MySQL 的迁移、资料事务与账务边界', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const db = await require('../scripts/isolated-mysql').isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const api = (action, data) => call(services.api, action, data)
    const other = localServices({ apiPool, importPool, subject: 'synthetic-billing-other' })
    const identity = await api('bootstrap'); await call(other.api, 'bootstrap')
    const create = (fields = {}) => api('accounts.create', { requestId: randomUUID(), name: '合成账单' + randomUUID().slice(0, 12), type: 'credit',
      openingDisplayBalanceMinor: '500000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480, ...fields })
    const update = (account, fields = {}) => api('accounts.update', { requestId: randomUUID(), accountId: account.accountId, version: account.version, ...fields })
    const billing = a => [a.statementDay, a.repaymentDay, a.creditLimitMinor]
    const snapshot = async () => ({
      transactions: (await db.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? ORDER BY transaction_id', [identity.uid]))[0],
      summary: (await api('statistics.get', { month: '2026-09' })).summary
    })
    let account
    await t.test('全部可留空，信用与其他负债均支持；0 额度与未知不同', async () => {
      const empty = await create()
      assert.deepEqual(billing(empty), [null, null, null])
      account = await create({ statementDay: 25, repaymentDay: 10, creditLimitMinor: '2000000' })
      assert.deepEqual(billing(account), [25, 10, '2000000'])
      const zero = await create({ type: 'other_liability', creditLimitMinor: '0' })
      assert.deepEqual(billing(zero), [null, null, '0'])
      const list = await api('accounts.list')
      assert.equal(list.liabilitySettingsVersion, 1)
      assert.deepEqual(billing(list.accounts.find(a => a.accountId === account.accountId)), billing(account))
      assert.equal(account.bookBalanceMinor, '-500000')
    })
    await t.test('改名省略保留设置，独立修改和清空不改流水、余额、统计', async () => {
      const before = await snapshot()
      account = await update(account, { name: '合成账单已改名' })
      assert.deepEqual(billing(account), [25, 10, '2000000'])
      account = await update(account, { statementDay: 31 })
      assert.equal(account.name, '合成账单已改名')
      assert.deepEqual(billing(account), [31, 10, '2000000'])
      account = await update(account, { statementDay: null, repaymentDay: null, creditLimitMinor: null })
      assert.deepEqual(billing(account), [null, null, null])
      assert.equal(account.bookBalanceMinor, '-500000')
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('日期、额度边界及资产误填在原事务内拒绝，失败不改名或写账', async () => {
      const before = await snapshot(), original = account
      for (const fields of [{ statementDay: 0 }, { statementDay: 32 }, { repaymentDay: 1.5 }, { repaymentDay: '10' },
        { statementDay: '' }, { creditLimitMinor: -1 }, { creditLimitMinor: '-1' }, { creditLimitMinor: '1.01' },
        { creditLimitMinor: '9223372036854775808' }]) {
        await assert.rejects(update(account, { name: '不应保存的名称', ...fields }), { publicCode: 'VALIDATION_ERROR' })
      }
      for (const field of ['statementDay', 'repaymentDay', 'creditLimitMinor']) {
        await assert.rejects(create({ type: 'bank', [field]: field === 'creditLimitMinor' ? '0' : 1 }), { publicCode: 'VALIDATION_ERROR' })
      }
      await assert.rejects(create({ statementDay: 3, occurredLocalAt: 'invalid' }), { publicCode: 'VALIDATION_ERROR' })
      assert.deepEqual((await api('accounts.list')).accounts.find(a => a.accountId === account.accountId), original)
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('跨用户、过期版本、并发重放与并发覆盖受既有锁和幂等保护', async () => {
      await assert.rejects(call(other.api, 'accounts.update', { requestId: randomUUID(), accountId: account.accountId, version: account.version, statementDay: 1 }), { publicCode: 'NOT_FOUND' })
      const request = { requestId: randomUUID(), accountId: account.accountId, version: account.version, statementDay: 1, repaymentDay: 31, creditLimitMinor: '9223372036854775807' }
      const [first, replay] = await Promise.all([api('accounts.update', request), api('accounts.update', request)])
      assert.deepEqual(first, replay); account = first
      await assert.rejects(update({ ...account, version: request.version }, { statementDay: 2 }), { publicCode: 'CONFLICT' })
      const results = await Promise.allSettled([update(account, { statementDay: 4 }), update(account, { statementDay: 5 })])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.find(r => r.status === 'rejected').reason.publicCode, 'CONFLICT')
      account = results.find(r => r.status === 'fulfilled').value
    })
    await t.test('迁移原语可重跑且保留已有设置，数据库约束拒绝非法日期及资产字段', async () => {
      const connection = await db.owner.getConnection()
      try {
        for (const sql of splitSqlStatements(readFileSync(path.join(__dirname, '../migrations/0023_account_billing_settings.sql'), 'utf8'))) await connection.query(sql)
      } finally { connection.release() }
      assert.deepEqual(billing((await api('accounts.list')).accounts.find(a => a.accountId === account.accountId)), billing(account))
      await assert.rejects(db.owner.execute('UPDATE catledger_accounts SET statement_day=32 WHERE uid=? AND account_id=?', [identity.uid, account.accountId]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
      const asset = await create({ type: 'bank' })
      await assert.rejects(db.owner.execute('UPDATE catledger_accounts SET credit_limit_minor=0 WHERE uid=? AND account_id=?', [identity.uid, asset.accountId]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
    })
    await t.test('批量创建遵循相同可选契约；停用账户保留资料并拒绝修改', async () => {
      const batch = await api('accounts.createBatch', { requestId: randomUUID(), accounts: [{ type: 'credit', name: '合成批量账单', statementDay: 15 }, { type: 'other_liability', name: '合成批量负债' }] })
      assert.deepEqual(billing(batch.accounts[0]), [15, null, null])
      assert.deepEqual(billing(batch.accounts[1]), [null, null, null])
      const archived = await api('accounts.archive', { requestId: randomUUID(), accountId: account.accountId, version: account.version })
      assert.deepEqual(billing(archived), billing(account))
      await assert.rejects(update(archived, { statementDay: null }), { publicCode: 'ACCOUNT_INACTIVE' })
    })
  } finally { await db.close() }
})
