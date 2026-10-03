const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call } = require('./helpers/local-services')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/review/policy')

test('已分类单笔修改：真实MySQL、隔离、版本、幂等、回滚与整批入账',
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
            if (failAfterSave && /UPDATE catledger_review_issue_members m JOIN/.test(sql)) throw new Error('synthetic failure after category update')
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function context() {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-category-edit-' + randomUUID() })
        const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
        const identity = await api('bootstrap'), categories = new Map(identity.categories.map(c => [c.systemKey, c]))
        const accountId = (await api('accounts.create', { requestId: randomUUID(), type: 'wallet', name: '合成分类纠正账户',
          openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        const content = Buffer.from(['微信支付账单明细,,,,,,,,,,,',
          '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
          ...[0, 1].map(i => `2026-09-01 12:0${i}:00,商户消费,合成美食商户,午餐,支出,${i + 1}.00,微信零钱,支付成功,SYNTHETIC-${randomUUID()},,,`)].join('\n'))
        const file = (await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成分类修改.csv', size: content.length }] })).files[0]
        services.objects.set(file.cloudPath, content)
        const parsed = await imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
          fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        const update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
        return { services, api, imp, uid: identity.uid, categories, accountId, update }
      }
      const rows = async c => (await c.imp('economicEvents.list', { updateId: c.update.updateId })).items
      const state = c => c.imp('financeUpdates.summary', { updateId: c.update.updateId })
      const dump = async (c, table, order) => (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid = ? ORDER BY ${order}`, [c.uid]))[0]
      const input = async (c, categoryId) => ({ requestId: randomUUID(), updateId: c.update.updateId,
        updateVersion: (await state(c)).update.version, eventId: (await rows(c))[0].eventId,
        eventVersion: (await rows(c))[0].version, categoryId: categoryId || c.categories.get('food__drink').id })
      async function mapAccounts(c) {
        const issues = (await c.imp('reviewIssues.list', { updateId: c.update.updateId, group: 'accounts', status: 'open' })).items
        return c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.update.updateId,
          updateVersion: (await state(c)).update.version, decisions: issues.map(issue => ({ issueId: issue.issueId, issueVersion: issue.version,
            operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } })) })
      }

      await t.test('修改单笔二级分类保留同商户其他笔、来源、金额、状态及账户待办；后续账户确认仍可保存', async () => {
        const c = await context(), original = await rows(c)
        const evidence = await dump(c, 'catledger_import_rows', 'row_id'), ledger = await dump(c, 'catledger_transactions', 'transaction_id')
        const before = await dump(c, 'catledger_economic_events', 'event_id')
        const issuesBefore = (await c.imp('reviewIssues.list', { updateId: c.update.updateId, group: 'accounts' })).items
        const receipt = await c.imp('financeUpdates.setCategory', await input(c))
        assert.equal(receipt.kind, 'operation-receipt')
        const after = await rows(c)
        assert.equal(after[0].categoryName, '餐饮 / 饮品')
        assert.equal(after[1].categoryName, '餐饮 / 美食')
        for (const key of ['eventId', 'status', 'economicNature', 'flowDirection', 'ledgerAccountId', 'amountMinor', 'localAt', 'reasonCodes']) {
          for (let i = 0; i < 2; i++) assert.deepEqual(after[i][key], original[i][key], key)
        }
        const stored = await dump(c, 'catledger_economic_events', 'event_id')
        const changed = stored.find(row => row.event_id === after[0].eventId)
        assert.ok(changed.manual_field_mask & FIELD_MASK.categoryId)
        assert.deepEqual(stored.find(row => row.event_id === after[1].eventId), before.find(row => row.event_id === after[1].eventId))
        const issuesAfter = (await c.imp('reviewIssues.list', { updateId: c.update.updateId, group: 'accounts' })).items
        assert.equal(issuesAfter[0].status, 'open')
        assert.equal(issuesAfter[0].version, issuesBefore[0].version + 1)
        await mapAccounts(c)
        assert.equal((await state(c)).coverage.selectedEventsReadyToPost, true)
        assert.equal((await rows(c))[0].categoryId, c.categories.get('food__drink').id)
        assert.deepEqual(await dump(c, 'catledger_import_rows', 'row_id'), evidence)
        assert.deepEqual(await dump(c, 'catledger_transactions', 'transaction_id'), ledger)
      })

      await t.test('并发同请求只写一次，人工分类重整保留，整批入账使用修改后分类', async () => {
        const c = await context(); await mapAccounts(c)
        const data = await input(c), before = await state(c)
        const [one, two] = await Promise.all([c.imp('financeUpdates.setCategory', data), c.imp('financeUpdates.setCategory', data)])
        assert.deepEqual(one, two)
        assert.equal(one.appliedVersion, before.update.version + 1)
        const recovered = await c.imp('imports.commandResult', { requestId: data.requestId, commandAction: 'financeUpdates.setCategory' })
        assert.deepEqual(recovered, one)
        const [[actions]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_finance_actions WHERE uid = ? AND action_type = 'set_event_category'", [c.uid])
        assert.equal(Number(actions.n), 1)
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v31' WHERE uid = ? AND update_id = ?", [c.uid, c.update.updateId])
        await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.update.updateId, version: one.appliedVersion })
        assert.equal((await rows(c))[0].categoryId, data.categoryId)
        await c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: c.update.updateId, version: (await state(c)).update.version })
        const transactions = (await dump(c, 'catledger_transactions', 'transaction_id')).filter(row => row.type === 'expense')
        assert.equal(transactions.find(row => String(row.amount_minor) === '100').category_id, data.categoryId)
        assert.equal(transactions.find(row => String(row.amount_minor) === '200').category_id, c.categories.get('food__meal').id)
        await assert.rejects(c.imp('financeUpdates.setCategory', { ...await input(c), requestId: randomUUID() }), { publicCode: 'CONFLICT' })
      })

      await t.test('跨用户、不同收支分类、归档、旧版本与非活动事件均拒绝', async () => {
        const c = await context(), other = await context(), data = await input(c)
        const before = await dump(c, 'catledger_economic_events', 'event_id')
        const income = [...c.categories.values()].find(row => row.kind === 'income')
        await assert.rejects(other.imp('financeUpdates.setCategory', data), { publicCode: 'NOT_FOUND' })
        for (const change of [{ categoryId: other.categories.get('food__drink').id }, { categoryId: income.id }]) {
          await assert.rejects(c.imp('financeUpdates.setCategory', { ...data, ...change, requestId: randomUUID() }), { publicCode: 'VALIDATION_ERROR' })
        }
        for (const change of [{ eventVersion: data.eventVersion + 1 }, { updateVersion: data.updateVersion + 1 }]) {
          await assert.rejects(c.imp('financeUpdates.setCategory', { ...data, ...change, requestId: randomUUID() }), { publicCode: 'CONFLICT' })
        }
        await c.api('categories.archive', { requestId: randomUUID(), categoryId: data.categoryId, version: 1 })
        await assert.rejects(c.imp('financeUpdates.setCategory', { ...data, requestId: randomUUID() }), { publicCode: 'VALIDATION_ERROR' })
        assert.deepEqual(await dump(c, 'catledger_economic_events', 'event_id'), before)
        for (const status of ['excluded', 'duplicate', 'posted']) {
          await lab.owner.execute('UPDATE catledger_economic_events SET status = ?, state = ? WHERE uid = ? AND event_id = ?', [status, status, c.uid, data.eventId])
          await assert.rejects(c.imp('financeUpdates.setCategory', { ...data, categoryId: c.categories.get('food').id, requestId: randomUUID() }), { publicCode: 'CONFLICT' })
        }
      })

      await t.test('中途失败全部回滚；两个不同分类同时提交只有一个版本胜出', async () => {
        const c = await context(), data = await input(c)
        const tables = [['catledger_economic_events', 'event_id'], ['catledger_finance_updates', 'update_id'], ['catledger_review_issues', 'issue_id'],
          ['catledger_review_issue_members', 'member_id'], ['catledger_finance_actions', 'action_id'], ['catledger_mutation_receipts', 'idempotency_key_digest']]
        const before = await Promise.all(tables.map(([table, order]) => dump(c, table, order)))
        failAfterSave = true
        await assert.rejects(c.imp('financeUpdates.setCategory', data), { publicCode: 'INTERNAL_ERROR' })
        failAfterSave = false
        assert.deepEqual(await Promise.all(tables.map(([table, order]) => dump(c, table, order))), before)
        const results = await Promise.allSettled([c.imp('financeUpdates.setCategory', data),
          c.imp('financeUpdates.setCategory', { ...data, requestId: randomUUID(), categoryId: c.categories.get('shopping').id })])
        assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
        assert.equal(results.find(row => row.status === 'rejected').reason.publicCode, 'CONFLICT')
      })

      await t.test('分类目录按收支过滤并搜索父子名称，跨页游标不能换收支范围', async () => {
        const c = await context(), first = await c.imp('financeUpdates.options', { updateId: c.update.updateId, kind: 'categories', categoryKind: 'expense', pageSize: 2 })
        assert.ok(first.items.every(row => row.kind === 'expense'))
        assert.ok(first.nextCursor)
        const next = await c.imp('financeUpdates.options', { updateId: c.update.updateId, kind: 'categories', categoryKind: 'expense', pageSize: 2, cursor: first.nextCursor })
        assert.ok(next.items.every(row => row.kind === 'expense'))
        await assert.rejects(c.imp('financeUpdates.options', { updateId: c.update.updateId, kind: 'categories', categoryKind: 'income', cursor: first.nextCursor }), { publicCode: 'INVALID_CURSOR' })
        const found = await c.imp('financeUpdates.options', { updateId: c.update.updateId, kind: 'categories', categoryKind: 'expense', query: '餐饮', pageSize: 40 })
        assert.ok(found.items.some(row => row.categoryId === c.categories.get('food__drink').id && row.parentName === '餐饮'))
      })
    } finally { await lab.close() }
  })
