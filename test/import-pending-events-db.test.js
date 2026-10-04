const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')

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

function ordered(events) {
  return events.slice().sort((a, b) => Number(a.localAt == null) - Number(b.localAt == null)
    || String(a.localAt || '').localeCompare(String(b.localAt || '')) || a.eventId.localeCompare(b.eventId))
}

test('待处理按交易分页：真实 MySQL 74 笔完整可达、紧凑问题入口及读取隔离', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer), trace = []
    const services = localServices({ apiPool, importPool: tracePool(importPool, trace), subject: 'synthetic-pending-events' })
    const identity = await call(services.api, 'bootstrap'), uid = identity.uid
    const category = identity.categories.find(item => item.systemKey === 'food')
    const update = await prepareSyntheticUpdate(services, 76, 'SYNTHETIC-PENDING-EVENTS'), updateId = update.updateId
    await lab.owner.execute('DELETE FROM catledger_review_issue_members WHERE uid=? AND update_id=?', [uid, updateId])
    await lab.owner.execute('DELETE FROM catledger_review_issues WHERE uid=? AND update_id=?', [uid, updateId])
    const [rows] = await lab.owner.execute(`SELECT e.event_id AS eventId, r.row_id AS rowId FROM catledger_economic_events e
      JOIN catledger_event_evidence v ON v.uid=e.uid AND v.update_id=e.update_id AND v.event_id=e.event_id AND v.evidence_role='primary'
      JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
      WHERE e.uid=? AND e.update_id=? ORDER BY r.source_row_number`, [uid, updateId])
    const events = []
    for (const [i, row] of rows.entries()) {
      const localAt = [72, 73].includes(i) ? null
        : new Date(Date.UTC(2026, 7, 1 + (73 - i) % 38)).toISOString().replace('T', ' ').replace('Z', '')
      await lab.owner.execute(`UPDATE catledger_economic_events SET status=?,economic_nature='expense',event_local_at=?,
        category_id=?,reason_codes_json='[]',field_sources_json='{}' WHERE uid=? AND event_id=?`,
      [i < 74 ? 'needs_action' : 'ready', localAt, i < 74 ? null : category.id, uid, row.eventId])
      await lab.owner.execute('UPDATE catledger_import_rows SET item_raw=?,note_raw=? WHERE uid=? AND row_id=?',
        [i === 1 ? '合成非首成员专用商品' : '合成待处理商品', '', uid, row.rowId])
      events.push({ ...row, localAt })
    }
    async function insertIssue({ issueId = randomUUID(), issueType = 'shared_fields', status = 'open', blocking = true,
      targets = [], candidates = [], owner = uid, batch = updateId, createdAt = '2026-08-10 00:00:00.000' } = {}) {
      const reasonCodes = ['synthetic_pending_issue'], version = 3
      await lab.owner.execute(`INSERT INTO catledger_review_issues
        (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,version,blocking,primary_reason_code,
         member_count,candidate_count,rule_version,reason_codes_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [owner, issueId, batch, createHash('sha256').update(issueId).digest('hex'), 'synthetic', issueType, status, version,
        Number(blocking), reasonCodes[0], targets.length + candidates.length, candidates.length, 'synthetic', JSON.stringify(reasonCodes), createdAt])
      for (const [i, event] of candidates.concat(targets).entries()) await lab.owner.execute(`INSERT INTO catledger_review_issue_members
        (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order)
        VALUES (?,?,?,?,'event',?,1,?,?)`,
      [owner, randomUUID(), batch, issueId, event.eventId, i < candidates.length ? 'candidate' : 'subject', i])
      return { issueId, issueType, status, version, blocking: issueType !== 'category_assignment' && blocking,
        primaryReasonCode: reasonCodes[0], reasonCodes, memberCount: targets.length + candidates.length, candidateCount: candidates.length }
    }
    const expectedIssues = new Map(), baseIssues = []
    for (let i = 0; i < 46; i++) {
      const targets = i < 28 ? events.slice(i * 2, i * 2 + 2) : [events[56 + i - 28]]
      const issue = await insertIssue({ issueType: i === 0 ? 'account_mapping' : 'shared_fields', targets,
        candidates: i === 0 ? [events[74]] : [] })
      baseIssues.push(issue)
      for (const event of targets) expectedIssues.set(event.eventId, issue)
    }
    const read = data => call(services.import, 'economicEvents.list', { updateId, ...data })
    const pending = data => read({ view: 'review_pending', ...data })
    const categories = data => read({ view: 'category_pending', ...data })
    async function visiblePage(fetch, cursor = null, viewVersion) {
      const items = [], transports = []; let total
      do {
        const page = await fetch({ pageSize: 50 - items.length, cursor, ...(viewVersion ? { viewVersion } : {}) })
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024)
        if (total != null) assert.equal(page.total, total)
        total = page.total; viewVersion = page.viewVersion; cursor = page.nextCursor
        transports.push(page); items.push(...page.items)
        assert.ok(transports.length < 60, '传输游标必须推进')
      } while (cursor && items.length < 50)
      return { items, total, nextCursor: cursor, viewVersion, transports }
    }
    await t.test('74 笔归属 46 个问题时仍返回 74 个独立交易入口，50/24 页完整无重漏', async () => {
      const summary = await call(services.import, 'financeUpdates.summary', { updateId })
      assert.equal(summary.workbench.reviewStatusTabs.find(tab => tab.value === 'pending').count, 74)
      assert.equal(Number((await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_review_issues WHERE uid=? AND update_id=?', [uid, updateId]))[0][0].count), 46)
      const first = await visiblePage(pending), second = await visiblePage(pending, first.nextCursor, first.viewVersion)
      assert.deepEqual([first.items.length, second.items.length], [50, 24])
      assert.equal(first.total, 74); assert.equal(second.total, 74)
      assert.ok(first.nextCursor); assert.equal(second.nextCursor, null)
      const listed = first.items.concat(second.items)
      assert.equal(new Set(listed.map(item => item.eventId)).size, 74)
      assert.deepEqual(listed.map(item => item.eventId), ordered(events.slice(0, 74)).map(event => event.eventId))
      assert.ok(listed.slice(-2).every(item => item.localAt === null))
      for (const event of listed) {
        assert.deepEqual(event.pendingIssue, expectedIssues.get(event.eventId))
        assert.deepEqual(Object.keys(event.pendingIssue).sort(), ['blocking', 'candidateCount', 'issueId', 'issueType',
          'memberCount', 'primaryReasonCode', 'reasonCodes', 'status', 'version'])
      }
      assert.equal(listed.filter(item => item.pendingIssue.issueType === 'account_mapping').length, 2)
      assert.equal(listed.find(item => item.eventId === events[0].eventId).pendingIssue.memberCount, 3)
    })
    await t.test('全批搜索命中非首成员，仍打开原问题；问题入口只为本页一次批量读取', async () => {
      const result = await pending({ query: '合成非首成员专用商品' })
      assert.equal(result.total, 1)
      assert.equal(result.items[0].eventId, events[1].eventId)
      assert.equal(result.items[0].pendingIssue.issueId, baseIssues[0].issueId)
      assert.equal(result.items[0].pendingIssue.memberCount, 3, '搜索不能缩小原问题决定范围')
      trace.length = 0
      await pending({ pageSize: 5 })
      const entryQueries = trace.filter(entry => /SELECT m\.object_id AS eventId, i\.issue_id AS issueId/.test(entry.sql))
      assert.equal(entryQueries.length, 1)
      assert.equal(entryQueries[0].parameterCount, 2 + 6, '只带当前页及下一项的事件 ID')
      assert.ok(!entryQueries[0].sql.includes('catledger_import_rows'))
      const page = await pending({ pageSize: 2 })
      await assert.rejects(pending({ cursor: page.nextCursor, query: '合成非首成员专用商品' }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(categories({ cursor: page.nextCursor }), { publicCode: 'INVALID_CURSOR' })
    })
    await t.test('同一交易多个问题仍只一笔；按创建时间和 ID 选入口，处理后展示下一个', async () => {
      const low = await insertIssue({ issueId: '11111111-1111-4111-8111-111111111111', targets: [events[0]], createdAt: '2026-08-01 00:00:00.000' })
      const high = await insertIssue({ issueId: '22222222-2222-4222-8222-222222222222', targets: [events[0]], createdAt: '2026-08-01 00:00:00.000' })
      const later = await insertIssue({ issueId: '00000000-0000-4000-8000-000000000001', targets: [events[0]], createdAt: '2026-08-02 00:00:00.000' })
      const before = await pending({ eventId: events[0].eventId })
      assert.equal(before.total, 1); assert.equal(before.items.length, 1)
      assert.deepEqual(before.items[0].pendingIssue, low)
      assert.equal((await pending({ pageSize: 1 })).total, 74)
      await lab.owner.execute("UPDATE catledger_review_issues SET status='resolved',version=version+1 WHERE uid=? AND issue_id=?", [uid, low.issueId])
      await lab.owner.execute('UPDATE catledger_finance_updates SET version=version+1 WHERE uid=? AND update_id=?', [uid, updateId])
      await assert.rejects(pending({ viewVersion: before.viewVersion }), { publicCode: 'STALE_VIEW' })
      assert.deepEqual((await pending({ eventId: events[0].eventId })).items[0].pendingIssue, high)
      await lab.owner.execute("UPDATE catledger_review_issues SET status='resolved' WHERE uid=? AND issue_id=?", [uid, high.issueId])
      assert.deepEqual((await pending({ eventId: events[0].eventId })).items[0].pendingIssue, later)
    })
    await t.test('没有可处理问题的 needs_action 交易保留 null；候选、关闭、非阻断和别用户问题不成为入口', async () => {
      await lab.owner.execute("UPDATE catledger_economic_events SET status='needs_action',category_id=NULL WHERE uid=? AND event_id=?", [uid, events[74].eventId])
      await insertIssue({ targets: [events[74]], status: 'resolved', createdAt: '2000-01-01 00:00:00.000' })
      await insertIssue({ targets: [events[74]], blocking: false, createdAt: '2000-01-01 00:00:00.000' })
      const other = localServices({ apiPool, importPool, subject: 'synthetic-pending-events-other' })
      const otherIdentity = await call(other.api, 'bootstrap'), otherUpdate = await prepareSyntheticUpdate(other, 1, 'SYNTHETIC-PENDING-OTHER')
      await insertIssue({ targets: [events[74]], owner: otherIdentity.uid, batch: otherUpdate.updateId, createdAt: '1999-01-01 00:00:00.000' })
      const result = await pending({ eventId: events[74].eventId })
      assert.equal(result.total, 1); assert.equal(result.items[0].pendingIssue, null)
      assert.ok(Object.hasOwn(result.items[0], 'pendingIssue'))
      await assert.rejects(call(other.import, 'economicEvents.list', { updateId, view: 'review_pending' }), { publicCode: 'NOT_FOUND' })
      const page = await pending({ pageSize: 1 })
      await assert.rejects(call(other.import, 'economicEvents.list', { updateId: otherUpdate.updateId, view: 'review_pending', cursor: page.nextCursor }), { publicCode: 'INVALID_CURSOR' })
    })
    await t.test('待分类按交易分页且只附分类问题，分类候选与其他问题不代替入口', async () => {
      await lab.owner.execute('UPDATE catledger_economic_events SET category_id=NULL WHERE uid=? AND event_id=?', [uid, events[75].eventId])
      const categoryIssue = await insertIssue({ issueType: 'category_assignment', targets: [events[0], events[1], events[75]],
        candidates: [events[74]], createdAt: '2000-01-01 00:00:00.000' })
      await insertIssue({ issueType: 'category_assignment', targets: [events[75]], status: 'resolved', createdAt: '1999-01-01 00:00:00.000' })
      const first = await visiblePage(categories), second = await visiblePage(categories, first.nextCursor, first.viewVersion)
      assert.deepEqual([first.items.length, second.items.length], [50, 26])
      assert.equal(first.total, 76)
      const listed = first.items.concat(second.items)
      assert.deepEqual(listed.map(item => item.eventId), ordered(events).map(event => event.eventId))
      for (const event of listed) assert.deepEqual(event.pendingIssue,
        [events[0].eventId, events[1].eventId, events[75].eventId].includes(event.eventId) ? categoryIssue : null)
      assert.equal(categoryIssue.blocking, false)
      assert.notEqual((await pending({ eventId: events[0].eventId })).items[0].pendingIssue.issueType, 'category_assignment')
      assert.equal((await pending({ eventId: events[75].eventId })).total, 0)
    })
    await t.test('超 16 KiB 事件降级仍保留问题对象或 null，读取不写账务或修改导入状态', async () => {
      const fields = JSON.stringify({ fundsProjection: { from: { label: '合成超长说明'.repeat(2000) } } })
      for (const event of [events[0], events[74]]) await lab.owner.execute('UPDATE catledger_economic_events SET field_sources_json=? WHERE uid=? AND event_id=?', [fields, uid, event.eventId])
      const snapshot = async () => {
        const result = {}
        for (const table of ['catledger_users', 'catledger_accounts', 'catledger_transactions', 'catledger_finance_updates',
          'catledger_economic_events', 'catledger_review_issues', 'catledger_review_issue_members', 'catledger_mutation_receipts']) {
          const [values] = await lab.owner.execute('SELECT * FROM ' + table + ' WHERE uid=?', [uid])
          result[table] = createHash('sha256').update(JSON.stringify(values.map(value => JSON.stringify(value)).sort())).digest('hex')
        }
        return result
      }
      const before = await snapshot(); trace.length = 0
      const withIssue = (await pending({ eventId: events[0].eventId })).items[0]
      assert.equal(withIssue.detailRequired, true); assert.equal(withIssue.detailKind, 'event')
      assert.equal(withIssue.pendingIssue.issueId, '00000000-0000-4000-8000-000000000001')
      assert.ok(!Object.hasOwn(withIssue, 'primaryEvidence'))
      const withoutIssue = (await pending({ eventId: events[74].eventId })).items[0]
      assert.equal(withoutIssue.detailRequired, true); assert.equal(withoutIssue.pendingIssue, null)
      assert.ok(Object.hasOwn(withoutIssue, 'pendingIssue'))
      const categoryItem = (await categories({ eventId: events[0].eventId })).items[0]
      assert.equal(categoryItem.pendingIssue.issueType, 'category_assignment')
      const ordinary = (await read({ eventId: events[0].eventId })).items[0]
      assert.ok(!Object.hasOwn(ordinary, 'pendingIssue'))
      assert.ok(trace.every(entry => !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE)\b/i.test(entry.sql)))
      assert.deepEqual(await snapshot(), before)
    })
  } finally { await lab.close() }
})
