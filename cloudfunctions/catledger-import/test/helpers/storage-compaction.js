const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { randomUUID } = require('node:crypto')
const { splitSqlStatements } = require('../../../../migrations/runner')
const { digestIdempotencyKey, digestParts } = require('../../src/digest')
const { DRAFT_TABLES } = require('../../src/discarded-update')
const retired = ['catledger_import_transaction_links', 'catledger_import_decisions', 'catledger_import_postings', 'catledger_import_batch_issues']
const migration = fs.readFileSync(path.resolve(__dirname, '../../../../migrations/0012_compact_import_storage.sql'), 'utf8')

async function counts(pool, uid, updateId) {
  const result = {}
  for (const table of DRAFT_TABLES) {
    const [[row]] = await pool.execute(`SELECT COUNT(*) AS count FROM ${table} WHERE uid=? AND update_id=?`, [uid, updateId])
    result[table] = Number(row.count)
  }
  return result
}

async function historicalSchema(pool) {
  for (const filename of ['0004_single_file_import.sql', '0006_unified_finance_updates.sql']) {
    for (const statement of splitSqlStatements(fs.readFileSync(path.resolve(__dirname, '../../../../migrations', filename), 'utf8'))) {
      const match = statement.match(/^CREATE TABLE IF NOT EXISTS (catledger_\w+)/)
      if (match && retired.includes(match[1])) await pool.query(statement)
    }
  }
}

function registerStorageCompactionTests({ hasDatabase, mysql, databaseConfig, createUserLedger, fixtureWithSequence, context, createImportService }) {
  async function setup(sequence) {
    const pool = mysql.createPool(databaseConfig())
    const objects = new Map()
    const storage = { async downloadExact(_id, key) { return objects.get(key) }, async remove() { return true } }
    const service = createImportService({ getPool: () => pool, storage })
    const user = await createUserLedger(pool, 'compaction-'+sequence)
    async function upload(offset = 0) {
      const content = fixtureWithSequence(sequence + offset)
      const prepared = await service.prepareMany(context(user, { requestId: randomUUID(), files: [{ fileName: '合成精简账单.csv', size: content.length }] }))
      const file = prepared.files[0]
      objects.set(file.cloudPath, content)
      return service.parseFile(context(user, { requestId: randomUUID(), importId: file.importId,
        fileID: 'cloud://synthetic.bucket/'+file.cloudPath, timezoneOffsetMinutes: -480 }))
    }
    return { pool, service, user, storage, upload }
  }

  test('精简回执只存引用，解析不生成旧事件，废弃回收隔离且旧请求不复活草稿', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const { pool, service, user, upload } = await setup(8901)
    try {
      const parsed = await upload()
      const [[initial]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_economic_events WHERE uid=?', [user.uid])
      assert.equal(Number(initial.count), 0)
      const fileView = await service.getFile(context(user, { importId: parsed.import.importId, pageSize: 1 }))
      const next = await service.getFile(context(user, { importId: parsed.import.importId, pageSize: 1, cursor: fileView.nextCursor }))
      assert.equal(fileView.rows.length, 1); assert.equal(next.rows.length, 1)
      assert.notEqual(fileView.rows[0].rowId, next.rows[0].rowId)
      assert.equal(fileView.rows[0].eventId, undefined)
      const request = context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
      const view = await service.financeUpdatePrepare(request)
      const [[receipt]] = await pool.execute('SELECT result_json AS result FROM catledger_mutation_receipts WHERE uid=? AND idempotency_key_digest=?', [user.uid, digestIdempotencyKey(request.data.requestId)])
      assert.deepEqual(receipt.result, { receiptVersion: 1, kind: 'finance-update-view', updateId: view.update.updateId })
      assert.ok(Buffer.byteLength(JSON.stringify(receipt.result)) < 160)
      const before = await counts(pool, user.uid, view.update.updateId)
      assert.ok(before.catledger_economic_events > 0 && before.catledger_review_issue_members > 0)
      const other = await createUserLedger(pool, 'compaction-other')
      await assert.rejects(service.financeUpdateAbandon(context(other, { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version })), { publicCode: 'NOT_FOUND' })
      assert.deepEqual(await counts(pool, user.uid, view.update.updateId), before)
      const issue = view.issues.find(item => item.status === 'open')
      const resolveRequest = context(user, { requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        issueVersion: issue.version, updateVersion: view.update.version, decision: 'exclude_events' })
      const resolved = await service.reviewIssueResolve(resolveRequest)
      const [[issueReceipt]] = await pool.execute('SELECT result_json AS result FROM catledger_mutation_receipts WHERE uid=? AND idempotency_key_digest=?', [user.uid, digestIdempotencyKey(resolveRequest.data.requestId)])
      assert.equal(issueReceipt.result.kind, 'review-issue-view')
      assert.ok(Buffer.byteLength(JSON.stringify(issueReceipt.result)) < 220)
      const replay = await service.financeUpdatePrepare(request)
      assert.equal(replay.update.version, resolved.update.version)
      await assert.rejects(service.financeUpdatePrepare({ ...request, data: { ...request.data, batchIds: [randomUUID()] } }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
      await service.financeUpdateAbandon(context(user, { requestId: randomUUID(), updateId: replay.update.updateId, version: replay.update.version }))
      assert.ok(Object.values(await counts(pool, user.uid, replay.update.updateId)).every(count => count === 0))
      const repeated = await service.financeUpdatePrepare(request)
      assert.equal(repeated.update.status, 'abandoned'); assert.deepEqual(repeated.events, [])
      const retiredIssue = await service.reviewIssueResolve(resolveRequest)
      assert.equal(retiredIssue.update.status, 'abandoned'); assert.equal(retiredIssue.issue, null)
      const [[sourceCount]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_import_rows WHERE uid=?', [user.uid])
      assert.equal(Number(sourceCount.count), parsed.batch.summary.total)
      const [[accountCount]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid=?', [user.uid])
      assert.equal(Number(accountCount.count), 1)
    } finally { await pool.end() }
  })

  test('废弃清理中途失败回滚状态、草稿和回执，原请求可重试', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const { pool, service, user, storage, upload } = await setup(9001)
    try {
      const parsed = await upload()
      const view = await service.financeUpdatePrepare(context(user, { requestId: randomUUID(), batchIds: [parsed.batch.batchId] }))
      const before = await counts(pool, user.uid, view.update.updateId)
      let inject = true
      const getPool = () => ({ async getConnection() {
        const connection = await pool.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, args) => {
            if (inject && sql.startsWith('DELETE FROM catledger_review_issues')) {
              inject = false; throw new Error('synthetic cleanup interruption')
            }
            return target.execute(sql, args)
          }
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
        } })
      } })
      const failing = createImportService({ getPool, storage })
      const request = context(user, { requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version })
      await assert.rejects(failing.financeUpdateAbandon(request), /synthetic cleanup interruption/)
      assert.deepEqual(await counts(pool, user.uid, view.update.updateId), before)
      assert.equal((await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))).update.status, 'review')
      const result = await service.financeUpdateAbandon(request)
      assert.equal(result.status, 'abandoned')
      assert.ok(Object.values(await counts(pool, user.uid, view.update.updateId)).every(count => count === 0))
    } finally { await pool.end() }
  })

  test('0012迁移保留旧已入账交易和来源，压缩历史回执，清理后中断可重入至25张表', { skip: !hasDatabase, timeout: 30000 }, async () => {
    const { pool, service, user, upload } = await setup(9101)
    let connection
    try {
      await historicalSchema(pool)
      const parsed = await upload()
      const [rows] = await pool.execute('SELECT row_id AS rowId, normalized_amount_minor AS amount FROM catledger_import_rows WHERE uid=? AND batch_id=? ORDER BY source_row_number', [user.uid, parsed.batch.batchId])
      const eventId = randomUUID(), transactionId = randomUUID(), postingId = randomUUID(), linkId = randomUUID()
      await pool.execute(`INSERT INTO catledger_economic_events (uid,event_id,batch_id,event_type,state,event_core_digest,rule_version)
        VALUES (?,?,?,'expense','posted',?,'synthetic-legacy')`, [user.uid,eventId,parsed.batch.batchId,digestParts(eventId)])
      await pool.execute(`INSERT INTO catledger_event_evidence (uid,event_id,row_id,evidence_role,relation_rule_version)
        VALUES (?,?,?,'primary','synthetic-legacy')`, [user.uid,eventId,rows[0].rowId])
      await pool.execute(`INSERT INTO catledger_transactions (uid,transaction_id,type,source_account_id,category_id,amount_minor,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,origin)
        VALUES (?,?,'expense',?,?,?,'2026-08-01','2026-08-01 12:00:00',-480,'2026-08-01 04:00:00','import')`,
        [user.uid,transactionId,user.accountId,user.categoryId,rows[0].amount])
      await pool.execute(`INSERT INTO catledger_import_decisions (uid,decision_id,event_id,decision_version,disposition,decision_origin,reason_code,account_id,category_id,decision_digest)
        VALUES (?,?,?,1,'post','manual','synthetic_migration',?,?,?)`, [user.uid,randomUUID(),eventId,user.accountId,user.categoryId,digestParts(eventId)])
      await pool.execute(`INSERT INTO catledger_import_postings (uid,posting_id,import_id,request_digest,state,selected_event_count,created_transaction_count,completed_at)
        VALUES (?,?,?,?,'completed',1,1,CURRENT_TIMESTAMP(3))`, [user.uid,postingId,parsed.import.importId,digestParts(postingId)])
      await pool.execute(`INSERT INTO catledger_import_transaction_links (uid,link_id,posting_id,event_id,row_id,transaction_id,relation_role,creation_method,rule_version)
        VALUES (?,?,?,?,?,?,'primary','created','synthetic-legacy')`, [user.uid,linkId,postingId,eventId,rows[0].rowId,transactionId])
      await pool.execute("UPDATE catledger_import_files SET state='committed' WHERE uid=? AND import_id=?",[user.uid,parsed.import.importId])
      await pool.execute("UPDATE catledger_import_batches SET state='committed' WHERE uid=? AND batch_id=?",[user.uid,parsed.batch.batchId])
      const second = await upload(1)
      const request = context(user,{ requestId:randomUUID(),batchIds:[second.batch.batchId] })
      const abandoned = await service.financeUpdatePrepare(request)
      await pool.execute("UPDATE catledger_finance_updates SET status='abandoned' WHERE uid=? AND update_id=?", [user.uid,abandoned.update.updateId])
      await pool.execute('UPDATE catledger_mutation_receipts SET result_json=? WHERE uid=? AND idempotency_key_digest=?',
        [JSON.stringify({...abandoned,extra:'x'.repeat(200000)}),user.uid,digestIdempotencyKey(request.data.requestId)])
      const [before] = await pool.execute('SELECT * FROM catledger_transactions WHERE uid=?',[user.uid])
      const [[beforeRows]] = await pool.execute('SELECT COUNT(*) AS count FROM catledger_import_rows WHERE uid=?',[user.uid])
      connection = await pool.getConnection()
      const statements=splitSqlStatements(migration)
      let interrupted=false
      for(const statement of statements) {
        await connection.query(statement)
        if(statement.startsWith('DROP TABLE')) { interrupted=true; break }
      }
      assert.equal(interrupted,true)
      for(const statement of statements) await connection.query(statement)
      assert.deepEqual((await pool.execute('SELECT * FROM catledger_transactions WHERE uid=?',[user.uid]))[0],before)
      const [[linked]]=await pool.execute('SELECT COUNT(*) AS count FROM catledger_economic_event_transactions WHERE uid=? AND event_id=? AND transaction_id=?',[user.uid,eventId,transactionId])
      assert.equal(Number(linked.count),1)
      const [[updates]]=await pool.execute('SELECT COUNT(*) AS count FROM catledger_finance_updates WHERE uid=?',[user.uid])
      assert.equal(Number(updates.count),2,'只给旧入账文件补批次，不重建现代批次')
      const [[afterRows]]=await pool.execute('SELECT COUNT(*) AS count FROM catledger_import_rows WHERE uid=?',[user.uid])
      assert.equal(Number(afterRows.count),Number(beforeRows.count))
      const [[tableCount]]=await pool.query("SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name LIKE 'catledger_%' AND column_name='uid'")
      assert.equal(Number(tableCount.count),25)
      assert.ok(Object.values(await counts(pool,user.uid,abandoned.update.updateId)).every(count=>count===0))
      const [[receipt]]=await pool.execute('SELECT result_json AS result FROM catledger_mutation_receipts WHERE uid=? AND idempotency_key_digest=?',[user.uid,digestIdempotencyKey(request.data.requestId)])
      assert.equal(receipt.result.kind,'finance-update-view'); assert.ok(JSON.stringify(receipt.result).length<160)
      assert.equal((await service.financeUpdatePrepare(request)).update.status,'abandoned')
      for(const statement of statements) await connection.query(statement)
      assert.deepEqual((await pool.execute('SELECT * FROM catledger_transactions WHERE uid=?',[user.uid]))[0],before)
    } finally {
      if(connection) connection.release()
      for(const table of retired) await pool.query('DROP TABLE IF EXISTS '+table)
      await pool.end()
    }
  })
}

module.exports={registerStorageCompactionTests}
