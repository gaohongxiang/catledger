const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { setup } = require('./helpers/bank-pairing')
const { localServices, call } = require('./helpers/local-services')

test('统一详情读取：真实 MySQL 账户与退款事实、只读、用户隔离和旧视图拒绝',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const grants = require('../scripts/runtime-role-grants')
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      for (const refund of [false, true]) await t.test(refund ? '退款关系未关联不伪造原消费' : '普通事件读取有效账户名称且不改变账本', async () => {
        const c = await setup({ apiPool, importPool, count: 1, refund })
        const summary = await c.summary()
        const events = (await c.imp('economicEvents.list', { updateId: c.updateId, viewVersion: summary.viewVersion })).items
        const row = events.find(event => event.primaryEvidence.sourceType === 'wechat')
        const dump = async () => {
          const result = {}
          for (const [table, key] of [['catledger_economic_events', 'event_id'], ['catledger_import_rows', 'row_id'],
            ['catledger_transactions', 'transaction_id'], ['catledger_loans', 'loan_id']]) {
            result[table] = (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${key}`, [c.uid]))[0]
          }
          return result
        }
        const before = await dump()
        let cursor = null, text = '', parts = 0
        do {
          const result = await c.imp('economicEvents.detail', { updateId: c.updateId, eventId: row.eventId,
            viewVersion: summary.viewVersion, cursor })
          assert.equal(result.viewVersion, summary.viewVersion)
          assert.ok(result.part.length <= 2048)
          text += result.part; cursor = result.nextCursor
          assert.ok(++parts <= 32)
        } while (cursor)
        const value = JSON.parse(text)
        assert.equal(value.eventId, row.eventId)
        assert.equal(value.detailFacts.version, 1)
        assert.equal(value.detailFacts.accounts.find(account => account.accountId === c.accountId).name, '合成配对信用卡')
        assert.equal(value.fieldSources, undefined)
        if (refund) assert.equal(value.detailFacts.refund.status, 'unlinked')
        else assert.equal(value.detailFacts.refund, null)
        assert.deepEqual(await dump(), before)
        const other = localServices({ apiPool, importPool, subject: 'synthetic-detail-other-' + randomUUID() })
        await call(other.api, 'bootstrap')
        await assert.rejects(call(other.import, 'economicEvents.detail', { eventId: row.eventId }), { publicCode: 'NOT_FOUND' })
        await c.api('accounts.create', { requestId: randomUUID(), name: '合成目录变化', type: 'wallet' })
        await assert.rejects(c.imp('economicEvents.detail', { eventId: row.eventId, viewVersion: summary.viewVersion }), { publicCode: 'STALE_VIEW' })
      })
    } finally { await lab.close() }
  })
