const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { setup } = require('./helpers/bank-pairing')

test('重复判断修改：真实解析、最小权限、事务与来源保全', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 240000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    async function merged(options = {}) {
      const c = await setup({ apiPool, importPool, count: 1, ...options })
      const page = await c.pairings()
      await c.resolve({ scopeToken: page.scopeToken, selection: { mode: 'all_except', excludedPairKeys: [] } })
      c.eventId = page.items[0].platform.eventId
      c.preview = () => c.imp('economicEvents.duplicateReview', { updateId: c.updateId, eventId: c.eventId })
      c.input = async () => ({ requestId: randomUUID(), updateId: c.updateId, eventId: c.eventId,
        updateVersion: (await c.summary()).update.version, eventVersion: (await c.preview()).eventVersion, decision: 'distinct' })
      c.revise = input => c.imp('financeUpdates.reviseDuplicate', input)
      return c
    }
    await t.test('单对直接合并后改为独立记录，证据与原主记录人工分类保留，未知性质继续阻断', async () => {
      const c = await merged()
      const preview = await c.preview()
      assert.equal(preview.canSplit, true); assert.equal(preview.count, 2)
      const [[before]] = await lab.owner.execute('SELECT GROUP_CONCAT(evidence_id ORDER BY evidence_id) AS ids FROM catledger_event_evidence WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      const [rows] = await lab.owner.execute('SELECT category_id AS id FROM catledger_categories WHERE uid=? AND kind=\'expense\' AND parent_id IS NOT NULL LIMIT 1', [c.uid])
      const selected = rows[0].id
      const categoryIssue = (await c.imp('reviewIssues.list', { updateId: c.updateId, group:'category', status:'open' })).items.find(item => item.issueType === 'category_assignment')
      await c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await c.summary()).update.version,
        issueId: categoryIssue.issueId, issueVersion: categoryIssue.version, decision:'apply_fields', fields:{ categoryId:selected } })
      const input = await c.input(), result = await c.revise(input)
      assert.deepEqual(await c.revise(input), result)
      assert.equal((await c.pairings()).total, 0, '已否定的这一来源对不会立即再次合并')
      const [events] = await lab.owner.execute('SELECT event_id AS id, economic_nature AS nature, status, category_id AS category FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(events.length, 2)
      assert.equal(events.find(item => item.id === c.eventId).category, selected)
      assert.equal(events.find(item => item.id !== c.eventId).nature, 'unknown')
      assert.equal(events.find(item => item.id !== c.eventId).status, 'needs_action')
      const [[after]] = await lab.owner.execute('SELECT GROUP_CONCAT(evidence_id ORDER BY evidence_id) AS ids, COUNT(DISTINCT event_id) AS events FROM catledger_event_evidence WHERE uid=? AND update_id=?', [c.uid, c.updateId])
      assert.equal(after.ids, before.ids); assert.equal(Number(after.events), 2)
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      const [[ledger]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid=?', [c.uid])
      assert.equal(Number(ledger.n), 0)
      assert.equal((await c.api('accounts.list')).accounts.find(item => item.accountId === c.accountId).bookBalanceMinor, '0')
      const receipt = await c.imp('imports.commandResult', { requestId: input.requestId, commandAction: 'financeUpdates.reviseDuplicate' })
      assert.equal(receipt.appliedVersion, result.appliedVersion)
      await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: result.update.version })
      assert.equal((await c.pairings()).total, 0)
      c.updateId = await c.prepare(); await c.map()
      assert.equal((await c.pairings()).total, 0, '重导不能复用被纠正的同笔记忆')
    })
    await t.test('旧版已合并记录无快照也能恢复，退款继续待核对', async () => {
      const c = await merged({ refund: true })
      await lab.owner.execute(`UPDATE catledger_economic_events SET field_sources_json=JSON_REMOVE(field_sources_json,'$.mergeOrigins') WHERE uid=? AND update_id=?`, [c.uid,c.updateId])
      await c.revise(await c.input())
      const [events] = await lab.owner.execute('SELECT status,economic_nature AS nature FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid,c.updateId])
      assert.equal(events.length, 2); assert.equal(events.find(row => row.nature === 'refund').status, 'needs_action')
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
    })
    await t.test('双版本、跨用户、正式入账及并发保护', async () => {
      const c = await merged(), input = await c.input(), other = await merged()
      await assert.rejects(other.revise(input), { publicCode: 'NOT_FOUND' })
      await assert.rejects(c.revise({ ...input, requestId: randomUUID(), eventVersion: input.eventVersion - 1 }), { publicCode: 'CONFLICT' })
      await assert.rejects(c.revise({ ...input, requestId: randomUUID(), updateVersion: input.updateVersion - 1 }), { publicCode: 'CONFLICT' })
      const [a,b] = await Promise.all([c.revise(input),c.revise(input)])
      assert.deepEqual(a,b)
      const [[actions]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_finance_actions WHERE uid=? AND update_id=? AND action_type='revise_duplicate'", [c.uid,c.updateId])
      assert.equal(Number(actions.n),1)
      const posted = await merged(), postedInput = await posted.input()
      await posted.post()
      assert.equal((await posted.preview()).canSplit,false)
      await assert.rejects(posted.revise({ ...postedInput, updateVersion:(await posted.summary()).update.version,
        eventVersion:(await posted.preview()).eventVersion }), { publicCode:'VALIDATION_ERROR' })
    })
    await t.test('证据搬移失败全部回滚；另一笔同额合并不受影响', async () => {
      const c = await merged({ count: 2 }), input = await c.input()
      await lab.owner.query(`CREATE TRIGGER synthetic_split_rollback BEFORE UPDATE ON catledger_event_evidence FOR EACH ROW
        BEGIN IF OLD.event_id='${c.eventId}' AND NEW.event_id <> OLD.event_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic split rollback'; END IF; END`)
      try { await assert.rejects(c.revise(input), { publicCode:'INTERNAL_ERROR' }) }
      finally { await lab.owner.query('DROP TRIGGER synthetic_split_rollback') }
      assert.equal((await c.preview()).eventVersion,input.eventVersion)
      assert.equal((await c.summary()).update.version,input.updateVersion)
      await c.revise(input)
      const [[events]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid,c.updateId])
      assert.equal(Number(events.n),3)
      const [[duplicate]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_event_evidence WHERE uid=? AND update_id=? AND evidence_role='supporting'", [c.uid,c.updateId])
      assert.equal(Number(duplicate.n),1)
    })
    await t.test('不同笔可以重新合并，只接受该对和双方当前版本，重试不重复；再次拆开后整批入账两笔', async () => {
      const c = await merged({ bankNature: '消费' })
      await c.revise(await c.input())
      const preview = await c.preview()
      assert.equal(preview.kind, 'distinct', JSON.stringify(preview))
      const pair = preview.pairs[0]
      assert.equal(preview.kind, 'distinct'); assert.equal(preview.canMerge, true)
      const listed = (await c.imp('economicEvents.list', { updateId:c.updateId, status:'ready' })).items
      assert.equal(listed.filter(row => row.pairingDecision === 'distinct').length, 2)
      const input = { ...await c.input(), decision:'same', pairKey:pair.pairKey,
        otherEventId:pair.otherEventId, otherEventVersion:pair.otherEventVersion }
      await assert.rejects(c.revise({ ...input, requestId:randomUUID(), otherEventVersion:pair.otherEventVersion - 1 }), { publicCode:'CONFLICT' })
      await assert.rejects(c.revise({ ...input, requestId:randomUUID(), pairKey:'a'.repeat(64) }), { publicCode:'CONFLICT' })
      const saved = await c.revise(input)
      assert.deepEqual(await c.revise(input), saved)
      assert.equal((await c.preview()).kind, 'same')
      assert.equal((await c.preview()).canSplit, true)
      await c.revise(await c.input())
      const post = await c.post()
      assert.equal(post.posting.createdTransactionCount, 2)
      const [rows] = await lab.owner.execute('SELECT amount_minor AS amount FROM catledger_transactions WHERE uid=? AND type=\'expense\'', [c.uid])
      assert.deepEqual(rows.map(row => String(row.amount)).sort(), ['1234','1234'])
      assert.equal((await c.api('accounts.list')).accounts.find(row => row.accountId === c.accountId).bookBalanceMinor, '-2468')
    })
    await t.test('误关联历史账目可重开、重选同一账目或改为独立，正式原账不被修改', async () => {
      const c = await merged({ bankNature:'消费' })
      const prior = await c.api('transactions.create', { requestId:randomUUID(), type:'expense', sourceAccountId:c.accountId,
        categoryId:c.user.categories.find(row => row.kind === 'expense').id, amountMinor:'1234',
        occurredLocalAt:'2026-09-01T12:00:00', timezoneOffsetMinutes:-480, note:'合成历史记录' })
      await c.imp('financeUpdates.organize', { requestId:randomUUID(), updateId:c.updateId, version:(await c.summary()).update.version })
      async function history(decision) {
        const issue = (await c.imp('reviewIssues.list', { updateId:c.updateId, status:'open' })).items.find(row => row.primaryReasonCode === 'historical_duplicate_candidate')
        assert.ok(issue)
        return c.imp('reviewIssues.resolve', { requestId:randomUUID(), updateId:c.updateId, updateVersion:(await c.summary()).update.version,
          issueId:issue.issueId, issueVersion:issue.version, decision, ...(decision === 'link_existing_transaction' ? { transactionId:prior.transactionId } : {}) })
      }
      for (let index=0; index<2; index++) {
        await history('link_existing_transaction')
        assert.equal((await c.preview()).kind, 'historical')
        const input={ ...await c.input(), decision:'reopen' }, reopened=await c.revise(input)
        assert.deepEqual(await c.revise(input),reopened)
        await assert.rejects(c.post(), { publicCode:'UNRESOLVED_IMPORT' })
      }
      await history('confirm_distinct')
      await c.post()
      const [[original]] = await lab.owner.execute('SELECT version, amount_minor AS amount FROM catledger_transactions WHERE uid=? AND transaction_id=?', [c.uid,prior.transactionId])
      assert.equal(Number(original.version),prior.version); assert.equal(String(original.amount),'1234')
      assert.equal((await c.api('accounts.list')).accounts.find(row => row.accountId === c.accountId).bookBalanceMinor, '-2468')
    })
    await t.test('同一可靠身份再次导入只能复用，不能用修改判断伪造独立来源', async () => {
      const c=await merged({ bankNature:'消费' }); await c.post()
      c.updateId=await c.prepare(c.contents.map(content => Buffer.concat([content,Buffer.from('\n')])))
      const rows=(await c.imp('economicEvents.list', { updateId:c.updateId,status:'duplicate' })).items
      assert.ok(rows.length)
      c.eventId=rows[0].eventId
      const preview=await c.preview()
      assert.equal(preview.canSplit,false); assert.notEqual(preview.kind,'historical')
      await assert.rejects(c.revise(await c.input()), { publicCode:'VALIDATION_ERROR' })
      assert.equal((await c.api('accounts.list')).accounts.find(row => row.accountId === c.accountId).bookBalanceMinor,'-1234')
    })
  } finally { await lab.close() }
})
