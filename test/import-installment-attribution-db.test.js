const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call } = require('./helpers/local-services')
const grants = require('../scripts/runtime-role-grants')
const presentation = require('../miniprogram/packages/finance/pages/import-workbench/presentation')
const { digestParts } = require('../cloudfunctions/catledger-import/src/digest')
const REASON = 'installment_attribution_required'
const PLAN_A = '电销现分按月收6期', PLAN_B = '电销总账分月6期'

test('分期归属：真实 MySQL JSON、往返保存、旧事项修复与页签卡片',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const apiPool = await lab.role('api', grants.api), importer = await lab.role('import', grants.importer)
      let failRepair = false
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failRepair && /SET status = 'superseded'/.test(sql)) throw Error('synthetic repair rollback')
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      const summary = c => c.imp('financeUpdates.summary', { updateId: c.updateId })
      const events = async (c, view = 'active') => (await c.imp('economicEvents.list', { updateId: c.updateId, view })).items
      const issues = async c => (await c.imp('reviewIssues.list', { updateId: c.updateId, status: 'open', issueType: 'installment_origin' })).items
      const dump = async (c, table, order) => (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${order}`, [c.uid]))[0]
      async function context() {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-attribution-' + randomUUID() })
        const c = { services, api: (action, data) => call(services.api, action, data), imp: (action, data) => call(services.import, action, data) }
        c.uid = (await c.api('bootstrap')).uid
        c.accountId = (await c.api('accounts.create', { requestId: randomUUID(), type: 'credit', name: '合成归属信用卡',
          openingDisplayBalanceMinor: '0', occurredLocalAt: '2026-07-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        const rows = [
          [PLAN_A + '第3期共6期', '200.00'], [PLAN_B + '第3期共6期', '300.00'],
          ['分期付款利息第3期共6期', '5.00'], ['分期付款利息第3期共6期', '7.00'],
          ['电销总账分月9期第2期共9期', '150.00'], ['分期付款利息第2期共9期', '3.00']
        ]
        const content = Buffer.from(['交易日期,交易金额,收支,交易类型,卡号,流水号,摘要',
          ...rows.map(([label, amount], index) => `2026-09-03,${amount},支出,${label},SYNTHETIC-ATTRIBUTION-CARD,SYNTHETIC-${index},${label}`)].join('\n'))
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成分期归属.csv', size: content.length }] })).files[0]
        services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        const first = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input }), p = first.bankPreview
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: {
          ...p.suggested, statementKind: 'credit', schemaVersion: 1, sheetIndex: p.sheetIndex, headerRow: p.headerRow, headerToken: p.headerToken
        } })
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })).updateId
        const mappings = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', status: 'open' })).items
        await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: mappings.map(issue => ({ issueId: issue.issueId,
            issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } })) })
        return c
      }
      async function assign(c, eventId, planLabel) {
        const event = (await events(c)).find(row => row.eventId === eventId)
        return c.imp('financeUpdates.setReview', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, eventId, eventVersion: event.version,
          editorVersion: 1, fields: {}, sourceCorrection: { planLabel } })
      }
      async function pendingGroup(c, pendingCharges = 2) {
        const pending = await events(c, 'review_pending'), open = await issues(c)
        assert.equal(pending.length, 4)
        assert.equal(open.length, 1)
        assert.equal(open[0].memberCount, 4)
        const cards = presentation.splitInstallmentCards(pending.map(event => presentation.pendingCard(event, false)))
        assert.equal(cards.length, 2)
        for (const card of cards) {
          assert.equal(card.subjects[0].rowRoleKey, 'principal')
          assert.equal(card.installmentPendingRows.length, pendingCharges)
        }
        const [members] = await lab.owner.execute(`SELECT e.field_sources_json AS fields, m.sort_order AS position
          FROM catledger_review_issue_members m JOIN catledger_economic_events e
          ON e.uid=m.uid AND e.update_id=m.update_id AND e.event_id=m.object_id
          WHERE m.uid=? AND m.update_id=? AND m.issue_id=? ORDER BY m.sort_order`, [c.uid, c.updateId, open[0].issueId])
        assert.equal(typeof members[0].fields, 'object', '使用 mysql2 默认 JSON 类型，不能模拟成字符串')
        assert.deepEqual(members.slice(0, 2).map(row => row.fields.installment.component), ['principal', 'principal'])
        return cards
      }
      async function splitLegacy(c, { closedKey = false } = {}) {
        const open = await issues(c), id = open[0].issueId
        const charges = (await events(c)).filter(row => row.installment && row.installment.periodNumber === 3 && row.installment.component === 'interest')
        await lab.owner.execute('DELETE FROM catledger_review_issue_members WHERE uid=? AND issue_id=?', [c.uid, id])
        await lab.owner.execute("UPDATE catledger_review_issues SET status='resolved',blocking=0,member_count=0 WHERE uid=? AND issue_id=?", [c.uid, id])
        if (closedKey) {
          const key = digestParts('review-follow-up-v2', c.updateId, REASON, charges[0].installment.groupKey)
          await lab.owner.execute('UPDATE catledger_review_issues SET issue_key=? WHERE uid=? AND issue_id=?', [key, c.uid, id])
          return
        }
        for (const charge of charges) {
          const issueId = randomUUID()
          await lab.owner.execute(`INSERT INTO catledger_review_issues
            (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,version,blocking,primary_reason_code,member_count,candidate_count,rule_version,reason_codes_json)
            SELECT uid,?,update_id,?,issue_key_version,issue_type,'open',1,1,primary_reason_code,1,0,rule_version,reason_codes_json
            FROM catledger_review_issues WHERE uid=? AND issue_id=?`, [issueId, digestParts('synthetic-split', issueId), c.uid, id])
          await lab.owner.execute(`INSERT INTO catledger_review_issue_members
            (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order)
            VALUES (?,?,?,?,'event',?,?,'subject',0)`, [c.uid, randomUUID(), c.updateId, issueId, charge.eventId, charge.version])
        }
      }
      await t.test('新批次的待定本息合为两张计划卡，确定归属的本息留在已核对', async () => {
        const c = await context()
        await pendingGroup(c)
        const reviewed = await events(c, 'review_completed'), cards = presentation.buildReviewedCards(reviewed, { fullEvents: reviewed })
        assert.equal(cards.length, 1)
        assert.equal(cards[0].rows.length, 2)
        assert.equal(cards[0].amountText, '¥153.00')
      })
      await t.test('拆散的旧事项收拢后更换视图版本，重复整理不写；失败回滚并隔离其他用户', async () => {
        const c = await context(), other = await context()
        await splitLegacy(c)
        const before = await summary(c), evidence = await dump(c, 'catledger_import_rows', 'row_id')
        const beforeIssues = await dump(c, 'catledger_review_issues', 'issue_id')
        const beforeMembers = await dump(c, 'catledger_review_issue_members', 'member_id')
        const beforeActions = await dump(c, 'catledger_finance_actions', 'action_id')
        const otherIssues = await dump(other, 'catledger_review_issues', 'issue_id')
        const request = { requestId: randomUUID(), updateId: c.updateId, version: before.update.version }
        failRepair = true
        try { await assert.rejects(c.imp('financeUpdates.organize', request)) } finally { failRepair = false }
        assert.deepEqual(await dump(c, 'catledger_review_issues', 'issue_id'), beforeIssues)
        assert.deepEqual(await dump(c, 'catledger_review_issue_members', 'member_id'), beforeMembers)
        assert.deepEqual(await dump(c, 'catledger_finance_actions', 'action_id'), beforeActions)
        assert.equal((await summary(c)).viewVersion, before.viewVersion)
        const [first, replay] = await Promise.all([c.imp('financeUpdates.organize', request), c.imp('financeUpdates.organize', request)])
        assert.deepEqual(replay, first)
        await pendingGroup(c)
        const after = await summary(c)
        assert.equal(after.update.version, before.update.version + 1)
        assert.notEqual(after.viewVersion, before.viewVersion)
        await assert.rejects(c.imp('economicEvents.list', { updateId: c.updateId, view: 'review_pending', viewVersion: before.viewVersion }), { publicCode: 'STALE_VIEW' })
        const fixedIssues = await dump(c, 'catledger_review_issues', 'issue_id'), fixedMembers = await dump(c, 'catledger_review_issue_members', 'member_id')
        const fixedActions = await dump(c, 'catledger_finance_actions', 'action_id')
        assert.equal(fixedActions.length, beforeActions.length + 1)
        assert.ok(fixedIssues.some(row => row.status === 'superseded' && row.resolved_action_id === after.update.currentActionId))
        await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: after.update.version })
        assert.equal((await summary(c)).viewVersion, after.viewVersion)
        assert.deepEqual(await dump(c, 'catledger_review_issues', 'issue_id'), fixedIssues)
        assert.deepEqual(await dump(c, 'catledger_review_issue_members', 'member_id'), fixedMembers)
        assert.deepEqual(await dump(c, 'catledger_finance_actions', 'action_id'), fixedActions)
        assert.deepEqual(await dump(c, 'catledger_import_rows', 'row_id'), evidence)
        assert.deepEqual(await dump(other, 'catledger_review_issues', 'issue_id'), otherIssues)
        assert.deepEqual(await dump(c, 'catledger_transactions', 'transaction_id'), [])
      })
      await t.test('两轮指定、取消再指定均保留整组，历史事项键不能阻止恢复', async () => {
        const c = await context(), beforeAccounts = await dump(c, 'catledger_accounts', 'account_id')
        const charges = (await events(c)).filter(row => row.installment && row.installment.periodNumber === 3 && row.installment.component === 'interest')
        for (let round = 0; round < 2; round++) {
          await assign(c, charges[0].eventId, PLAN_A)
          await pendingGroup(c, 1)
          await assign(c, charges[1].eventId, PLAN_B)
          assert.equal((await events(c, 'review_pending')).length, 0)
          assert.equal((await issues(c)).length, 0)
          const reviewed = await events(c, 'review_completed')
          const cards = presentation.buildReviewedCards(reviewed, { fullEvents: reviewed })
          assert.equal(cards.length, 3)
          assert.ok(cards.every(card => card.rows.length === 2))
          await assign(c, charges[0].eventId, null)
          await pendingGroup(c, 1)
          await assign(c, charges[1].eventId, null)
          await pendingGroup(c)
        }
        assert.deepEqual(await dump(c, 'catledger_accounts', 'account_id'), beforeAccounts)
        assert.deepEqual(await dump(c, 'catledger_transactions', 'transaction_id'), [])
      })
      await t.test('旧归属事项已收尾但费用仍待指定时，重新整理可以补齐整组', async () => {
        const c = await context()
        await splitLegacy(c, { closedKey: true })
        const history = (await dump(c, 'catledger_review_issues', 'issue_id')).filter(row => row.primary_reason_code === REASON)
        await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })
        await pendingGroup(c)
        const repaired = await dump(c, 'catledger_review_issues', 'issue_id')
        for (const old of history) assert.deepEqual(repaired.find(row => row.issue_id === old.issue_id), old)
      })
    } finally { await lab.close() }
  })
