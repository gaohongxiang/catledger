const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call } = require('./helpers/local-services')

test('普通已核对交易修改：真实 MySQL 单笔隔离、版本、回滚、幂等及入账',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const grants = require('../scripts/runtime-role-grants')
      const apiPool = await lab.role('api', grants.api), importer = await lab.role('import', grants.importer)
      let failAfterSave = false
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failAfterSave && /SELECT member.member_id/.test(sql)) throw Error('synthetic failure after event save')
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function setup() {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-reviewed-edit-' + randomUUID() })
        const api = (action, input) => call(services.api, action, input), imp = (action, input) => call(services.import, action, input)
        const identity = await api('bootstrap'), accounts = []
        for (const name of ['合成钱包甲', '合成钱包乙']) accounts.push((await api('accounts.create', { requestId: randomUUID(), type: 'wallet', name,
          openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId)
        const content = Buffer.from(['微信支付账单明细,,,,,,,,,,,',
          '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
          ...[0, 1].map(i => `2026-09-01 12:0${i}:00,商户消费,合成美食商户,午餐,支出,${i + 1}.00,微信零钱,支付成功,SYNTHETIC-${randomUUID()},,,`)].join('\n'))
        const file = (await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成已核对修改.csv', size: content.length }] })).files[0]
        services.objects.set(file.cloudPath, content)
        const parsed = await imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
          fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        const update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
        const issues = (await imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts', status: 'open' })).items
        await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId,
          updateVersion: (await imp('financeUpdates.summary', { updateId: update.updateId })).update.version,
          decisions: issues.map(issue => ({ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve',
            decision: 'apply_fields', fields: { mappingAccountId: accounts[0] } })) })
        return { api, imp, uid: identity.uid, accounts, update }
      }
      const rows = async c => (await c.imp('economicEvents.list', { updateId: c.update.updateId })).items
      const summary = c => c.imp('financeUpdates.summary', { updateId: c.update.updateId })
      const dump = async (c, table, order) => (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${order}`, [c.uid]))[0]
      async function input(c, fields) {
        const row = (await rows(c))[0]
        return { requestId: randomUUID(), updateId: c.update.updateId, updateVersion: (await summary(c)).update.version,
          eventId: row.eventId, eventVersion: row.version, fields }
      }

      await t.test('普通单来源支出改收入和收款账户，金额原文及同组其他笔保持', async () => {
        const c = await setup(), before = await rows(c)
        assert.equal(before[0].evidenceCount, 1)
        assert.equal(before[0].status, 'ready')
        const originals = await dump(c, 'catledger_import_rows', 'row_id'), ledger = await dump(c, 'catledger_transactions', 'transaction_id')
        await c.imp('financeUpdates.setReview', await input(c, { economicNature: 'income', ledgerAccountId: c.accounts[1] }))
        const after = await rows(c)
        assert.equal(after[0].economicNature, 'income')
        assert.equal(after[0].flowDirection, 'inflow')
        assert.equal(after[0].ledgerAccountId, c.accounts[1])
        assert.equal(after[0].categoryId, null)
        assert.equal(after[0].status, 'ready')
        assert.equal(after[0].amountMinor, before[0].amountMinor)
        assert.equal(after[0].localAt, before[0].localAt)
        assert.deepEqual(after[1], before[1])
        assert.deepEqual(await dump(c, 'catledger_import_rows', 'row_id'), originals)
        assert.deepEqual(await dump(c, 'catledger_transactions', 'transaction_id'), ledger)
      })

      await t.test('改为两账户转账后按新结果整批入账，不能把同一账户当两端', async () => {
        const c = await setup(), data = await input(c, { economicNature: 'internal_transfer', counterpartyLedgerAccountId: c.accounts[1] })
        await assert.rejects(c.imp('financeUpdates.setReview', { ...data, fields: { ...data.fields, counterpartyLedgerAccountId: c.accounts[0] } }), { publicCode: 'VALIDATION_ERROR' })
        await c.imp('financeUpdates.setReview', { ...data, requestId: randomUUID() })
        assert.equal((await rows(c))[0].categoryId, null)
        await c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: c.update.updateId, version: (await summary(c)).update.version })
        const transactions = await dump(c, 'catledger_transactions', 'transaction_id')
        const transfer = transactions.find(row => row.origin === 'import' && row.type === 'transfer')
        assert.equal(String(transfer.amount_minor), '100')
        assert.equal(transfer.source_account_id, c.accounts[0])
        assert.equal(transfer.destination_account_id, c.accounts[1])
        assert.equal(transactions.filter(row => row.origin === 'import').length, 2)
      })

      await t.test('跨用户账户、旧版本、未授权字段和已入账记录不能修改', async () => {
        const c = await setup(), stranger = await setup(), data = await input(c, { economicNature: 'income' })
        const before = await dump(c, 'catledger_economic_events', 'event_id')
        for (const fields of [{ ledgerAccountId: stranger.accounts[0] }, { amountMinor: '99999' }, { economicNature: 'invented' }]) {
          await assert.rejects(c.imp('financeUpdates.setReview', { ...data, requestId: randomUUID(), fields }), { publicCode: 'VALIDATION_ERROR' })
        }
        for (const change of [{ updateVersion: data.updateVersion + 1 }, { eventVersion: data.eventVersion + 1 }]) {
          await assert.rejects(c.imp('financeUpdates.setReview', { ...data, ...change, requestId: randomUUID() }), { publicCode: 'CONFLICT' })
        }
        await assert.rejects(stranger.imp('financeUpdates.setReview', data), { publicCode: 'NOT_FOUND' })
        assert.deepEqual(await dump(c, 'catledger_economic_events', 'event_id'), before)
        await c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: c.update.updateId, version: data.updateVersion })
        await assert.rejects(c.imp('financeUpdates.setReview', { ...data, requestId: randomUUID() }), { publicCode: 'CONFLICT' })
      })

      await t.test('中途失败完整回滚；同请求并发只改一次且回执可恢复，重新整理保留人工结果', async () => {
        const c = await setup(), data = await input(c, { economicNature: 'income' })
        const tables = [['catledger_economic_events', 'event_id'], ['catledger_finance_updates', 'update_id'], ['catledger_review_issues', 'issue_id'],
          ['catledger_review_issue_members', 'member_id'], ['catledger_finance_actions', 'action_id'], ['catledger_mutation_receipts', 'idempotency_key_digest']]
        const before = await Promise.all(tables.map(([table, order]) => dump(c, table, order)))
        failAfterSave = true
        await assert.rejects(c.imp('financeUpdates.setReview', data), { publicCode: 'INTERNAL_ERROR' })
        failAfterSave = false
        assert.deepEqual(await Promise.all(tables.map(([table, order]) => dump(c, table, order))), before)
        const [one, two] = await Promise.all([c.imp('financeUpdates.setReview', data), c.imp('financeUpdates.setReview', data)])
        assert.deepEqual(one, two)
        assert.deepEqual(await c.imp('imports.commandResult', { requestId: data.requestId, commandAction: 'financeUpdates.setReview' }), one)
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v31' WHERE uid=? AND update_id=?", [c.uid, c.update.updateId])
        await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.update.updateId, version: one.appliedVersion })
        assert.equal((await rows(c))[0].economicNature, 'income')
      })

      await t.test('改为退款或暂不确定后生成对应待核对事项，不能跳过整批入账门禁', async () => {
        for (const economicNature of ['refund', 'unknown']) {
          const c = await setup()
          await c.imp('financeUpdates.setReview', await input(c, { economicNature }))
          assert.equal((await rows(c))[0].status, 'needs_action')
          assert.equal((await summary(c)).coverage.selectedEventsReadyToPost, false)
          await assert.rejects(c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: c.update.updateId,
            version: (await summary(c)).update.version }), { publicCode: 'UNRESOLVED_IMPORT' })
        }
      })
    } finally { await lab.close() }
  })
