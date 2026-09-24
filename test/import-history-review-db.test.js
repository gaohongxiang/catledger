const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')

test('历史疑似重复：真实隔离 MySQL，原子拒绝与人工裁决', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const logs = []
    async function context() {
      const services = localServices({ apiPool, importPool, subject: 'synthetic-history-' + randomUUID(),
        logger: { warn(value) { logs.push(value) }, error(value) { logs.push(value) } } })
      const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
      const user = await api('bootstrap')
      const accountId = (await api('accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成查重账户',
        openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
      const categoryId = user.categories.find(row => row.kind === 'expense').id
      const manual = (overrides = {}) => api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: accountId,
        categoryId, amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480, ...overrides })
      return { services, api, imp, uid: user.uid, accountId, manual, incomeCategoryId: user.categories.find(row => row.kind === 'income').id }
    }
    async function mapAccounts(c, update) {
      const issues = await c.imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })
      const decisions = issues.items.filter(row => row.status === 'open').map(row => ({ issueId: row.issueId, issueVersion: row.version,
        operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } }))
      if (decisions.length) await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId,
        updateVersion: update.appliedVersion, decisions })
      return update.updateId
    }
    async function bank(c, extra = '', nature = '消费') {
      const content = Buffer.from('交易日期,交易金额,收支,交易类型,摘要\n2026-09-01 12:00,1.00,支出,' + nature + ',合成银行消费' + extra)
      const prepared = await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成信用卡.csv', size: content.length }] })
      const file = prepared.files[0]; c.services.objects.set(file.cloudPath, content)
      const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
      const preview = (await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })).bankPreview
      const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: { ...preview.suggested,
        schemaVersion: 1, headerRow: preview.headerRow, sheetIndex: preview.sheetIndex, headerToken: preview.headerToken } })
      const update = await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
      return mapAccounts(c, update)
    }
    const summary = (c, updateId) => c.imp('financeUpdates.summary', { updateId })
    const issues = async (c, updateId) => (await c.imp('reviewIssues.list', { updateId, status: 'open' })).items.filter(row => row.primaryReasonCode === 'historical_duplicate_candidate')
    const post = async (c, updateId) => c.imp('financeUpdates.post', { requestId: randomUUID(), updateId, version: (await summary(c, updateId)).update.version })
    const recheck = async (c, updateId) => c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId, version: (await summary(c, updateId)).update.version })
    async function resolve(c, updateId, issue, decision, extra = {}) {
      return c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId, updateVersion: (await summary(c, updateId)).update.version,
        issueId: issue.issueId, issueVersion: issue.version, decision, ...extra })
    }
    async function count(c) {
      return Number((await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid = ? AND type = 'expense' AND deleted_at IS NULL", [c.uid]))[0][0].n)
    }
    await t.test('微信已入账后导银行，候选可分页；选择同一笔不重复写钱且重试幂等', async () => {
      const c = await context()
      const first = await mapAccounts(c, await prepareSyntheticUpdate(c.services, 1, 'SYNTHETIC-HISTORY-WECHAT'))
      await post(c, first)
      const updateId = await bank(c)
      const [issue] = await issues(c, updateId)
      assert.ok(issue); assert.equal(issue.candidateCount, 1)
      await assert.rejects(post(c, updateId), { publicCode: 'UNRESOLVED_IMPORT' })
      const page = await c.imp('reviewIssues.members', { updateId, issueId: issue.issueId, memberKind: 'transaction', pageSize: 1 })
      assert.equal(page.total, 1); assert.ok(page.items[0].transaction.transactionId)
      const data = { requestId: randomUUID(), updateId, updateVersion: (await summary(c, updateId)).update.version,
        issueId: issue.issueId, issueVersion: issue.version, decision: 'link_existing_transaction', transactionId: page.items[0].transaction.transactionId }
      const [a, b] = await Promise.all([c.imp('reviewIssues.resolve', data), c.imp('reviewIssues.resolve', data)])
      assert.equal(a.appliedVersion, b.appliedVersion)
      await post(c, updateId)
      assert.equal(await count(c), 1)
      assert.equal((await summary(c, updateId)).posting.createdTransactionCount, 0)
      const counts = (await summary(c, updateId)).workbench.recordSummary
      assert.equal(counts.duplicateCount, 1); assert.equal(counts.excludedCount, 0); assert.equal(counts.totalCount, 1)
      assert.equal((await c.imp('economicEvents.list', { updateId, status: 'duplicate' })).items.length, 1)
    })
    await t.test('手工账也参与；同额独立交易只有明确确认后才新增，另一个用户不能套用候选', async () => {
      const c = await context(), other = await context()
      await c.manual(); const foreign = await other.manual()
      const updateId = await bank(c), [issue] = await issues(c, updateId)
      const page = await c.imp('reviewIssues.members', { updateId, issueId: issue.issueId, memberKind: 'transaction' })
      assert.equal(page.total, 1); assert.notEqual(page.items[0].objectId, foreign.transactionId)
      await assert.rejects(call(other.services.import, 'reviewIssues.members', { updateId, issueId: issue.issueId, memberKind: 'transaction' }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(resolve(c, updateId, issue, 'link_existing_transaction', { transactionId: foreign.transactionId }), { publicCode: 'VALIDATION_ERROR' })
      await resolve(c, updateId, issue, 'confirm_distinct')
      await recheck(c, updateId); assert.equal((await issues(c, updateId)).length, 0)
      await post(c, updateId); assert.equal(await count(c), 2)
    })
    await t.test('进入核对后新增历史记录，正式入账锁内复查整批拒绝；重新核对保留原选择', async () => {
      const c = await context(), updateId = await bank(c)
      assert.equal((await issues(c, updateId)).length, 0)
      await c.manual()
      await assert.rejects(post(c, updateId), { publicCode: 'HISTORY_REVIEW_REQUIRED' })
      assert.equal(await count(c), 1)
      assert.equal((await summary(c, updateId)).update.status, 'review')
      await recheck(c, updateId); const [issue] = await issues(c, updateId)
      assert.ok(issue)
      await resolve(c, updateId, issue, 'confirm_distinct')
      await c.manual({ note: '第二笔独立合成记录' })
      await assert.rejects(post(c, updateId), { publicCode: 'HISTORY_REVIEW_REQUIRED' })
      await recheck(c, updateId); const [newIssue] = await issues(c, updateId)
      assert.notEqual(newIssue.issueId, issue.issueId); assert.equal(newIssue.candidateCount, 2)
      await resolve(c, updateId, newIssue, 'confirm_distinct'); await post(c, updateId)
      assert.equal(await count(c), 3)
    })
    await t.test('候选变更拒绝旧选择；已确认复用的历史记录被删除后恢复本次记录', async () => {
      const c = await context(), prior = await c.manual(), updateId = await bank(c)
      let [issue] = await issues(c, updateId)
      await lab.owner.execute('UPDATE catledger_transactions SET version = version + 1 WHERE uid = ? AND transaction_id = ?', [c.uid, prior.transactionId])
      await assert.rejects(resolve(c, updateId, issue, 'link_existing_transaction', { transactionId: prior.transactionId }), { publicCode: 'HISTORY_REVIEW_REQUIRED' })
      await recheck(c, updateId); [issue] = await issues(c, updateId)
      await resolve(c, updateId, issue, 'link_existing_transaction', { transactionId: prior.transactionId })
      await lab.owner.execute('UPDATE catledger_transactions SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1 WHERE uid = ? AND transaction_id = ?', [c.uid, prior.transactionId])
      await assert.rejects(post(c, updateId), { publicCode: 'HISTORY_REVIEW_REQUIRED' })
      await recheck(c, updateId)
      assert.equal((await issues(c, updateId)).length, 0)
      await post(c, updateId); assert.equal(await count(c), 1)
    })
    await t.test('方向不同、时间超过窗口不匹配；历史候选超过一页可完整浏览', async () => {
      const c = await context()
      await c.manual({ occurredLocalAt: '2026-08-01T12:00:00' })
      await c.api('transactions.create', { requestId: randomUUID(), type: 'income', destinationAccountId: c.accountId,
        categoryId: c.incomeCategoryId, amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480 })
      for (let index = 0; index < 10; index++) await c.manual()
      const updateId = await bank(c), [issue] = await issues(c, updateId)
      assert.equal(issue.candidateCount, 10)
      let cursor, found = []
      do {
        const page = await c.imp('reviewIssues.members', { updateId, issueId: issue.issueId, memberKind: 'transaction', pageSize: 4, cursor })
        found.push(...page.items.map(row => row.objectId)); cursor = page.nextCursor
      } while (cursor)
      assert.equal(new Set(found).size, 10)
    })
    await t.test('未知交易类型也先查重；复用记录删除后恢复类型核对，不能直接入账', async () => {
      const c = await context(), prior = await c.manual(), updateId = await bank(c, '', '')
      const [issue] = await issues(c, updateId)
      assert.ok(issue)
      await resolve(c, updateId, issue, 'link_existing_transaction', { transactionId: prior.transactionId })
      assert.equal((await c.imp('reviewIssues.list', { updateId, status: 'open' })).items.length, 0)
      await lab.owner.execute('UPDATE catledger_transactions SET deleted_at = CURRENT_TIMESTAMP(3), version = version + 1 WHERE uid = ? AND transaction_id = ?', [c.uid, prior.transactionId])
      await assert.rejects(post(c, updateId), { publicCode: 'HISTORY_REVIEW_REQUIRED' })
      await recheck(c, updateId)
      const pending = (await c.imp('reviewIssues.list', { updateId, status: 'open' })).items
      assert.ok(pending.some(row => row.issueType === 'shared_fields'))
      await assert.rejects(post(c, updateId), { publicCode: 'UNRESOLVED_IMPORT' })
      assert.equal(await count(c), 0)
    })
    await t.test('两份无流水号文件先同时整理，第一份入账后第二份不可绕过历史核对', async () => {
      const c = await context(), first = await bank(c, '甲'), second = await bank(c, '乙')
      const results = await Promise.allSettled([post(c, first), post(c, second)])
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(results.find(result => result.status === 'rejected').reason.publicCode, 'HISTORY_REVIEW_REQUIRED')
      assert.equal(await count(c), 1)
      const pending = (await summary(c, first)).update.status === 'review' ? first : second
      await recheck(c, pending)
      const [issue] = await issues(c, pending)
      const page = await c.imp('reviewIssues.members', { updateId: pending, issueId: issue.issueId, memberKind: 'transaction' })
      await resolve(c, pending, issue, 'link_existing_transaction', { transactionId: page.items[0].objectId })
      await post(c, pending); assert.equal(await count(c), 1)
    })
    assert.doesNotMatch(JSON.stringify(logs), /合成银行消费|sourceAccountName|transactionVersion|bindings|password/)
  } finally { await lab.close() }
})
