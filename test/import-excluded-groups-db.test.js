const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, syntheticBill, prepareSyntheticUpdate } = require('./helpers/local-services')

function tracePool(pool, trace) {
  return new Proxy(pool, { get(target, name) {
    if (name === 'getConnection') return async () => {
      const connection = await target.getConnection()
      return new Proxy(connection, { get(inner, method) {
        if (method === 'execute' || method === 'query') return async (sql, values) => {
          trace.push({ sql, parameterCount: values ? values.length : 0 })
          return inner[method](sql, values)
        }
        return typeof inner[method] === 'function' ? inner[method].bind(inner) : inner[method]
      } })
    }
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name]
  } })
}

function ordered(rows, key = 'eventId') {
  return rows.slice().sort((a, b) => Number(a.localAt == null) - Number(b.localAt == null)
    || String(a.localAt || '').localeCompare(String(b.localAt || '')) || a[key].localeCompare(b[key]))
}

test('已排除整批归组：真实 MySQL 区分整账户与自动排除、独立成员分页与只读隔离', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer), trace = []
    const services = localServices({ apiPool, importPool: tracePool(importPool, trace), subject: 'synthetic-excluded-groups' })
    const identity = await call(services.api, 'bootstrap'), uid = identity.uid
    const batches = []
    for (const [source, count] of [193, 4].entries()) {
      const content = syntheticBill(count, 'SYNTHETIC-EXCLUDED-' + source)
      const prepared = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(),
        files: [{ fileName: '合成账户归组' + source + '.csv', size: content.length }] })
      const file = prepared.files[0]; services.objects.set(file.cloudPath, content)
      const parsed = await call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId,
        fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
      batches.push(parsed.batch.batchId)
    }
    const update = await call(services.import, 'financeUpdates.prepare', { requestId: randomUUID(), batchIds: batches })
    const updateId = update.updateId, name = '合成银行信用卡（１２３４）'
    await lab.owner.execute('UPDATE catledger_finance_update_sources SET source_type_snapshot=? WHERE uid=? AND update_id=? AND batch_id=?',
      ['alipay', uid, updateId, batches[1]])
    const [evidence] = await lab.owner.execute(`SELECT e.event_id AS eventId, r.row_id AS rowId, r.batch_id AS batchId,
      r.source_row_number AS rowNumber FROM catledger_economic_events e
      JOIN catledger_event_evidence v ON v.uid=e.uid AND v.update_id=e.update_id AND v.event_id=e.event_id AND v.evidence_role='primary'
      JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
      WHERE e.uid=? AND e.update_id=? ORDER BY r.batch_id, r.source_row_number`, [uid, updateId])
    const events = []
    for (const batchId of batches) {
      const rows = evidence.filter(row => row.batchId === batchId), second = batchId === batches[1]
      for (const [i, row] of rows.entries()) {
        const sourceType = second ? 'alipay' : 'wechat', historical = !second && [189, 190].includes(i)
        let bucket = second ? 'other-source' : i < 125 ? 'main' : i < 180 ? 'other-account-' + i
          : i < 183 ? 'closed' : i < 186 ? 'failed' : ['non-financial', 'manual', 'other', 'history-auto', 'history-link', 'unknown-account', 'active'][i - 186]
        const reasons = second ? ['account_mapping_excluded'] : i < 125
          ? [['account_mapping_excluded'], ['source_account_ignored_default'], ['manual_exclusion', 'account_mapping_excluded'],
            ['transaction_closed', 'account_mapping_excluded'], ['transaction_failed', 'source_account_ignored_default'],
            ['source_non_financial', 'account_mapping_excluded'], ['synthetic_other_exclusion', 'account_mapping_excluded']][i % 7]
          : i < 180 ? ['account_mapping_excluded'] : i < 183 ? ['transaction_closed']
            : i < 186 ? ['manual_exclusion', 'transaction_failed'] : [
              ['transaction_failed', 'source_non_financial'], ['manual_exclusion'], [], ['already_posted', 'account_mapping_excluded'],
              ['linked_existing_transaction', 'account_mapping_excluded'], ['source_account_ignored_default'], ['manual_exclusion']][i - 186]
        let paymentMethod = second || i < 125 || historical || i === 192 ? (i % 3 === 0 ? name
          : i % 3 === 1 ? '合成银行 - 信用卡 尾号 1234' : '合成银行信用卡 622200001234')
          : i < 180 ? (i >= 178 ? '合成长账户'.repeat(40) + i : '合成储蓄账户' + i)
            : ['', '/', '未提供', '--', '未知', 'N/A', '暂无', 'null', 'undefined', '', '', '该账户'][i - 180]
        // 自动/单笔排除即使有具体账户，也不能混进整账户排除卡；同原因跨账户合卡。
        if (!second && i >= 180 && i <= 188) paymentMethod = i % 2 ? '合成另一支付账户' : name
        let fields = {}
        if (!second && i === 119) { paymentMethod = '未提供'; fields = { fundsProjection: { from: { label: name } } } }
        if (!second && i === 120) { paymentMethod = '/'; fields = { fundsProjection: { from: { label: '未知' }, to: { label: name } } } }
        const localAt = !second && [123, 124, 186].includes(i) ? null
          : new Date(Date.UTC(2026, 7, 1 + (i * 17) % 75)).toISOString().replace('T', ' ').replace('Z', '')
        const searchHit = !second && i >= 110 && i < 125 || second && i === 2
        const status = bucket === 'active' ? 'ready' : 'excluded'
        await lab.owner.execute(`UPDATE catledger_economic_events SET status=?,event_local_at=?,reason_codes_json=?,field_sources_json=?
          WHERE uid=? AND update_id=? AND event_id=?`, [status, localAt, JSON.stringify(reasons), JSON.stringify(fields), uid, updateId, row.eventId])
        const sourceStatus = reasons.includes('transaction_closed') ? '交易关闭' : reasons.includes('transaction_failed') ? '支付失败' : '交易成功'
        await lab.owner.execute('UPDATE catledger_import_rows SET payment_method_raw=?,item_raw=?,counterparty_raw=?,status_raw=? WHERE uid=? AND row_id=?',
          [paymentMethod, searchHit ? '跨页末段商品' : '合成普通商品', '合成账户商户', sourceStatus, uid, row.rowId])
        events.push({ ...row, bucket, sourceType, localAt, searchHit, status, historical, sourceStatus, reasons })
      }
    }
    const read = data => call(services.import, 'economicEvents.list', { updateId, ...data })
    const groups = data => read({ view: 'excluded_groups', ...data })
    const members = (groupId, data) => read({ status: 'excluded', excludedGroupId: groupId, ...data })
    async function collect(fetch, filter = {}, key = 'eventId') {
      const items = [], pages = []; let cursor = null, viewVersion
      do {
        const page = await fetch({ ...filter, cursor, ...(viewVersion ? { viewVersion } : {}) })
        viewVersion = page.viewVersion; pages.push(page)
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024)
        assert.equal(page.total, pages[0].total)
        items.push(...page.items); cursor = page.nextCursor
        assert.ok(pages.length < 100, '游标必须推进')
      } while (cursor)
      assert.equal(items.length, pages[0].total)
      assert.equal(new Set(items.map(item => item[key])).size, items.length)
      return { items, pages }
    }
    let allGroups, main, otherSource
    await t.test('整账户排除跨50笔仍只一卡；有具体支付账户的自动排除按原因合卡', async () => {
      const result = await collect(groups, { pageSize: 50 }, 'groupId'); allGroups = result.items
      assert.equal(allGroups.length, 63)
      assert.deepEqual(result.pages.map(page => page.items.length), [50, 13])
      main = allGroups.find(group => group.count === 125)
      otherSource = allGroups.find(group => group.count === 4)
      assert.ok(main); assert.ok(otherSource); assert.notEqual(main.groupId, otherSource.groupId)
      assert.equal(allGroups.reduce((n, group) => n + group.count, 0), 194)
      assert.ok(allGroups.some(group => group.label === '非资金记录' && group.count === 1))
      assert.ok(allGroups.some(group => group.label === '交易关闭' && group.count === 3))
      assert.ok(allGroups.some(group => group.label === '交易失败' && group.count === 3))
      assert.ok(allGroups.some(group => group.label === '账户已排除' && group.count === 1))
      assert.equal(allGroups.some(group => group.label === '合成另一支付账户'), false)
      const closed = allGroups.find(group => group.label === '交易关闭')
      const closedMembers = await collect(data => members(closed.groupId, data))
      assert.deepEqual(closedMembers.items.map(row => row.eventId), ordered(events.filter(row => row.bucket === 'closed')).map(row => row.eventId))
      assert.equal(new Set(closedMembers.items.map(row => row.primaryEvidence.paymentMethod)).size, 2)
      for (const group of allGroups) {
        assert.match(group.groupId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        assert.equal(group.key, group.groupId); assert.ok(group.label.length <= 160)
        assert.deepEqual(Object.keys(group).sort(), ['count', 'groupId', 'key', 'label', 'note', 'sortLocalAt'])
      }
      assert.deepEqual(allGroups, allGroups.slice().sort((a, b) => Number(a.sortLocalAt == null) - Number(b.sortLocalAt == null)
        || String(a.sortLocalAt || '').localeCompare(String(b.sortLocalAt || '')) || a.groupId.localeCompare(b.groupId)))
      assert.equal(main.sortLocalAt.slice(0, 19), ordered(events.filter(e => e.bucket === 'main'))[0].localAt.slice(0, 19))
    })
    await t.test('组内成员跨页按日期与 ID 稳定排序，未知日期放末尾且不重不漏', async () => {
      const result = await collect(data => members(main.groupId, data), { pageSize: 50 })
      assert.deepEqual(result.items.map(item => item.eventId), ordered(events.filter(e => e.bucket === 'main')).map(e => e.eventId))
      assert.ok(result.pages.length >= 3)
      assert.ok(result.items.slice(-2).every(item => item.localAt === null))
      for (const item of result.items) assert.equal(item.primaryEvidence.status, events.find(event => event.eventId === item.eventId).sourceStatus)
      const distinct = await collect(data => members(otherSource.groupId, data), { pageSize: 2 })
      assert.deepEqual(distinct.items.map(item => item.eventId), ordered(events.filter(e => e.bucket === 'other-source')).map(e => e.eventId))
      assert.ok(distinct.items.every(item => item.primaryEvidence.sourceType === 'alipay'))
      const byStatus = await collect(read, { status: 'excluded', pageSize: 50 })
      assert.equal(byStatus.items.length, 194)
      assert.ok(byStatus.items.every(item => !item.reasonCodes.includes('already_posted') && !item.reasonCodes.includes('linked_existing_transaction')))
    })
    await t.test('完整批次搜索再归组，关键词和日期筛选保留同一账户 ID 与命中笔数', async () => {
      const result = await groups({ query: '跨页末段商品' })
      assert.equal(result.total, 2)
      assert.deepEqual(result.items.map(item => [item.groupId, item.count]).sort(), [[main.groupId, 15], [otherSource.groupId, 1]].sort())
      const selected = await collect(data => members(main.groupId, data), { query: '跨页末段商品', pageSize: 4 })
      assert.deepEqual(selected.items.map(item => item.eventId), ordered(events.filter(e => e.bucket === 'main' && e.searchHit)).map(e => e.eventId))
      for (const query of ['2026-08', '2026/8', '2026年8月']) {
        const matching = events.filter(e => e.bucket === 'main' && e.localAt && e.localAt.startsWith('2026-08'))
        const page = await groups({ query, pageSize: 100 })
        assert.equal(page.items.find(group => group.groupId === main.groupId).count, matching.length)
        const dates = await collect(data => members(main.groupId, data), { query, pageSize: 9 })
        assert.deepEqual(dates.items.map(item => item.eventId), ordered(matching).map(e => e.eventId))
      }
      assert.equal((await groups({ query: "' OR 1=1 --" })).total, 0)
      assert.equal((await members(main.groupId, { query: '不存在的合成商品' })).total, 0)
      assert.equal((await members(randomUUID(), {})).total, 0)
    })
    await t.test('游标绑定视图、组、搜索与用户；用户会话不会复用另一人的成员页', async () => {
      const summaryPage = await groups({ pageSize: 1 }), memberPage = await members(main.groupId, { pageSize: 2 })
      await assert.rejects(groups({ query: '合成普通商品', cursor: summaryPage.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(members(main.groupId, { cursor: summaryPage.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(groups({ cursor: memberPage.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(members(otherSource.groupId, { cursor: memberPage.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(members(main.groupId, { query: '跨页末段商品', cursor: memberPage.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(read({ excludedGroupId: main.groupId }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(groups({ status: 'ready' }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(members('not-a-uuid', {}), { publicCode: 'VALIDATION_ERROR' })
      const other = localServices({ apiPool, importPool, subject: 'synthetic-excluded-groups-other' })
      const otherIdentity = await call(other.api, 'bootstrap'), otherUpdate = await prepareSyntheticUpdate(other, 3, 'SYNTHETIC-EXCLUDED-OTHER')
      await lab.owner.execute("UPDATE catledger_economic_events SET status='excluded',reason_codes_json='[\"account_mapping_excluded\"]',field_sources_json='{}' WHERE uid=?", [otherIdentity.uid])
      await lab.owner.execute('UPDATE catledger_import_rows SET payment_method_raw=? WHERE uid=?', [name, otherIdentity.uid])
      await assert.rejects(call(other.import, 'economicEvents.list', { updateId, view: 'excluded_groups' }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(call(other.import, 'economicEvents.list', { updateId: otherUpdate.updateId, status: 'excluded',
        excludedGroupId: main.groupId, cursor: memberPage.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      const isolated = await call(other.import, 'economicEvents.list', { updateId: otherUpdate.updateId, status: 'excluded', excludedGroupId: main.groupId })
      assert.equal(isolated.total, 3)
      assert.ok(isolated.items.every(item => !events.some(event => event.eventId === item.eventId)))
    })
    await t.test('超长排除记录降级后仍保留自动排除原因及原账单状态', async () => {
      const event = events.find(row => row.bucket === 'closed')
      const fields = JSON.stringify({ fundsProjection: { from: { label: '合成超长说明'.repeat(2000) } } })
      await lab.owner.execute('UPDATE catledger_economic_events SET field_sources_json=? WHERE uid=? AND event_id=?', [fields, uid, event.eventId])
      const page = await read({ status: 'excluded', eventId: event.eventId })
      assert.equal(page.items.length, 1)
      assert.equal(page.items[0].detailRequired, true)
      assert.deepEqual(page.items[0].reasonCodes, ['transaction_closed'])
      assert.equal(page.items[0].primaryEvidence.status, '交易关闭')
      await lab.owner.execute("UPDATE catledger_economic_events SET field_sources_json='{}' WHERE uid=? AND event_id=?", [uid, event.eventId])
    })
    await t.test('摘要不读取整批原文详情，短响应成员页完整续读且读取不改变账务或导入状态', async () => {
      await lab.owner.execute('UPDATE catledger_import_rows SET note_raw=? WHERE uid=?', ['合成备注'.repeat(200), uid])
      const snapshot = async () => {
        const result = {}
        for (const table of ['catledger_users', 'catledger_accounts', 'catledger_transactions', 'catledger_finance_updates',
          'catledger_economic_events', 'catledger_event_evidence', 'catledger_review_issues', 'catledger_mutation_receipts']) {
          const [rows] = await lab.owner.execute('SELECT * FROM ' + table + ' WHERE uid=?', [uid])
          result[table] = createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex')
        }
        return result
      }
      const before = await snapshot(); trace.length = 0
      await groups({ pageSize: 50 })
      assert.ok(!trace.some(entry => /r\.item_raw AS item|r\.note_raw AS sourceNote|e\.field_sources_json AS fieldSources/.test(entry.sql)))
      assert.equal(trace.filter(entry => /AS paymentMethod/.test(entry.sql)).length, 1)
      trace.length = 0
      const first = await members(main.groupId, { pageSize: 50 })
      assert.ok(first.items.length < 50); assert.ok(first.nextCursor)
      assert.equal(trace.filter(entry => /r\.item_raw AS item/.test(entry.sql)).length, 1, '只读取当前有界成员页，不逐笔查询')
      const result = await collect(data => members(main.groupId, data), { pageSize: 50 })
      assert.deepEqual(result.items.map(item => item.eventId), ordered(events.filter(e => e.bucket === 'main')).map(e => e.eventId))
      assert.ok(trace.every(entry => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE)\b/i.test(entry.sql)))
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('首笔变化只使旧视图失效，同一账户 ID 不随首笔或页大小改变', async () => {
      const first = await groups({ pageSize: 1 }), firstMember = await members(main.groupId, { pageSize: 1 })
      const earliest = ordered(events.filter(e => e.bucket === 'main'))[0]
      await lab.owner.execute("UPDATE catledger_economic_events SET status='ready' WHERE uid=? AND event_id=?", [uid, earliest.eventId])
      await lab.owner.execute('UPDATE catledger_finance_updates SET version=version+1 WHERE uid=? AND update_id=?', [uid, updateId])
      await assert.rejects(groups({ cursor: first.nextCursor }), { publicCode: 'STALE_VIEW' })
      await assert.rejects(members(main.groupId, { cursor: firstMember.nextCursor }), { publicCode: 'STALE_VIEW' })
      await assert.rejects(groups({ viewVersion: first.viewVersion }), { publicCode: 'STALE_VIEW' })
      const after = await collect(groups, { pageSize: 7 }, 'groupId')
      assert.equal(after.items.find(item => item.groupId === main.groupId).count, 124)
      assert.equal(after.items.find(item => item.groupId === main.groupId).sortLocalAt.slice(0, 19),
        ordered(events.filter(e => e.bucket === 'main' && e.eventId !== earliest.eventId))[0].localAt.slice(0, 19))
      assert.ok(!JSON.stringify(after.items).includes(earliest.eventId))
    })
  } finally { await lab.close() }
})
