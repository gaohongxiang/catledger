const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const { persistPlan, parseJson } = require('../cloudfunctions/catledger-import/src/finance-update-repository')
const { REVIEW_ISSUE_VERSION } = require('../cloudfunctions/catledger-import/src/domain-versions')

test('银行与支付平台同笔核对：真实解析、账户确认、人工裁决及旧草稿升级', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    async function setup({ refund = false, bankType = '', differentAccount = false, original = false, bankOriginal = false, exactRefund = false,
      bankTime = '2026-09-01 12:34', platformTime = '2026-09-01 12:34:45' } = {}) {
      const subject = 'synthetic-channel-' + randomUUID()
      const services = localServices({ apiPool, importPool, subject })
      const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
      const user = await api('bootstrap')
      const accountId = (await api('accounts.create', { requestId: randomUUID(), type: 'credit', name: '合成核对信用卡' })).accountId
      const otherId = differentAccount ? (await api('accounts.create', { requestId: randomUUID(), type: 'credit', name: '合成另一卡' })).accountId : accountId
      const direction = refund ? '收入' : '支出'
      const order = exactRefund ? 'SYNTHETIC-ORIGINAL-ORDER' : ''
      const contents = [
        Buffer.from(['微信支付账单明细,,,,,,,,,,,', '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
          ...(original ? [`2026-08-31 12:34:45,商户消费,合成平台商户,合成商品,支出,12.34,合成银行信用卡(1234),支付成功,SYNTHETIC-ORIGINAL,${order},,`] : []),
          `${platformTime},${refund ? '退款' : '商户消费'},合成平台商户,合成商品,${direction},12.34,合成银行信用卡(1234),${refund ? '退款成功' : '支付成功'},SYNTHETIC-CHANNEL-${randomUUID()},${order},,`].join('\n')),
        Buffer.from(['交易日期,交易金额,收支,交易类型,摘要,账户',
          ...(bankOriginal ? ['2026-08-31 12:34,12.34,支出,消费,财付通-合成收单商户,****1234'] : []),
          `${bankTime},12.34,${direction},${bankType},财付通-合成收单商户,****1234`].join('\n'))
      ]
      const batchIds = []
      for (const [index, content] of contents.entries()) {
        const file = (await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: `合成渠道${index}.csv`, size: content.length }] })).files[0]
        services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        let parsed = await imp('imports.parseFile', { requestId: randomUUID(), ...input })
        if (parsed.bankPreview) {
          const preview = parsed.bankPreview
          parsed = await imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: { ...preview.suggested,
            schemaVersion: 1, headerRow: preview.headerRow, sheetIndex: preview.sheetIndex, headerToken: preview.headerToken, statementKind: 'credit' } })
        }
        batchIds.push(parsed.batch.batchId)
      }
      const prepared = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds })
      const c = { services, subject, api, imp, uid: user.uid, accountId, otherId, updateId: prepared.updateId, categoryId: user.categories.find(item => item.kind === 'expense').id }
      c.summary = () => imp('financeUpdates.summary', { updateId: c.updateId })
      c.issues = async () => (await imp('reviewIssues.list', { updateId: c.updateId, status: 'open' })).items
      c.candidates = async () => (await c.issues()).filter(item => item.primaryReasonCode === 'bank_channel_same_event_candidate')
      c.resolve = async (issue, decision, extra = {}) => imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: c.updateId,
        updateVersion: (await c.summary()).update.version, issueId: issue.issueId, issueVersion: issue.version, decision, ...extra })
      c.recheck = async () => imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
      c.post = async () => imp('financeUpdates.post', { requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
      c.members = async issue => (await imp('reviewIssues.members', { updateId: c.updateId, issueId: issue.issueId, memberKind: 'event' })).items
      c.map = async () => {
        const issues = (await imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts' })).items.filter(item => item.status === 'open')
        const decisions = []
        for (const issue of issues) {
          const members = await c.members(issue)
          const bank = members[0].event.primaryEvidence.sourceType === 'bank'
          decisions.push({ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: bank ? c.otherId : c.accountId } })
        }
        if (decisions.length) await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await c.summary()).update.version, decisions })
      }
      return c
    }
    async function oldPlan(c) { await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v30' WHERE uid = ? AND update_id = ?", [c.uid, c.updateId]) }
    async function legacyOpen(c) {
      // 只复原旧版已存的核对结构；来源行与账户仍由真实解析和账户确认生成。
      const [events] = await lab.owner.execute(`SELECT event_id AS eventId, version, reason_codes_json AS reasons
        FROM catledger_economic_events WHERE uid = ? AND update_id = ? AND event_local_date = '2026-09-01'`, [c.uid, c.updateId])
      assert.equal(events.length, 2)
      const ids = events.map(event => event.eventId)
      await lab.owner.execute(`UPDATE catledger_review_issues i SET status = 'superseded', blocking = 0, version = version + 1
        WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND i.issue_type <> 'account_mapping'
          AND EXISTS (SELECT 1 FROM catledger_review_issue_members m WHERE m.uid = i.uid AND m.issue_id = i.issue_id
            AND m.object_type = 'event' AND m.member_role = 'subject' AND m.object_id IN (?, ?))`, [c.uid, c.updateId, ...ids])
      for (const event of events) {
        const reasons = [...new Set([...parseJson(event.reasons, []).filter(reason => reason !== 'bank_channel_same_event_candidate'),
          'same_event_candidate', 'relation_ambiguous'])]
        await lab.owner.execute(`UPDATE catledger_economic_events SET state = 'needs_action', status = 'needs_action',
          field_sources_json = JSON_REMOVE(field_sources_json, '$.bankChannelCandidate'), reason_codes_json = ?
          WHERE uid = ? AND update_id = ? AND event_id = ?`, [JSON.stringify(reasons), c.uid, c.updateId, event.eventId])
      }
      const issueId = randomUUID()
      await persistPlan(lab.owner, c.uid, c.updateId, { planVersion: 'organizer-plan-v30', events: [], evidence: [], relations: [],
        issues: [{ issueId, issueKey: randomUUID(), issueKeyVersion: REVIEW_ISSUE_VERSION, issueType: 'same_event', status: 'open',
          version: 1, blocking: true, primaryReasonCode: 'relation_ambiguous', memberCount: 2, candidateCount: 1,
          ruleVersion: REVIEW_ISSUE_VERSION, reasonCodes: ['same_event_candidate', 'relation_ambiguous'] }],
        members: events.map((event, index) => ({ memberId: randomUUID(), issueId, objectType: 'event', objectId: event.eventId,
          objectVersion: Number(event.version), memberRole: 'subject', sortOrder: index })) })
      await oldPlan(c)
      return (await c.issues()).find(issue => issue.issueId === issueId)
    }
    await t.test('账户确认后完整分组，拒绝银行未知主记录与旧版本；并发确认同笔只记一笔且原文和重复计数均保留', async () => {
      const c = await setup()
      assert.equal((await c.candidates()).length, 0)
      await c.map()
      const [issue] = await c.candidates()
      assert.ok(issue); assert.equal(issue.memberCount, 2); assert.equal(issue.candidateCount, 1)
      const members = await c.members(issue)
      assert.equal(issue.subject.primaryEvidence.sourceType, 'wechat')
      const primary = members.find(item => item.event.primaryEvidence.sourceType === 'wechat').event
      const bank = members.find(item => item.event.primaryEvidence.sourceType === 'bank').event
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      await assert.rejects(c.resolve(issue, 'confirm_same', { primaryEventId: bank.eventId }), { publicCode: 'VALIDATION_ERROR' })
      const data = { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await c.summary()).update.version,
        issueId: issue.issueId, issueVersion: issue.version, decision: 'confirm_same', primaryEventId: primary.eventId }
      await assert.rejects(c.imp('reviewIssues.resolve', { ...data, requestId: randomUUID(), updateVersion: data.updateVersion - 1 }), { publicCode: 'CONFLICT' })
      const [first, retried] = await Promise.all([c.imp('reviewIssues.resolve', data), c.imp('reviewIssues.resolve', data)])
      assert.equal(first.appliedVersion, retried.appliedVersion)
      let summary = await c.summary()
      assert.equal(summary.workbench.recordSummary.duplicateCount, 1)
      assert.equal(summary.coverage.recognizedRows, 2)
      assert.equal(summary.coverage.dispositionCounts.duplicate, 1)
      const [mappingDrafts] = await lab.owner.execute('SELECT source_type AS sourceType, account_id AS accountId FROM catledger_finance_update_account_mapping_drafts WHERE uid = ? AND update_id = ?', [c.uid, c.updateId])
      assert.deepEqual(mappingDrafts.map(item => item.sourceType).sort(), ['bank', 'wechat'])
      assert.ok(mappingDrafts.every(item => item.accountId === c.accountId))
      const accountIssues = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts' })).items
      assert.deepEqual(accountIssues.map(item => item.accountContext.sourceType).sort(), ['bank', 'wechat'])
      assert.ok(accountIssues.every(item => item.subject && item.subject.eventId === primary.eventId))
      const duplicates = (await c.imp('economicEvents.list', { updateId: c.updateId, status: 'duplicate' })).items
      assert.equal(duplicates.length, 1); assert.equal(duplicates[0].evidenceCount, 2); assert.equal(duplicates[0].duplicateEvidenceCount, 1)
      const rowPage = await c.imp('financeUpdates.rows', { updateId: c.updateId, pageSize: 1 })
      assert.ok(rowPage.nextCursor)
      const nextRowPage = await c.imp('financeUpdates.rows', { updateId: c.updateId, pageSize: 1, cursor: rowPage.nextCursor })
      const rows = rowPage.items.concat(nextRowPage.items)
      assert.equal(rows.length, 2)
      assert.ok(rows.every(row => row.recognized === true))
      await oldPlan(c); await c.recheck()
      assert.equal((await c.candidates()).length, 0)
      summary = await c.summary()
      assert.equal(summary.coverage.selectedEventsReadyToPost, true)
      const [posted, parallel] = await Promise.allSettled([c.post(), c.post()])
      assert.ok(posted.status === 'fulfilled' || parallel.status === 'fulfilled')
      const [[count]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid = ? AND type = 'expense' AND deleted_at IS NULL", [c.uid])
      assert.equal(Number(count.n), 1)
    })
    await t.test('退款同笔确认保留退款核对，不能变成普通收入或重复退款', async () => {
      const c = await setup({ refund: true }); await c.map()
      const [issue] = await c.candidates(); assert.ok(issue); assert.equal(issue.memberCount, 2)
      const primary = (await c.members(issue)).find(item => item.event.primaryEvidence.sourceType === 'wechat').event
      await c.resolve(issue, 'confirm_same', { primaryEventId: primary.eventId })
      const [refundIssue] = (await c.issues()).filter(item => item.issueType === 'refund_relation')
      assert.ok(refundIssue); assert.equal(refundIssue.candidateCount, 0)
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      await c.resolve(refundIssue, 'mark_refund_pending')
      await oldPlan(c); await c.recheck()
      const [event] = (await c.imp('economicEvents.list', { updateId: c.updateId, status: 'duplicate' })).items
      assert.equal(event.economicNature, 'refund'); assert.equal(event.status, 'ready')
      await c.post()
      const [[count]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid = ? AND type = 'refund' AND deleted_at IS NULL", [c.uid])
      assert.equal(Number(count.n), 1)
    })
    await t.test('确认不同笔的决定经过升级与再次账户刷新仍有效；不会自动消除银行类型阻断', async () => {
      const c = await setup(); await c.map()
      const [issue] = await c.candidates(); await c.resolve(issue, 'confirm_distinct')
      await oldPlan(c); await c.recheck(); await c.map()
      assert.equal((await c.candidates()).length, 0)
      assert.ok((await c.issues()).some(item => item.issueType === 'shared_fields'))
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
    })
    await t.test('旧版已确认不同笔且没有新标记的决定，升级仍不会重开', async () => {
      const c = await setup(); await c.map()
      const [issue] = await c.candidates(); await c.resolve(issue, 'confirm_distinct')
      await lab.owner.execute("UPDATE catledger_economic_events SET field_sources_json = JSON_REMOVE(field_sources_json, '$.bankChannelDistinctPairs') WHERE uid = ? AND update_id = ?", [c.uid, c.updateId])
      await lab.owner.execute("UPDATE catledger_review_issues SET primary_reason_code = 'relation_ambiguous' WHERE uid = ? AND issue_id = ?", [c.uid, issue.issueId])
      await oldPlan(c); await c.recheck()
      assert.equal((await c.candidates()).length, 0)
    })
    for (const scenario of [
      { name: '两个已确认账户不同', options: { differentAccount: true } },
      { name: '银行只有日期精度', options: { bankTime: '2026-09-01', platformTime: '2026-09-01 00:00:45' } }
    ]) await t.test(`旧 open 文本候选${scenario.name}：直接确认拒绝，升级撤销候选并恢复原核对`, async () => {
      const c = await setup(scenario.options); await c.map()
      assert.equal((await c.candidates()).length, 0)
      const legacy = await legacyOpen(c)
      const primary = (await c.members(legacy)).find(item => item.event.primaryEvidence.sourceType === 'wechat').event
      const version = (await c.summary()).update.version
      await assert.rejects(c.resolve(legacy, 'confirm_same', { primaryEventId: primary.eventId }), { publicCode: 'VALIDATION_ERROR' })
      assert.equal((await c.summary()).update.version, version)
      const [before] = await lab.owner.execute(`SELECT event_id AS eventId, ledger_account_id AS accountId
        FROM catledger_economic_events WHERE uid = ? AND update_id = ? ORDER BY event_id`, [c.uid, c.updateId])
      assert.equal(before.length, 2)
      await c.recheck()
      const issues = await c.issues()
      assert.ok(!issues.some(issue => issue.issueType === 'same_event'))
      assert.ok(issues.some(issue => issue.issueType === 'shared_fields'))
      const [[stored]] = await lab.owner.execute('SELECT status FROM catledger_review_issues WHERE uid = ? AND issue_id = ?', [c.uid, legacy.issueId])
      assert.equal(stored.status, 'superseded')
      const [after] = await lab.owner.execute(`SELECT event_id AS eventId, ledger_account_id AS accountId
        FROM catledger_economic_events WHERE uid = ? AND update_id = ? ORDER BY event_id`, [c.uid, c.updateId])
      assert.deepEqual(after, before)
      await assert.rejects(c.resolve(legacy, 'confirm_same', { primaryEventId: primary.eventId }), { publicCode: 'CONFLICT' })
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
    })
    await t.test('有效旧 open 文本候选升级为新规则，保留事件与账户并可人工合并入账', async () => {
      const c = await setup(); await c.map()
      const legacy = await legacyOpen(c)
      const before = await c.members(legacy)
      await c.recheck()
      const [issue] = await c.candidates()
      assert.ok(issue); assert.equal(issue.memberCount, 2); assert.equal(issue.candidateCount, 1)
      assert.notEqual(issue.issueId, legacy.issueId)
      const members = await c.members(issue)
      assert.deepEqual(members.map(item => item.event.eventId).sort(), before.map(item => item.event.eventId).sort())
      assert.ok(members.every(item => item.event.ledgerAccountId === c.accountId))
      const [[stored]] = await lab.owner.execute('SELECT status FROM catledger_review_issues WHERE uid = ? AND issue_id = ?', [c.uid, legacy.issueId])
      assert.equal(stored.status, 'superseded')
      await c.resolve(issue, 'confirm_same', { primaryEventId: issue.subject.eventId })
      await c.post()
      const [[count]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid = ? AND type = 'expense' AND deleted_at IS NULL", [c.uid])
      assert.equal(Number(count.n), 1)
    })
    for (const decision of ['confirm_same', 'confirm_distinct']) await t.test(`无需先整理即可按实际证据处理有效旧退款候选 ${decision}，保留原消费关系`, async () => {
      const c = await setup({ refund: true, original: true }); await c.map()
      const legacy = await legacyOpen(c)
      const primary = (await c.members(legacy)).find(item => item.event.primaryEvidence.sourceType === 'wechat').event
      const [before] = await lab.owner.execute(`SELECT relation_id AS relationId, status, source_event_id AS sourceId, target_event_id AS targetId
        FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ? ORDER BY relation_id`, [c.uid, c.updateId])
      assert.ok(before.some(relation => relation.status === 'proposed'))
      await c.resolve(legacy, decision, decision === 'confirm_same' ? { primaryEventId: primary.eventId } : {})
      const [after] = await lab.owner.execute(`SELECT relation_id AS relationId, status, source_event_id AS sourceId, target_event_id AS targetId
        FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ? ORDER BY relation_id`, [c.uid, c.updateId])
      assert.deepEqual(after, before)
      await c.recheck()
      assert.equal((await c.candidates()).length, 0)
      const refundIssue = (await c.issues()).find(issue => issue.issueType === 'refund_relation')
      assert.ok(refundIssue); assert.ok(refundIssue.candidateCount > 0)
    })
    for (const exactRefund of [false, true]) await t.test(`退款已有${exactRefund ? '确定' : '待确认'}原消费关联，同笔合并后关系保留`, async () => {
      const c = await setup({ refund: true, original: true, exactRefund }); await c.map()
      const [issue] = await c.candidates(); assert.ok(issue); assert.equal(issue.memberCount, 2)
      const primary = (await c.members(issue)).find(item => item.event.primaryEvidence.sourceType === 'wechat').event
      const [before] = await lab.owner.execute("SELECT relation_id AS relationId, status FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ? AND source_event_id = ? AND relation_type = 'refund_of'", [c.uid, c.updateId, primary.eventId])
      assert.ok(before.some(item => item.status === (exactRefund ? 'confirmed' : 'proposed')))
      await c.resolve(issue, 'confirm_same', { primaryEventId: primary.eventId })
      const [after] = await lab.owner.execute('SELECT relation_id AS relationId, status FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ? AND source_event_id = ?', [c.uid, c.updateId, primary.eventId])
      assert.deepEqual(after, before)
      if (!exactRefund) assert.ok((await c.issues()).some(item => item.issueType === 'refund_relation' && item.candidateCount > 0))
      else { await oldPlan(c); await c.recheck(); await c.post() }
    })
    await t.test('退款确认不同笔后原消费候选仍可选', async () => {
      const c = await setup({ refund: true, original: true }); await c.map()
      const [issue] = await c.candidates(); await c.resolve(issue, 'confirm_distinct')
      const refundIssue = (await c.issues()).find(item => item.issueType === 'refund_relation')
      assert.ok(refundIssue); assert.ok(refundIssue.candidateCount > 0)
      const relationMembers = await c.imp('reviewIssues.members', { updateId: c.updateId, issueId: refundIssue.issueId, memberKind: 'relation' })
      assert.ok(relationMembers.items.every(item => item.relation.status === 'proposed'))
    })
    await t.test('银行原消费合并时迁移被引用关系，退款随后合并保留一个原消费候选', async () => {
      const c = await setup({ refund: true, bankType: '退款', original: true, bankOriginal: true }); await c.map()
      let issues = await c.candidates(); assert.equal(issues.length, 2)
      for (const nature of ['expense', 'refund']) {
        issues = await c.candidates()
        const issue = issues.find(item => item.subject.economicNature === nature)
        assert.ok(issue); assert.equal(issue.memberCount, 2)
        await c.resolve(issue, 'confirm_same', { primaryEventId: issue.subject.eventId })
      }
      const [relations] = await lab.owner.execute("SELECT source_event_id AS sourceId, target_event_id AS targetId FROM catledger_economic_event_relations WHERE uid = ? AND update_id = ? AND status = 'proposed'", [c.uid, c.updateId])
      assert.equal(relations.length, 1)
      const refundIssue = (await c.issues()).find(item => item.issueType === 'refund_relation')
      assert.ok(refundIssue); assert.equal(refundIssue.candidateCount, 1)
      await c.resolve(refundIssue, 'link_refund', { targetEventId: relations[0].targetId })
      await c.post()
      const [transactions] = await lab.owner.execute('SELECT type FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL', [c.uid])
      assert.deepEqual(transactions.map(item => item.type).sort(), ['expense', 'refund'])
    })
    await t.test('合并迁移证据后发生故障，事件、原文、账户决定和回执全部回滚，再试原请求可完成', async () => {
      const c = await setup(); await c.map()
      const [issue] = await c.candidates()
      const version = (await c.summary()).update.version
      const request = { requestId: randomUUID(), updateId: c.updateId, updateVersion: version,
        issueId: issue.issueId, issueVersion: issue.version, decision: 'confirm_same', primaryEventId: issue.subject.eventId }
      let failed = false
      const faultPool = { async getConnection() {
        const connection = await importPool.getConnection()
        return new Proxy(connection, { get(target, property) {
          if (property === 'execute') return async (sql, values) => {
            if (!failed && sql.includes('DELETE FROM catledger_economic_events')) { failed = true; throw new Error('synthetic-merge-fault') }
            return target.execute(sql, values)
          }
          return typeof target[property] === 'function' ? target[property].bind(target) : target[property]
        } })
      } }
      const fault = localServices({ apiPool, importPool: faultPool, subject: c.subject, objects: c.services.objects })
      await assert.rejects(call(fault.import, 'reviewIssues.resolve', request), { publicCode: 'INTERNAL_ERROR' })
      assert.equal(failed, true)
      assert.equal((await c.summary()).update.version, version)
      const [[state]] = await lab.owner.execute(`SELECT COUNT(DISTINCT event_id) AS events, COUNT(*) AS evidence
        FROM catledger_event_evidence WHERE uid = ? AND update_id = ?`, [c.uid, c.updateId])
      assert.equal(Number(state.events), 2); assert.equal(Number(state.evidence), 2)
      assert.equal((await c.candidates()).length, 1)
      const [drafts] = await lab.owner.execute('SELECT DISTINCT event_id FROM catledger_finance_update_account_mapping_drafts WHERE uid = ? AND update_id = ?', [c.uid, c.updateId])
      assert.equal(drafts.length, 2)
      await c.imp('reviewIssues.resolve', request)
      assert.equal((await c.summary()).workbench.recordSummary.duplicateCount, 1)
    })
    await t.test('已有 v30 草稿原位增加候选，保留事件/账户/分类；另一用户不可读取或裁决', async () => {
      const c = await setup({ bankType: '消费', differentAccount: true }); await c.map()
      assert.equal((await c.candidates()).length, 0)
      const [before] = await lab.owner.execute('SELECT event_id AS eventId FROM catledger_economic_events WHERE uid = ? AND update_id = ?', [c.uid, c.updateId])
      await lab.owner.execute('UPDATE catledger_economic_events SET ledger_account_id = ?, category_id = ?, manual_field_mask = 8 WHERE uid = ? AND update_id = ?', [c.accountId, c.categoryId, c.uid, c.updateId])
      await oldPlan(c); await c.recheck()
      const [issue] = await c.candidates(); assert.ok(issue)
      const members = await c.members(issue)
      assert.deepEqual(members.map(item => item.event.eventId).sort(), before.map(item => item.eventId).sort())
      assert.ok(members.every(item => item.event.ledgerAccountId === c.accountId && item.event.categoryId === c.categoryId))
      const other = await setup()
      await assert.rejects(other.imp('reviewIssues.members', { updateId: c.updateId, issueId: issue.issueId, memberKind: 'event' }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(other.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await c.summary()).update.version,
        issueId: issue.issueId, issueVersion: issue.version, decision: 'confirm_distinct' }), { publicCode: 'NOT_FOUND' })
    })
  } finally { await lab.close() }
})
