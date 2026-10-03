const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const { hashWechatSubject } = require('../cloudfunctions/catledger-import/src/handler')
const { encodeCursor } = require('../cloudfunctions/catledger-import/src/view-cursor')

test('整理分页：真实 MySQL 全局日期、问题组、成员、分类路径与用户隔离', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const subject = 'synthetic-sort-primary', services = localServices({ apiPool, importPool, subject })
    const identity = await call(services.api, 'bootstrap')
    const other = localServices({ apiPool, importPool, subject: 'synthetic-sort-other' })
    const otherIdentity = await call(other.api, 'bootstrap')
    const uid = identity.uid, parent = identity.categories.find(c => c.systemKey === 'food')
    const child = identity.categories.find(c => c.parentId === parent.id)
    const update = await prepareSyntheticUpdate(services, 125, 'SYNTHETIC-SORT')
    const updateId = update.updateId
    const context = data => ({ provider: 'wechat-mini', subjectHash: hashWechatSubject(subject), data: { updateId, ...data } })
    const read = data => services.importer.economicEventList(context(data))
    const issues = data => services.importer.reviewIssueList(context({ protocolVersion: 2, ...data }))
    const members = data => services.importer.reviewIssueMembers(context(data))
    await lab.owner.execute('DELETE FROM catledger_review_issue_members WHERE uid=? AND update_id=?', [uid, updateId])
    await lab.owner.execute('DELETE FROM catledger_review_issues WHERE uid=? AND update_id=?', [uid, updateId])
    const [ids] = await lab.owner.execute('SELECT event_id AS eventId FROM catledger_economic_events WHERE uid=? AND update_id=? ORDER BY event_id DESC', [uid, updateId])
    const events = []
    for (const [i, row] of ids.entries()) {
      const localAt = i >= 123 ? null : i === 0 ? '2024-02-29 00:00:00.000' : new Date(Date.UTC(2026, 7, 1 + (124 - i) % 57)).toISOString().replace('T', ' ').replace('Z', '')
      const status = i >= 85 && i < 105 ? 'excluded' : i >= 105 ? 'needs_action' : 'ready'
      const economicNature = i >= 105 ? 'unknown' : i >= 75 && i < 85 ? 'repayment' : 'expense'
      const categoryId = i < 65 ? (i === 0 ? parent.id : child.id) : null
      const reason = i >= 95 && i < 105 ? ['already_posted'] : status === 'excluded' ? ['manual_exclusion'] : []
      await lab.owner.execute(`UPDATE catledger_economic_events SET event_local_at=?, status=?, economic_nature=?, category_id=?, reason_codes_json=?
        WHERE uid=? AND event_id=?`, [localAt, status, economicNature, categoryId, JSON.stringify(reason), uid, row.eventId])
      events.push({ ...row, localAt, status, economicNature, categoryId, historical: reason.includes('already_posted') })
    }
    const ordered = (rows, key) => rows.slice().sort((a, b) => Number(a.localAt == null) - Number(b.localAt == null)
      || String(a.localAt || '').localeCompare(String(b.localAt || '')) || a[key].localeCompare(b[key]))
    async function collect(fetch, filter = {}, key = 'eventId') {
      const rows = [], pages = []; let cursor = null
      do {
        const page = await fetch({ ...filter, cursor }); pages.push(page)
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024)
        rows.push(...page.items); cursor = page.nextCursor
        assert.ok(pages.length < 100, '游标必须向前推进')
      } while (cursor)
      assert.equal(rows.length, pages[0].total)
      assert.equal(new Set(rows.map(row => row[key])).size, rows.length)
      return { rows, pages }
    }
    await t.test('跨月、相同时间和未知时间跨页无遗漏；每个事件 tab 遵循同一顺序', async () => {
      const cases = [
        [{}, () => true],
        [{ view: 'review_completed' }, e => e.status === 'ready'],
        [{ view: 'review_pending' }, e => e.status === 'needs_action'],
        [{ view: 'category_completed' }, e => e.categoryId],
        [{ view: 'category_pending' }, e => e.status !== 'excluded' && ['expense', 'unknown'].includes(e.economicNature) && !e.categoryId],
        [{ view: 'category_none' }, e => e.economicNature === 'repayment'],
        [{ status: 'excluded' }, e => e.status === 'excluded' && !e.historical],
        [{ status: 'duplicate' }, e => e.historical]
      ]
      for (const [filter, matches] of cases) {
        const result = await collect(read, { ...filter, pageSize: 7 })
        assert.deepEqual(result.rows.map(e => e.eventId), ordered(events.filter(matches), 'eventId').map(e => e.eventId), JSON.stringify(filter))
      }
    })
    await t.test('已分类返回一级与二级具体名称；分类改名使旧页失效且不串用户', async () => {
      const before = await read({ view: 'category_completed', pageSize: 1 })
      const all = await collect(read, { view: 'category_completed' })
      assert.equal(all.rows.find(e => e.categoryId === parent.id).categoryName, parent.name)
      assert.ok(all.rows.filter(e => e.categoryId === child.id).every(e => e.categoryName === parent.name + ' / ' + child.name))
      await assert.rejects(read({ status: 'ready', cursor: before.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(call(other.import, 'economicEvents.list', { updateId, cursor: before.nextCursor }), { publicCode: 'NOT_FOUND' })
      const token = JSON.parse(Buffer.from(before.nextCursor.split('.')[0], 'base64url').toString())
      const oldCursor = encodeCursor(hashWechatSubject(subject), { ...token.scope, order: 'id-asc' }, all.rows[0].eventId)
      await assert.rejects(read({ view: 'category_completed', cursor: oldCursor }), { publicCode: 'INVALID_CURSOR' })
      const foreign = otherIdentity.categories.find(c => c.systemKey === 'food')
      await lab.owner.execute('UPDATE catledger_categories SET name=? WHERE uid=? AND category_id=?', ['别人的分类', otherIdentity.uid, foreign.id])
      await call(services.api, 'categories.update', { requestId: randomUUID(), categoryId: parent.id, version: 1, name: '合成餐饮新名' })
      await assert.rejects(read({ view: 'category_completed', cursor: before.nextCursor }), { publicCode: 'STALE_VIEW' })
      const renamed = await collect(read, { view: 'category_completed' })
      assert.ok(renamed.rows.every(e => e.categoryName.startsWith('合成餐饮新名')))
    })
    const expectedIssues = [], memberRows = []
    async function insertIssue(type, targets, candidates = []) {
      const issueId = randomUUID()
      await lab.owner.execute(`INSERT INTO catledger_review_issues (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,
        blocking,primary_reason_code,member_count,candidate_count,rule_version,reason_codes_json) VALUES (?,?,?,?,?,?,'open',1,'synthetic',?,?,?,'[]')`,
      [uid, issueId, updateId, createHash('sha256').update(issueId).digest('hex'), 'synthetic', type, targets.length + candidates.length, candidates.length, 'synthetic'])
      // 特意把候选放在 sort_order=0、晚日期成员在前，不能决定卡片位置和首条预览。
      for (const [i, event] of candidates.concat(targets).entries()) {
        const memberId = randomUUID()
        await lab.owner.execute(`INSERT INTO catledger_review_issue_members (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order)
          VALUES (?,?,?,?,'event',?,1,?,?)`, [uid, memberId, updateId, issueId, event.eventId, i < candidates.length ? 'candidate' : 'subject', i])
        memberRows.push({ memberId, issueId, localAt: event.localAt })
      }
      const first = ordered(targets, 'eventId')[0]
      expectedIssues.push({ issueId, issueType: type, localAt: first && first.localAt || null, firstId: first && first.eventId, targetIds: targets.map(row => row.eventId) })
      return issueId
    }
    await t.test('待核对/待分类按最早真实成员全局分页；候选不抢占日期与首条预览', async () => {
      const known = ordered(events.filter(e => e.localAt), 'eventId')
      for (let i = 0; i < 90; i++) await insertIssue(i % 2 ? 'category_assignment' : i % 4 ? 'refund_relation' : 'same_event',
        [known[100 - i], known[99 - i]], [known[0]])
      await insertIssue('same_event', events.slice(-2))
      for (const group of ['review', 'category']) {
        const expected = expectedIssues.filter(i => group === 'category' ? i.issueType === 'category_assignment' : i.issueType !== 'category_assignment')
        const result = await collect(issues, { group, status: 'open', pageSize: 9 }, 'issueId')
        assert.deepEqual(result.rows.map(i => i.issueId), ordered(expected, 'issueId').map(i => i.issueId))
        for (const issue of result.rows) {
          const expectedIssue = expected.find(i => i.issueId === issue.issueId)
          assert.equal(issue.subject.eventId, expectedIssue.firstId)
          assert.equal(issue.sortLocalAt && issue.sortLocalAt.slice(0, 19), expectedIssue.localAt && expectedIssue.localAt.slice(0, 19))
        }
      }
    })
    await t.test('一组多笔的成员分页同样从早到晚，未知日期放末尾', async () => {
      const issueId = await insertIssue('shared_fields', events.slice().reverse())
      const result = await collect(members, { issueId, memberKind: 'event', pageSize: 8 }, 'memberId')
      assert.deepEqual(result.rows.map(m => m.memberId), ordered(memberRows.filter(m => m.issueId === issueId), 'memberId').map(m => m.memberId))
      assert.ok(result.rows.slice(-2).every(m => m.event.localAt === null))
    })
    await t.test('搜索真实交易日期支持年月日、年月、月日与中文斜杠；闰日、未知日期和状态筛选正确', async () => {
      for (const query of ['2024-02-29', '2024/2/29', '2024年2月29日', '02-29', '2/29', '2月29日']) {
        const result = await read({ query })
        assert.deepEqual(result.items.map(row => row.eventId), [events[0].eventId], query)
      }
      for (const query of ['2026-08', '2026/8', '2026年8月']) {
        const result = await collect(read, { query, pageSize: 5 })
        assert.deepEqual(result.rows.map(row => row.eventId), ordered(events.filter(e => e.localAt && e.localAt.startsWith('2026-08')), 'eventId').map(e => e.eventId), query)
      }
      for (const query of ['2025-02-29', '2026-02-30', '2026-13-01', '13-01']) assert.equal((await read({ query })).total, 0, query)
      const day = await read({ query: '2026-09-01' })
      assert.equal(day.total, events.filter(e => e.localAt && e.localAt.startsWith('2026-09-01')).length, '不能用原文的统一日期替代事件实际日期')
      const excluded = await collect(read, { status: 'excluded', query: '2026' })
      assert.ok(excluded.rows.length > 0)
      assert.ok(excluded.rows.every(e => e.status === 'excluded' && !e.reasonCodes.includes('already_posted')))
      assert.equal((await read({ query: '2026', pageSize: 1 })).total, 122)
    })
    await t.test('商户、商品、一级二级和完整分类路径全批搜索，游标绑定关键词且不串用户', async () => {
      assert.equal((await read({ query: '合成商户' })).total, 125)
      assert.equal((await read({ query: '合成商品' })).total, 125)
      assert.equal((await read({ query: '合成餐饮新名' })).total, 65)
      assert.equal((await read({ query: child.name })).total, 64)
      assert.equal((await read({ query: '合成餐饮新名 / ' + child.name })).total, 64)
      for (const query of ['别人的分类', '%', "' OR 1=1 --"]) assert.equal((await read({ query })).total, 0)
      const first = await read({ query: '2026-08', pageSize: 1 })
      assert.ok(first.nextCursor)
      await assert.rejects(read({ query: '2026-09', cursor: first.nextCursor }), { publicCode: 'INVALID_CURSOR' })
      await assert.rejects(call(other.import, 'economicEvents.list', { updateId, query: '2026-08' }), { publicCode: 'NOT_FOUND' })
    })
    await t.test('待核对与待分类搜索所有真实成员，候选不冒充命中，不改变成员范围', async () => {
      for (const group of ['review', 'category']) for (const query of ['2024-02-29', '2026-08']) {
        const expected = expectedIssues.filter(issue => (group === 'category') === (issue.issueType === 'category_assignment') &&
          issue.targetIds.some(id => events.some(e => e.eventId === id && e.localAt && e.localAt.startsWith(query))))
        const result = await collect(issues, { group, status: 'open', query, pageSize: 3 }, 'issueId')
        assert.deepEqual(result.rows.map(i => i.issueId), ordered(expected, 'issueId').map(i => i.issueId), group + ':' + query)
        for (const issue of result.rows) assert.equal(issue.memberCount - issue.candidateCount, expected.find(i => i.issueId === issue.issueId).targetIds.length)
      }
      const matching = expectedIssues.filter(issue => issue.issueType !== 'category_assignment' && issue.targetIds.some(id => events.some(e => e.eventId === id && e.categoryId)))
      const byCategory = await collect(issues, { group: 'review', status: 'open', query: '合成餐饮新名', pageSize: 3 }, 'issueId')
      assert.deepEqual(byCategory.rows.map(i => i.issueId), ordered(matching, 'issueId').map(i => i.issueId))
      assert.equal((await issues({ group: 'review', query: '别人的分类' })).total, 0)
      const first = await issues({ group: 'review', query: '2026-08', pageSize: 1 })
      await assert.rejects(issues({ group: 'review', query: '2026-09', cursor: first.nextCursor }), { publicCode: 'INVALID_CURSOR' })
    })
    await t.test('页面因长字段提前截断后，日期游标仍完整遍历且读取不改变账务', async () => {
      await lab.owner.execute(`UPDATE catledger_import_rows SET note_raw=? WHERE uid=?`, ['合成备注'.repeat(200), uid])
      const before = (await lab.owner.execute('SELECT event_id,version,status,category_id FROM catledger_economic_events WHERE uid=? ORDER BY event_id', [uid]))[0]
      const result = await collect(read)
      assert.ok(result.pages[0].items.length < 40)
      assert.deepEqual(result.rows.map(e => e.eventId), ordered(events, 'eventId').map(e => e.eventId))
      assert.deepEqual((await lab.owner.execute('SELECT event_id,version,status,category_id FROM catledger_economic_events WHERE uid=? ORDER BY event_id', [uid]))[0], before)
      assert.equal(Number((await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid=?', [uid]))[0][0].n), 0)
    })
  } finally { await lab.close() }
})
