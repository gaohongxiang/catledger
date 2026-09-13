const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { encodeCursor, decodeCursor } = require('../src/view-cursor')
const { BUDGET, jsonBytes, ordinarySqlBudget } = require('../src/performance-contract')
const { createImportService } = require('../src/import-service')
const { hashWechatSubject } = require('../src/handler')
const { createObserver } = require('../../../scripts/performance-observer')

test('signed view cursor binds identity, filters and immutable view revision', () => {
  const scope = { uid: 'synthetic', updateId: 'update', kind: 'events', filter: { status: 'ready' }, viewVersion: 'v1' }
  const cursor = encodeCursor('server-only-subject', scope, 'last')
  assert.equal(decodeCursor('server-only-subject', cursor, scope), 'last')
  assert.throws(() => decodeCursor('other', cursor, scope), { publicCode: 'INVALID_CURSOR' })
  assert.throws(() => decodeCursor('server-only-subject', cursor, { ...scope, filter: {} }), { publicCode: 'INVALID_CURSOR' })
  assert.throws(() => decodeCursor('server-only-subject', cursor, { ...scope, viewVersion: 'v2' }), { publicCode: 'STALE_VIEW' })
})

const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])
test('V2 pages conserve hidden members; receipts stay immutable after posting; oversized evidence remains reachable', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const mysql = require('mysql2/promise'), env = process.env
  const pool = mysql.createPool({ host: env.CATLEDGER_TEST_DB_HOST, port: Number(env.CATLEDGER_TEST_DB_PORT || 3306),
    user: env.CATLEDGER_TEST_DB_USER, password: env.CATLEDGER_TEST_DB_PASSWORD, database: env.CATLEDGER_TEST_DB_NAME,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 1 })
  const observer = createObserver(pool), objects = new Map()
  let failLinkChunk = false, linkChunks = 0, loseCommitResponse = false, failLegacyRead = false
  const faultPool = { async getConnection() {
    const connection = await observer.pool.getConnection()
    return new Proxy(connection, { get(target, key) {
      if (key === 'execute') return async (sql, values) => {
        if (failLinkChunk && /INSERT INTO catledger_economic_event_transactions/.test(sql) && ++linkChunks === 2) throw new Error('synthetic chunk interruption')
        if (failLegacyRead && /FROM catledger_economic_events e\s/.test(sql)) throw Object.assign(new Error('synthetic read timeout'), { code: 'ETIMEDOUT' })
        return target.execute(sql, values)
      }
      if (key === 'commit') return async () => {
        await target.commit()
        if (loseCommitResponse) { loseCommitResponse = false; throw Object.assign(new Error('synthetic committed response lost'), { code: 'ECONNRESET' }) }
      }
      return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
    } })
  } }
  const service = createImportService({ getPool: () => faultPool, storage: { async downloadExact(_, key) { return objects.get(key) }, async remove() { return true } } })
  const uid = randomUUID(), accountId = randomUUID(), subjectHash = hashWechatSubject('synthetic-v2-' + uid)
  const context = data => ({ provider: 'wechat-mini', subjectHash, data })
  try {
    await pool.execute("INSERT INTO catledger_users (uid, status) VALUES (?, 'active')", [uid])
    await pool.execute("INSERT INTO catledger_user_identities (uid, provider, subject_hash) VALUES (?, 'wechat-mini', ?)", [uid, subjectHash])
    await pool.execute("INSERT INTO catledger_accounts (uid, account_id, type, nature, name, normalized_name, currency) VALUES (?, ?, 'wallet', 'asset', '合成分页账户', '合成分页账户', 'CNY')", [uid, accountId])
    const content = Buffer.from(['微信支付账单明细,,,,,,,,,,,', '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
      ...Array.from({ length: 121 }, (_, i) => `2026-09-01 12:00:00,商户消费,合成商户,合成商品,支出,1.00,微信零钱,支付成功,SYNTHETIC-PAGE-${i},,,`)].join('\n'))
    const prepared = await service.prepareMany(context({ requestId: randomUUID(), files: [{ fileName: '合成分页.csv', size: content.length }] }))
    const file = prepared.files[0]; objects.set(file.cloudPath, content)
    const parsed = await service.parseFile(context({ requestId: randomUUID(), importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }))
    const request = { requestId: randomUUID(), resultMode: 'receipt', batchIds: [parsed.batch.batchId] }
    observer.reset()
    const receipt = await service.financeUpdatePrepare(context(request))
    assert.ok(observer.snapshot().sqlCount <= ordinarySqlBudget('prepareUpdate', 121))
    assert.equal(receipt.kind, 'operation-receipt')
    assert.ok(jsonBytes(receipt) < BUDGET.receipt)
    const updateId = receipt.updateId
    const summary = await service.financeUpdateSummary(context({ updateId }))
    assert.equal((await service.capabilities(context({}))).workbenchVersion, 1)
    assert.ok(jsonBytes(summary) < BUDGET.summary)
    assert.equal(summary.coverage.dataRows, 121)
    assert.equal(summary.coverage.rowConservationPassed, true)
    assert.equal(summary.coverage.selectedEventsReadyToPost, false)
    assert.equal(summary.workbench.reviewStatusTabs[0].count, 121)
    assert.equal(summary.workbench.accountStepSummary.pending, 1)
    assert.equal((await service.reviewIssueList(context({ protocolVersion: 2, updateId, group: 'accounts' }))).total, 1)
    assert.equal((await service.economicEventList(context({ updateId, view: 'review_pending' }))).total, 121)
    const option = await service.financeUpdateOptions(context({ updateId, kind: 'accounts', query: '合成分页' }))
    assert.equal(option.items[0].accountId, accountId)
    assert.equal((await service.financeUpdateOptions(context({ updateId, kind: 'accounts', ids: [accountId] }))).total, 1)
    const dispositionPage = await service.financeUpdateRows(context({ updateId }))
    assert.equal(dispositionPage.items.length, 40); assert.equal(dispositionPage.total, 121)
    assert.ok(dispositionPage.items.every(row => row.disposition === 'needs_confirmation' && row.conflict === false))
    const first = await service.economicEventList(context({ updateId }))
    assert.equal(first.items.length, 40)
    assert.equal(first.total, 121)
    const all = first.items.slice(); let cursor = first.nextCursor
    while (cursor) {
      const next = await service.economicEventList(context({ updateId, cursor }))
      assert.equal(next.viewVersion, first.viewVersion); assert.ok(jsonBytes(next) < BUDGET.page)
      all.push(...next.items); cursor = next.nextCursor
    }
    assert.equal(all.length, 121); assert.equal(new Set(all.map(row => row.eventId)).size, 121)
    await assert.rejects(service.economicEventList(context({ updateId, cursor: first.nextCursor, status: 'ready' })), { publicCode: 'INVALID_CURSOR' })
    const issues = await service.reviewIssueList(context({ protocolVersion: 2, updateId, issueType: 'account_mapping', status: 'open' }))
    const issue = issues.items[0]
    assert.deepEqual(issue.subjectEventIds, [])
    assert.equal(issue.memberCount, 121)
    const members = await service.reviewIssueMembers(context({ updateId, issueId: issue.issueId }))
    assert.equal(members.items.length, 40); assert.equal(members.total, 121)
    await assert.rejects(service.financeUpdatePost(context({ resultMode: 'receipt', requestId: randomUUID(), updateId, version: receipt.appliedVersion })), { publicCode: 'UNRESOLVED_IMPORT' })
    const partial = await service.reviewIssueResolve(context({ resultMode: 'receipt', requestId: randomUUID(), updateId,
      updateVersion: summary.update.version, issueId: issue.issueId, issueVersion: issue.version,
      decision: 'exclude_events', selection: { mode: 'include', eventIds: [all[0].eventId] } }))
    const remaining = await service.reviewIssueGet(context({ protocolVersion: 2, issueId: issue.issueId }))
    assert.equal(remaining.issue.status, 'open'); assert.equal(remaining.total, 120)
    await assert.rejects(service.financeUpdatePost(context({ resultMode: 'receipt', requestId: randomUUID(), updateId, version: partial.appliedVersion })), { publicCode: 'UNRESOLVED_IMPORT' })
    observer.reset()
    const mapped = await service.reviewIssueResolveAccountMappings(context({ requestId: randomUUID(), resultMode: 'receipt', updateId, updateVersion: partial.appliedVersion,
      decisions: [{ issueId: issue.issueId, issueVersion: remaining.issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: accountId } }] }))
    assert.ok(observer.snapshot().sqlCount <= ordinarySqlBudget('resolveAccounts', 120))
    await assert.rejects(service.economicEventList(context({ updateId, cursor: first.nextCursor })), { publicCode: 'STALE_VIEW' })
    const mappedSummary = await service.financeUpdateSummary(context({ updateId }))
    assert.equal(mappedSummary.coverage.readySelectedEvents, 120)
    assert.equal(mappedSummary.workbench.finalSummary.expenseText, '¥120.00')
    assert.equal(mappedSummary.workbench.finalSummary.affectedAccountCount, 1)
    assert.equal(mappedSummary.workbench.reviewStatusTabs[0].count, 0)
    assert.equal((await service.economicEventList(context({ updateId, view: 'review_completed' }))).total, 120)
    assert.equal((await service.economicEventList(context({ updateId, view: 'expense', status: 'ready', accountId }))).total, 120)
    const affected = await service.financeUpdateOptions(context({ updateId, kind: 'affected_accounts' }))
    assert.equal(affected.items[0].count, 120)
    assert.equal((await service.financeUpdateOptions(context({ updateId, kind: 'new_accounts' }))).total, 0)
    const evidence = await service.economicEventEvidence(context({ protocolVersion: 2, eventId: all[0].eventId }))
    assert.equal(evidence.items[0].rawFields, undefined)
    const evidenceId = evidence.items[0].evidenceId
    const raw = { long: '合成长字段😀'.repeat(6000) }
    await pool.execute('UPDATE catledger_import_rows SET raw_fields_json = ? WHERE uid = ? AND row_id = ?', [JSON.stringify(raw), uid, evidence.items[0].rowId])
    let reconstructed = '', detailCursor = null
    do {
      const page = await service.economicEventDetail(context({ updateId, eventId: all[0].eventId, evidenceId, cursor: detailCursor }))
      assert.ok(jsonBytes(page) < BUDGET.page); reconstructed += page.part; detailCursor = page.nextCursor
    } while (detailCursor)
    assert.deepEqual(JSON.parse(reconstructed), raw)
    const postRequest = { resultMode: 'receipt', requestId: randomUUID(), updateId, version: mapped.appliedVersion }
    failLinkChunk = true
    await assert.rejects(service.financeUpdatePost(context(postRequest)), /synthetic chunk interruption/)
    const [[rolledBack]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [uid])
    assert.equal(Number(rolledBack.count), 0)
    assert.equal((await service.financeUpdateSummary(context({ updateId }))).update.version, mapped.appliedVersion)
    failLinkChunk = false; loseCommitResponse = true; observer.reset()
    const posted = await service.financeUpdatePost(context(postRequest))
    assert.ok(observer.snapshot().sqlCount <= ordinarySqlBudget('post', 120))
    assert.equal(posted.posting.createdTransactionCount, 120)
    assert.deepEqual(await service.financeUpdatePrepare(context(request)), receipt)
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => service.financeUpdatePost(context(postRequest))))
    assert.ok(concurrent.every(result => JSON.stringify(result) === JSON.stringify(posted)))
    const [[transactions]] = await pool.execute('SELECT COUNT(*) AS count, SUM(amount_minor) AS amount FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL', [uid])
    assert.equal(Number(transactions.count), 120); assert.equal(String(transactions.amount), '12000')
    const undoImpact = await service.financeUpdateUndoImpact(context({ updateId }))
    const undoRequest = { resultMode: 'receipt', requestId: randomUUID(), updateId, version: posted.appliedVersion, previewToken: undoImpact.previewToken }
    const undone = await service.financeUpdateUndo(context(undoRequest))
    assert.equal(undone.status, 'undone')
    assert.deepEqual(await service.financeUpdatePost(context(postRequest)), posted)
    assert.deepEqual(await service.financeUpdateUndo(context(undoRequest)), undone)
    const [[afterUndo]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL', [uid])
    assert.equal(Number(afterUndo.count), 0)

    // 旧小规模客户端提交后展示超时：返回已保存事实，原请求可恢复展示。
    const small = Buffer.from(content.toString().split('\n').slice(0, 4).join('\n').replaceAll('SYNTHETIC-PAGE', 'SYNTHETIC-LEGACY'))
    const smallFiles = await service.prepareMany(context({ requestId: randomUUID(), files: [{ fileName: '合成恢复.csv', size: small.length }] }))
    const smallFile = smallFiles.files[0]; objects.set(smallFile.cloudPath, small)
    const smallParsed = await service.parseFile(context({ requestId: randomUUID(), importId: smallFile.importId, fileID: 'cloud://synthetic.bucket/' + smallFile.cloudPath, timezoneOffsetMinutes: -480 }))
    const legacyRequest = { requestId: randomUUID(), batchIds: [smallParsed.batch.batchId] }
    failLegacyRead = true
    const saved = await service.financeUpdatePrepare(context(legacyRequest))
    assert.equal(saved.kind, 'operation-receipt'); assert.equal(saved.refreshRequired, true); assert.equal(saved.status, 'review')
    failLegacyRead = false
    const recovered = await service.financeUpdatePrepare(context(legacyRequest))
    assert.equal(recovered.update.updateId, saved.updateId); assert.equal(recovered.events.length, 2)

  } finally { await pool.end() }
})
