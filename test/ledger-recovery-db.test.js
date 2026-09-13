const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const mysql = require('../cloudfunctions/catledger-api/node_modules/mysql2/promise')
const hasDatabase = Boolean(process.env.CATLEDGER_TEST_DB_HOST)
test('真实 MySQL 原请求只读核实、不同用户拒绝、单连接池重放不重复写账', { skip: !hasDatabase }, async () => {
  const lab = await isolatedMysql()
  const one = mysql.createPool({ ...lab.config, connectionLimit: 1, waitForConnections: false })
  try {
    const svc = localServices({ apiPool: one, importPool: lab.owner })
    const user = await call(svc.api, 'bootstrap')
    const account = await call(svc.api, 'accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成恢复账户', currency: 'CNY',
      openingDisplayBalanceMinor: '0', occurredLocalAt: '2026-09-01T09:00:00', timezoneOffsetMinutes: -480 })
    const data = { requestId: randomUUID(), type: 'expense', sourceAccountId: account.accountId, categoryId: user.categories.find(c => c.kind === 'expense').id,
      amountMinor: '100', occurredLocalAt: '2026-09-01T10:00:00', timezoneOffsetMinutes: -480 }
    const saved = await call(svc.api, 'transactions.create', data)
    const verified = await call(svc.api, 'transactions.commandResult', { requestId: data.requestId, commandAction: 'transactions.create' })
    assert.deepEqual(verified.result, saved)
    assert.deepEqual(await call(svc.api, 'transactions.create', data), saved)
    await assert.rejects(call(svc.api, 'transactions.create', { ...data, amountMinor: '200' }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
    const other = localServices({ apiPool: lab.owner, importPool: lab.owner, subject: 'synthetic-recovery-other' })
    await call(other.api, 'bootstrap')
    for (const service of [svc.api, other.api]) await assert.rejects(call(service, 'transactions.commandResult', {
      requestId: data.requestId, commandAction: 'transactions.delete' }), { publicCode: 'OPERATION_UNCONFIRMED' })
    await assert.rejects(call(other.api, 'transactions.commandResult', { requestId: data.requestId, commandAction: 'transactions.create' }), { publicCode: 'OPERATION_UNCONFIRMED' })
    const [[rows]] = await lab.owner.execute("SELECT COUNT(*) AS count, SUM(amount_minor) AS amount FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL", [user.uid])
    assert.equal(Number(rows.count), 1); assert.equal(String(rows.amount), '100')
  } finally { await one.end(); await lab.close() }
})
test('分期候选 UUID 不足以排除已存在事件，拒绝后原记录和幂等回执保持不变', { skip: !hasDatabase }, async () => {
  const lab = await isolatedMysql()
  try {
    const svc = localServices({ apiPool: lab.owner, importPool: lab.owner })
    const user = await call(svc.api, 'bootstrap')
    const update = await prepareSyntheticUpdate(svc, 3)
    const [[issue]] = await lab.owner.execute("SELECT issue_id AS issueId, version FROM catledger_review_issues WHERE uid=? AND update_id=? AND status='open' LIMIT 1", [user.uid, update.updateId])
    await lab.owner.execute("UPDATE catledger_review_issues SET issue_type='installment_origin' WHERE uid=? AND issue_id=?", [user.uid, issue.issueId])
    const [before] = await lab.owner.execute('SELECT event_id,status,version FROM catledger_economic_events WHERE uid=? AND update_id=? ORDER BY event_id', [user.uid, update.updateId])
    await assert.rejects(call(svc.import, 'reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId,
      updateVersion: update.appliedVersion, issueId: issue.issueId, issueVersion: Number(issue.version),
      decision: 'confirm_installment_principal', installmentCandidateId: randomUUID() }), { publicCode: 'INSTALLMENT_CONFIRMATION_UNAVAILABLE' })
    const [after] = await lab.owner.execute('SELECT event_id,status,version FROM catledger_economic_events WHERE uid=? AND update_id=? ORDER BY event_id', [user.uid, update.updateId])
    assert.deepEqual(after, before)
    const [[count]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_mutation_receipts WHERE uid=? AND action='reviewIssues.resolve'", [user.uid])
    assert.equal(Number(count.count), 0)
  } finally { await lab.close() }
})
