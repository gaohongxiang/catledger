const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { splitSqlStatements } = require('../migrations/runner')
const { localServices, call, syntheticBill } = require('./helpers/local-services')

test('账单改名：真实解析、最小权限、并发恢复与来源保全', {
  skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000
}, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    async function setup() {
      const subject = 'synthetic-file-rename-' + randomUUID()
      const services = localServices({ apiPool, importPool, subject })
      const api = (action, data) => call(services.api, action, data)
      const imp = (action, data) => call(services.import, action, data)
      const { uid } = await api('bootstrap')
      const content = syntheticBill(2, 'SYNTHETIC-FILE-RENAME-' + randomUUID())
      const c = { uid, subject, services, api, imp, content }
      c.prepare = async ({ fileName = '合成账单原名.csv', displayName, bytes = content } = {}) => {
        const file = (await imp('imports.prepareMany', { requestId: randomUUID(), files: [{
          fileName, size: bytes.length, ...(displayName === undefined ? {} : { displayName })
        }] })).files[0]
        services.objects.set(file.cloudPath, bytes)
        return file
      }
      c.parse = file => imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
        fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
      c.get = async importId => (await imp('imports.getFile', { importId, includeOptions: false })).import
      c.rename = input => imp('imports.renameFile', input)
      c.renameTo = async (importId, displayName) => c.rename({ requestId: randomUUID(), importId,
        version: (await c.get(importId)).version, displayName })
      c.recover = requestId => imp('imports.commandResult', { requestId, commandAction: 'imports.renameFile' })
      c.update = async batchId => (await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [batchId] })).updateId
      c.summary = updateId => imp('financeUpdates.summary', { updateId })
      c.fileFacts = async importId => (await lab.owner.execute(`SELECT state, original_file_name, declared_size, actual_size,
        file_extension, mime_type, content_sha256, storage_object_key, cloud_file_id, error_code, content_deleted_at
        FROM catledger_import_files WHERE uid = ? AND import_id = ?`, [uid, importId]))[0][0]
      c.provenance = async () => {
        const result = {}
        for (const [table, key] of [['catledger_import_rows', 'row_id'], ['catledger_import_batches', 'batch_id'],
          ['catledger_source_identities', 'identity_id'], ['catledger_finance_update_sources', 'source_id'],
          ['catledger_economic_events', 'event_id'], ['catledger_event_evidence', 'evidence_id'],
          ['catledger_transactions', 'transaction_id'], ['catledger_accounts', 'account_id']]) {
          result[table] = (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid = ? ORDER BY ${key}`, [uid]))[0]
        }
        return result
      }
      c.sourceIdentity = async () => {
        const [rows] = await lab.owner.execute(`SELECT row_id, batch_id, identity_id, observed_identity_key,
          observed_core_digest, raw_fields_json, semantic_json FROM catledger_import_rows WHERE uid = ? ORDER BY row_id`, [uid])
        const [identities] = await lab.owner.execute(`SELECT identity_id, identity_key, core_digest
          FROM catledger_source_identities WHERE uid = ? ORDER BY identity_id`, [uid])
        return { rows, identities }
      }
      c.references = async importId => (await lab.owner.execute(`SELECT u.update_id AS updateId, u.version, u.status
        FROM catledger_finance_updates u JOIN catledger_finance_update_sources s ON s.uid = u.uid AND s.update_id = u.update_id
        WHERE u.uid = ? AND s.import_id = ? ORDER BY u.update_id`, [uid, importId]))[0]
      c.post = async updateId => {
        const accountId = (await api('accounts.create', { requestId: randomUUID(), type: 'wallet', name: '合成改名验收零钱',
          openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        const issues = (await imp('reviewIssues.list', { updateId, group: 'accounts' })).items.filter(issue => issue.status === 'open')
        assert.ok(issues.length)
        await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId,
          updateVersion: (await c.summary(updateId)).update.version, decisions: issues.map(issue => ({
            issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields',
            fields: { mappingAccountId: accountId }
          })) })
        const result = await imp('financeUpdates.post', { requestId: randomUUID(), updateId,
          version: (await c.summary(updateId)).update.version })
        assert.equal(result.posting.createdTransactionCount, 2)
        assert.equal((await api('accounts.list')).accounts.find(account => account.accountId === accountId).bookBalanceMinor, '99800')
        return accountId
      }
      return c
    }

    await t.test('解析前后改名持久化且原名不变；0033直接重复执行保留别名与未改名记录默认值', async () => {
      const c = await setup(), file = await c.prepare()
      const initial = await c.get(file.importId), before = await c.fileFacts(file.importId)
      assert.equal(initial.fileName, file.fileName); assert.equal(Object.hasOwn(initial, 'displayName'), false)
      const renamed = await c.renameTo(file.importId, '合成九月账单.csv')
      assert.equal(renamed.protocolVersion, 2); assert.equal(renamed.kind, 'file-receipt')
      assert.equal(renamed.action, 'imports.renameFile'); assert.ok(renamed.receiptId)
      assert.equal(renamed.import.fileName, file.fileName); assert.equal(renamed.import.displayName, '合成九月账单.csv')
      assert.equal(renamed.import.version, initial.version + 1)
      assert.deepEqual(await c.fileFacts(file.importId), before)
      const parsed = await c.parse(file)
      assert.ok(parsed.batch); assert.equal(parsed.import.displayName, '合成九月账单.csv')
      const parsedFacts = await c.fileFacts(file.importId), provenance = await c.provenance()
      const second = await c.renameTo(file.importId, '  合成９月已解析.csv  ')
      assert.equal(second.import.displayName, '合成9月已解析.csv')
      assert.equal((await c.get(file.importId)).displayName, second.import.displayName)
      assert.deepEqual(await c.fileFacts(file.importId), parsedFacts)
      assert.deepEqual(await c.provenance(), provenance)
      assert.equal(parsedFacts.content_sha256, createHash('sha256').update(c.content).digest('hex'))
      assert.deepEqual(c.services.objects.get(file.cloudPath), c.content)
      const original = await c.prepare({ fileName: '合成无别名旧记录.csv' })
      const connection = await lab.owner.getConnection()
      try {
        const sql = await readFile(path.resolve(__dirname, '../migrations/0033_import_file_display_name.sql'), 'utf8')
        for (let i = 0; i < 2; i++) for (const statement of splitSqlStatements(sql)) await connection.query(statement)
      } finally { connection.release() }
      assert.equal((await c.get(file.importId)).displayName, '合成9月已解析.csv')
      const [[untouched]] = await lab.owner.execute('SELECT display_name FROM catledger_import_files WHERE uid = ? AND import_id = ?', [c.uid, original.importId])
      assert.equal(untouched.display_name, null)
      assert.equal(Object.hasOwn(await c.get(original.importId), 'displayName'), false)
    })

    await t.test('排队时显式名称随真实解析保存，非法队列名称整批回滚', async () => {
      const c = await setup(), file = await c.prepare({ fileName: '合成排队原名.csv', displayName: '合成队列显示名.csv' })
      assert.equal(file.fileName, '合成排队原名.csv'); assert.equal(file.displayName, '合成队列显示名.csv')
      const parsed = await c.parse(file)
      assert.equal(parsed.import.displayName, file.displayName)
      const updateId = await c.update(parsed.batch.batchId), source = (await c.summary(updateId)).sources[0]
      assert.equal(source.fileName, file.displayName); assert.equal(source.originalFileName, file.fileName)
      const [[before]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_files WHERE uid = ?', [c.uid])
      await assert.rejects(c.imp('imports.prepareMany', { requestId: randomUUID(), files: [
        { fileName: '合成批量有效.csv', size: c.content.length, displayName: '合成有效名称.csv' },
        { fileName: '合成批量无效.csv', size: c.content.length, displayName: '合成错误格式.xlsx' }
      ] }), { publicCode: 'VALIDATION_ERROR' })
      const [[after]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_files WHERE uid = ?', [c.uid])
      assert.equal(Number(after.n), Number(before.n))
    })

    await t.test('提交后丢响应可从回执恢复；并发重试只改一次，旧请求不回滚后来的名称', async () => {
      const c = await setup(), file = await c.prepare()
      const request = { requestId: randomUUID(), importId: file.importId, version: file.version, displayName: '合成首次名称.csv' }
      await assert.rejects(async () => { await c.rename(request); throw new Error('synthetic-response-lost') }, { message: 'synthetic-response-lost' })
      const fresh = localServices({ apiPool, importPool, subject: c.subject, objects: c.services.objects })
      const receipt = await call(fresh.import, 'imports.commandResult', { requestId: request.requestId, commandAction: 'imports.renameFile' })
      assert.equal(receipt.import.displayName, request.displayName); assert.equal(receipt.import.version, 2)
      const replays = await Promise.all([c.rename(request), c.rename(request), c.recover(request.requestId)])
      replays.forEach(value => assert.deepEqual(value, receipt))
      assert.equal((await c.get(file.importId)).version, 2)
      await c.renameTo(file.importId, '合成后来名称.csv')
      const latest = await c.get(file.importId)
      assert.equal(latest.version, 3)
      assert.deepEqual(await c.rename(request), receipt)
      assert.deepEqual(await c.get(file.importId), latest)
      await assert.rejects(c.rename({ ...request, displayName: '合成同请求篡改.csv' }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
      await assert.rejects(c.recover(randomUUID()), { publicCode: 'OPERATION_UNCONFIRMED' })
      const [[receipts]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_mutation_receipts WHERE uid = ? AND action = 'imports.renameFile'", [c.uid])
      assert.equal(Number(receipts.n), 2)
    })

    await t.test('同版本不同请求并发只有一个成功，旧版本和失败请求均不能覆盖名称', async () => {
      const c = await setup(), file = await c.prepare()
      const requests = ['合成并发甲.csv', '合成并发乙.csv'].map(displayName => ({ requestId: randomUUID(),
        importId: file.importId, version: file.version, displayName }))
      const results = await Promise.allSettled(requests.map(c.rename))
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      const loser = results.findIndex(result => result.status === 'rejected')
      assert.equal(results[loser].reason.publicCode, 'CONFLICT')
      const winner = results[1 - loser].value
      assert.equal(winner.import.version, 2)
      assert.equal((await c.get(file.importId)).displayName, requests[1 - loser].displayName)
      await assert.rejects(c.rename({ ...requests[loser], requestId: randomUUID() }), { publicCode: 'CONFLICT' })
      await assert.rejects(c.recover(requests[loser].requestId), { publicCode: 'OPERATION_UNCONFIRMED' })
      assert.deepEqual(await c.rename(requests[1 - loser]), winner)
      assert.equal((await c.get(file.importId)).version, 2)
    })

    await t.test('空名、过长、路径、控制字符和改后缀拒绝；最大合法名称可保存并可恢复原名', async () => {
      const c = await setup(), file = await c.prepare(), before = await c.get(file.importId)
      for (const displayName of ['', '   ', '.csv', '..csv', '合成.xlsx', '合成.csv.exe', '../合成.csv',
        '合成/账单.csv', '合成\\账单.csv', '合成\n.csv', '合成\u0000.csv', '合成\u0085.csv', '名'.repeat(252) + '.csv', null, 123]) {
        await assert.rejects(c.rename({ requestId: randomUUID(), importId: file.importId, version: before.version, displayName }),
          { publicCode: 'VALIDATION_ERROR' })
      }
      assert.deepEqual(await c.get(file.importId), before)
      const boundary = '名'.repeat(251) + '.csv'
      assert.equal((await c.renameTo(file.importId, boundary)).import.displayName, boundary)
      await c.renameTo(file.importId, file.fileName)
      const restored = await c.get(file.importId)
      assert.equal(Object.hasOwn(restored, 'displayName'), false); assert.equal(restored.fileName, file.fileName)
      const discarded = await c.imp('imports.discardFile', { requestId: randomUUID(), importId: file.importId, version: restored.version })
      assert.equal(discarded.state, 'discarded')
      await assert.rejects(c.renameTo(file.importId, '合成废弃文件.csv'), { publicCode: 'CONFLICT' })
      const failedFile = await c.prepare({ bytes: Buffer.from('合成未知来源,无法解析\n合成数据,1') })
      const failed = await c.parse(failedFile)
      assert.equal(failed.import.state, 'failed')
      const failedFacts = await c.fileFacts(failedFile.importId)
      const renamed = await c.renameTo(failedFile.importId, '合成待重新解析.csv')
      assert.equal(renamed.import.state, 'failed'); assert.equal(renamed.import.errorCode, failed.import.errorCode)
      assert.deepEqual(await c.fileFacts(failedFile.importId), failedFacts)
    })

    await t.test('服务端用户隔离：伪造uid不能读改他人文件或恢复回执，同请求号可由各用户独立使用', async () => {
      const c = await setup(), other = await setup(), file = await c.prepare(), own = await other.prepare()
      const requestId = randomUUID()
      const receipt = await c.rename({ requestId, importId: file.importId, version: 1, displayName: '合成甲的名称.csv' })
      await assert.rejects(other.imp('imports.getFile', { uid: c.uid, importId: file.importId }), { publicCode: 'INVALID_REQUEST' })
      await assert.rejects(other.rename({ uid: c.uid, requestId, importId: file.importId, version: receipt.import.version,
        displayName: '合成越权名称.csv' }), { publicCode: 'INVALID_REQUEST' })
      await assert.rejects(other.get(file.importId), { publicCode: 'NOT_FOUND' })
      await assert.rejects(other.rename({ requestId, importId: file.importId, version: receipt.import.version,
        displayName: '合成越权名称.csv' }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(other.recover(requestId), { publicCode: 'OPERATION_UNCONFIRMED' })
      const otherReceipt = await other.rename({ requestId, importId: own.importId, version: 1, displayName: '合成乙的名称.csv' })
      assert.equal(otherReceipt.import.importId, own.importId)
      assert.equal((await c.get(file.importId)).displayName, '合成甲的名称.csv')
      assert.equal((await other.get(own.importId)).displayName, '合成乙的名称.csv')
      assert.deepEqual(await c.recover(requestId), receipt)
      assert.deepEqual(await other.recover(requestId), otherReceipt)
    })

    await t.test('来源摘要、事件、证据与已入账历史统一显示别名；旧视图失效，来源快照、内容及余额不变', async () => {
      const c = await setup(), file = await c.prepare(), parsed = await c.parse(file)
      const updateId = await c.update(parsed.batch.batchId), initial = await c.summary(updateId)
      const page = await c.imp('economicEvents.list', { updateId, pageSize: 1 })
      assert.ok(page.nextCursor); assert.equal(initial.sources[0].fileName, file.fileName)
      assert.equal(Object.hasOwn(initial.sources[0], 'originalFileName'), false)
      const eventId = page.items[0].eventId
      const initialEvidence = await c.imp('economicEvents.evidence', { updateId, eventId })
      assert.equal(initialEvidence.items[0].fileName, file.fileName)
      assert.equal(Object.hasOwn(initialEvidence.items[0], 'originalFileName'), false)
      async function verifyDisplay(displayName) {
        const summary = await c.summary(updateId)
        assert.equal(summary.sources[0].fileName, displayName); assert.equal(summary.sources[0].originalFileName, file.fileName)
        const events = await c.imp('economicEvents.list', { updateId })
        assert.equal(events.total, 2); assert.ok(events.items.every(event => event.primaryEvidence.fileName === displayName))
        const evidence = await c.imp('economicEvents.evidence', { updateId, eventId })
        assert.equal(evidence.items[0].fileName, displayName); assert.equal(evidence.items[0].originalFileName, file.fileName)
        return summary
      }
      const before = await c.provenance(), fileFacts = await c.fileFacts(file.importId)
      await c.renameTo(file.importId, '合成整理中名称.csv')
      const renamed = await verifyDisplay('合成整理中名称.csv')
      assert.equal(renamed.update.version, initial.update.version + 1); assert.notEqual(renamed.viewVersion, initial.viewVersion)
      await assert.rejects(c.imp('economicEvents.list', { updateId, viewVersion: page.viewVersion }), { publicCode: 'STALE_VIEW' })
      await assert.rejects(c.imp('economicEvents.list', { updateId, pageSize: 1, cursor: page.nextCursor }), { publicCode: 'STALE_VIEW' })
      await assert.rejects(c.imp('economicEvents.evidence', { updateId, eventId, viewVersion: initialEvidence.viewVersion }), { publicCode: 'STALE_VIEW' })
      assert.deepEqual(await c.fileFacts(file.importId), fileFacts); assert.deepEqual(await c.provenance(), before)
      assert.deepEqual(c.services.objects.get(file.cloudPath), c.content)
      await c.post(updateId)
      const posted = await c.summary(updateId), postedFacts = await c.fileFacts(file.importId), postedData = await c.provenance()
      assert.equal(posted.update.status, 'posted'); assert.equal(postedFacts.state, 'committed')
      assert.deepEqual((await c.imp('financeUpdates.list')).items.find(item => item.updateId === updateId).files, ['合成整理中名称.csv'])
      await c.renameTo(file.importId, '合成已入账名称.csv')
      const final = await verifyDisplay('合成已入账名称.csv')
      assert.equal(final.update.version, posted.update.version + 1)
      const history = (await c.imp('financeUpdates.list')).items.find(item => item.updateId === updateId)
      assert.deepEqual(history.files, ['合成已入账名称.csv']); assert.equal(history.transactionCount, 2)
      assert.equal(history.version, final.update.version)
      assert.deepEqual(await c.fileFacts(file.importId), postedFacts); assert.deepEqual(await c.provenance(), postedData)
      const identity = await c.sourceIdentity()
      const duplicate = await c.prepare({ fileName: '合成已入账重复上传.csv', displayName: '合成不能覆盖已入账别名.csv' })
      const duplicateResult = await c.parse(duplicate)
      assert.equal(duplicateResult.duplicateDisposition, 'already_posted'); assert.equal(duplicateResult.duplicateImportId, file.importId)
      assert.equal(duplicateResult.batch, null)
      assert.equal((await c.get(file.importId)).displayName, '合成已入账名称.csv')
      assert.deepEqual(await c.sourceIdentity(), identity)
      assert.equal((await c.api('transactions.list', { month: '2026-09' })).transactions.length, 2)
      assert.deepEqual(await c.provenance(), postedData)
    })

    await t.test('未入账内容去重复用canonical身份；显式别名迁移并保留原后缀，无别名保留旧称，所有引用版本同步', async () => {
      const c = await setup(), file = await c.prepare({ fileName: '合成规范原名.CSV', displayName: '合成原有别名.CSV' })
      const parsed = await c.parse(file), identity = await c.sourceIdentity(), facts = await c.fileFacts(file.importId)
      const firstId = await c.update(parsed.batch.batchId)
      const noAlias = await c.prepare({ fileName: '合成无别名重复.csv' }), reused = await c.parse(noAlias)
      assert.equal(reused.reusedImportId, file.importId); assert.equal(reused.import.importId, file.importId)
      assert.equal(reused.batch.batchId, parsed.batch.batchId); assert.equal(reused.replacedUpdateId, firstId)
      assert.equal(reused.import.displayName, '合成原有别名.CSV')
      const secondId = await c.update(reused.batch.batchId)
      const explicit = await c.prepare({ fileName: '合成有别名重复.csv', displayName: '合成显式新名称.csv' })
      const replaced = await c.parse(explicit)
      assert.equal(replaced.reusedImportId, file.importId); assert.equal(replaced.replacedUpdateId, secondId)
      assert.equal(replaced.batch.batchId, parsed.batch.batchId)
      assert.equal(replaced.import.fileName, '合成规范原名.CSV'); assert.equal(replaced.import.displayName, '合成显式新名称.CSV')
      assert.deepEqual(await c.sourceIdentity(), identity); assert.deepEqual(await c.fileFacts(file.importId), facts)
      const thirdId = await c.update(replaced.batch.batchId), before = await c.references(file.importId)
      assert.equal(before.length, 3)
      await c.renameTo(file.importId, '合成所有引用新名称.CSV')
      const after = await c.references(file.importId)
      for (const row of after) {
        assert.equal(Number(row.version), Number(before.find(prior => prior.updateId === row.updateId).version) + 1)
        const source = (await c.summary(row.updateId)).sources[0]
        assert.equal(source.fileName, '合成所有引用新名称.CSV'); assert.equal(source.originalFileName, file.fileName)
      }
      assert.equal(after.find(row => row.updateId === thirdId).status, 'review')
      const duplicateFile = await c.get(explicit.importId)
      assert.equal(duplicateFile.state, 'duplicate')
      await c.renameTo(explicit.importId, '合成冗余副本名称.csv')
      assert.equal((await c.get(file.importId)).displayName, '合成所有引用新名称.CSV')
      assert.deepEqual(await c.references(file.importId), after)
      assert.deepEqual(await c.sourceIdentity(), identity)
    })
  } finally { await lab.close() }
})
