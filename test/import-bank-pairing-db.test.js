const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { setup } = require('./helpers/bank-pairing')

test('配对真实解析/handler/MySQL：范围、原子保存及整批入账', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 240000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    await t.test('100组跨页唯一候选一次原子保存，回执重放、来源和最终余额正确', async () => {
      const c = await setup({ apiPool, importPool, count: 100 })
      const balanceOf = async () => (await c.api('accounts.list')).accounts.find(row => row.accountId === c.accountId)
      assert.equal((await balanceOf()).bookBalanceMinor, '0')
      const preview = await c.pairings({ pageSize: 4 })
      assert.equal(preview.total, 100); assert.equal(preview.items.length, 4); assert.equal(preview.scopeSourceCount, 200)
      const second = await c.pairings({ pageSize: 4, cursor: preview.nextCursor })
      assert.equal(second.scopeToken, preview.scopeToken)
      const issues = (await c.imp('reviewIssues.list', { updateId: c.updateId, status: 'open', pageSize: 100 })).items
      const issue = issues.find(item => item.primaryReasonCode === 'bank_channel_same_event_candidate')
      assert.equal((await c.pairings({ mode: 'ambiguous', issueId: issue.issueId })).total, 1, '逐对入口也能打开唯一候选')
      const input = { requestId: randomUUID(), scopeToken: preview.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } }
      const result = await c.resolve(input)
      assert.deepEqual(result.pairing, { savedCount: 100, totalCount: 100, remainingCount: 0, batchSavedCount: 100, continuationToken: null })
      assert.deepEqual(await c.resolve(input), result)
      const [[before]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ?', [c.uid])
      assert.equal(Number(before.count), 0)
      assert.equal((await balanceOf()).bookBalanceMinor, '0', '保存配对不能提前改变正式信用卡余额')
      const [[evidence]] = await lab.owner.execute('SELECT COUNT(*) AS count, COUNT(DISTINCT event_id) AS events FROM catledger_event_evidence WHERE uid = ? AND update_id = ?', [c.uid, c.updateId])
      assert.equal(Number(evidence.count), 200); assert.equal(Number(evidence.events), 100)
      const [[orphans]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_review_issue_members m
        LEFT JOIN catledger_economic_events e ON e.uid=m.uid AND e.event_id=m.object_id
        WHERE m.uid=? AND m.update_id=? AND m.object_type='event' AND e.event_id IS NULL`, [c.uid, c.updateId])
      assert.equal(Number(orphans.count), 0)
      const posted = await c.post()
      assert.equal(posted.posting.createdTransactionCount, 100)
      const [[balance]] = await lab.owner.execute('SELECT SUM(amount_minor) AS total FROM catledger_transactions WHERE uid = ?', [c.uid])
      assert.equal(String(balance.total), '123400')
      const account = await balanceOf()
      assert.equal(account.bookBalanceMinor, '-123400'); assert.equal(account.displayBalanceMinor, '123400')
    })
    await t.test('2银行+2平台完整图不被一页1对误判唯一，明确两对只生成两笔', async () => {
      const c = await setup({ apiPool, importPool, count: 2, ambiguous: true })
      assert.equal((await c.pairings()).total, 0)
      const first = await c.pairings({ mode: 'ambiguous', pageSize: 1 })
      assert.equal(first.total, 4); assert.equal(first.suggestedTotal, 0)
      const all = await c.pairings({ mode: 'ambiguous' }), a = all.items[0]
      const b = all.items.find(pair => pair.bank.eventId !== a.bank.eventId && pair.platform.eventId !== a.platform.eventId)
      const overlap = all.items.find(pair => pair.pairKey !== a.pairKey && pair.bank.eventId === a.bank.eventId)
      await assert.rejects(c.resolve({ scopeToken: first.scopeToken, selection: { mode: 'include', pairs: [a, overlap].map(pair => ({ pairKey: pair.pairKey, decision: 'same' })) } }), { publicCode: 'VALIDATION_ERROR' })
      await c.resolve({ scopeToken: first.scopeToken, selection: { mode: 'include', pairs: [a, b].map(pair => ({ pairKey: pair.pairKey, decision: 'same' })) } })
      assert.equal((await c.post()).posting.createdTransactionCount, 2)
    })
    await t.test('250对跨页排除3对，100/100/47有界续批：中途失败回滚、原请求恢复、前序回执可重放', async () => {
      const c = await setup({ apiPool, importPool, count: 250 })
      const preview = await c.pairings(), excludedPairKeys = preview.items.slice(0, 3).map(pair => pair.pairKey)
      const firstInput = { requestId: randomUUID(), scopeToken: preview.scopeToken, selection: { mode: 'all_except', excludedPairKeys } }
      const first = await c.resolve(firstInput)
      assert.equal(first.pairing.savedCount, 100); assert.equal(first.pairing.remainingCount, 147)
      const remainder = await c.pairings()
      assert.equal(remainder.total, 150)
      const rejected = remainder.items.filter(pair => !excludedPairKeys.includes(pair.pairKey)).at(-1).bank.eventId
      await lab.owner.query(`CREATE TRIGGER synthetic_pair_rollback BEFORE DELETE ON catledger_economic_events FOR EACH ROW
        BEGIN IF OLD.event_id='${rejected}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic pairing rollback'; END IF; END`)
      const continuation = { requestId: randomUUID(), continuationToken: first.pairing.continuationToken }
      try { await assert.rejects(c.resolve(continuation), { publicCode: 'INTERNAL_ERROR' }) }
      finally { await lab.owner.query('DROP TRIGGER synthetic_pair_rollback') }
      assert.equal((await c.pairings()).total, 150, '失败批没有丢失或部分合并')
      const second = await c.resolve(continuation)
      assert.equal(second.pairing.savedCount, 200); assert.equal(second.pairing.remainingCount, 47)
      assert.deepEqual(await c.resolve(firstInput), first, '旧回执不被后续版本覆盖')
      const last = await c.resolve({ continuationToken: second.pairing.continuationToken })
      assert.equal(last.pairing.savedCount, 247); assert.equal(last.pairing.remainingCount, 0)
      assert.deepEqual((await c.pairings()).items.map(pair => pair.pairKey), excludedPairKeys)
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      const [[events]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(Number(events.n), 253)
    })
    await t.test('拒绝一对只移除一条边，可靠身份在重新整理和重导时复用', async () => {
      const c = await setup({ apiPool, importPool, count: 2, ambiguous: true })
      const preview = await c.pairings({ mode: 'ambiguous' })
      await c.resolve({ scopeToken: preview.scopeToken, selection: { mode: 'include', pairs: [{ pairKey: preview.items[0].pairKey, decision: 'distinct' }] } })
      assert.equal((await c.pairings({ mode: 'ambiguous' })).total, 3)
      await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
      assert.equal((await c.pairings({ mode: 'ambiguous' })).total, 3)
      c.updateId = await c.prepare(); await c.map()
      assert.equal((await c.pairings({ mode: 'ambiguous' })).total, 3)
      // 将这批来源的账户草稿按现有正式映射结构预置，模拟以前已入账确认过的账户。
      await lab.owner.execute(`INSERT INTO catledger_import_account_mappings
        (mapping_id, uid, source_type, payment_method_key, account_id, version)
        SELECT MIN(draft_mapping_id), uid, source_type, payment_method_key, account_id, 1
        FROM catledger_finance_update_account_mapping_drafts WHERE uid=? AND update_id=?
        GROUP BY uid, source_type, payment_method_key, account_id`, [c.uid, c.updateId])
      c.updateId = await c.prepare()
      assert.equal((await c.pairings({ mode: 'ambiguous' })).total, 3, '已有账户映射时重导不需再map也不重开拒绝边')
    })
    await t.test('具体可靠同笔决定跨临时事件身份重导复用；金额实质变化不复用', async () => {
      const c = await setup({ apiPool, importPool, count: 1 })
      const preview = await c.pairings()
      await c.resolve({ scopeToken: preview.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } })
      const firstId = c.updateId
      c.updateId = await c.prepare(); await c.map()
      assert.notEqual(c.updateId, firstId)
      assert.equal((await c.pairings()).total, 0)
      const [[events]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(Number(events.n), 1)
      c.updateId = await c.prepare(c.contents.map(buffer => Buffer.from(buffer.toString().replaceAll('12.34', '12.35')))); await c.map()
      const [[changed]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(Number(changed.n), 2, '可靠身份金额冲突保留双方证据并待核对')
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
    })
    await t.test('外部revision、账户归档与跨用户范围拒绝；重复与并发提交只保存一次', async () => {
      const c = await setup({ apiPool, importPool, count: 101 })
      const preview = await c.pairings()
      const input = { requestId: randomUUID(), scopeToken: preview.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } }
      const [a, b] = await Promise.all([c.resolve(input), c.resolve(input)])
      assert.deepEqual(a, b); assert.equal(a.pairing.savedCount, 100)
      await c.api('accounts.create', { requestId: randomUUID(), name: '合成外部变化', type: 'cash' })
      await assert.rejects(c.resolve({ continuationToken: a.pairing.continuationToken }), { publicCode: 'STALE_VIEW' })
      assert.equal((await c.pairings()).total, 1)
      const other = await setup({ apiPool, importPool, count: 1 })
      await assert.rejects(other.resolve({ scopeToken: (await c.pairings()).scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } }), { publicCode: 'INVALID_CURSOR' })
      const p = await other.pairings()
      await lab.owner.execute('UPDATE catledger_accounts SET archived_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND account_id=?', [other.uid, other.accountId])
      await assert.rejects(other.resolve({ scopeToken: p.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } }), { publicCode: 'STALE_VIEW' })
    })
    await t.test('退款合并保留退款关系阻断与两条原文，不变成普通消费', async () => {
      const c = await setup({ apiPool, importPool, count: 1, refund: true })
      const preview = await c.pairings()
      assert.deepEqual(preview.scopeNatureCounts, { expense: 0, refund: 1 })
      await c.resolve({ scopeToken: preview.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } })
      const [[event]] = await lab.owner.execute('SELECT economic_nature AS nature, status FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(event.nature, 'refund'); assert.equal(event.status, 'needs_action')
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      const [[evidence]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_event_evidence WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(Number(evidence.n), 2)
    })
    await t.test('仅物理行身份不推广为重导自动合并规则', async () => {
      const c = await setup({ apiPool, importPool, count: 1, reliable: false })
      const p = await c.pairings()
      await c.resolve({ scopeToken: p.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } })
      const [[rules]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_bank_channel_decisions WHERE uid=?', [c.uid])
      assert.equal(Number(rules.n), 0)
      c.updateId = await c.prepare(); await c.map()
      assert.equal((await c.pairings()).total, 1)
    })
  } finally { await lab.close() }
})
