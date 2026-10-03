const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { splitSqlStatements } = require('../migrations/runner')
const { localServices, call } = require('./helpers/local-services')
const { categoryMemory } = require('../cloudfunctions/catledger-import/src/category-memory')
const { digestParts } = require('../cloudfunctions/catledger-import/src/digest')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/review/policy')

test('分类自动化隔离MySQL：名称迁移、实际解析、旧草稿、记忆隔离与原子入账',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const grants = require('../scripts/runtime-role-grants')
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      let failMemory = false
      const faultPool = { async getConnection() {
        const connection = await importPool.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failMemory && /INSERT INTO catledger_import_category_mappings/.test(sql)) throw new Error('synthetic category persistence failure')
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function context() {
        const services = localServices({ apiPool, importPool: faultPool, subject: 'synthetic-category-' + randomUUID() })
        const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
        const identity = await api('bootstrap'), categories = new Map(identity.categories.map(c => [c.systemKey, c]))
        const accountId = (await api('accounts.create', { requestId: randomUUID(), type: 'wallet', name: '合成分类账户',
          openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        return { services, api, imp, uid: identity.uid, categories, accountId }
      }
      async function prepare(c, items, { day = '01', map = true } = {}) {
        const prefix = randomUUID()
        const content = Buffer.from(['微信支付账单明细,,,,,,,,,,,',
          '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
          ...items.map((item, i) => `2026-09-${day} 12:${String(i).padStart(2, '0')}:00,商户消费,合成分类商户,${item},支出,${i + 1}.00,微信零钱,支付成功,SYNTHETIC-${prefix}-${i},,,`)].join('\n'))
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成分类验证.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
          fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        let update = await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
        if (map) {
          const issues = (await c.imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })).items.filter(i => i.status === 'open')
          if (issues.length) update = await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId,
            updateVersion: update.appliedVersion, decisions: issues.map(i => ({ issueId: i.issueId, issueVersion: i.version,
              operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } })) })
        }
        return update
      }
      const events = async (c, update) => (await c.imp('economicEvents.list', { updateId: update.updateId })).items
      const summary = (c, update) => c.imp('financeUpdates.summary', { updateId: update.updateId })
      const evidence = async c => (await lab.owner.execute('SELECT * FROM catledger_import_rows WHERE uid=? ORDER BY row_id', [c.uid]))[0]
      const ledger = async c => (await lab.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? ORDER BY transaction_id', [c.uid]))[0]
      const revision = async c => String((await lab.owner.execute('SELECT data_revision AS r FROM catledger_users WHERE uid=?', [c.uid]))[0][0].r)
      async function remember(c, key, categoryId, version = 'category-alias-v2') {
        await lab.owner.execute(`INSERT INTO catledger_import_category_mappings
          (uid,mapping_id,source_type,alias_key,alias_key_version,category_id) VALUES (?,?,'wechat',?,?,?)`,
        [c.uid, randomUUID(), key, version, categoryId])
      }
      const keyFor = item => categoryMemory('wechat', { rawTransactionType: '商户消费', counterparty: '合成分类商户', item }).pairKey

      await t.test('原预设改名原子且可重跑，自定义、同名冲突、归档与旧账ID均保留', async () => {
        const old = await context(), renamed = await context(), conflict = await context(), archived = await context()
        for (const c of [old, renamed, conflict, archived]) await lab.owner.execute(
          "UPDATE catledger_categories SET name='吃饭', normalized_name='吃饭' WHERE uid=? AND system_key='food__meal'", [c.uid])
        await renamed.api('categories.update', { requestId: randomUUID(), categoryId: renamed.categories.get('food__meal').id, version: 1, name: '我的正餐' })
        await conflict.api('categories.create', { requestId: randomUUID(), kind: 'expense', parentId: conflict.categories.get('food').id, name: '美食' })
        await archived.api('categories.archive', { requestId: randomUUID(), categoryId: archived.categories.get('food__meal').id, version: 1 })
        const meal = old.categories.get('food__meal')
        await old.api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: old.accountId,
          categoryId: meal.id, amountMinor: '100', occurredLocalAt: '2026-08-02T10:00:00', timezoneOffsetMinutes: -480 })
        const before = await ledger(old), revisions = await Promise.all([old, renamed, conflict, archived].map(revision))
        const statements = splitSqlStatements(readFileSync(join(__dirname, '../migrations/0032_category_meal_name.sql'), 'utf8'))
        for (const statement of statements) await lab.owner.query(statement)
        const current = (await old.api('categories.list')).categories.find(c => c.id === meal.id)
        assert.equal(current.name, '美食'); assert.equal(current.parentId, meal.parentId); assert.equal(current.version, Number(meal.version) + 1)
        assert.equal(BigInt(await revision(old)), BigInt(revisions[0]) + 1n)
        for (const [index, c] of [renamed, conflict, archived].entries()) assert.equal(await revision(c), revisions[index + 1])
        assert.equal((await renamed.api('categories.list')).categories.find(c => c.systemKey === 'food__meal').name, '我的正餐')
        assert.equal((await conflict.api('categories.list')).categories.find(c => c.systemKey === 'food__meal').name, '吃饭')
        assert.equal((await archived.api('categories.list')).categories.find(c => c.systemKey === 'food__meal').archived, true)
        assert.deepEqual(await ledger(old), before)
        const after = await revision(old)
        for (const statement of statements) await lab.owner.query(statement)
        assert.equal(await revision(old), after)
      })

      await t.test('真实CSV解析到二级与具体名称，宽泛旧类型记忆无效且不串用户', async () => {
        const c = await context(), other = await context()
        await remember(c, digestParts('category-alias-v1', 'wechat', '商户消费'), c.categories.get('shopping').id, 'category-alias-v1')
        await remember(other, keyFor('午餐'), other.categories.get('shopping').id)
        const update = await prepare(c, ['午餐', '奶茶', '水果零食', '地铁票', '药品', '咖啡机', '奶茶和图书'])
        const rows = await events(c, update)
        assert.deepEqual(rows.map(r => r.categoryId), ['food__meal', 'food__drink', 'food__snack', 'transport__public', 'medical__medicine', null, null].map(key => key && c.categories.get(key).id))
        assert.equal(rows[0].categoryName, '餐饮 / 美食')
        assert.equal(rows[4].categoryName, '医疗 / 药品')
        assert.equal((await ledger(c)).length, 1, '整理不应提前写入交易（只有账户开户余额校正）')
        await assert.rejects(other.imp('economicEvents.list', { updateId: update.updateId }), { publicCode: 'NOT_FOUND' })
      })

      await t.test('旧草稿重新整理保留人工分类和排除决定，自动细分不改来源与资金字段', async () => {
        const c = await context(), update = await prepare(c, ['午餐', '奶茶', '药品'])
        const before = await events(c, update), sourceBefore = await evidence(c), ledgerBefore = await ledger(c)
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v31' WHERE uid=? AND update_id=?", [c.uid, update.updateId])
        await lab.owner.execute('UPDATE catledger_economic_events SET category_id=? WHERE uid=? AND event_id=?', [c.categories.get('food').id, c.uid, before[0].eventId])
        await lab.owner.execute('UPDATE catledger_economic_events SET category_id=?, manual_field_mask=manual_field_mask|? WHERE uid=? AND event_id=?',
          [c.categories.get('shopping').id, FIELD_MASK.categoryId, c.uid, before[1].eventId])
        await lab.owner.execute("UPDATE catledger_economic_events SET status='excluded', state='excluded' WHERE uid=? AND event_id=?", [c.uid, before[2].eventId])
        const input = { requestId: randomUUID(), updateId: update.updateId, version: (await summary(c, update)).update.version }
        const [one, two] = await Promise.all([c.imp('financeUpdates.organize', input), c.imp('financeUpdates.organize', input)])
        assert.equal(one.appliedVersion, two.appliedVersion)
        const after = await events(c, update)
        assert.equal(after[0].categoryId, c.categories.get('food__meal').id)
        assert.equal(after[1].categoryId, c.categories.get('shopping').id)
        assert.equal(after[2].status, 'excluded')
        for (let i = 0; i < before.length; i++) for (const key of ['eventId', 'ledgerAccountId', 'amountMinor', 'localAt', 'economicNature']) assert.equal(after[i][key], before[i][key], key)
        assert.deepEqual(await evidence(c), sourceBefore); assert.deepEqual(await ledger(c), ledgerBefore)
        assert.equal((await summary(c, update)).update.requiresReorganization, false)
      })

      await t.test('分类记忆与整批入账原子回滚；并发重试只写一次并只记具体商品', async () => {
        const c = await context(), update = await prepare(c, ['午餐', '奶茶'])
        const before = await ledger(c), balance = (await c.api('accounts.list')).accounts[0].bookBalanceMinor
        const input = { requestId: randomUUID(), updateId: update.updateId, version: (await summary(c, update)).update.version }
        failMemory = true
        await assert.rejects(c.imp('financeUpdates.post', input), { publicCode: 'INTERNAL_ERROR' })
        failMemory = false
        assert.deepEqual(await ledger(c), before)
        assert.equal((await c.api('accounts.list')).accounts[0].bookBalanceMinor, balance)
        assert.equal(Number((await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_category_mappings WHERE uid=?', [c.uid]))[0][0].n), 0)
        const [first, replay] = await Promise.all([c.imp('financeUpdates.post', input), c.imp('financeUpdates.post', input)])
        assert.deepEqual(first, replay)
        assert.equal(first.posting.createdTransactionCount, 2)
        const [memory] = await lab.owner.execute('SELECT alias_key AS aliasKey, alias_key_version AS aliasVersion, version FROM catledger_import_category_mappings WHERE uid=?', [c.uid])
        assert.equal(memory.length, 2); assert.ok(memory.every(m => m.aliasVersion === 'category-alias-v2' && Number(m.version) === 1))
        assert.deepEqual(memory.map(m => m.aliasKey).sort(), [keyFor('午餐'), keyFor('奶茶')].sort())
        const next = await prepare(c, ['午餐', '奶茶', '合成其他商品'], { day: '03' })
        assert.deepEqual((await events(c, next)).map(e => e.categoryId), [c.categories.get('food__meal').id, c.categories.get('food__drink').id, null])
      })

      await t.test('同一具体证据的分类冲突停用旧记忆，不沿用旧值或随机取最后一条', async () => {
        const c = await context(), update = await prepare(c, ['合成混合商品', '合成混合商品'])
        const rows = await events(c, update)
        const food = c.categories.get('food__meal').id, shopping = c.categories.get('shopping').id
        await remember(c, keyFor('合成混合商品'), food)
        for (const [i, event] of rows.entries()) await lab.owner.execute('UPDATE catledger_economic_events SET category_id=?, manual_field_mask=manual_field_mask|? WHERE uid=? AND event_id=?', [i ? shopping : food, FIELD_MASK.categoryId, c.uid, event.eventId])
        await c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: (await summary(c, update)).update.version })
        const [[memory]] = await lab.owner.execute('SELECT disabled_at,version FROM catledger_import_category_mappings WHERE uid=? AND alias_key=?', [c.uid, keyFor('合成混合商品')])
        assert.ok(memory.disabled_at); assert.equal(Number(memory.version), 2)
        const next = await prepare(c, ['合成混合商品'], { day: '04' })
        assert.equal((await events(c, next))[0].categoryId, null)
      })

      await t.test('已入账补分类使用同一具体记忆协议，跨用户和冲突版本整批拒绝', async () => {
        const c = await context(), other = await context(), update = await prepare(c, ['合成特别商品'])
        await c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: (await summary(c, update)).update.version })
        const tx = (await ledger(c)).find(r => r.type === 'expense'), child = c.categories.get('food__meal')
        const data = { requestId: randomUUID(), categoryId: child.id, items: [{ transactionId: tx.transaction_id, version: Number(tx.version) }] }
        await assert.rejects(other.api('categories.assignTransactions', data), { publicCode: 'NOT_FOUND' })
        await assert.rejects(c.api('categories.assignTransactions', { ...data, items: [{ ...data.items[0], version: Number(tx.version) + 1 }] }), { publicCode: 'CONFLICT' })
        const [one, two] = await Promise.all([c.api('categories.assignTransactions', data), c.api('categories.assignTransactions', data)])
        assert.deepEqual(one, two)
        const [memory] = await lab.owner.execute('SELECT alias_key,alias_key_version FROM catledger_import_category_mappings WHERE uid=?', [c.uid])
        assert.deepEqual(memory, [{ alias_key: keyFor('合成特别商品'), alias_key_version: 'category-alias-v2' }])
        const next = await prepare(c, ['合成特别商品', '合成其他商品'], { day: '05' })
        assert.deepEqual((await events(c, next)).map(e => e.categoryId), [child.id, null])
      })
    } finally { await lab.close() }
  })
