const { createUpdate } = require('../src/finance-update-repository')
const { executeIdempotentMutation } = require('../src/import-transaction')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const test = require('node:test')

const mysql = require('mysql2/promise')

const { PLAN_VERSION } = require('../src/domain-versions')
const { digestParts } = require('../src/digest')
const { hashWechatSubject } = require('../src/handler')
const { buildPaymentMethodKey } = require('../src/identity')
const { createImportService } = require('../src/import-service')
const { createAccountService } = require('../../catledger-api/src/account-service')
const { createTransactionService } = require('../../catledger-api/src/transaction-service')
const { createReportingService } = require('../../catledger-api/src/reporting-service')
const { createCategoryService } = require('../../catledger-api/src/category-service')

const DATABASE_ENV_KEYS = [
  'CATLEDGER_TEST_DB_HOST',
  'CATLEDGER_TEST_DB_USER',
  'CATLEDGER_TEST_DB_PASSWORD',
  'CATLEDGER_TEST_DB_NAME'
]
const hasDatabase = DATABASE_ENV_KEYS.every((key) => process.env[key])

function databaseConfig() {
  return {
    host: process.env.CATLEDGER_TEST_DB_HOST,
    port: Number(process.env.CATLEDGER_TEST_DB_PORT || 3306),
    user: process.env.CATLEDGER_TEST_DB_USER,
    password: process.env.CATLEDGER_TEST_DB_PASSWORD,
    database: process.env.CATLEDGER_TEST_DB_NAME,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectionLimit: 8
  }
}

function fixture() {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'wechat-pay.csv'))
}

test('桥接强身份贯通人工合并、旧计划保留决定升级、回滚与最终 posting 屏障', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig()), objects = new Map()
  const storage = { async downloadExact(fileID, key) { return objects.get(key) }, async remove() { return true } }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'bridge-invariant'), other = await createUserLedger(pool, 'bridge-other')
    const contents = [Buffer.from([
      '微信支付账单明细,,,,,,,,,,,',
      '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
      '2026-09-01 10:00:00,商户消费,合成商户,合成购买甲,支出,10.00,微信零钱,支付成功,WX-BRIDGE-A,,ORDER-BRIDGE-001,',
      '2026-09-01 10:00:00,商户消费,合成商户,合成购买乙,支出,10.00,微信零钱,支付成功,WX-BRIDGE-B,,ORDER-BRIDGE-001,'
    ].join('\n')), Buffer.from([
      '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
      '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
      '2026-09-01 10:00:00,日用百货,合成商户,另一来源记录,10.00,支出,账户余额,交易成功,,ALI-BRIDGE-C,,ORDER-BRIDGE-001'
    ].join('\n'))]
    const prepared = await service.prepareMany(context(user, { requestId: randomUUID(),
      files: contents.map((buffer, index) => ({ fileName: `合成桥接${index}.csv`, size: buffer.length })) }))
    const batchIds = []
    for (const [index, file] of prepared.files.entries()) {
      objects.set(file.cloudPath, contents[index])
      const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480 }))
      batchIds.push(parsed.batch.batchId)
    }
    let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds }))
    const updateId = view.update.updateId
    assert.equal(view.events.length, 3)
    const issue = view.issues.find(issue => issue.primaryReasonCode === 'source_group_conflict')
    assert.ok(issue)
    await assert.rejects(service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId,
      updateVersion: view.update.version, issueId: issue.issueId, issueVersion: issue.version,
      decision: 'confirm_same', primaryEventId: view.events[0].eventId })), { publicCode: 'IDENTITY_CONFLICT' })

    // 隔离库构造 v28 遗留图；保留原主记录人工金额/分类与动作标记。
    const primary = view.events.find(event => event.primaryEvidence.sourceType === 'wechat')
    const others = view.events.filter(event => event.eventId !== primary.eventId)
    await pool.execute('DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ?', [user.uid, updateId])
    await pool.execute('DELETE FROM catledger_review_issues WHERE uid = ? AND update_id = ?', [user.uid, updateId])
    await pool.execute('DELETE FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ?', [user.uid, updateId])
    for (const event of others) {
      await pool.execute(`UPDATE catledger_event_evidence SET event_id = ?, evidence_role = 'supporting'
        WHERE uid = ? AND update_id = ? AND event_id = ?`, [primary.eventId, user.uid, updateId, event.eventId])
      await pool.execute('DELETE FROM catledger_economic_events WHERE uid = ? AND event_id = ?', [user.uid, event.eventId])
    }
    await pool.execute(`UPDATE catledger_economic_events SET state = 'ready', status = 'ready', version = 7,
      amount_minor = 1500, ledger_account_id = ?, category_id = ?, manual_field_mask = 161,
      reason_codes_json = '[]', field_sources_json = JSON_SET(field_sources_json, '$.lastUserActionId', 'synthetic-choice')
      WHERE uid = ? AND event_id = ?`, [user.accountId, user.categoryId, user.uid, primary.eventId])
    await pool.execute(`UPDATE catledger_finance_updates SET plan_version = ?, final_event_count = 1,
      ready_event_count = 1, needs_action_event_count = 0, duplicate_evidence_count = 2
      WHERE uid = ? AND update_id = ?`, [PLAN_VERSION, user.uid, updateId])
    await assert.rejects(service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId,
      version: view.update.version })), { publicCode: 'IDENTITY_CONFLICT' })
    await pool.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v28' WHERE uid = ? AND update_id = ?", [user.uid, updateId])
    await assert.rejects(service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId,
      version: view.update.version })), { publicCode: 'CONFLICT' })
    const request = { requestId: randomUUID(), updateId, version: view.update.version }
    const faulty = createImportService({ storage, getPool: () => ({ async getConnection() {
      const connection = await pool.getConnection(), execute = connection.execute.bind(connection)
      connection.execute = async (sql, values) => {
        if (/UPDATE catledger_event_evidence SET event_id/.test(sql)) throw new Error('synthetic split rollback')
        return execute(sql, values)
      }
      const release = connection.release.bind(connection)
      connection.release = () => { connection.execute = execute; connection.release = release; release() }
      return connection
    } }) })
    await assert.rejects(faulty.financeUpdateOrganize(context(user, request)), /synthetic split rollback/)
    assert.equal((await service.financeUpdateGet(context(user, { updateId }))).events.length, 1)
    await assert.rejects(service.financeUpdateOrganize(context(other, request)), { publicCode: 'NOT_FOUND' })
    view = await service.financeUpdateOrganize(context(user, request))
    assert.deepEqual(await service.financeUpdateOrganize(context(user, request)), view)
    assert.equal(view.events.length, 3)
    assert.equal(view.update.planVersion, PLAN_VERSION)
    assert.equal(view.update.counts.duplicateEvidence, 0)
    const kept = view.events.find(event => event.eventId === primary.eventId)
    assert.equal(kept.amountMinor, '1500')
    assert.equal(kept.categoryId, user.categoryId)
    assert.equal(kept.primaryEvidence.rowId, primary.primaryEvidence.rowId)
    assert.ok(view.events.filter(event => event.eventId !== kept.eventId).every(event => event.amountMinor === '1000'))
    const [[stored]] = await pool.execute('SELECT field_sources_json AS sources, manual_field_mask AS mask FROM catledger_economic_events WHERE uid = ? AND event_id = ?', [user.uid, kept.eventId])
    assert.equal(Number(stored.mask), 161)
    assert.equal((typeof stored.sources === 'string' ? JSON.parse(stored.sources) : stored.sources).lastUserActionId, 'synthetic-choice')
    const conflict = view.issues.find(issue => issue.status === 'open' && issue.primaryReasonCode === 'source_group_conflict')
    assert.equal(conflict.memberCount, 3)
    await service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId,
      updateVersion: view.update.version, issueId: conflict.issueId, issueVersion: conflict.version, decision: 'confirm_distinct' }))
    view = await service.financeUpdateGet(context(user, { updateId }))
    const accounts = view.issues.filter(issue => issue.status === 'open' && issue.issueType === 'account_mapping')
    if (accounts.length) view = await service.reviewIssueResolveAccountMappings(context(user, { requestId: randomUUID(), updateId,
      decisions: accounts.map(issue => ({ issueId: issue.issueId, operation: 'resolve', decision: 'apply_fields', fields: { ledgerAccountId: user.accountId } })) }))
    const posted = await service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId, version: view.update.version }))
    assert.equal(posted.posting.createdTransactionCount, 3)
  } finally { await pool.end() }
})

test('语义升级保留旧批次决定和共享问题成员，支持隔离、事务回滚、并发重试及最终入账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig()), objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) }, async remove() { return true }
  } })
  const json = value => typeof value === 'string' ? JSON.parse(value) : value
  try {
    const user = await createUserLedger(pool, 'semantic-upgrade'), other = await createUserLedger(pool, 'semantic-upgrade-other')
    const content = Buffer.from([
      '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
      '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
      ...['6.00', '8.00', '10.00', '12.00'].map((amount, index) =>
        `2026-09-06 10:0${index}:00,信用借还,合成免押服务,设备使用费,${amount},支出,账户余额,交易成功,,SYNTHETIC-UPGRADE-${index},,`)
    ].join('\n'))
    const prepared = await service.prepareMany(context(user, { requestId: randomUUID(), files: [{ fileName: '免押合成.csv', size: content.length }] }))
    const file = prepared.files[0]; objects.set(file.cloudPath, content)
    const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
      fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }))
    let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
    const updateId = view.update.updateId
    const accountIssue = view.issues.find(issue => issue.status === 'open' && issue.issueType === 'account_mapping')
    await service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId, issueId: accountIssue.issueId,
      updateVersion: view.update.version, issueVersion: accountIssue.version, decision: 'apply_fields',
      fields: { ledgerAccountDraft: { name: '合成免押付款账户', type: 'wallet', currency: 'CNY' } } }))
    view = await resolveOpenCategoryIssues(service, user, await service.financeUpdateGet(context(user, { updateId })))
    const [initial] = await pool.execute(`SELECT event_id AS eventId, field_sources_json AS sources FROM catledger_economic_events
      WHERE uid = ? AND update_id = ? ORDER BY amount_minor`, [user.uid, updateId])
    assert.equal(initial.length, 4)
    const affectedIds = initial.slice(0, 2).map(event => event.eventId)
    for (const event of initial.slice(0, 2)) {
      const sources = json(event.sources)
      sources.semanticBlockers = ['row_transaction_type_unknown']
      await pool.execute(`UPDATE catledger_economic_events SET economic_nature = 'unknown', state = 'needs_action', status = 'needs_action',
        field_sources_json = ?, reason_codes_json = ? WHERE uid = ? AND event_id = ?`,
      [JSON.stringify(sources), JSON.stringify(['row_transaction_type_unknown', 'economic_nature_required']), user.uid, event.eventId])
    }
    await pool.execute(`UPDATE catledger_economic_events SET state = 'excluded', status = 'excluded', reason_codes_json = '["user_excluded"]'
      WHERE uid = ? AND event_id = ?`, [user.uid, initial[2].eventId])
    await pool.execute(`UPDATE catledger_economic_events SET state = 'needs_action', status = 'needs_action', reason_codes_json = '["core_fields_conflict"]'
      WHERE uid = ? AND event_id = ?`, [user.uid, initial[3].eventId])
    await pool.execute(`UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v26' WHERE uid = ? AND update_id = ?`, [user.uid, updateId])
    const issueId = randomUUID()
    await pool.execute(`INSERT INTO catledger_review_issues
      (uid, issue_id, update_id, issue_key, issue_key_version, issue_type, status, version, blocking, primary_reason_code,
       member_count, candidate_count, rule_version, reason_codes_json)
      VALUES (?, ?, ?, ?, 'synthetic-v1', 'shared_fields', 'open', 1, 1, 'economic_nature_required', 3, 0, 'synthetic-v1', '["economic_nature_required"]')`,
    [user.uid, issueId, updateId, digestParts('synthetic-upgrade-shared', updateId)])
    for (const [index, eventId] of [...affectedIds, initial[3].eventId].entries()) {
      const [[event]] = await pool.execute('SELECT version FROM catledger_economic_events WHERE uid = ? AND event_id = ?', [user.uid, eventId])
      await pool.execute(`INSERT INTO catledger_review_issue_members
        (uid, member_id, update_id, issue_id, object_type, object_id, object_version, member_role, sort_order)
        VALUES (?, ?, ?, ?, 'event', ?, ?, 'subject', ?)`, [user.uid, randomUUID(), updateId, issueId, eventId, event.version, index])
    }
    const snapshot = async () => {
      const result = {}
      for (const table of ['catledger_economic_events', 'catledger_event_evidence', 'catledger_review_issues',
        'catledger_review_issue_members', 'catledger_finance_update_account_drafts', 'catledger_finance_update_account_mapping_drafts', 'catledger_finance_actions']) {
        const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE uid = ? AND update_id = ?`, [user.uid, updateId])
        result[table] = rows
      }
      return result
    }
    const before = await snapshot()
    view = await service.financeUpdateGet(context(user, { updateId }))
    assert.equal(view.update.requiresReorganization, true)
    const data = { requestId: randomUUID(), updateId, version: view.update.version }
    await assert.rejects(service.financeUpdateOrganize(context(other, data)), error => error.publicCode === 'NOT_FOUND')
    const trigger = 'semantic_' + randomUUID().replaceAll('-', '')
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON catledger_finance_updates FOR EACH ROW
      BEGIN IF NEW.uid = '${user.uid}' AND NEW.plan_version = '${PLAN_VERSION}' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic rollback'; END IF; END`)
    try {
      await assert.rejects(service.financeUpdateOrganize(context(user, data)))
      assert.deepEqual(await snapshot(), before)
    } finally { await pool.query(`DROP TRIGGER IF EXISTS ${trigger}`) }
    const [upgraded, replay] = await Promise.all([
      service.financeUpdateOrganize(context(user, data)), service.financeUpdateOrganize(context(user, data))
    ])
    assert.deepEqual(replay, upgraded)
    assert.equal(upgraded.update.requiresReorganization, false)
    const after = await snapshot()
    assert.equal(after.catledger_economic_events.length, before.catledger_economic_events.length)
    for (const previous of before.catledger_economic_events) {
      const next = after.catledger_economic_events.find(event => event.event_id === previous.event_id)
      for (const key of ['event_id', 'ledger_account_id', 'counterparty_ledger_account_id', 'category_id', 'manual_field_mask', 'amount_minor', 'event_local_at']) assert.deepEqual(next[key], previous[key])
      if (affectedIds.includes(next.event_id)) {
        assert.equal(next.economic_nature, 'expense'); assert.equal(next.status, 'ready')
        assert.equal(json(next.field_sources_json).lastUserActionId, json(previous.field_sources_json).lastUserActionId)
        assert.ok(json(next.field_sources_json).lastSemanticActionId)
      }
      else assert.deepEqual(next, previous)
    }
    for (const table of ['catledger_event_evidence', 'catledger_finance_update_account_drafts', 'catledger_finance_update_account_mapping_drafts']) assert.deepEqual(after[table], before[table])
    const priorIssue = after.catledger_review_issues.find(issue => issue.issue_id === issueId)
    assert.equal(priorIssue.status, 'superseded')
    const remaining = upgraded.issues.find(issue => issue.status === 'open' && issue.issueType === 'field_conflict')
    assert.ok(remaining)
    assert.ok(after.catledger_review_issue_members.some(member => member.issue_id === remaining.issueId && member.object_id === initial[3].eventId))
    const noOp = await service.financeUpdateOrganize(context(user, { requestId: randomUUID(), updateId, version: upgraded.update.version }))
    assert.equal(noOp.update.version, upgraded.update.version)
    assert.equal(after.catledger_finance_actions.filter(action => action.action_type === 'semantic_upgrade').length, 1)
    await service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId, issueId: remaining.issueId,
      updateVersion: upgraded.update.version, issueVersion: remaining.version, decision: 'exclude_events' }))
    const ready = await service.financeUpdateGet(context(user, { updateId }))
    assert.equal(ready.coverage.selectedEventsReadyToPost, true)
    const posted = await service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId, version: ready.update.version, mode: 'all_ready' }))
    assert.equal(posted.update.status, 'posted')
    const [[totals]] = await pool.execute('SELECT COUNT(*) AS count, SUM(amount_minor) AS amount FROM catledger_transactions WHERE uid = ?', [user.uid])
    assert.equal(Number(totals.count), 2)
    assert.equal(String(totals.amount), '1400')
  } finally { await pool.end() }
})

test('可跳过分类：旧批次、整批回滚、幂等入账与后补分类统计一致', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) }, async remove() { return true }
  } })
  const reporting = createReportingService({ getPool: () => pool })
  const categories = createCategoryService({ getPool: () => pool })
  try {
    const user = await createUserLedger(pool, 'optional-category')
    const other = await createUserLedger(pool, 'optional-category-other')
    const prepared = await service.prepareMany(context(user, { requestId: randomUUID(),
      files: [{ fileName: '可选分类合成.csv', size: fixture().length }] }))
    const file = prepared.files[0]
    objects.set(file.cloudPath, fixture())
    const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
      fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }))
    let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
    const updateId = view.update.updateId
    const accountIssue = view.issues.find(issue => issue.status === 'open' && issue.issueType === 'account_mapping')
    await assert.rejects(service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId, version: view.update.version, mode: 'all_ready'
    })), error => error.publicCode === 'UNRESOLVED_IMPORT')
    await service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId,
      issueId: accountIssue.issueId, issueVersion: accountIssue.version, updateVersion: view.update.version,
      decision: 'apply_fields', fields: { ledgerAccountId: user.accountId } }))
    view = await service.financeUpdateGet(context(user, { updateId }))
    assert.equal(view.coverage.selectedEventsReadyToPost, true)
    assert.ok(view.events.every(event => event.status === 'ready' && event.categoryId === null))
    const suggestions = view.issues.filter(issue => issue.status === 'open' && issue.issueType === 'category_assignment')
    assert.ok(suggestions.length > 0)
    assert.ok(suggestions.every(issue => issue.blocking === false))

    // 模拟已存在批次的旧持久化状态；读取和入账都必须兼容，且不重新整理。
    await pool.execute("UPDATE catledger_economic_events SET status = 'needs_action', state = 'needs_action' WHERE uid = ? AND update_id = ?", [user.uid, updateId])
    await pool.execute("UPDATE catledger_review_issues SET blocking = 1 WHERE uid = ? AND update_id = ? AND issue_type = 'category_assignment' AND status = 'open'", [user.uid, updateId])
    view = await service.financeUpdateGet(context(user, { updateId }))
    assert.equal(view.coverage.selectedEventsReadyToPost, true)
    assert.ok(view.events.every(event => event.status === 'ready'))
    const data = { requestId: randomUUID(), updateId, version: view.update.version, mode: 'all_ready' }
    await assert.rejects(service.financeUpdatePost(context(other, data)), error => error.publicCode === 'NOT_FOUND')

    const trigger = 'optional_' + randomUUID().replaceAll('-', '')
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON catledger_finance_updates FOR EACH ROW
      BEGIN IF NEW.uid = '${user.uid}' AND NEW.status = 'posted' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic rollback'; END IF; END`)
    try {
      await assert.rejects(service.financeUpdatePost(context(user, data)))
      const [[transactions]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
      assert.equal(Number(transactions.count), 0)
      const [[open]] = await pool.execute("SELECT COUNT(*) AS count FROM catledger_review_issues WHERE uid = ? AND update_id = ? AND issue_type = 'category_assignment' AND status = 'open'", [user.uid, updateId])
      assert.equal(Number(open.count), suggestions.length)
    } finally { await pool.query(`DROP TRIGGER IF EXISTS ${trigger}`) }

    const posted = await service.financeUpdatePost(context(user, data))
    const replayed = await service.financeUpdatePost(context(user, data))
    assert.equal(posted.update.status, 'posted')
    assert.equal(replayed.update.version, posted.update.version)
    assert.ok(posted.issues.filter(issue => issue.issueType === 'category_assignment').every(issue => issue.status === 'superseded'))
    const [transactions] = await pool.execute('SELECT transaction_id AS transactionId, version, category_id AS categoryId FROM catledger_transactions WHERE uid = ?', [user.uid])
    assert.equal(transactions.length, 2)
    assert.ok(transactions.every(transaction => transaction.categoryId === null))
    const before = await reporting.statistics(context(user, { month: '2026-08' }))
    assert.equal(before.uncategorized.transactionCount, 2)
    assert.equal(before.summary.expenseMinor, '2468')
    await categories.assignTransactions(context(user, { requestId: randomUUID(), categoryId: user.categoryId,
      items: transactions.map(transaction => ({ transactionId: transaction.transactionId, version: Number(transaction.version) })) }))
    const after = await reporting.statistics(context(user, { month: '2026-08' }))
    assert.equal(after.uncategorized.transactionCount, 0)
    assert.equal(after.summary.expenseMinor, before.summary.expenseMinor)
  } finally { await pool.end() }
})

function fixtureWithSequence(sequence) {
  const value = String(sequence).padStart(3, '0')
  const next = String(Number(sequence) + 1).padStart(3, '0')
  return Buffer.from(fixture().toString('utf8')
    .replaceAll('001', value)
    .replaceAll('002', next))
}

function wechatWithdrawalFixture() {
  return Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '微信昵称: 合成用户,,,,,,,,,,,',
    '起始时间: 2026-07-01 00:00:00 终止时间: 2026-07-31 23:59:59,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    '2026-07-08 16:26:00,零钱提现,浙江农商联合银行(5564),/,/,10.01,浙江农商联合银行储蓄卡(5564),提现已到账,WX-WITHDRAWAL-001,,,服务费¥0.01'
  ].join('\n'))
}

function alipayBalanceTransferFixture() {
  return Buffer.from([
    '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
    '支付宝账户: synth@example.invalid,,,,,,,,,,,',
    '起始日期: [2026-07-01 00:00:00] 终止日期: [2026-07-31 23:59:59],,,,,,,,,,,',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    '2026-07-06 13:49:00,余额宝-转出到余额,支付宝,余额宝-转出到余额,494.00,不计收支,账户余额,交易成功,,ALI-BALANCE-TRANSFER-001,, '
  ].join('\n'))
}

function alipayAggregateRepaymentFixture() {
  return Buffer.from([
    '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
    '支付宝账户: synth@example.invalid,,,,,,,,,,,',
    '起始日期: [2026-07-01 00:00:00] 终止日期: [2026-07-31 23:59:59],,,,,,,,,,,',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    '2026-07-01 10:00:00,日用百货,合成商户甲,合成消费甲,1.00,支出,花呗,交易成功,,ALI-HUABEI-001,,',
    '2026-07-02 10:00:00,日用百货,合成商户乙,合成消费乙,2.00,支出,江苏银行信用购,交易成功,,ALI-CREDIT-001,,',
    '2026-07-20 09:00:00,信用借还,花呗|信用购,自动还款-花呗|信用购2026年07月账单,100.00,不计收支,浙江农商联合银行储蓄卡(5564),还款成功,,ALI-REPAYMENT-001,,'
  ].join('\n'))
}

function wechatRefundCandidatesFixture() {
  return Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '微信昵称: 合成用户,,,,,,,,,,,',
    '起始时间: 2026-07-01 00:00:00 终止时间: 2026-07-31 23:59:59,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    '2026-07-01 10:00:00,商户消费,合成商户甲,合成消费甲,支出,10.00,微信零钱,支付成功,WX-REFUND-ORIGINAL-001,,,',
    '2026-07-02 10:00:00,商户消费,合成商户甲,合成消费乙,支出,9.00,微信零钱,支付成功,WX-REFUND-ORIGINAL-002,,,',
    '2026-07-02 11:00:00,商户消费,无关商户,无关消费,支出,8.00,微信零钱,支付成功,WX-REFUND-UNRELATED-001,,,',
    '2026-07-03 10:00:00,商户退款,合成商户甲,退款入账,收入,3.00,微信零钱,退款成功,WX-REFUND-INCOME-001,,,'
  ].join('\n'))
}

function wechatUnlinkedRefundFixture() {
  return Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '微信昵称: 合成用户,,,,,,,,,,,',
    '起始时间: 2026-07-01 00:00:00 终止时间: 2026-07-31 23:59:59,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    '2026-07-04 15:02:00,商户退款,义乌市千单日用品有限公司,退款-手持小型缝纫机,收入,4.66,微信零钱,退款成功,WX-UNLINKED-REFUND-001,,,'
  ].join('\n'))
}

async function createUserLedger(pool, label) {
  const uid = randomUUID()
  const accountId = randomUUID()
  const categoryId = randomUUID()
  const subjectHash = hashWechatSubject(`synthetic-${label}-${randomUUID()}`)
  await pool.execute('INSERT INTO catledger_users (uid, status) VALUES (?, \'active\')', [uid])
  await pool.execute(
    `INSERT INTO catledger_user_identities (uid, provider, subject_hash)
     VALUES (?, 'wechat-mini', ?)`,
    [uid, subjectHash]
  )
  await pool.execute(
    `INSERT INTO catledger_accounts
       (uid, account_id, type, nature, name, normalized_name, currency)
     VALUES (?, ?, 'wallet', 'asset', ?, ?, 'CNY')`,
    [uid, accountId, `合成账户-${label}`, `合成账户-${label}`]
  )
  await pool.execute(
    `INSERT INTO catledger_categories
       (category_id, uid, kind, system_key, name, normalized_name, sort_order, is_system_default)
     VALUES (?, ?, 'expense', NULL, ?, ?, 1, 0)`,
    [categoryId, uid, `合成分类-${label}`, `合成分类-${label}`]
  )
  return { uid, accountId, categoryId, subjectHash }
}

function createDraft(pool, request) {
  return executeIdempotentMutation({ getPool: () => pool, ...request, action: 'synthetic.createDraft',
    operation: (connection, uid, data, digest, key) => createUpdate(connection, uid, data.batchIds, digest, key) })
}

async function prepareSingle(service, request) {
  const { fileName, size, ...data } = request.data
  const result = await service.prepareMany({ ...request, data: { ...data, files: [{ fileName, size }] } })
  return result.files[0]
}

function context(user, data) {
  return { provider: 'wechat-mini', subjectHash: user.subjectHash, data }
}

async function resolveOpenCategoryIssues(service, user, initialView) {
  let view = initialView
  while (true) {
    const issue = view.issues.find((item) => item.status === 'open' && item.issueType === 'category_assignment')
    if (!issue) return view
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
      updateVersion: view.update.version, issueVersion: issue.version,
      decision: 'apply_fields', fields: { categoryId: user.categoryId }
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
  }
}

test('MySQL 多文件形成一个 FinanceUpdate 并整批原子入账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'multi')
    const contents = [fixtureWithSequence(101), fixtureWithSequence(201)]
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(),
      files: contents.map((content, index) => ({ fileName: `多账单-${index + 1}.csv`, size: content.length }))
    }))
    const parsed = []
    for (let index = 0; index < prepared.files.length; index += 1) {
      const file = prepared.files[index]
      objects.set(file.cloudPath, contents[index])
      parsed.push(await service.parseFile(context(user, {
        requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480
      })))
    }
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: parsed.map((item) => item.batch.batchId)
    }))
    assert.equal(view.sources.length, 2)
    assert.equal(view.events.length, 4)
    assert.equal(view.update.counts.validEvidence, 4)
    assert.equal(view.coverage.statementFullyRecognized, true)
    assert.equal(view.coverage.rowConservationPassed, true)
    assert.equal(view.coverage.selectedEventsReadyToPost, false)
    const [[snapshots]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_rows
        WHERE uid = ? AND semantic_json IS NOT NULL AND observations_json IS NOT NULL`, [user.uid]
    )
    assert.equal(Number(snapshots.count), 4)

    const accountIssues = view.issues.filter((item) => item.status === 'open')
    for (const issue of accountIssues) {
      assert.equal(issue.issueType, 'account_mapping')
    }
    const versionBeforeAccountBatch = view.update.version
    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(),
      updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: { ledgerAccountDraft: { name: '多账单新账户', type: 'wallet', currency: 'CNY' } }
      }))
    }))
    assert.equal(view.update.version, versionBeforeAccountBatch + 1)
    view = await resolveOpenCategoryIssues(service, user, view)
    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 4)
    const [[accountBatchActions]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM catledger_finance_actions
        WHERE uid = ? AND update_id = ? AND action_type = 'resolve_account_mappings'`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(accountBatchActions.count), 1)

    const [[formalMappingsBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ?`,
      [user.uid]
    )
    const [[draftMappingsBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM catledger_finance_update_account_mapping_drafts
        WHERE uid = ? AND update_id = ?`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(formalMappingsBeforePost.count), 0)
    assert.ok(Number(draftMappingsBeforePost.count) > 0)
    const [[formalAccountsBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid = ?`,
      [user.uid]
    )
    assert.equal(Number(formalAccountsBeforePost.count), 1)

    assert.equal(view.coverage.selectedEventsReadyToPost, true)
    await pool.execute('UPDATE catledger_finance_updates SET plan_version = ? WHERE uid = ? AND update_id = ?',
      ['organizer-plan-stale', user.uid, view.update.updateId])
    await assert.rejects(service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version
    })), (error) => error.publicCode === 'CONFLICT')
    const staleView = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(staleView.coverage.selectedEventsReadyToPost, false)
    await pool.execute('UPDATE catledger_finance_updates SET plan_version = ? WHERE uid = ? AND update_id = ?',
      [PLAN_VERSION, user.uid, view.update.updateId])

    const [[savedEvidence]] = await pool.execute(
      'SELECT * FROM catledger_event_evidence WHERE uid = ? AND update_id = ? LIMIT 1',
      [user.uid, view.update.updateId])
    await pool.execute('DELETE FROM catledger_event_evidence WHERE uid = ? AND evidence_id = ?',
      [user.uid, savedEvidence.evidence_id])
    await assert.rejects(service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version
    })), (error) => error.publicCode === 'UNRESOLVED_IMPORT')
    await pool.query('INSERT INTO catledger_event_evidence SET ?', savedEvidence)
    const [[rejectedWrites]] = await pool.execute(
      'SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
    assert.equal(Number(rejectedWrites.count), 0)

    const obsoleteDraftId = randomUUID()
    await pool.execute(`INSERT INTO catledger_finance_update_account_drafts
      (uid, draft_account_id, update_id, name, normalized_name, type, nature, currency, action_id)
      SELECT uid, ?, update_id, '旧选择测试', '旧选择测试', type, nature, currency, action_id
      FROM catledger_finance_update_account_drafts WHERE uid = ? AND update_id = ? LIMIT 1`,
      [obsoleteDraftId, user.uid, view.update.updateId])
    const requestId = randomUUID()
    const posted = await service.financeUpdatePost(context(user, {
      requestId, updateId: view.update.updateId, version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(posted.update.status, 'posted')
    assert.deepEqual(posted.posting, { createdTransactionCount: 4, reusedTransactionCount: 0 })
    const listedImported = await createTransactionService({ getPool: () => pool }).list(context(user, { month: '2026-08', pageSize: 30 }))
    assert.ok(listedImported.transactions.length > 0)
    assert.ok(listedImported.transactions.every((row) => row.importContext && row.importContext.updateId === posted.update.updateId && row.editable === false))

    const replayed = await service.financeUpdatePost(context(user, {
      requestId, updateId: view.update.updateId, version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(replayed.update.status, 'posted')
    const [[transactions]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL`,
      [user.uid]
    )
    assert.equal(Number(transactions.count), 4)
    const [[formalMappingsAfterPost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ?`,
      [user.uid]
    )
    assert.ok(Number(formalMappingsAfterPost.count) > 0)
    const [[formalAccountsAfterPost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid = ?`,
      [user.uid]
    )
    assert.equal(Number(formalAccountsAfterPost.count), 2)
    const [[obsolete]] = await pool.execute(`SELECT materialized_at AS materializedAt, superseded_at AS supersededAt
      FROM catledger_finance_update_account_drafts WHERE uid = ? AND draft_account_id = ?`, [user.uid, obsoleteDraftId])
    assert.equal(obsolete.materializedAt, null)
    assert.ok(obsolete.supersededAt)

    const target = posted.events.find((event) => event.economicNature === 'expense')
    const correctionFields = { amountMinor: '50' }
    const beforeCorrection = await service.economicEventCorrectionImpact(context(user, { eventId: target.eventId, fields: correctionFields }))
    assert.equal(beforeCorrection.canCorrect, true)
    await assert.rejects(service.economicEventCorrect(context(user, {
      requestId: randomUUID(), updateId: posted.update.updateId, eventId: target.eventId,
      updateVersion: posted.update.version, eventVersion: target.version, fields: correctionFields, previewToken: 'stale'
    })), (error) => error.publicCode === 'CONFLICT')
    const corrected = await service.economicEventCorrect(context(user, {
      requestId: randomUUID(), updateId: posted.update.updateId, eventId: target.eventId,
      updateVersion: posted.update.version, eventVersion: target.version, fields: correctionFields, previewToken: beforeCorrection.previewToken
    }))
    assert.equal(corrected.events.find((event) => event.eventId === target.eventId).status, 'corrected')
    const cashId = randomUUID()
    await pool.execute(`INSERT INTO catledger_accounts (uid, account_id, type, nature, name, normalized_name, currency)
      VALUES (?, ?, 'cash', 'asset', '维护现金测试', '维护现金测试', 'CNY')`, [user.uid, cashId])
    const cashImpact = await service.economicEventCorrectionImpact(context(user, { eventId: target.eventId, fields: { ledgerAccountId: cashId } }))
    assert.equal(cashImpact.canCorrect, false)
    assert.ok(cashImpact.conflicts.includes('INSUFFICIENT_CASH_BALANCE'))
    await pool.execute('UPDATE catledger_transactions SET version = version + 1 WHERE uid = ? AND transaction_id = ?', [user.uid, beforeCorrection.transactionIds[0]])
    const externalChange = await service.financeUpdateUndoImpact(context(user, { updateId: posted.update.updateId }))
    assert.equal(externalChange.canUndo, false)
    assert.ok(externalChange.conflicts.includes('TRANSACTION_SET_CHANGED'))
    await pool.execute('UPDATE catledger_transactions SET version = version - 1 WHERE uid = ? AND transaction_id = ?', [user.uid, beforeCorrection.transactionIds[0]])
    const impact = await service.financeUpdateUndoImpact(context(user, { updateId: posted.update.updateId }))
    assert.equal(impact.canUndo, true)
    assert.equal(impact.createdTransactionCount, 4)
    const undone = await service.financeUpdateUndo(context(user, {
      requestId: randomUUID(), updateId: posted.update.updateId, version: corrected.update.version, previewToken: impact.previewToken
    }))
    assert.equal(undone.update.status, 'undone')
    const [[activeAfterUndo]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL`,
      [user.uid]
    )
    assert.equal(Number(activeAfterUndo.count), 0)
    assert.equal(impact.sideEffects.archivedAccountIds.length, 1)
    const [[archivedDraft]] = await pool.execute('SELECT archived_at AS archivedAt FROM catledger_accounts WHERE uid = ? AND account_id = ?',
      [user.uid, impact.sideEffects.archivedAccountIds[0]])
    assert.ok(archivedDraft.archivedAt)
    const [[activeMappings]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ? AND disabled_at IS NULL', [user.uid])
    assert.equal(Number(activeMappings.count), 0)
  } finally {
    await pool.end()
  }
})

test('退款详情只返回冻结候选且服务端拒绝集合外原消费', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'refund-policy')
    const content = wechatRefundCandidatesFixture()
    const prepared = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '退款候选账单.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.ok(accountIssue)
    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: [{
        issueId: accountIssue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: { ledgerAccountId: user.accountId }
      }]
    }))

    const refundIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'refund_relation')
    assert.ok(refundIssue)
    assert.equal(refundIssue.candidateCount, 2)
    const details = await service.reviewIssueGet(context(user, { issueId: refundIssue.issueId }))
    assert.equal(Object.prototype.hasOwnProperty.call(details, 'refundChoices'), false)
    const candidateMembers = details.members.filter((member) => member.memberRole === 'candidate')
    assert.equal(candidateMembers.length, 2)

    const unrelated = view.events.find((event) => event.amountMinor === '800')
    assert.ok(unrelated)
    await assert.rejects(() => service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: refundIssue.issueId,
      updateVersion: view.update.version, issueVersion: refundIssue.version,
      decision: 'link_refund', targetEventId: unrelated.eventId
    })), { publicCode: 'VALIDATION_ERROR' })

    const selectedTargetId = candidateMembers[0].relation.targetEventId
    const refundEventId = candidateMembers[0].relation.sourceEventId
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: refundIssue.issueId,
      updateVersion: view.update.version, issueVersion: refundIssue.version,
      decision: 'link_refund', targetEventId: selectedTargetId
    }))
    const afterResolve = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(afterResolve.issues.find((issue) => issue.issueId === refundIssue.issueId).status, 'resolved')
    const [relationStates] = await pool.execute(
      `SELECT status, COUNT(*) AS count
         FROM catledger_economic_event_relations
        WHERE uid = ? AND update_id = ? AND source_event_id = ? AND relation_type = 'refund_of'
        GROUP BY status ORDER BY status`,
      [user.uid, view.update.updateId, refundEventId]
    )
    assert.deepEqual(relationStates.map((row) => [row.status, Number(row.count)]), [
      ['confirmed', 1], ['rejected', 1]
    ])
    const ready = await resolveOpenCategoryIssues(service, user, afterResolve)
    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: ready.update.updateId, version: ready.update.version
    }))
    const correction = async (eventId, fields) => service.economicEventCorrectionImpact(context(user, { eventId, fields }))
    await assert.rejects(correction(selectedTargetId, { occurredLocalAt: '2026-07-05T10:00:00', timezoneOffsetMinutes: -480 }),
      { publicCode: 'VALIDATION_ERROR' })
    await assert.rejects(correction(refundEventId, { occurredLocalAt: '2026-06-01T10:00:00', timezoneOffsetMinutes: -480 }),
      { publicCode: 'VALIDATION_ERROR' })
    const expense = posted.events.find(event => event.eventId === selectedTargetId)
    const fields = { amountMinor: String(Number(expense.amountMinor) + 1) }
    const impact = await correction(selectedTargetId, fields)
    assert.equal(impact.canCorrect, true)
    const corrected = await service.economicEventCorrect(context(user, { requestId: randomUUID(), updateId: posted.update.updateId,
      updateVersion: posted.update.version, eventId: selectedTargetId, eventVersion: expense.version,
      fields, previewToken: impact.previewToken }))
    const currentExpense = corrected.events.find(event => event.eventId === selectedTargetId)
    const [[originalLink]] = await pool.execute(`SELECT transaction_id AS transactionId FROM catledger_economic_event_transactions
      WHERE uid = ? AND event_id = ? AND role = 'primary' AND superseded_at IS NULL`, [user.uid, selectedTargetId])
    const reduced = { amountMinor: '300' }
    const reduceImpact = await correction(selectedTargetId, reduced)
    const outcomes = await Promise.allSettled([
      createTransactionService({ getPool: () => pool }).create(context(user, { requestId: randomUUID(), type: 'refund',
        destinationAccountId: user.accountId, originalTransactionId: originalLink.transactionId, amountMinor: '100',
        occurredLocalAt: '2026-07-04T10:00:00', timezoneOffsetMinutes: -480 })),
      service.economicEventCorrect(context(user, { requestId: randomUUID(), updateId: corrected.update.updateId,
        updateVersion: corrected.update.version, eventId: selectedTargetId, eventVersion: currentExpense.version,
        fields: reduced, previewToken: reduceImpact.previewToken }))
    ])
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
    assert.ok(['VALIDATION_ERROR', 'CONFLICT', 'REFUND_EXCEEDS_ORIGINAL'].includes(outcomes.find(result => result.status === 'rejected').reason.publicCode))
  } finally {
    await pool.end()
  }
})

test('零候选退款可明确暂记并入账余额但不进入收支统计', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  const accountService = createAccountService({ getPool: () => pool })
  const transactionService = createTransactionService({ getPool: () => pool })
  try {
    const user = await createUserLedger(pool, 'unlinked-refund')
    const content = wechatUnlinkedRefundFixture()
    const prepared = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '待关联退款.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.ok(accountIssue)
    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: [{
        issueId: accountIssue.issueId, operation: 'resolve', decision: 'apply_fields',
        fields: { ledgerAccountId: user.accountId }
      }]
    }))
    const refundIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'refund_relation')
    assert.ok(refundIssue)
    assert.equal(refundIssue.candidateCount, 0)
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: refundIssue.issueId,
      updateVersion: view.update.version, issueVersion: refundIssue.version,
      decision: 'mark_refund_pending'
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 1)
    const pending = view.events.find((event) => event.economicNature === 'refund')
    const [[storedPending]] = await pool.execute(
      `SELECT field_sources_json AS fieldSources
         FROM catledger_economic_events
        WHERE uid = ? AND update_id = ? AND event_id = ?`,
      [user.uid, view.update.updateId, pending.eventId]
    )
    const storedFieldSources = typeof storedPending.fieldSources === 'string'
      ? JSON.parse(storedPending.fieldSources)
      : storedPending.fieldSources
    assert.equal(storedFieldSources.refundRelation.status, 'pending')

    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(posted.update.status, 'posted')
    const [rows] = await pool.execute(
      `SELECT type, destination_account_id AS destinationAccountId,
              original_transaction_id AS originalTransactionId
         FROM catledger_transactions
        WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL`,
      [user.uid]
    )
    assert.deepEqual(rows, [{
      type: 'refund', destinationAccountId: user.accountId, originalTransactionId: null
    }])
    const page = await transactionService.list(context(user, { month: '2026-07' }))
    assert.deepEqual(page.summary, { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' })
    assert.equal(page.transactions[0].refundLinkStatus, 'pending')
    const statistics = await transactionService.statistics(context(user, { month: '2026-07' }))
    assert.deepEqual(statistics.expenseCategories, [])
    assert.equal(statistics.daily.find((day) => day.date === '2026-07-04').expenseMinor, '0')
    const accounts = await accountService.list(context(user, {}))
    assert.equal(accounts.accounts.find((account) => account.accountId === user.accountId).bookBalanceMinor, '466')

    const original = await transactionService.create(context(user, {
      requestId: randomUUID(), type: 'expense', sourceAccountId: user.accountId,
      categoryId: user.categoryId, amountMinor: '466',
      occurredLocalAt: '2026-07-05T11:37:00', timezoneOffsetMinutes: -480,
      note: '手持小型缝纫机'
    }))
    await assert.rejects(transactionService.linkRefund(context(user, {
      requestId: randomUUID(), transactionId: page.transactions[0].transactionId,
      version: page.transactions[0].version, originalTransactionId: original.transactionId
    })), { publicCode: 'VALIDATION_ERROR' })
    await transactionService.update(context(user, { requestId: randomUUID(), transactionId: original.transactionId,
      version: original.version, type: 'expense', sourceAccountId: user.accountId, categoryId: user.categoryId,
      amountMinor: '466', occurredLocalAt: '2026-07-04T11:37:00', timezoneOffsetMinutes: -480 }))
    const linked = await transactionService.linkRefund(context(user, {
      requestId: randomUUID(), transactionId: page.transactions[0].transactionId,
      version: page.transactions[0].version, originalTransactionId: original.transactionId
    }))
    assert.equal(linked.refundLinkStatus, 'linked')
    assert.equal(linked.originalTransaction.transactionId, original.transactionId)
    const [refundOriginalLinks] = await pool.execute(
      `SELECT transaction_id AS transactionId, role, creation_method AS creationMethod,
              rule_version AS ruleVersion
         FROM catledger_economic_event_transactions
        WHERE uid = ? AND transaction_id = ? AND role = 'refund_original'`,
      [user.uid, original.transactionId]
    )
    assert.deepEqual(refundOriginalLinks, [{
      transactionId: original.transactionId,
      role: 'refund_original',
      creationMethod: 'manual_link',
      ruleVersion: 'refund-link-v1'
    }])
    const afterLink = await transactionService.list(context(user, { month: '2026-07' }))
    assert.deepEqual(afterLink.summary, { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' })
    assert.equal(afterLink.transactions.find((transaction) => transaction.type === 'refund').refundLinkStatus, 'linked')
    const afterLinkAccounts = await accountService.list(context(user, {}))
    assert.equal(afterLinkAccounts.accounts.find((account) => account.accountId === user.accountId).bookBalanceMinor, '0')
  } finally {
    await pool.end()
  }
})

test('MySQL 同一批账单放弃后可再次原子 prepare', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'repeat-prepare')
    const content = fixtureWithSequence(251)
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '重复整理账单.csv', size: content.length }]
    }))
    const file = prepared.files[0]
    objects.set(file.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: file.importId,
      fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const batchIds = [parsed.batch.batchId]

    const first = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds
    }))
    const abandoned = await service.financeUpdateAbandon(context(user, {
      requestId: randomUUID(), updateId: first.update.updateId, version: first.update.version
    }))
    assert.equal(abandoned.status, 'abandoned')

    const second = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds
    }))
    assert.notEqual(second.update.updateId, first.update.updateId)
    assert.equal(second.update.status, 'review')
  } finally {
    await pool.end()
  }
})

test('微信零钱提现按资金端分别确认，账户归属后不再生成同账户转账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'wechat-withdrawal')
    const content = wechatWithdrawalFixture()
    const prepared = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '微信零钱提现.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssues = view.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.equal(accountIssues.length, 2)
    assert.deepEqual(accountIssues.map((issue) => [issue.accountContext.fundsSide, issue.accountContext.label])
      .sort((left, right) => left[0].localeCompare(right[0])), [
      ['from', '微信零钱'],
      ['to', '浙江农商联合银行储蓄卡(5564)']
    ])

    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: {
          mappingAccountDraft: {
            name: issue.accountContext.label,
            type: issue.accountContext.fundsSide === 'from' ? 'wallet' : 'bank',
            currency: 'CNY'
          }
        }
      }))
    }))

    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 1)
    assert.equal(view.issues.some((issue) => issue.status === 'open'), false)
    assert.equal(view.events.length, 1)
    assert.notEqual(view.events[0].ledgerAccountId, view.events[0].counterpartyLedgerAccountId)
    const drafts = new Map(view.accountDrafts.map((draft) => [draft.accountId, draft.name]))
    assert.equal(drafts.get(view.events[0].ledgerAccountId), '微信零钱')
    assert.equal(drafts.get(view.events[0].counterpartyLedgerAccountId), '浙江农商联合银行储蓄卡(5564)')
  } finally {
    await pool.end()
  }
})

test('余额宝转出到账户余额确认两端归属后直接完成整理', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'alipay-balance-transfer')
    const content = alipayBalanceTransferFixture()
    const prepared = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '支付宝余额宝转出.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssues = view.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.deepEqual(accountIssues.map((issue) => [issue.accountContext.fundsSide, issue.accountContext.label])
      .sort((left, right) => left[0].localeCompare(right[0])), [
      ['from', '支付宝余额宝'],
      ['to', '支付宝账户余额']
    ])

    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: {
          mappingAccountDraft: {
            name: issue.accountContext.label,
            type: issue.accountContext.fundsSide === 'from' ? 'other_asset' : 'wallet',
            currency: 'CNY'
          }
        }
      }))
    }))

    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 1)
    assert.equal(view.issues.some((issue) => issue.status === 'open'), false)
    assert.notEqual(view.events[0].ledgerAccountId, view.events[0].counterpartyLedgerAccountId)
    const drafts = new Map(view.accountDrafts.map((draft) => [draft.accountId, draft.name]))
    assert.equal(drafts.get(view.events[0].ledgerAccountId), '支付宝余额宝')
    assert.equal(drafts.get(view.events[0].counterpartyLedgerAccountId), '支付宝账户余额')
  } finally {
    await pool.end()
  }
})

test('支付宝合并还款不创建第三账户并原子入账为多笔守恒转账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'alipay-aggregate-repayment')
    const content = alipayAggregateRepaymentFixture()
    const prepared = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '支付宝合并还款.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssues = view.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.deepEqual(accountIssues.map((issue) => issue.accountContext.label).sort(), [
      '支付宝花呗', '江苏银行信用购', '浙江农商联合银行储蓄卡(5564)'
    ].sort())
    assert.equal(accountIssues.some((issue) => issue.accountContext.label.includes('花呗｜信用购')), false)

    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: {
          mappingAccountDraft: {
            name: issue.accountContext.label,
            type: issue.accountContext.label.includes('储蓄卡') ? 'bank' : 'credit',
            currency: 'CNY'
          }
        }
      }))
    }))

    const draftsByName = new Map(view.accountDrafts.map((draft) => [draft.name, draft.accountId]))
    const repaymentIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'transfer_accounts' &&
      issue.subject && issue.subject.fundsProjection && issue.subject.fundsProjection.to.referenceKind === 'aggregate')
    assert.ok(repaymentIssue)
    assert.equal(repaymentIssue.subject.ledgerAccountId, draftsByName.get('浙江农商联合银行储蓄卡(5564)'))
    assert.deepEqual(repaymentIssue.subject.fundsProjection.to.candidates.map((candidate) => candidate.accountId).sort(), [
      draftsByName.get('支付宝花呗'), draftsByName.get('江苏银行信用购')
    ].sort())

    await assert.rejects(() => service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: repaymentIssue.issueId,
      updateVersion: view.update.version, issueVersion: repaymentIssue.version,
      decision: 'apply_fields',
      fields: {
        repaymentAllocations: [{ accountId: user.accountId, amountMinor: '10000' }]
      }
    })), { publicCode: 'VALIDATION_ERROR' })

    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: repaymentIssue.issueId,
      updateVersion: view.update.version, issueVersion: repaymentIssue.version,
      decision: 'apply_fields',
      fields: {
        repaymentAllocations: [
          { accountId: draftsByName.get('支付宝花呗'), amountMinor: '6000' },
          { accountId: draftsByName.get('江苏银行信用购'), amountMinor: '4000' }
        ]
      }
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    view = await resolveOpenCategoryIssues(service, user, view)

    while (view.issues.some((issue) => issue.status === 'open')) {
      const issue = view.issues.find((item) => item.status === 'open')
      await service.reviewIssueResolve(context(user, {
        requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version,
        decision: 'exclude_events'
      }))
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    }
    const repaymentEvent = view.events.find((event) => event.economicNature === 'repayment')
    assert.ok(repaymentEvent)
    assert.equal(repaymentEvent.status, 'ready')

    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      version: view.update.version, mode: 'all_ready'
    }))
    assert.deepEqual(posted.posting, { createdTransactionCount: 4, reusedTransactionCount: 0 })
    const [transactions] = await pool.execute(
      `SELECT transaction_row.source_account_id AS sourceAccountId,
              transaction_row.destination_account_id AS destinationAccountId,
              CAST(transaction_row.amount_minor AS CHAR) AS amountMinor,
              event_link.role
         FROM catledger_economic_event_transactions event_link
         JOIN catledger_transactions transaction_row
           ON transaction_row.uid = event_link.uid AND transaction_row.transaction_id = event_link.transaction_id
        WHERE event_link.uid = ? AND event_link.event_id = ?
        ORDER BY amountMinor`,
      [user.uid, repaymentEvent.eventId]
    )
    assert.deepEqual(transactions.map((transaction) => ({
      sourceAccountId: transaction.sourceAccountId,
      destinationAccountId: transaction.destinationAccountId,
      amountMinor: transaction.amountMinor,
      role: transaction.role
    })), [
      {
        sourceAccountId: draftsByName.get('浙江农商联合银行储蓄卡(5564)'),
        destinationAccountId: draftsByName.get('江苏银行信用购'),
        amountMinor: '4000', role: 'repayment_allocation'
      },
      {
        sourceAccountId: draftsByName.get('浙江农商联合银行储蓄卡(5564)'),
        destinationAccountId: draftsByName.get('支付宝花呗'),
        amountMinor: '6000', role: 'repayment_allocation'
      }
    ])
    const fields = { repaymentAllocations: [
      { accountId: draftsByName.get('支付宝花呗'), amountMinor: '7000' },
      { accountId: draftsByName.get('江苏银行信用购'), amountMinor: '3000' }
    ] }
    const impact = await service.economicEventCorrectionImpact(context(user, { eventId: repaymentEvent.eventId, fields }))
    assert.equal(impact.canCorrect, true)
    assert.equal(impact.transactionSet.length, 2)
    const correction = { requestId: randomUUID(), updateId: posted.update.updateId, eventId: repaymentEvent.eventId,
      updateVersion: posted.update.version, eventVersion: impact.eventVersion, fields, previewToken: impact.previewToken }
    const triggerName = 'a1_fail_' + randomUUID().replaceAll('-', '')
    await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON catledger_transactions FOR EACH ROW
      BEGIN IF NEW.uid = '${user.uid}' AND NEW.amount_minor = 3000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic failure'; END IF; END`)
    try {
      await assert.rejects(service.economicEventCorrect(context(user, correction)))
      const [[unchanged]] = await pool.execute(`SELECT COUNT(*) AS count FROM catledger_economic_event_transactions l
        JOIN catledger_transactions t ON t.uid = l.uid AND t.transaction_id = l.transaction_id
        WHERE l.uid = ? AND l.event_id = ? AND l.superseded_at IS NULL AND t.deleted_at IS NULL`, [user.uid, repaymentEvent.eventId])
      assert.equal(Number(unchanged.count), 2)
    } finally { await pool.query(`DROP TRIGGER ${triggerName}`) }
    const corrected = await service.economicEventCorrect(context(user, correction))
    assert.deepEqual(await service.economicEventCorrect(context(user, correction)), corrected)
    const [active] = await pool.execute(`SELECT t.amount_minor AS amountMinor FROM catledger_transactions t
      JOIN catledger_economic_event_transactions l ON l.uid = t.uid AND l.transaction_id = t.transaction_id
      WHERE l.uid = ? AND l.event_id = ? AND l.superseded_at IS NULL AND t.deleted_at IS NULL ORDER BY t.amount_minor`, [user.uid, repaymentEvent.eventId])
    assert.deepEqual(active.map((row) => String(row.amountMinor)), ['3000', '7000'])
    const staleUndo = await service.financeUpdateUndoImpact(context(user, { updateId: posted.update.updateId }))
    const [[mapping]] = await pool.execute('SELECT mapping_id AS mappingId FROM catledger_import_account_mappings WHERE uid = ? AND disabled_at IS NULL LIMIT 1', [user.uid])
    await pool.execute('UPDATE catledger_import_account_mappings SET version = version + 1 WHERE uid = ? AND mapping_id = ?', [user.uid, mapping.mappingId])
    await assert.rejects(service.financeUpdateUndo(context(user, { requestId: randomUUID(), updateId: posted.update.updateId,
      version: corrected.update.version, previewToken: staleUndo.previewToken })), (error) => error.publicCode === 'CONFLICT')
    const undo = await service.financeUpdateUndoImpact(context(user, { updateId: posted.update.updateId }))
    assert.equal(undo.canUndo, true)
    assert.ok(undo.sideEffects.retainedMappingCount > 0)
    await service.financeUpdateUndo(context(user, { requestId: randomUUID(), updateId: posted.update.updateId,
      version: corrected.update.version, previewToken: undo.previewToken }))
    const [[remaining]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL', [user.uid])
    assert.equal(Number(remaining.count), 0)

  } finally {
    await pool.end()
  }
})

test('FinanceUpdate 永久忽略只在整批入账后提升并让后续匹配自动排除且可修改', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'finance-update-ignore')
    const content = fixtureWithSequence(501)
    const prepared = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '整批永久忽略.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const created = await createDraft(pool, context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    let view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: created.updateId, version: created.version
    }))
    const issue = view.issues.find((item) => item.status === 'open' && item.issueType === 'account_mapping')
    assert.ok(issue)
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
      updateVersion: view.update.version, issueVersion: issue.version,
      decision: 'exclude_events', paymentRuleAction: 'ignore'
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(view.update.counts.readyEvents, 0)
    assert.equal(view.update.counts.excludedEvents, 2)
    view.events.filter((event) => event.status === 'excluded').forEach((event) => {
      assert.ok(event.reasonCodes.includes('account_mapping_excluded'))
    })

    const [[formalBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ?`,
      [user.uid]
    )
    const [[draftBeforePost]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, account_id AS accountId
         FROM catledger_finance_update_account_mapping_drafts
        WHERE uid = ? AND update_id = ? LIMIT 1`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(formalBeforePost.count), 0)
    assert.deepEqual(draftBeforePost, { mappingAction: 'ignore', accountId: null })

    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(posted.update.status, 'posted')
    assert.deepEqual(posted.posting, { createdTransactionCount: 0, reusedTransactionCount: 0 })
    const [[formalAfterPost]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, account_id AS accountId, disabled_at AS disabledAt
         FROM catledger_import_account_mappings WHERE uid = ? LIMIT 1`,
      [user.uid]
    )
    assert.deepEqual(formalAfterPost, { mappingAction: 'ignore', accountId: null, disabledAt: null })

    // 模拟旧版本曾按带平台前缀的原文生成键。原事实必须保留，后续读取
    // 应从稳定提示派生当前规范键别名，而不是要求用户再次确认。
    const legacyKey = digestParts('payment-method-v1', 'wechat', '微信零钱')
    await pool.execute(
      `UPDATE catledger_import_account_mappings
          SET payment_method_key = ?, payment_method_hint = '微信零钱'
        WHERE uid = ?`,
      [legacyKey, user.uid]
    )

    const laterContent = fixtureWithSequence(601)
    const later = await prepareSingle(service, context(user, {
      requestId: randomUUID(), fileName: '后续复用永久忽略.csv', size: laterContent.length
    }))
    objects.set(later.cloudPath, laterContent)
    const laterParsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: later.importId,
      fileID: `cloud://synthetic.bucket/${later.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const laterCreated = await createDraft(pool, context(user, {
      requestId: randomUUID(), batchIds: [laterParsed.batch.batchId]
    }))
    const laterView = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: laterCreated.updateId, version: laterCreated.version
    }))
    assert.equal(laterView.events.every((event) => event.status === 'excluded'), true)
    assert.equal(laterView.events.every((event) => event.reasonCodes.includes('source_account_ignored_default')), true)
    const laterIssue = laterView.issues.find((item) => item.status === 'resolved' && item.issueType === 'account_mapping')
    assert.ok(laterIssue)
    assert.equal(laterIssue.blocking, false)
    assert.equal(laterIssue.accountContext.defaultIgnored, true)
    // 恢复规范键后，验证自动复用规则的来源证据也能阻止规则被撤回。
    await pool.execute('UPDATE catledger_import_account_mappings SET payment_method_key = ? WHERE uid = ?',
      [buildPaymentMethodKey('wechat', '微信零钱'), user.uid])
    const inheritedImpact = await service.financeUpdateUndoImpact(context(user, { updateId: posted.update.updateId }))
    assert.equal(inheritedImpact.canUndo, true)
    assert.equal(inheritedImpact.sideEffects.revertedMappingCount, 0)
    assert.equal(inheritedImpact.sideEffects.retainedMappingCount, 1)
    await pool.execute('UPDATE catledger_import_account_mappings SET payment_method_key = ? WHERE uid = ?', [legacyKey, user.uid])

    await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: laterView.update.updateId,
      decisions: [{
        issueId: laterIssue.issueId,
        operation: 'revise',
        decision: 'apply_fields',
        fields: { ledgerAccountId: user.accountId }
      }]
    }))
    const laterResolved = await service.financeUpdateGet(context(user, { updateId: laterView.update.updateId }))
    const categorizedLater = await resolveOpenCategoryIssues(service, user, laterResolved)
    assert.equal(categorizedLater.issues.some((item) => item.status === 'open'), false)
    await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: categorizedLater.update.updateId,
      version: categorizedLater.update.version, mode: 'all_ready'
    }))
    const [rulesAfterOverride] = await pool.execute(
      `SELECT payment_method_key AS paymentMethodKey, mapping_action AS mappingAction,
              account_id AS accountId
         FROM catledger_import_account_mappings WHERE uid = ? ORDER BY payment_method_key`,
      [user.uid]
    )
    assert.equal(rulesAfterOverride.length, 2)
    assert.deepEqual(rulesAfterOverride.find((rule) => rule.paymentMethodKey === legacyKey), {
      paymentMethodKey: legacyKey, mappingAction: 'ignore', accountId: null
    })
    assert.deepEqual(rulesAfterOverride.find((rule) => rule.mappingAction === 'account'), {
      paymentMethodKey: buildPaymentMethodKey('wechat', '零钱'),
      mappingAction: 'account', accountId: user.accountId
    })
  } finally {
    await pool.end()
  }
})

test('FinanceUpdate 入账不得产生现金负余额且失败时整批回滚', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'cash-guard')
    await pool.execute(
      `UPDATE catledger_accounts SET type = 'cash' WHERE uid = ? AND account_id = ?`,
      [user.uid, user.accountId]
    )
    const content = fixtureWithSequence(601)
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '现金支出.csv', size: content.length }]
    }))
    objects.set(prepared.files[0].cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.files[0].importId,
      fileID: `cloud://synthetic.bucket/${prepared.files[0].cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const created = await createDraft(pool, context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    let view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: created.updateId, version: created.version
    }))
    while (view.issues.some((item) => item.status === 'open')) {
      const issue = view.issues.find((item) => item.status === 'open')
      await service.reviewIssueResolve(context(user, {
        requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version,
        decision: 'apply_fields',
        fields: issue.issueType === 'category_assignment'
          ? { categoryId: user.categoryId }
          : { ledgerAccountId: user.accountId }
      }))
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    }

    await assert.rejects(service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version, mode: 'all_ready'
    })), { publicCode: 'INSUFFICIENT_CASH_BALANCE' })

    const after = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(after.update.status, 'review')
    const [[counts]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM catledger_transactions WHERE uid = ? AND origin = 'import') AS transactions,
         (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid = ?) AS mappings,
         (SELECT COUNT(*) FROM catledger_economic_event_transactions WHERE uid = ? AND update_id = ?) AS links`,
      [user.uid, user.uid, user.uid, view.update.updateId]
    )
    assert.deepEqual({
      transactions: Number(counts.transactions),
      mappings: Number(counts.mappings),
      links: Number(counts.links)
    }, { transactions: 0, mappings: 0, links: 0 })
  } finally {
    await pool.end()
  }
})

test('MySQL 旧解析版本追加批次，覆盖统计重用当前语义且旧证据不改写', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  } })
  try {
    const user = await createUserLedger(pool, 'parse-upgrade')
    const content = fixtureWithSequence(781)
    async function upload() {
      const prepared = await service.prepareMany(context(user, {
        requestId: randomUUID(), files: [{ fileName: '版本升级合成账单.csv', size: content.length }]
      }))
      const file = prepared.files[0]
      objects.set(file.cloudPath, content)
      return { requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480 }
    }
    const parsed = await service.parseFile(context(user, await upload()))
    const initial = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    assert.ok(initial.coverage.recognizedRows > 0)
    await pool.execute('UPDATE catledger_import_batches SET parse_fingerprint = ?, analysis_json = NULL WHERE uid = ? AND batch_id = ?',
      [digestParts('legacy-parser'), user.uid, parsed.batch.batchId])
    await pool.execute('UPDATE catledger_import_rows SET semantic_json = NULL, observations_json = NULL WHERE uid = ? AND batch_id = ?',
      [user.uid, parsed.batch.batchId])
    const [legacyCores] = await pool.execute(`SELECT row_id, identity_id, normalized_amount_minor AS amountMinor,
      currency, normalized_direction AS direction FROM catledger_import_rows WHERE uid = ? AND batch_id = ?`,
    [user.uid, parsed.batch.batchId])
    for (const row of legacyCores) {
      const core = digestParts('source-core-v1', row.amountMinor, row.currency, row.direction, 'unknown')
      await pool.execute('UPDATE catledger_source_identities SET core_digest = ? WHERE uid = ? AND identity_id = ?',
        [core, user.uid, row.identity_id])
      await pool.execute("UPDATE catledger_import_rows SET economic_effect = 'unknown', observed_core_digest = ? WHERE uid = ? AND row_id = ?",
        [core, user.uid, row.row_id])
    }
    const legacy = await service.financeUpdateGet(context(user, { updateId: initial.update.updateId }))
    assert.equal(legacy.coverage.recognizedRows, initial.coverage.recognizedRows)
    assert.equal(legacy.coverage.fileObservationsPassed, false)
    const request = await upload()
    await pool.query(`CREATE TRIGGER catledger_test_upgrade_failure BEFORE INSERT ON catledger_import_batches
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic upgrade failure'`)
    try {
      await assert.rejects(service.parseFile(context(user, request)))
      const unchanged = await service.financeUpdateGet(context(user, { updateId: initial.update.updateId }))
      assert.equal(unchanged.update.status, 'review')
      assert.equal(unchanged.update.version, initial.update.version)
    } finally { await pool.query('DROP TRIGGER catledger_test_upgrade_failure') }
    const refreshed = await service.parseFile(context(user, request))
    assert.equal(refreshed.reusedImportId, parsed.import.importId)
    assert.notEqual(refreshed.batch.batchId, parsed.batch.batchId)
    assert.deepEqual(await service.parseFile(context(user, request)), refreshed)
    const [batches] = await pool.execute('SELECT batch_id, analysis_json FROM catledger_import_batches WHERE uid = ? AND import_id = ?',
      [user.uid, parsed.import.importId])
    assert.equal(batches.length, 2)
    assert.equal(batches.find((batch) => batch.batch_id === parsed.batch.batchId).analysis_json, null)
    assert.ok(batches.find((batch) => batch.batch_id === refreshed.batch.batchId).analysis_json)
    const [oldRows] = await pool.execute('SELECT semantic_json FROM catledger_import_rows WHERE uid = ? AND batch_id = ?',
      [user.uid, parsed.batch.batchId])
    assert.ok(oldRows.every((row) => row.semantic_json === null))
    const old = await service.financeUpdateGet(context(user, { updateId: initial.update.updateId }))
    assert.equal(old.update.status, 'abandoned')
    const current = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [refreshed.batch.batchId]
    }))
    assert.equal(current.coverage.recognizedRows, initial.coverage.recognizedRows)
    assert.equal(current.coverage.dataRows, initial.coverage.dataRows)
    assert.equal(current.issues.filter((issue) => issue.issueType === 'identity_conflict').length, 0)
    const [updatedInterpretations] = await pool.execute('SELECT identity_state, issues_json FROM catledger_import_rows WHERE uid = ? AND batch_id = ?',
      [user.uid, refreshed.batch.batchId])
    assert.ok(updatedInterpretations.every((row) => row.identity_state === 'exact_duplicate'))
    assert.ok(updatedInterpretations.every((row) => JSON.stringify(row.issues_json).includes('source_interpretation_updated')))
    const [[ledger]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
    assert.equal(Number(ledger.count), 0)
  } finally { await pool.end() }
})

test('MySQL 重新解析自动放弃旧 FinanceUpdate，不改变正式账本并可幂等重放', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'abandon')
    const content = fixtureWithSequence(701)
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '待放弃账单.csv', size: content.length }]
    }))
    objects.set(prepared.files[0].cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.files[0].importId,
      fileID: `cloud://synthetic.bucket/${prepared.files[0].cloudPath}`, timezoneOffsetMinutes: -480
    }))

    const selectedAgain = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '再次选择未入账账单.csv', size: content.length }]
    }))
    objects.set(selectedAgain.files[0].cloudPath, content)
    const reused = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: selectedAgain.files[0].importId,
      fileID: `cloud://synthetic.bucket/${selectedAgain.files[0].cloudPath}`, timezoneOffsetMinutes: -480
    }))
    assert.equal(reused.duplicateDisposition, 'reused_unposted')
    assert.equal(reused.reusedImportId, parsed.import.importId)
    assert.equal(reused.import.state, 'review_ready')
    assert.equal(reused.batch.batchId, parsed.batch.batchId)
    assert.equal(reused.duplicateImportId, undefined)

    const created = await createDraft(pool, context(user, {
      requestId: randomUUID(), batchIds: [reused.batch.batchId]
    }))
    let view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: created.updateId, version: created.version
    }))

    const issue = view.issues.find((item) => item.status === 'open')
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
      updateVersion: view.update.version, issueVersion: issue.version,
      decision: 'apply_fields',
      fields: { ledgerAccountDraft: { name: '替换时不创建', type: 'wallet', currency: 'CNY' } }
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    const [[before]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM catledger_accounts WHERE uid = ?) AS accounts,
         (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid = ?) AS mappings,
         (SELECT COUNT(*) FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL) AS transactions`,
      [user.uid, user.uid, user.uid]
    )

    const selectedDuringActiveUpdate = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '整理中再次选择.csv', size: content.length }]
    }))
    objects.set(selectedDuringActiveUpdate.files[0].cloudPath, content)
    const replacementRequest = {
      requestId: randomUUID(), importId: selectedDuringActiveUpdate.files[0].importId,
      fileID: `cloud://synthetic.bucket/${selectedDuringActiveUpdate.files[0].cloudPath}`,
      timezoneOffsetMinutes: -480
    }
    const resumable = await service.parseFile(context(user, replacementRequest))
    assert.equal(resumable.duplicateDisposition, 'replaced_unposted_update')
    assert.equal(resumable.replacedUpdateId, view.update.updateId)
    assert.equal(resumable.reusedImportId, parsed.import.importId)
    assert.equal(resumable.import.state, 'review_ready')
    assert.equal(resumable.batch.batchId, parsed.batch.batchId)
    assert.equal(resumable.duplicateImportId, undefined)
    assert.deepEqual(await service.parseFile(context(user, replacementRequest)), resumable)

    const replaced = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(replaced.update.status, 'abandoned')
    const [[replacementAction]] = await pool.execute(
      `SELECT action_type AS actionType, reason_codes_json AS reasonCodes
         FROM catledger_finance_actions
        WHERE uid = ? AND update_id = ? AND action_type = 'replace_unposted_update'
        LIMIT 1`,
      [user.uid, view.update.updateId]
    )
    assert.equal(replacementAction.actionType, 'replace_unposted_update')
    assert.deepEqual(
      typeof replacementAction.reasonCodes === 'string'
        ? JSON.parse(replacementAction.reasonCodes)
        : replacementAction.reasonCodes,
      ['unposted_update_replaced_by_reparse']
    )
    const [[replacementActionCount]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM catledger_finance_actions
        WHERE uid = ? AND update_id = ? AND action_type = 'replace_unposted_update'`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(replacementActionCount.count), 1)
    const [[after]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM catledger_accounts WHERE uid = ?) AS accounts,
         (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid = ?) AS mappings,
         (SELECT COUNT(*) FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL) AS transactions`,
      [user.uid, user.uid, user.uid]
    )
    assert.deepEqual(after, before)

    const restarted = await createDraft(pool, context(user, {
      requestId: randomUUID(), batchIds: [resumable.batch.batchId]
    }))
    assert.notEqual(restarted.updateId, view.update.updateId)
    assert.equal(restarted.status, 'draft')
  } finally {
    await pool.end()
  }
})

test('MySQL 多文件解析失败彼此隔离，成功来源仍可建立更新', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'isolated-files')
    const contents = [fixtureWithSequence(301), Buffer.from('not,a,supported,bill\n')]
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(),
      files: contents.map((content, index) => ({ fileName: `隔离-${index + 1}.csv`, size: content.length }))
    }))
    const results = []
    for (let index = 0; index < prepared.files.length; index += 1) {
      const file = prepared.files[index]
      objects.set(file.cloudPath, contents[index])
      results.push(await service.parseFile(context(user, {
        requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480
      })))
    }
    assert.equal(results[0].import.state, 'review_ready')
    assert.equal(results[1].import.state, 'failed')
    const update = await createDraft(pool, context(user, {
      requestId: randomUUID(), batchIds: [results[0].batch.batchId]
    }))
    const view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: update.updateId, version: update.version
    }))
    assert.equal(view.sources.length, 1)
    assert.equal(view.sources[0].importId, prepared.files[0].importId)
  } finally {
    await pool.end()
  }
})

test('MySQL 人工组合支付覆盖隔离、守恒、原子回滚、重试和整批撤销', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: { async downloadExact(fileID, key) { return objects.get(key) }, async remove() { return true } } })
  try {
    for (const nature of ['expense', 'repayment']) for (const activeIndex of [null, 0, 1]) {
      const user = await createUserLedger(pool, 'split-' + nature)
      const other = await createUserLedger(pool, 'split-foreign')
      const bankId = randomUUID(), debtId = randomUUID()
      await pool.execute(`INSERT INTO catledger_accounts (uid, account_id, type, nature, name, normalized_name, currency)
        VALUES (?, ?, 'bank', 'asset', '测试银行卡', '测试银行卡', 'CNY'), (?, ?, 'credit', 'liability', '测试欠款', '测试欠款', 'CNY')`,
      [user.uid, bankId, user.uid, debtId])
      const content = Buffer.from(['微信支付账单明细',
        '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号',
        '2026-09-01 12:00:00,商户消费,合成商户,合成商品,支出,10.00,零钱&招商银行储蓄卡(1234),支付成功,SYNTHETIC-SPLIT-' + randomUUID()
      ].join('\n'))
      const prepared = await service.prepareMany(context(user, { requestId: randomUUID(), files: [{ fileName: '合成组合支付.csv', size: content.length }] }))
      const file = prepared.files[0]; objects.set(file.cloudPath, content)
      const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480 }))
      let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
      let issue = view.issues.find(i => i.status === 'open')
      if (nature === 'expense') {
        await pool.execute("UPDATE catledger_economic_events SET field_sources_json = JSON_REMOVE(field_sources_json, '$.paymentComponents', '$.paymentSourceDirection') WHERE uid = ? AND update_id = ?", [user.uid, view.update.updateId])
      }
      const detail = await service.reviewIssueGet(context(user, { issueId: issue.issueId }))
      assert.equal(detail.update.version, view.update.version)
      const event = detail.members.find(m => m.event).event
      assert.equal(event.paymentComponents.filter(x => x.componentKind === 'financial').length, 2)
      const resolution = { version: 'payment-resolution-v1', nature, targetAccountId: nature === 'repayment' ? debtId : null,
        confirmedFromDetails: true, evidenceNote: '已核对合成付款详情', allocations: [
          { componentIndex: 0, accountId: user.accountId, amountMinor: '600' },
          { componentIndex: 1, accountId: bankId, amountMinor: '400' }
        ] }
      if (activeIndex != null) {
        resolution.version = 'payment-resolution-v2'
        resolution.allocations.forEach((item, index) => { item.amountMinor = index === activeIndex ? '1000' : '0' })
      }
      const accountRequest = { requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version, decision: 'apply_fields',
        fields: { paymentAccounts: resolution.allocations.map(({ componentIndex, accountId }) => ({ componentIndex, accountId })) } }
      const foreignAccounts = JSON.parse(JSON.stringify(accountRequest)); foreignAccounts.requestId = randomUUID(); foreignAccounts.fields.paymentAccounts[1].accountId = other.accountId
      await assert.rejects(service.reviewIssueResolve(context(user, foreignAccounts)), error => error.publicCode === 'VALIDATION_ERROR')
      view = await service.reviewIssueResolve(context(user, accountRequest))
      const accountRetry = await service.reviewIssueResolve(context(user, accountRequest))
      assert.equal(accountRetry.update.version, view.update.version)
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
      issue = view.issues.find(i => i.status === 'open')
      assert.equal(issue.issueType, 'shared_fields')
      const afterAccounts = await service.reviewIssueGet(context(user, { issueId: issue.issueId }))
      assert.equal(afterAccounts.members.find(m => m.event).event.paymentAccounts.length, 2)
      assert.equal(view.events.find(e => e.eventId === event.eventId).status, 'needs_action')
      const request = { requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version, decision: 'apply_fields', fields: { paymentResolution: resolution } }
      const foreign = JSON.parse(JSON.stringify(request)); foreign.requestId = randomUUID(); foreign.fields.paymentResolution.allocations[activeIndex === 1 ? 0 : 1].accountId = other.accountId
      await assert.rejects(service.reviewIssueResolve(context(user, foreign)), error => error.publicCode === 'VALIDATION_ERROR')
      const mismatch = JSON.parse(JSON.stringify(request)); mismatch.requestId = randomUUID(); mismatch.fields.paymentResolution.allocations[1].amountMinor = '401'
      await assert.rejects(service.reviewIssueResolve(context(user, mismatch)), error => error.publicCode === 'VALIDATION_ERROR')
      const saved = await service.reviewIssueResolve(context(user, request))
      assert.deepEqual(await service.reviewIssueResolve(context(user, request)), saved)
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
      view = await resolveOpenCategoryIssues(service, user, view)
      assert.equal(view.events[0].status, 'ready', JSON.stringify({ reasons: view.events[0].reasonCodes, issues: view.issues.filter(i => i.status === 'open').map(i => ({ type: i.issueType, reasons: i.reasonCodes })) }))
      const posting = { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version }
      const trigger = 'split_fail_' + randomUUID().replaceAll('-', '')
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON catledger_transactions FOR EACH ROW BEGIN
        IF NEW.uid = '${user.uid}' AND NEW.amount_minor = ${activeIndex == null ? 400 : 1000} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic failure'; END IF; END`)
      try {
        await assert.rejects(service.financeUpdatePost(context(user, posting)))
        const [[count]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
        assert.equal(Number(count.count), 0)
      } finally { await pool.query(`DROP TRIGGER ${trigger}`) }
      const posted = await service.financeUpdatePost(context(user, posting))
      assert.deepEqual(await service.financeUpdatePost(context(user, posting)), posted)
      const [rows] = await pool.execute('SELECT type, amount_minor AS amountMinor FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL ORDER BY amount_minor', [user.uid])
      assert.deepEqual(rows.map(r => String(r.amountMinor)), activeIndex == null ? ['400', '600'] : ['1000'])
      assert.ok(rows.every(r => r.type === (nature === 'expense' ? 'expense' : 'transfer')))
      const impact = await service.economicEventCorrectionImpact(context(user, { eventId: event.eventId }))
      assert.equal(impact.canCorrect, false)
      const undo = await service.financeUpdateUndoImpact(context(user, { updateId: view.update.updateId }))
      assert.equal(undo.canUndo, true)
      assert.equal(undo.createdTransactionCount, activeIndex == null ? 2 : 1)
      await service.financeUpdateUndo(context(user, { requestId: randomUUID(), updateId: view.update.updateId, version: posted.update.version, previewToken: undo.previewToken }))
      const [[remaining]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL', [user.uid])
      assert.equal(Number(remaining.count), 0)
    }
  } finally { await pool.end() }
})

test('MySQL 账户归组允许同一组合事件属于多个账户，识别先采后付目标并保留独立事件', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig()), objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: { async downloadExact(id, key) { return objects.get(key) }, async remove() { return true } } })
  try {
    const user = await createUserLedger(pool, 'account-groups'), other = await createUserLedger(pool, 'groups-other')
    const bankId = randomUUID(), debtId = randomUUID()
    await pool.execute(`INSERT INTO catledger_accounts (uid, account_id, type, nature, name, normalized_name, currency)
      VALUES (?, ?, 'bank', 'asset', '测试银行储蓄卡(1234)', '测试银行储蓄卡(1234)', 'CNY'),
      (?, ?, 'credit', 'liability', '1688先采后付', '1688先采后付', 'CNY')`, [user.uid, bankId, user.uid, debtId])
    const content = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单',
      '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
      '2026-09-01 12:00:00,信用借还,1688先采后付,先采后付账单付款,10.00,支出,测试银行储蓄卡(1234)&账户余额,交易成功,,GROUP-SPLIT,,,',
      '2026-09-02 12:00:00,餐饮美食,合成餐馆,午餐,2.00,支出,账户余额,交易成功,,GROUP-BALANCE,,,',
      '2026-09-03 12:00:00,餐饮美食,合成餐馆,晚餐,3.00,支出,测试银行储蓄卡(1234),交易成功,,GROUP-BANK,,,'
    ].join('\n'))
    const prepared = await service.prepareMany(context(user, { requestId: randomUUID(), files: [{ fileName: '合成账户分组.csv', size: content.length }] }))
    const file = prepared.files[0]; objects.set(file.cloudPath, content)
    const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId, fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480 }))
    let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
    assert.equal(view.freshness.requiresAccountGroupRefresh, true)
    const before = view.events.length
    const legacyIssue = view.issues.find(i => i.issueType === 'account_mapping' && (i.reasonCodes || []).includes('payment_components_ambiguous'))
    await service.reviewIssueResolve(context(user, { requestId: randomUUID(), updateId: view.update.updateId,
      issueId: legacyIssue.issueId, updateVersion: view.update.version, issueVersion: legacyIssue.version, decision: 'apply_fields',
      fields: { paymentAccounts: [{ componentIndex: 0, accountId: bankId }, { componentIndex: 1, accountId: user.accountId }] } }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    const request = { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version }
    await assert.rejects(service.reviewIssueRefreshAccountGroups(context(other, { ...request, requestId: randomUUID() })))
    view = await service.reviewIssueRefreshAccountGroups(context(user, request))
    assert.deepEqual(await service.reviewIssueRefreshAccountGroups(context(user, request)), view)
    assert.equal(view.events.length, before)
    const groups = view.issues.filter(i => i.issueType === 'account_mapping' && ['open', 'resolved'].includes(i.status))
    assert.equal(groups.length, 3, JSON.stringify({ events: view.events.length, groups: view.issues.map(i => ({ label: i.accountContext?.label, status: i.status, count: i.memberCount })) }))
    const wallet = groups.find(i => i.accountContext.label === '支付宝账户余额')
    const bank = groups.find(i => i.accountContext.label === '测试银行储蓄卡(1234)')
    const debt = groups.find(i => i.accountContext.label === '1688先采后付')
    assert.equal(wallet.memberCount, 2); assert.equal(bank.memberCount, 2); assert.equal(debt.memberCount, 1)
    const wd = await service.reviewIssueGet(context(user, { issueId: wallet.issueId }))
    const bd = await service.reviewIssueGet(context(user, { issueId: bank.issueId }))
    const overlap = wd.members.filter(m => m.event && bd.members.some(n => n.objectId === m.objectId))
    assert.equal(overlap.length, 1)
    const refreshed = await service.reviewIssueRefreshAccountGroups(context(user, { ...request, requestId: randomUUID(), version: view.update.version }))
    assert.equal(refreshed.update.version, view.update.version)
    assert.equal(refreshed.freshness.requiresAccountGroupRefresh, false)
    assert.equal(refreshed.freshness.viewRevision, view.freshness.viewRevision)
    const restored = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.deepEqual(restored.freshness, refreshed.freshness)
    await pool.execute('UPDATE catledger_accounts SET name = ?, version = version + 1 WHERE uid = ? AND account_id = ?', ['合成更名账户', user.uid, bankId])
    const renamed = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.notEqual(renamed.freshness.viewRevision, restored.freshness.viewRevision)
    assert.equal(renamed.update.version, restored.update.version)
    assert.equal(renamed.freshness.requiresAccountGroupRefresh, false)
    const partial = await service.financeUpdateGet(context(user, { updateId: view.update.updateId, includeEvents: false }))
    assert.equal(partial.freshness.requiresAccountGroupRefresh, null)
    view = await service.reviewIssueResolveAccountMappings(context(user, { requestId: randomUUID(), updateId: view.update.updateId,
      decisions: groups.filter(i => i.status === 'open').map(i => ({ issueId: i.issueId, operation: 'resolve', decision: 'apply_fields', fields: { ledgerAccountId: i === debt ? debtId : i === bank ? bankId : user.accountId } })) }))
    view = await service.financeUpdateGet(context(user, { updateId: request.updateId }))
    assert.equal(view.issues.filter(i => i.issueType === 'account_mapping' && i.status === 'open').length, 0)
    const combined = view.events.find(e => e.eventId === overlap[0].objectId)
    assert.equal(combined.paymentAccounts.length, 2)
    assert.equal(combined.counterpartyLedgerAccountId, debtId)
    assert.equal(combined.ledgerAccountId, null)
    assert.equal(combined.status, 'needs_action')
    for (const open of view.issues.filter(i => i.status === 'open')) {
      const detail = await service.reviewIssueGet(context(user, { issueId: open.issueId }))
      for (const member of detail.members.filter(m => m.event)) assert.equal(member.objectVersion, member.event.version)
    }
    const revisedGroup = view.issues.find(i => i.issueId === wallet.issueId)
    await service.reviewIssueResolveAccountMappings(context(user, { requestId: randomUUID(), updateId: request.updateId,
      decisions: [{ issueId: revisedGroup.issueId, operation: 'revise', decision: 'apply_fields', fields: { ledgerAccountId: user.accountId } }] }))
    const repeated = await service.financeUpdateGet(context(user, { updateId: request.updateId }))
    assert.equal(repeated.events.find(e => e.eventId === combined.eventId).paymentAccounts.length, 2)
    const [[count]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
    assert.equal(Number(count.count), 0)
  } finally { await pool.end() }
})

test('还款目标未在本批消费仍可补选或建草稿；资格、失败回滚、幂等和入账撤销贯通', { skip: !hasDatabase, timeout: 60000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = { async downloadExact(_, key) { return objects.get(key) }, async remove() { return true } }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    for (const candidateCount of [0, 1]) {
      const user = await createUserLedger(pool, 'allocation-coverage-' + candidateCount)
      const other = await createUserLedger(pool, 'allocation-foreign')
      await pool.execute("UPDATE catledger_accounts SET type = 'credit', nature = 'liability' WHERE uid = ? AND account_id = ?", [other.uid, other.accountId])
      const historyId = randomUUID()
      await pool.execute(`INSERT INTO catledger_accounts (uid, account_id, type, nature, name, normalized_name, currency)
        VALUES (?, ?, 'credit', 'liability', '合成历史花呗', '合成历史花呗', 'CNY')`, [user.uid, historyId])
      const content = Buffer.from(alipayAggregateRepaymentFixture().toString().split('\n').filter(line =>
        !line.includes('ALI-HUABEI-001') && (candidateCount || !line.includes('ALI-CREDIT-001'))).join('\n'))
      const prepared = await prepareSingle(service, context(user, { requestId: randomUUID(), fileName: '合成候选缺席.csv', size: content.length }))
      objects.set(prepared.cloudPath, content)
      const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: prepared.importId,
        fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480 }))
      let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
      view = await service.reviewIssueResolveAccountMappings(context(user, { requestId: randomUUID(), updateId: view.update.updateId,
        decisions: view.issues.filter(x => x.issueType === 'account_mapping' && x.status === 'open').map(issue => ({
          issueId: issue.issueId, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountDraft: {
            name: issue.accountContext.label, type: issue.accountContext.label.includes('储蓄卡') ? 'bank' : 'credit', currency: 'CNY'
          } }
        })) }))
      const issue = view.issues.find(x => x.status === 'open' && x.subject?.fundsProjection?.to.referenceKind === 'aggregate')
      assert.ok(issue)
      assert.equal(issue.subject.fundsProjection.to.candidates.length, candidateCount)
      const draftCount = view.accountDrafts.length
      const command = allocations => ({ requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version, decision: 'apply_fields', fields: { repaymentAllocations: allocations } })
      for (const id of [other.accountId, user.accountId, issue.subject.ledgerAccountId]) {
        await assert.rejects(service.reviewIssueResolve(context(user, command([{ accountId: id, amountMinor: '10000' }]))), { publicCode: 'VALIDATION_ERROR' })
      }
      await assert.rejects(service.reviewIssueResolve(context(user, command([
        { accountDraft: { name: '失败应回滚', type: 'credit', currency: 'CNY' }, amountMinor: '9999' }
      ]))), { publicCode: 'VALIDATION_ERROR' })
      const unchanged = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
      assert.equal(unchanged.update.version, view.update.version)
      assert.equal(unchanged.accountDrafts.length, draftCount)
      const payload = command([
        candidateCount ? { accountDraft: { name: '合成历史花呗', type: 'credit', currency: 'CNY' }, amountMinor: '6000' } : { accountId: historyId, amountMinor: '6000' },
        { accountDraft: { name: '合成未登记信用购', type: 'credit', currency: 'CNY' }, amountMinor: '4000' }
      ])
      await service.reviewIssueResolve(context(user, payload))
      await service.reviewIssueResolve(context(user, payload))
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
      assert.equal(view.accountDrafts.length, draftCount + 1)
      const targetId = view.accountDrafts.find(x => x.name === '合成未登记信用购').accountId
      const [[before]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
      assert.equal(Number(before.count), 0)
      const [[formal]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid = ? AND account_id = ?', [user.uid, targetId])
      assert.equal(Number(formal.count), 0)
      view = await resolveOpenCategoryIssues(service, user, view)
      assert.equal(view.issues.filter(x => x.status === 'open').length, 0)
      const trigger = 'allocation_fail_' + randomUUID().replaceAll('-', '')
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON catledger_transactions FOR EACH ROW
        BEGIN IF NEW.uid = '${user.uid}' AND NEW.amount_minor = 4000 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic allocation rollback'; END IF; END`)
      try {
        await assert.rejects(service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version, mode: 'all_ready' })))
        const [[empty]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [user.uid])
        assert.equal(Number(empty.count), 0)
      } finally { await pool.query(`DROP TRIGGER IF EXISTS ${trigger}`) }
      const posted = await service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version, mode: 'all_ready' }))
      const [transfers] = await pool.execute("SELECT destination_account_id AS target, amount_minor AS amount FROM catledger_transactions WHERE uid = ? AND type = 'transfer'", [user.uid])
      assert.deepEqual(transfers.map(x => x.target).sort(), [historyId, targetId].sort())
      assert.equal(transfers.reduce((sum, x) => sum + BigInt(x.amount), 0n), 10000n)
      const undo = await service.financeUpdateUndoImpact(context(user, { updateId: view.update.updateId }))
      assert.equal(undo.canUndo, true)
      await service.financeUpdateUndo(context(user, { requestId: randomUUID(), updateId: view.update.updateId, version: posted.update.version, previewToken: undo.previewToken }))
      const [[remaining]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL', [user.uid])
      assert.equal(Number(remaining.count), 0)
    }
  } finally { await pool.end() }
})
test('MySQL 整理真实成员与重复来源数量守恒且隔离用户', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) }, async remove() { return true }
  } })
  try {
    const user = await createUserLedger(pool, 'record-counts')
    const other = await createUserLedger(pool, 'record-counts-other')
    const contents = [fixtureWithSequence(701), Buffer.from(fixtureWithSequence(801).toString('utf8').replaceAll('801', '701'))]
    const prepared = await service.prepareMany(context(user, { requestId: randomUUID(),
      files: contents.map((content, i) => ({ fileName: '数量合成-' + i + '.csv', size: content.length })) }))
    const batchIds = []
    for (let i = 0; i < prepared.files.length; i += 1) {
      const file = prepared.files[i]
      objects.set(file.cloudPath, contents[i])
      const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
        fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }))
      batchIds.push(parsed.batch.batchId)
    }
    const view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds }))
    assert.equal(view.coverage.dataRows, 4)
    assert.equal(view.events.length, 3)
    const duplicates = view.events.reduce((sum, event) => sum + event.duplicateEvidenceCount, 0)
    assert.equal(duplicates, 1)
    assert.equal(view.events.length + duplicates, 4)
    const eventIds = new Set(view.events.map(event => event.eventId))
    const members = new Set(view.issues.filter(issue => issue.status === 'open').flatMap(issue => issue.subjectEventIds))
    assert.deepEqual([...members].sort(), [...eventIds].sort())
    for (const issue of view.issues) {
      assert.equal(issue.subjectEventIds.length, new Set(issue.subjectEventIds).size)
      assert.ok(issue.subjectEventIds.every(id => eventIds.has(id)))
    }
    const duplicateEvent = view.events.find(event => event.duplicateEvidenceCount)
    const evidence = await service.economicEventEvidence(context(user, { eventId: duplicateEvent.eventId }))
    assert.equal(evidence.evidence.filter(row => row.evidenceRole === 'duplicate').length, 1)
    await assert.rejects(service.financeUpdateGet(context(other, { updateId: view.update.updateId })), error => error.publicCode === 'NOT_FOUND')
  } finally { await pool.end() }
})


test('归属证据不足的还款：本人、他人支出与代垫待核对，隔离/回滚/幂等贯通', { skip: !hasDatabase, timeout: 60000 }, async () => {
  const pool = mysql.createPool(databaseConfig()), objects = new Map()
  const service = createImportService({ getPool: () => pool, storage: {
    async downloadExact(_, key) { return objects.get(key) }, async remove() { return true }
  } })
  try {
    for (const treatment of ['self', 'expense', 'pending']) {
      const user = await createUserLedger(pool, 'ownership-' + treatment)
      const stranger = await createUserLedger(pool, 'ownership-stranger-' + treatment)
      const content = Buffer.from([
        '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
        '支付宝账户: synth@example.invalid,,,,,,,,,,,',
        '起始日期: [2026-07-01 00:00:00] 终止日期: [2026-07-31 23:59:59],,,,,,,,,,,',
        '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
        '2026-07-20 09:00:00,信用借还,合成银行,信用卡还款,120.00,不计收支,账户余额,还款成功,,OWNERSHIP-001,,'
      ].join('\n'))
      const prepared = await service.prepareMany(context(user, { requestId: randomUUID(), files: [{ fileName: '合成还款.csv', size: content.length }] }))
      const file = prepared.files[0]; objects.set(file.cloudPath, content)
      const parsed = await service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
        fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }))
      let view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
      const updateId = view.update.updateId
      const account = view.issues.find(issue => issue.status === 'open' && issue.issueType === 'account_mapping')
      await service.reviewIssueResolveAccountMappings(context(user, { requestId: randomUUID(), updateId,
        decisions: [{ issueId: account.issueId, operation: 'resolve', decision: 'apply_fields', fields: { ledgerAccountId: user.accountId } }] }))
      view = await service.financeUpdateGet(context(user, { updateId }))
      await pool.execute("UPDATE catledger_economic_events SET reason_codes_json = '[\"repayment_account_required\"]' WHERE uid = ? AND update_id = ?", [user.uid, updateId])
      await pool.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v27' WHERE uid = ? AND update_id = ?", [user.uid, updateId])
      view = await service.financeUpdateOrganize(context(user, { requestId: randomUUID(), updateId, version: view.update.version }))
      const issue = view.issues.find(issue => issue.status === 'open' && issue.issueType === 'transfer_accounts')
      assert.equal(issue.primaryReasonCode, 'repayment_ownership_required')
      assert.ok(issue.subject.repaymentOwnershipRequired)
      const command = fields => ({ requestId: randomUUID(), updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version, decision: 'apply_fields', fields })
      await assert.rejects(service.reviewIssueResolve(context(user, command({ repaymentOwnership: { owner: 'self' }, counterpartyLedgerAccountId: stranger.accountId }))), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(service.reviewIssueResolve(context(user, command({ repaymentOwnership: { owner: 'other', treatment: 'expense' },
        counterpartyLedgerAccountDraft: { name: '不应保留的他人信用卡', type: 'credit', currency: 'CNY' } }))), { publicCode: 'VALIDATION_ERROR' })
      const unchanged = await service.financeUpdateGet(context(user, { updateId }))
      assert.equal(unchanged.update.version, view.update.version)
      assert.equal(unchanged.accountDrafts.length, view.accountDrafts.length)
      const fields = treatment === 'self' ? { repaymentOwnership: { owner: 'self' },
        counterpartyLedgerAccountDraft: { name: '我的合成信用卡', type: 'credit', currency: 'CNY' } }
        : { repaymentOwnership: { owner: 'other', treatment } }
      const payload = command(fields)
      await service.reviewIssueResolve(context(user, payload))
      await service.reviewIssueResolve(context(user, payload))
      view = await service.financeUpdateGet(context(user, { updateId }))
      assert.equal(view.events[0].repaymentOwnership.owner, treatment === 'self' ? 'self' : 'other')
      const confirmedOwnership = view.events[0].repaymentOwnership
      await pool.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v27' WHERE uid = ? AND update_id = ?", [user.uid, updateId])
      view = await service.financeUpdateOrganize(context(user, { requestId: randomUUID(), updateId, version: view.update.version }))
      assert.deepEqual(view.events[0].repaymentOwnership, confirmedOwnership)
      if (treatment === 'pending') {
        assert.equal(view.events[0].economicNature, 'unknown')
        assert.ok(view.issues.some(issue => issue.status === 'open' && issue.primaryReasonCode === 'repayment_other_treatment_required'))
        await assert.rejects(service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId, version: view.update.version, mode: 'all_ready' })))
      } else {
        assert.equal(view.accountDrafts.length, treatment === 'self' ? 1 : 0)
        view = await resolveOpenCategoryIssues(service, user, view)
        await service.financeUpdatePost(context(user, { requestId: randomUUID(), updateId, version: view.update.version, mode: 'all_ready' }))
        const [transactions] = await pool.execute('SELECT type, source_account_id AS sourceId, destination_account_id AS targetId, amount_minor AS amount FROM catledger_transactions WHERE uid = ?', [user.uid])
        assert.equal(transactions.length, 1)
        assert.equal(transactions[0].type, treatment === 'self' ? 'transfer' : 'expense')
        assert.equal(transactions[0].sourceId, user.accountId)
        assert.equal(Boolean(transactions[0].targetId), treatment === 'self')
        assert.equal(String(transactions[0].amount), '12000')
      }
      const [[foreign]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [stranger.uid])
      assert.equal(Number(foreign.count), 0)
    }
  } finally { await pool.end() }
})

require('./helpers/storage-compaction').registerStorageCompactionTests({
  hasDatabase, mysql, databaseConfig, createUserLedger, fixtureWithSequence, context, createImportService
})
