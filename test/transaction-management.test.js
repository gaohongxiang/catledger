const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate, confirmSyntheticHistoryDistinct } = require('./helpers/local-services')

test('批量删除、导入记录与整批撤销使用隔离 MySQL 和最小权限', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-batch-management' })
    const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
    const user = await api('bootstrap'), expenseCategory = user.categories.find(row => row.kind === 'expense').id, incomeCategory = user.categories.find(row => row.kind === 'income').id
    const account = async (type = 'bank', amount = '100000') => (await api('accounts.create', { requestId: randomUUID(), type, name: '合成删除账户' + randomUUID().slice(0, 6),
      openingDisplayBalanceMinor: amount, occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const bank = await account()
    const manual = (overrides = {}) => api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: bank,
      categoryId: expenseCategory, amountMinor: '100', occurredLocalAt: '2026-09-05T12:00:00', timezoneOffsetMinutes: -480, ...overrides })
    const request = rows => ({ requestId: randomUUID(), items: rows.map(row => ({ transactionId: row.transactionId, version: row.version })) })
    const live = async rows => {
      const [[result]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=? AND deleted_at IS NULL AND transaction_id IN (${rows.map(() => '?').join(',')})`, [user.uid, ...rows.map(row => row.transactionId)])
      return Number(result.count)
    }
    const balance = async id => (await api('accounts.list')).accounts.find(row => row.accountId === id).bookBalanceMinor

    await t.test('同额独立账目一组删除、并发重放和回执查询只记一次，停用账户可删', async () => {
      const archived = await account(), rows = [await manual({ sourceAccountId: archived }), await manual({ sourceAccountId: archived })]
      await api('accounts.archive', { requestId: randomUUID(), accountId: archived, version: 1 })
      const data = request(rows), results = await Promise.all([api('transactions.deleteMany', data), api('transactions.deleteMany', data)])
      assert.deepEqual(results[0], results[1]); assert.equal(results[0].deletedCount, 2); assert.equal(await live(rows), 0)
      assert.equal(await balance(archived), '100000')
      assert.deepEqual((await api('transactions.commandResult', { requestId: data.requestId, commandAction: 'transactions.deleteMany' })).result, results[0])
      const [[receipt]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_mutation_receipts WHERE uid=? AND action='transactions.deleteMany'", [user.uid])
      assert.equal(Number(receipt.count), 1)
      await assert.rejects(api('transactions.deleteMany', { ...data, items: data.items.slice(0, 1) }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
    })
    await t.test('消费与退款整组可删，遗漏退款则全部回滚', async () => {
      const expense = await manual(), other = await manual()
      const refund = await manual({ type: 'refund', sourceAccountId: undefined, categoryId: undefined, destinationAccountId: bank, originalTransactionId: expense.transactionId, amountMinor: '50' })
      await assert.rejects(api('transactions.deleteMany', request([expense, other])), { publicCode: 'REFUNDED_TRANSACTION_LOCKED' })
      assert.equal(await live([expense, other, refund]), 3)
      await api('transactions.deleteMany', request([expense, other, refund])); assert.equal(await live([expense, other, refund]), 0)
    })
    await t.test('现金按整组最终余额验证；删除收入会造成透支时零笔删除', async () => {
      const cash = await account('cash', '0')
      const income = await manual({ type: 'income', sourceAccountId: undefined, destinationAccountId: cash, categoryId: incomeCategory })
      const expense = await manual({ sourceAccountId: cash })
      await assert.rejects(api('transactions.deleteMany', request([income])), { publicCode: 'INSUFFICIENT_CASH_BALANCE' })
      assert.equal(await live([income, expense]), 2)
      await api('transactions.deleteMany', request([income, expense])); assert.equal(await balance(cash), '0')
    })
    await t.test('过期版本、不存在、重复ID（含超过100笔）和空列表都不部分删除', async () => {
      const rows = [await manual(), await manual()]
      const stale = request(rows); stale.items[1].version++
      await assert.rejects(api('transactions.deleteMany', stale), { publicCode: 'CONFLICT' })
      for (const items of [[], [stale.items[0], stale.items[0]], Array.from({ length: 101 }, () => stale.items[0])]) {
        await assert.rejects(api('transactions.deleteMany', { requestId: randomUUID(), items }), { publicCode: 'VALIDATION_ERROR' })
      }
      await assert.rejects(api('transactions.deleteMany', request([...rows, { transactionId: randomUUID(), version: 1 }])), { publicCode: 'NOT_FOUND' })
      await lab.owner.execute("UPDATE catledger_transactions SET origin='import' WHERE uid=? AND transaction_id=?", [user.uid, rows[1].transactionId])
      const other = localServices({ apiPool, importPool, subject: 'synthetic-delete-other' }); await call(other.api, 'bootstrap')
      await assert.rejects(call(other.api, 'transactions.deleteMany', request(rows)), { publicCode: 'NOT_FOUND' })
      assert.equal(await live(rows), 2)
    })
    await t.test('贷款关联账目混选保护整组', async () => {
      const debt = await account('other_liability', '1000')
      const loan = await api('loans.create', { requestId: randomUUID(), name: '合成贷款', kind: 'borrowing', accountId: debt, baselinePrincipalMinor: '1000', baselineDate: '2026-09-01' })
      const transfer = await manual({ type: 'transfer', categoryId: undefined, destinationAccountId: debt })
      const source = (await api('loans.source', { transactionIds: [transfer.transactionId] })).source
      await api('loans.record', { requestId: randomUUID(), mode: 'associate', source, kind: 'repayment', assetAccountId: bank,
        totalMinor: '100', occurredLocalAt: '2026-09-05T12:00:00', timezoneOffsetMinutes: -480, confirmed: true,
        allocations: [{ loanId: loan.loanId, version: 1, principalMinor: '100', interestMinor: '0', feeMinor: '0', interestTreatment: 'expense', feeTreatment: 'expense' }] })
      const expense = await manual()
      await assert.rejects(api('transactions.deleteMany', request([expense, transfer])), { publicCode: 'LOAN_TRANSACTION_LOCKED' })
      assert.equal(await live([expense, transfer]), 2)
    })
    async function posted(prefix) {
      let update = await prepareSyntheticUpdate(services, 2, prefix)
      const issues = await imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })
      const decisions = issues.items.filter(row => row.status === 'open').map(row => ({ issueId: row.issueId, issueVersion: row.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: bank } }))
      if (decisions.length) update = await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion, decisions })
      // 不同前缀代表独立合成消费，不能绕过新加入的历史疑似重复确认。
      update = await confirmSyntheticHistoryDistinct(services, update)
      return imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
    }
    await t.test('无撤销审计的旧导入与手动混选删除，跨月分页隔离、余额及同文件重导正确', async () => {
      const original = await posted('SYNTHETIC-UNIFIED')
      await lab.owner.execute('UPDATE catledger_finance_updates SET side_effects_json=NULL WHERE uid=? AND update_id=?', [user.uid, original.updateId])
      const first = await api('transactions.list', { importUpdateId: original.updateId, pageSize: 1 })
      assert.equal(first.transactions.length, 1); assert.equal(first.summary.expenseMinor, '200')
      const next = await api('transactions.list', { importUpdateId: original.updateId, pageSize: 1, cursor: first.nextCursor })
      assert.equal(next.transactions.length, 1); assert.notEqual(first.transactions[0].transactionId, next.transactions[0].transactionId)
      await lab.owner.execute("UPDATE catledger_transactions SET occurred_local_date='2026-08-01', occurred_local_at='2026-08-01 12:00:00' WHERE uid=? AND transaction_id=?", [user.uid, next.transactions[0].transactionId])
      assert.equal((await api('transactions.list', { importUpdateId: original.updateId })).transactions.length, 2)
      const before = BigInt(await balance(bank)), own = await manual()
      await api('transactions.deleteMany', request([own, first.transactions[0]]))
      assert.equal(BigInt(await balance(bank)), before + 100n)
      assert.equal((await imp('financeUpdates.list')).items.find(row => row.updateId === original.updateId).transactionCount, 1)
      const replay = await posted('SYNTHETIC-UNIFIED')
      assert.notEqual(replay.updateId, original.updateId)
      assert.equal((await imp('financeUpdates.summary', { updateId: replay.updateId })).posting.createdTransactionCount, 1)
      const restored = await api('transactions.list', { importUpdateId: replay.updateId })
      assert.equal(restored.transactions.length, 2)
      await api('transactions.deleteMany', request(restored.transactions))
      assert.equal((await imp('financeUpdates.list')).items.find(row => row.updateId === replay.updateId).transactionCount, 0)
      const again = await posted('SYNTHETIC-UNIFIED')
      assert.equal((await imp('financeUpdates.summary', { updateId: again.updateId })).posting.createdTransactionCount, 2)
      await assert.rejects(api('transactions.list', { importUpdateId: again.updateId, cursor: first.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
      const other = localServices({ apiPool, importPool, subject: 'synthetic-unified-other' }); await call(other.api, 'bootstrap')
      await assert.rejects(call(other.api, 'transactions.list', { importUpdateId: again.updateId }), { publicCode: 'NOT_FOUND' })
    })
    await t.test('导入可查文件和时间，改分类后可撤销，旧预览不得覆盖后来修改；重导仍正常入账', async () => {
      const post = await posted('SYNTHETIC-REIMPORT')
      const history = await imp('financeUpdates.list')
      assert.ok(history.items.length >= 1); assert.equal(history.items[0].files[0], '合成原生验证.csv'); assert.equal(history.items[0].status, 'posted')
      const [rows] = await lab.owner.execute('SELECT t.transaction_id AS transactionId,t.version FROM catledger_transactions t JOIN catledger_economic_event_transactions l ON l.uid=t.uid AND l.transaction_id=t.transaction_id WHERE l.uid=? AND l.update_id=? AND l.superseded_at IS NULL', [user.uid, post.updateId])
      const impact = await imp('financeUpdates.undoImpact', { updateId: post.updateId })
      await api('transactions.setCategory', { requestId: randomUUID(), transactionId: rows[0].transactionId, version: Number(rows[0].version), categoryId: expenseCategory })
      const undo = { requestId: randomUUID(), updateId: post.updateId, version: post.appliedVersion, previewToken: impact.previewToken }
      await assert.rejects(imp('financeUpdates.undo', undo), { publicCode: 'CONFLICT' }); assert.equal(await live(rows), 2)
      const fresh = await imp('financeUpdates.undoImpact', { updateId: post.updateId }); assert.equal(fresh.canUndo, true)
      undo.previewToken = fresh.previewToken
      const results = await Promise.all([imp('financeUpdates.undo', undo), imp('financeUpdates.undo', undo)])
      assert.deepEqual(results[0], results[1]); assert.equal(await live(rows), 0)
      assert.equal((await imp('financeUpdates.list')).items[0].status, 'undone')
      const reimport = await posted('SYNTHETIC-REIMPORT'); assert.notEqual(reimport.updateId, post.updateId); assert.equal(reimport.status, 'posted')
      const summary = await imp('financeUpdates.summary', { updateId: reimport.updateId }); assert.equal(summary.posting.createdTransactionCount, 2)
      const page1 = await imp('financeUpdates.list', { pageSize: 1 }), page2 = await imp('financeUpdates.list', { pageSize: 1, cursor: page1.nextCursor })
      assert.equal(page1.items[0].updateId, reimport.updateId); assert.equal(page2.items[0].updateId, post.updateId); assert.ok(page2.nextCursor)
      const other = localServices({ apiPool, importPool, subject: 'synthetic-history-other' }); await call(other.api, 'bootstrap')
      assert.deepEqual((await call(other.import, 'financeUpdates.list')).items, [])
      await assert.rejects(call(other.import, 'financeUpdates.list', { cursor: page1.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(imp('financeUpdates.list', { cursor: page1.nextCursor + 'x' }), { publicCode: 'INVALID_CURSOR' })
    })
  } finally { await lab.close() }
})
