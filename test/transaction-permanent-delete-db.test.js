const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate, confirmSyntheticHistoryDistinct } = require('./helpers/local-services')
const { plan } = require('./helpers/loan-charges')

const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])
const parse = value => typeof value === 'string' ? JSON.parse(value) : value

test('普通永久删账：真实 handler、隔离 MySQL、依赖清理和最小权限', { skip: !hasDatabase, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    async function context() {
      const subject = 'synthetic-permanent-delete-' + randomUUID()
      const services = localServices({ apiPool, importPool, subject, now: () => Date.parse('2026-09-28T12:00:00Z') })
      const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
      const user = await api('bootstrap'), uid = user.uid, categoryId = user.categories.find(row => row.kind === 'expense').id
      const account = async (type, amount, name) => (await api('accounts.create', { requestId: randomUUID(), type,
        name, openingDisplayBalanceMinor: amount, occurredLocalAt: '2020-01-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
      const accountId = await account('bank', '1000000', '合成删账资产')
      const manual = extra => api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: accountId,
        categoryId, amountMinor: '800', occurredLocalAt: '2026-09-05T12:00:00', timezoneOffsetMinutes: -480, ...extra })
      return { subject, services, api, imp, uid, categoryId, accountId, account, manual }
    }
    async function rows(c, table, order) {
      const [result] = await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${order}`, [c.uid])
      return result.map(row => ({ ...row }))
    }
    async function transaction(c, id) {
      const [[row]] = await lab.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? AND transaction_id=?', [c.uid, id])
      return row ? { ...row } : null
    }
    async function revision(c) {
      const [[row]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [c.uid])
      return String(row.revision)
    }
    async function balance(c) {
      return (await c.api('accounts.list')).accounts.find(row => row.accountId === c.accountId).bookBalanceMinor
    }
    async function snapshot(c) {
      const result = { revision: await revision(c) }
      for (const [table, order] of [
        ['catledger_transactions', 'transaction_id'], ['catledger_economic_event_transactions', 'link_id'],
        ['catledger_review_issue_members', 'member_id'], ['catledger_economic_events', 'event_id'],
        ['catledger_finance_updates', 'update_id'], ['catledger_mutation_receipts', 'idempotency_key_digest']
      ]) result[table] = await rows(c, table, order)
      return result
    }
    const deleteRequest = row => ({ requestId: randomUUID(), transactionId: row.transactionId, version: Number(row.version) })
    async function mapAccounts(c, update) {
      const issues = await c.imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })
      const decisions = issues.items.filter(row => row.status === 'open').map(row => ({ issueId: row.issueId,
        issueVersion: row.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } }))
      return decisions.length ? c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId,
        updateVersion: update.appliedVersion, decisions }) : update
    }
    async function post(c, update) {
      return c.imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
    }
    async function imported(c, count, prefix) {
      const update = await mapAccounts(c, await prepareSyntheticUpdate(c.services, count, prefix))
      const result = await post(c, update)
      const [items] = await lab.owner.execute(`SELECT t.transaction_id AS transactionId, t.version, l.event_id AS eventId
        FROM catledger_economic_event_transactions l JOIN catledger_transactions t
          ON t.uid=l.uid AND t.transaction_id=l.transaction_id
        WHERE l.uid=? AND l.update_id=? AND l.creation_method='created' ORDER BY t.transaction_id`, [c.uid, update.updateId])
      return { update, result, items }
    }
    async function historicalCandidate(c, transactionId, prefix) {
      let update = await mapAccounts(c, await prepareSyntheticUpdate(c.services, 1, prefix))
      const issue = (await c.imp('reviewIssues.list', { updateId: update.updateId, status: 'open' })).items
        .find(row => row.primaryReasonCode === 'historical_duplicate_candidate')
      assert.ok(issue, '真实历史核对必须产生候选，不能直接播种决定')
      update = await c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId,
        updateVersion: update.appliedVersion, issueId: issue.issueId, issueVersion: issue.version,
        decision: 'link_existing_transaction', transactionId })
      return update
    }
    async function assertProtected(c, id, sibling) {
      const row = await transaction(c, id), before = await snapshot(c)
      assert.ok(row)
      await assert.rejects(c.api('transactions.delete', { requestId: randomUUID(), transactionId: id, version: Number(row.version) }),
        { publicCode: 'LOAN_TRANSACTION_LOCKED' })
      await assert.rejects(c.api('transactions.deleteMany', { requestId: randomUUID(), items: [
        { transactionId: sibling.transactionId, version: sibling.version }, { transactionId: id, version: Number(row.version) }
      ] }), { publicCode: 'LOAN_TRANSACTION_LOCKED' })
      assert.deepEqual(await snapshot(c), before)
    }

    await t.test('单笔手工账物理消失；跨用户和旧版本拒绝；响应丢失、并发重放不删后来重添的账', async () => {
      const c = await context(), old = await c.manual({ note: '合成可永久删除记录' }), request = deleteRequest(old)
      const before = await snapshot(c), other = await context()
      await assert.rejects(other.api('transactions.delete', request), { publicCode: 'NOT_FOUND' })
      await assert.rejects(c.api('transactions.delete', { ...request, version: old.version + 1 }), { publicCode: 'CONFLICT' })
      assert.deepEqual(await snapshot(c), before)
      assert.equal(await balance(c), '999200')
      let committed
      await assert.rejects((async () => {
        committed = await c.api('transactions.delete', request)
        throw new Error('synthetic response lost after commit')
      })(), /synthetic response lost/)
      assert.equal(await transaction(c, old.transactionId), null, '直接查主表，不通过 deleted_at 过滤')
      assert.equal(await balance(c), '1000000')
      assert.equal((await c.api('statistics.get', { month: '2026-09' })).summary.expenseMinor, '0')
      assert.equal((await c.api('transactions.list', { month: '2026-09' })).transactions.length, 0)
      assert.deepEqual((await c.api('transactions.commandResult', { requestId: request.requestId,
        commandAction: 'transactions.delete' })).result, committed)
      const restored = await c.manual({ note: '合成可永久删除记录' }), stableRevision = await revision(c)
      assert.notEqual(restored.transactionId, old.transactionId)
      const results = await Promise.all([c.api('transactions.delete', request), c.api('transactions.delete', request)])
      assert.deepEqual(results, [committed, committed]); assert.equal(await revision(c), stableRevision)
      assert.ok(await transaction(c, restored.transactionId)); assert.equal(await balance(c), '999200')
      await assert.rejects(c.api('transactions.delete', { ...request, transactionId: restored.transactionId }),
        { publicCode: 'IDEMPOTENCY_CONFLICT' })
      const receipts = (await rows(c, 'catledger_mutation_receipts', 'idempotency_key_digest')).filter(row => row.action === 'transactions.delete')
      assert.equal(receipts.length, 1)
      assert.match(receipts[0].request_digest, /^[a-f0-9]{64}$/)
      assert.deepEqual(parse(receipts[0].result_json), { transactionId: old.transactionId, deleted: true, version: old.version + 1 })
    })

    await t.test('导入单笔硬删保留共享证据；同文件重导只补缺失账；旧删除回放和导出均无孤立现行关系', async () => {
      const c = await context(), prefix = 'SYNTHETIC-PERMANENT-IMPORT'
      const first = await imported(c, 2, prefix), [deleted, survivor] = first.items
      await historicalCandidate(c, deleted.transactionId, 'SYNTHETIC-PERMANENT-CANDIDATE')
      const retainedTables = [
        ['catledger_import_files', 'import_id'], ['catledger_import_batches', 'batch_id'],
        ['catledger_import_rows', 'row_id'], ['catledger_source_identities', 'identity_id'],
        ['catledger_event_evidence', 'event_id,row_id,evidence_role'], ['catledger_finance_update_sources', 'source_id'],
        ['catledger_finance_update_postings', 'posting_id'], ['catledger_accounts', 'account_id'], ['catledger_categories', 'category_id']
      ]
      const evidenceBefore = new Map()
      for (const [table, order] of retainedTables) evidenceBefore.set(table, await rows(c, table, order))
      const filesBefore = [...c.services.objects].map(([key, bytes]) => [key, Buffer.from(bytes)])
      const request = deleteRequest(deleted), result = await c.api('transactions.delete', request)
      assert.equal(await transaction(c, deleted.transactionId), null); assert.ok(await transaction(c, survivor.transactionId))
      assert.equal(await balance(c), '999900')
      assert.equal((await c.api('statistics.get', { month: '2026-09' })).summary.expenseMinor, '100')
      const current = await c.api('transactions.list', { month: '2026-09' })
      assert.deepEqual(current.transactions.map(row => row.transactionId), [survivor.transactionId])
      assert.equal(current.transactions[0].importContext.updateId, first.update.updateId)
      for (const [table, order] of retainedTables) assert.deepEqual(await rows(c, table, order), evidenceBefore.get(table), table)
      for (const [key, bytes] of filesBefore) assert.deepEqual(c.services.objects.get(key), bytes)
      for (const event of [deleted, survivor]) {
        const evidence = await c.imp('economicEvents.evidence', { protocolVersion: 2, eventId: event.eventId })
        assert.equal(evidence.total, 1)
      }
      const history = (await c.imp('financeUpdates.list')).items.find(row => row.updateId === first.update.updateId)
      assert.equal(history.status, 'posted'); assert.equal(history.transactionCount, 1)
      assert.equal((await c.imp('financeUpdates.summary', { updateId: first.update.updateId })).posting.createdTransactionCount, 2)
      let again = await mapAccounts(c, await prepareSyntheticUpdate(c.services, 2, prefix))
      assert.notEqual(again.updateId, first.update.updateId)
      again = await confirmSyntheticHistoryDistinct(c.services, again)
      assert.equal((await post(c, again)).posting.createdTransactionCount, 1)
      const afterImport = await c.api('transactions.list', { month: '2026-09' })
      assert.equal(afterImport.transactions.length, 2)
      assert.ok(afterImport.transactions.some(row => row.transactionId === survivor.transactionId))
      const newlyImported = afterImport.transactions.find(row => row.transactionId !== survivor.transactionId)
      const stableRevision = await revision(c)
      assert.deepEqual(await c.api('transactions.delete', request), result)
      assert.equal(await revision(c), stableRevision); assert.ok(await transaction(c, newlyImported.transactionId))
      assert.equal(await transaction(c, deleted.transactionId), null)
      assert.equal(await balance(c), '999800')
      const job = await c.api('dataExports.start', { requestId: randomUUID() }), parts = []
      let cursor, completeToken
      do {
        const page = await c.api('dataExports.page', { exportId: job.exportId, ...(cursor ? { cursor } : {}) })
        parts.push(page.text); cursor = page.nextCursor; completeToken = page.completeToken
      } while (cursor)
      const exported = parts.join('').trimEnd().split('\n').map(line => JSON.parse(line))
      assert.equal((await c.api('dataExports.finish', { exportId: job.exportId, completeToken })).rows, exported.length)
      const table = name => exported.filter(row => row.table === name).map(row => row.row)
      const transactionIds = new Set(table('catledger_transactions').map(row => row.transaction_id))
      assert.equal(transactionIds.has(deleted.transactionId), false)
      assert.ok(table('catledger_economic_event_transactions').every(row => transactionIds.has(row.transaction_id)))
      assert.ok(table('catledger_review_issue_members').filter(row => row.object_type === 'transaction')
        .every(row => transactionIds.has(row.object_id)))
      const originalPosting = table('catledger_finance_update_postings').find(row => row.update_id === first.update.updateId)
      assert.equal(Number(originalPosting.created_transaction_count), 2); assert.equal(originalPosting.state, 'completed')
      const originalFiles = evidenceBefore.get('catledger_import_files')
      assert.ok(originalFiles.every(file => table('catledger_import_files').some(row => row.import_id === file.import_id)))
      for (const [key, bytes] of filesBefore) assert.deepEqual(c.services.objects.get(key), bytes)
    })

    await t.test('只复用已有交易的已入账文件也可在永久删除后重导；原来源撤销不删除重导新账', async () => {
      const c = await context(), prior = await c.manual({ amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00' }), prefix = 'SYNTHETIC-REUSED-DELETE'
      const original = await historicalCandidate(c, prior.transactionId, prefix)
      assert.equal((await post(c, original)).posting.createdTransactionCount, 0)
      await c.api('transactions.delete', deleteRequest(prior))
      assert.equal(await transaction(c, prior.transactionId), null)
      const events = await rows(c, 'catledger_economic_events', 'event_id')
      const reused = events.find(row => row.update_id === original.updateId)
      assert.ok(parse(reused.reason_codes_json).includes('reused_transaction_permanently_deleted'))
      assert.equal(parse(reused.reason_codes_json).includes('transaction_permanently_deleted'), false)
      const next = await mapAccounts(c, await prepareSyntheticUpdate(c.services, 1, prefix))
      assert.notEqual(next.updateId, original.updateId)
      assert.equal((await post(c, next)).posting.createdTransactionCount, 1)
      const current = (await c.api('transactions.list', { month: '2026-09' })).transactions
      assert.equal(current.length, 1); assert.notEqual(current[0].transactionId, prior.transactionId)
      const impact = await c.imp('financeUpdates.undoImpact', { updateId: original.updateId })
      assert.equal(impact.canUndo, true); assert.equal(impact.createdTransactionCount, 0)
      await c.imp('financeUpdates.undo', { requestId: randomUUID(), updateId: original.updateId,
        version: impact.update.version, previewToken: impact.previewToken })
      assert.ok(await transaction(c, current[0].transactionId))
      assert.equal(await balance(c), '999900')
      assert.equal((await c.imp('financeUpdates.summary', { updateId: next.updateId })).posting.createdTransactionCount, 1)
    })

    for (const kind of ['payment', 'repayment']) await t.test(`${kind}完整来源分配才可删除；拒绝部分选择，完整删除后同文件重导仍走分配确认`, async () => {
      const c = await context(), sibling = await c.manual(), wallet = await c.account('wallet', '100000', '合成组合零钱')
      const debt = await c.account('credit', '100000', '合成还款目标一'), debt2 = await c.account('credit', '100000', '合成还款目标二')
      const content = Buffer.from(kind === 'payment' ? ['微信支付账单明细',
        '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号',
        '2026-09-01 12:00:00,商户消费,合成商户,合成商品,支出,10.00,零钱&招商银行储蓄卡(1234),支付成功,SYNTHETIC-DELETE-SPLIT'
      ].join('\n') : ['支付宝(中国)网络技术有限公司 电子客户回单',
        '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
        '2026-09-01 12:00:00,信用借还,花呗|信用购,自动还款-花呗|信用购2026年09月账单,10.00,不计收支,合成银行储蓄卡(1234),还款成功,,SYNTHETIC-DELETE-AGGREGATE,,'
      ].join('\n'))
      async function prepare() {
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成完整分配.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
          fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        let update = await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
        const issues = (await c.imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts', status: 'open' })).items
        if (kind === 'payment') {
          for (const issue of issues) {
            assert.equal(issue.primaryReasonCode, 'payment_components_ambiguous')
            update = await c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
              issueId: issue.issueId, issueVersion: issue.version, decision: 'apply_fields', fields: { paymentAccounts: [
                { componentIndex: 0, accountId: wallet }, { componentIndex: 1, accountId: c.accountId }
              ] } })
          }
        } else update = await mapAccounts(c, update)
        return update
      }
      async function confirm(update) {
        const issues = (await c.imp('reviewIssues.list', { updateId: update.updateId, status: 'open' })).items
        const allocation = issues.find(issue => issue.issueType === (kind === 'payment' ? 'shared_fields' : 'transfer_accounts'))
        assert.ok(allocation, '重导必须重新确认本次资金分配：' + issues.map(issue => issue.issueType + ':' + issue.primaryReasonCode).join(','))
        const fields = kind === 'payment' ? { paymentResolution: { version: 'payment-resolution-v2', nature: 'expense',
          confirmedFromDetails: true, evidenceNote: '已核对合成付款详情', allocations: [
            { componentIndex: 0, accountId: wallet, amountMinor: '600' }, { componentIndex: 1, accountId: c.accountId, amountMinor: '400' }
          ] } } : { repaymentAllocations: [{ accountId: debt, amountMinor: '600' }, { accountId: debt2, amountMinor: '400' }] }
        update = await c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
          issueId: allocation.issueId, issueVersion: allocation.version, decision: 'apply_fields', fields })
        for (const issue of (await c.imp('reviewIssues.list', { updateId: update.updateId, status: 'open' })).items) {
          assert.equal(issue.issueType, 'category_assignment')
          update = await c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
            issueId: issue.issueId, issueVersion: issue.version, decision: 'apply_fields', fields: { categoryId: c.categoryId } })
        }
        return update
      }
      const first = await confirm(await prepare())
      assert.equal((await post(c, first)).posting.createdTransactionCount, 2)
      const [items] = await lab.owner.execute(`SELECT t.transaction_id AS transactionId,t.version FROM catledger_transactions t
        JOIN catledger_economic_event_transactions l ON l.uid=t.uid AND l.transaction_id=t.transaction_id
        WHERE l.uid=? AND l.update_id=? AND l.superseded_at IS NULL`, [c.uid, first.updateId])
      assert.equal(items.length, 2)
      const before = await snapshot(c)
      await assert.rejects(c.api('transactions.delete', deleteRequest(items[0])), { publicCode: 'TRANSACTION_GROUP_LOCKED' })
      await assert.rejects(c.api('transactions.deleteMany', { requestId: randomUUID(),
        items: [items[0], sibling].map(row => ({ transactionId: row.transactionId, version: Number(row.version) })) }), { publicCode: 'TRANSACTION_GROUP_LOCKED' })
      assert.deepEqual(await snapshot(c), before)
      const request = { requestId: randomUUID(), items: items.map(row => ({ transactionId: row.transactionId, version: Number(row.version) })) }
      assert.equal((await c.api('transactions.deleteMany', request)).deletedCount, 2)
      for (const row of items) assert.equal(await transaction(c, row.transactionId), null)
      assert.ok(await transaction(c, sibling.transactionId))
      const next = await prepare()
      await assert.rejects(post(c, next), { publicCode: 'UNRESOLVED_IMPORT' })
      assert.equal((await post(c, await confirm(next))).posting.createdTransactionCount, 2)
      await c.api('transactions.deleteMany', request)
      const current = (await c.api('transactions.list', { month: '2026-09' })).transactions
      assert.equal(current.length, 3)
      assert.ok(current.some(row => row.transactionId === sibling.transactionId))
      assert.ok(items.every(old => !current.some(row => row.transactionId === old.transactionId)))
    })

    await t.test('关联已清理或交易已删除后故障，完整回滚关联、事件、修订和回执；原键随后成功', async () => {
      const c = await context(), first = await imported(c, 1, 'SYNTHETIC-PERMANENT-FAULT'), selected = first.items[0]
      await historicalCandidate(c, selected.transactionId, 'SYNTHETIC-PERMANENT-FAULT-CANDIDATE')
      const before = await snapshot(c), request = deleteRequest(selected)
      assert.ok(before.catledger_economic_event_transactions.length > 1)
      assert.ok(before.catledger_review_issue_members.some(row => row.object_id === selected.transactionId))
      for (const point of [/DELETE FROM catledger_transactions\s/, /UPDATE catledger_users SET data_revision/]) {
        let failed = false, cleanedLinks = false, cleanedMembers = false
        const faultPool = { async getConnection() {
          const connection = await apiPool.getConnection()
          return new Proxy(connection, { get(target, key) {
            if (key === 'execute') return async (sql, values) => {
              if (/DELETE FROM catledger_economic_event_transactions/.test(sql)) cleanedLinks = true
              if (/DELETE FROM catledger_review_issue_members/.test(sql)) cleanedMembers = true
              if (point.test(sql)) { failed = true; throw new Error('synthetic permanent deletion rollback') }
              return target.execute(sql, values)
            }
            return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
          } })
        } }
        const fault = localServices({ apiPool: faultPool, importPool, subject: c.subject })
        await assert.rejects(call(fault.api, 'transactions.delete', request), { publicCode: 'INTERNAL_ERROR' })
        assert.ok(failed && cleanedLinks && cleanedMembers)
        assert.deepEqual(await snapshot(c), before)
      }
      await c.api('transactions.delete', request)
      assert.equal(await transaction(c, selected.transactionId), null)
      assert.equal((await rows(c, 'catledger_economic_event_transactions', 'link_id')).some(row => row.transaction_id === selected.transactionId), false)
      assert.equal((await rows(c, 'catledger_review_issue_members', 'member_id')).some(row => row.object_type === 'transaction' && row.object_id === selected.transactionId), false)
    })

    await t.test('旧软删除退款仅解除已消失原消费的外键，历史行与删除时间继续保留', async () => {
      const c = await context(), original = await c.manual()
      const refund = await c.api('transactions.create', { requestId: randomUUID(), type: 'refund', amountMinor: '200',
        destinationAccountId: c.accountId, originalTransactionId: original.transactionId,
        occurredLocalAt: '2026-09-06T12:00:00', timezoneOffsetMinutes: -480, note: '合成旧退款历史' })
      // 仅播种本次上线前已存在的软删除状态，验证本次不物理清除这类旧行。
      await lab.owner.execute('UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1 WHERE uid=? AND transaction_id=?', [c.uid, refund.transactionId])
      const before = await transaction(c, refund.transactionId)
      await c.api('transactions.delete', deleteRequest(original))
      assert.equal(await transaction(c, original.transactionId), null)
      const after = await transaction(c, refund.transactionId)
      assert.ok(after); assert.equal(after.original_transaction_id, null); assert.equal(after.deleted_at, before.deleted_at)
      assert.equal(Number(after.version), Number(before.version) + 1)
      for (const field of ['transaction_id', 'type', 'amount_minor', 'source_account_id', 'destination_account_id', 'category_id', 'origin', 'note', 'created_at']) {
        assert.equal(after[field], before[field], field)
      }
      assert.equal(await balance(c), '1000000')
      assert.equal((await c.api('statistics.get', { month: '2026-09' })).summary.expenseMinor, '0')
    })

    await t.test('活动付款、已解除付款和更正后恢复的原交易均保护；贷款自身撤销仍软删历史', async () => {
      const c = await context(), debt = await c.account('credit', '100000', '合成贷款负债'), sibling = await c.manual()
      const loan = await c.api('loans.create', { requestId: randomUUID(), accountId: debt, name: '合成贷款',
        kind: 'borrowing', baselinePrincipalMinor: '100000', baselineDate: '2026-01-01' })
      const makePayment = async (sourceTransaction, mode, interestMinor = '0') => c.api('loans.record', {
        requestId: randomUUID(), mode, kind: 'repayment', assetAccountId: c.accountId,
        totalMinor: sourceTransaction.amountMinor, occurredLocalAt: sourceTransaction.occurredLocalAt,
        timezoneOffsetMinutes: -480, confirmed: true,
        source: (await c.api('loans.source', { transactionIds: [sourceTransaction.transactionId] })).source,
        allocations: [{ loanId: loan.loanId, version: (await c.api('loans.get', { loanId: loan.loanId })).loan.version,
          principalMinor: '1000', interestMinor, feeMinor: '0', interestTreatment: 'expense', feeTreatment: 'expense',
          interestCategoryId: interestMinor === '0' ? null : c.categoryId }]
      })
      const transfer = await c.api('transactions.create', { requestId: randomUUID(), type: 'transfer', sourceAccountId: c.accountId,
        destinationAccountId: debt, amountMinor: '1000', occurredLocalAt: '2026-09-05T12:00:00', timezoneOffsetMinutes: -480 })
      const associated = await makePayment(transfer, 'associate')
      await assertProtected(c, transfer.transactionId, sibling)
      await c.api('loans.reverse', { requestId: randomUUID(), paymentId: associated.paymentId, version: 1, loans: associated.loans, confirmed: true })
      const [[inactive]] = await lab.owner.execute('SELECT active FROM catledger_loan_payment_transactions WHERE uid=? AND transaction_id=?', [c.uid, transfer.transactionId])
      assert.equal(Number(inactive.active), 0); assert.equal((await transaction(c, transfer.transactionId)).deleted_at, null)
      await assertProtected(c, transfer.transactionId, sibling)
      const original = await c.manual({ amountMinor: '1200', occurredLocalAt: '2026-09-06T12:00:00' })
      const corrected = await makePayment(original, 'correctExisting', '200')
      assert.ok((await transaction(c, original.transactionId)).deleted_at)
      const [replacementIds] = await lab.owner.execute('SELECT transaction_id AS id FROM catledger_loan_payment_transactions WHERE uid=? AND payment_id=?', [c.uid, corrected.paymentId])
      await c.api('loans.reverse', { requestId: randomUUID(), paymentId: corrected.paymentId, version: 1, loans: corrected.loans, confirmed: true })
      const restored = await transaction(c, original.transactionId)
      assert.equal(restored.deleted_at, null); assert.equal(Number(restored.version), 3)
      const [[root]] = await lab.owner.execute('SELECT transaction_id FROM catledger_loan_replaced_transactions WHERE uid=? AND transaction_id=?', [c.uid, original.transactionId])
      assert.ok(root)
      await assertProtected(c, original.transactionId, sibling)
      for (const replacement of replacementIds) assert.ok((await transaction(c, replacement.id)).deleted_at, '系统撤销交易仍保留主表历史')
    })

    await t.test('分期遗留引用、实费和历史余额保全都拒绝普通删除，整组无旁路', async () => {
      const c = await context(), debt = await c.account('credit', '600000', '合成分期负债'), sibling = await c.manual()
      const loan = await c.api('loans.create', { ...plan, requestId: randomUUID(), accountId: debt, feeUpfrontMinor: '2000', repayments: [] })
      const fee = await c.manual({ sourceAccountId: debt, amountMinor: '2000', occurredLocalAt: '2026-01-01T12:00:00' })
      await c.api('loans.recordUpfrontFee', { requestId: randomUUID(), loanId: loan.loanId, version: loan.version,
        mode: 'existing', transactionId: fee.transactionId, transactionVersion: fee.version, confirmed: true })
      await assertProtected(c, fee.transactionId, sibling)
      for (const active of [0, 1]) {
        const legacy = await c.manual({ sourceAccountId: debt, amountMinor: '500' })
        // 模拟仍受外键约束的旧分期关系；正式交易使用真实创建入口，不能靠费用表保护掩盖此关系。
        await lab.owner.execute(`INSERT INTO catledger_installment_items
          (uid,item_id,account_id,loan_id,period_number,component,amount_minor,occurred_date,origin,transaction_id,canonical,active)
          VALUES (?,?,?,?,?,'fee',500,'2026-09-05','manual',?,0,?)`, [c.uid, randomUUID(), debt, loan.loanId, 11 + active, legacy.transactionId, active])
        await assertProtected(c, legacy.transactionId, sibling)
      }
      const historical = await c.api('loans.create', { ...plan, requestId: randomUUID(), accountId: debt,
        baselinePrincipalMinor: '550000', repayments: [{ periodNumber: 1, paid: true }] })
      const costs = await c.api('loans.chargePlan', { loanId: historical.loanId })
      const paired = costs.items.find(row => row.balanceAdjustmentId)
      assert.ok(paired && paired.transactionId)
      await assertProtected(c, paired.transactionId, sibling)
      await assertProtected(c, paired.balanceAdjustmentId, sibling)
      assert.ok(await transaction(c, paired.transactionId)); assert.ok(await transaction(c, paired.balanceAdjustmentId))
    })
  } finally { await lab.close() }
})
