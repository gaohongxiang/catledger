const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call } = require('./helpers/local-services')
const grants = require('../scripts/runtime-role-grants')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const snapshotCodec = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const localModel = require('../miniprogram/packages/finance/services/import-local-model')
const localRead = require('../miniprogram/packages/finance/services/import-local-read')
const localIdentity = require('../cloudfunctions/catledger-import/src/local-review-identity')

const PAIR_LABEL = '合成现金分期12期'
const REGISTER_LABEL = '合成账单分期12期 转分期付款'
const SYNTHETIC_CARD = '9900000000000001'
const pair = (prefix = 'SYNTHETIC-PAIR', date = '2026-08-25') => [
  [date, '1200.00', '支出', PAIR_LABEL, prefix + '-DRAW'],
  [date, '1200.00', '收入', PAIR_LABEL + ' 转分期付款', prefix + '-OFFSET']
]
const registration = (prefix = 'SYNTHETIC-REGISTER', date = '2026-08-26') => [
  [date, '1200.00', '收入', REGISTER_LABEL, prefix]
]

test('分期业务：最小权限真实 MySQL 合卡、登记、来源防重、回滚与隔离',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql(), logs = []
    try {
      const apiPool = await lab.role('api', grants.api), importer = await lab.role('import', grants.importer)
      let failPosting = false, faultReached = false
      let failLoanCreation = false, loanFaultReached = false
      const apiRuntimePool = { async getConnection() {
        const connection = await apiPool.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failLoanCreation && /INSERT INTO catledger_loan_periods\s/.test(sql)) {
              loanFaultReached = true
              throw Error('synthetic installment account and plan rollback')
            }
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failPosting && /UPDATE catledger_finance_updates\s+SET status = 'posted'/.test(sql)) {
              faultReached = true
              throw Error('synthetic installment posting rollback')
            }
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function context({ createPlan = true, createCredit = true } = {}) {
        const subject = 'synthetic-business-' + randomUUID()
        const services = localServices({ apiPool: apiRuntimePool, importPool, subject,
          logger: { error: value => logs.push(value), warn: value => logs.push(value) } })
        const c = { services, api: (action, data) => call(services.api, action, data), imp: async (action, data) => {
          try { return await call(services.import, action, data) } catch (error) {
            throw Object.assign(error, { diagnostic: logs.findLast(row => row.action === action) })
          }
        } }
        c.uid = (await c.api('bootstrap')).uid
        for (const [key, type, name] of [['accountId', 'credit', '合成业务信用卡'], ['assetAccountId', 'bank', '合成到账账户']]) {
          if (type === 'credit' && !createCredit) continue
          c[key] = (await c.api('accounts.create', { requestId: randomUUID(), type, name, openingDisplayBalanceMinor: '0',
            occurredLocalAt: '2026-07-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        }
        if (createPlan) c.loanId = (await createLoan(c)).loanId
        return c
      }
      const createLoan = (c, extra = {}) => c.api('loans.create', { requestId: randomUUID(), accountId: c.accountId,
        scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'repayment', repaymentMinor: '10000',
        firstPaymentDate: '2026-09-25', kind: 'installment', name: '合成分期计划', baselinePrincipalMinor: '120000',
        baselineDate: '2026-08-01', generatePlan: true, confirmed: true,
        installmentSetup: { schema: 1, originalPrincipalMinor: '120000', historicalPaidTerms: 0,
          recordType: 'credit_card', customRecordType: '', discountKind: null, discountValue: null }, ...extra })
      const summary = c => c.imp('financeUpdates.summary', { updateId: c.updateId })
      const events = (c, data = {}) => c.imp('economicEvents.list', { updateId: c.updateId, ...data })
      const balances = async c => Object.fromEntries((await c.api('accounts.list')).accounts.map(row => [row.accountId, row.bookBalanceMinor]))
      const rows = async (c, table, order) => (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${order}`, [c.uid]))[0]
      const liveTransactions = async c => (await rows(c, 'catledger_transactions', 'transaction_id')).filter(row => row.deleted_at == null)
      const planDecision = (c, action = 'link', loanId = c.loanId) => ({ action, loanId: action === 'skip' ? null : loanId,
        accountId: c.accountId, planLabel: '合成分期计划', totalTerms: 12, principalMinor: '120000', startMonth: '2026-08' })
      async function prepare(c, billRows, suffix = '') {
        // 全部字段来自本测试的合成记录；换行变化只改变文件指纹，可靠来源编号保持不变。
        const content = Buffer.from(['交易日期,交易金额,收支,交易类型,卡号,流水号,摘要',
          ...billRows.map(([date, amount, direction, label, identity]) =>
            [date, amount, direction, label, SYNTHETIC_CARD, identity, label].join(','))].join('\n') + suffix)
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(),
          files: [{ fileName: '合成分期业务.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        let parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })
        if (parsed.bankPreview) {
          const p = parsed.bankPreview
          parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: {
            ...p.suggested, statementKind: 'credit', schemaVersion: 1, sheetIndex: p.sheetIndex, headerRow: p.headerRow, headerToken: p.headerToken
          } })
        }
        if (!parsed.batch) return parsed
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })).updateId
        const mappings = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', status: 'open' })).items
        if (c.accountId && mappings.length) await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: mappings.map(issue => ({ issueId: issue.issueId,
            issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } })) })
        return { ...parsed, updateId: c.updateId }
      }
      async function edit(c, eventId, fields) {
        const event = (await events(c)).items.find(row => row.eventId === eventId)
        assert.ok(event, '待保存事件属于当前用户和批次')
        const data = { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, eventId, eventVersion: event.version, editorVersion: 1, fields }
        return c.imp('financeUpdates.setReview', data)
      }
      async function reviewAll(c) {
        for (const event of (await events(c, { view: 'active' })).items) await edit(c, event.eventId, {
          ledgerAccountId: c.accountId,
          ...(event.disbursement.role === 'disbursement' ? { counterpartyLedgerAccountId: c.assetAccountId } : {}),
          installmentPlan: planDecision(c)
        })
      }
      const postingRequest = async c => ({ requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })
      async function readRaw(c, eventId, evidenceId) {
        let cursor, text = ''
        do {
          const part = await c.imp('economicEvents.detail', { updateId: c.updateId, eventId, evidenceId, ...(cursor ? { cursor } : {}) })
          text += part.part; cursor = part.nextCursor
        } while (cursor)
        return JSON.parse(text)
      }
      async function downloadReviewObject(c, objectId) {
        let offset = 0, header
        const descriptors = []
        do {
          const page = await c.imp('financeUpdates.snapshotManifest', { objectId, offset })
          header = page.header; descriptors.push(...page.parts); offset = page.nextOffset
        } while (offset != null)
        protocol.validateManifest(header, descriptors)
        const contents = []
        for (const part of descriptors) contents.push(protocol.validatePart(header, part,
          await c.imp('financeUpdates.snapshotChunk', { objectId, index: part.index })))
        const value = JSON.parse(contents.join(''))
        return { header, facts: header.kind === 'snapshot' ? snapshotCodec.decode(value) : value }
      }
      async function localAccountDraft(c, billRows, name) {
        await prepare(c, billRows)
        const prepared = await c.imp('financeUpdates.prepareSnapshot', { requestId: randomUUID(),
          updateId: c.updateId, version: (await summary(c)).update.version })
        const snapshot = await downloadReviewObject(c, prepared.snapshot.objectId)
        const [[stored]] = await lab.owner.execute(`SELECT state, object_kind AS kind FROM catledger_import_review_objects
          WHERE uid=? AND update_id=? AND object_id=?`, [c.uid, c.updateId, snapshot.header.objectId])
        assert.deepEqual(stored, { state: 'sealed', kind: 'snapshot' })
        assert.equal(snapshot.facts.update.reviewMode, 'local_v3')
        const model = localModel.create(snapshot.facts), draft = { name, type: 'credit', currency: 'CNY' }
        const accountIssues = [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping' && issue.status === 'open')
        assert.ok(accountIssues.length > 0, '真实快照保留尚未选择信用卡的账户事项：' + JSON.stringify({
          issues: [...model.issues.values()].map(row => ({ type: row.issueType, status: row.status, reason: row.primaryReasonCode })),
          events: [...model.events.values()].map(row => ({ role: row.fieldSources.disbursement?.role,
            nature: row.economicNature, hasAccount: Boolean(row.ledgerAccountId), status: row.status, reasons: row.reasonCodes }))
        }))
        for (const issue of accountIssues) model.mapAccount({ issueId: issue.issueId,
          decision: 'apply_fields', fields: { mappingAccountDraft: draft } })
        c.accountId = localIdentity.accountId(snapshot.header.objectId, name, 'credit')
        const main = [...model.events.values()].find(event => ['disbursement', 'registration'].includes(event.fieldSources.disbursement?.role))
        assert.ok(main); assert.equal(main.ledgerAccountId, c.accountId)
        assert.equal(model.drafts.size, 1)
        return { snapshot, model, eventId: main.eventId,
          importOrigin: { updateId: c.updateId, eventId: main.eventId },
          importAccountDraft: { snapshotId: snapshot.header.objectId, ...draft } }
      }
      async function stageLocal(c, model) {
        const state = model.finalState(), packed = protocol.split(JSON.stringify(state), 'decisions'), uploadId = randomUUID()
        for (const part of packed.parts) await c.imp('financeUpdates.stageDecisions', { requestId: randomUUID(),
          updateId: state.updateId, snapshotId: state.snapshotId, uploadId, baseVersion: state.baseVersion,
          ruleVersion: state.ruleVersion, chunkCount: packed.chunkCount, index: part.index, content: part.content })
        const sealed = await c.imp('financeUpdates.sealDecisions', { requestId: randomUUID(),
          updateId: state.updateId, snapshotId: state.snapshotId, uploadId })
        return { requestId: randomUUID(), protocolVersion: 3, updateId: state.updateId, version: state.baseVersion,
          snapshotId: state.snapshotId, uploadId, payloadDigest: sealed.digest }
      }
      function saveLocalPlan(c, local) {
        const event = local.model.events.get(local.eventId)
        local.model.edit({ eventId: local.eventId, editorVersion: 1, fields: { ledgerAccountId: c.accountId,
          ...(event.fieldSources.disbursement.role === 'disbursement' ? { counterpartyLedgerAccountId: c.assetAccountId } : {}),
          installmentPlan: planDecision(c, 'create') } })
        assert.equal(localRead.create(local.model).summary().coverage.selectedEventsReadyToPost, true)
      }

      await t.test('一对放款只显示一张借款卡，摘要和排除分页一致，两份原文均可从主卡读取', async () => {
        const c = await context()
        await prepare(c, pair())
        const page = await events(c, { view: 'active', pageSize: 1 }), main = page.items[0]
        assert.equal(page.total, 1); assert.equal(page.items.length, 1); assert.equal(page.nextCursor, null)
        assert.equal(main.disbursement.role, 'disbursement'); assert.equal(main.economicNature, 'borrow')
        assert.equal(main.evidenceCount, 2)
        const all = await events(c)
        assert.equal(all.total, 1); assert.deepEqual(all.items.map(row => row.eventId), [main.eventId])
        const s = await summary(c)
        assert.deepEqual(s.workbench.recordSummary, { activeCount: 1, excludedCount: 0, duplicateCount: 0, totalCount: 1 })
        assert.equal(s.workbench.reviewStatusTabs.find(tab => tab.value === 'pending').count, 1)
        for (const filter of [{ status: 'excluded' }, { view: 'excluded_groups' }]) {
          const excluded = await events(c, filter)
          assert.equal(excluded.total, 0); assert.deepEqual(excluded.items, []); assert.equal(excluded.nextCursor, null)
        }
        const evidence = await c.imp('economicEvents.evidence', { updateId: c.updateId, eventId: main.eventId, pageSize: 1 })
        assert.equal(evidence.total, 2); assert.equal(evidence.items.length, 1); assert.ok(evidence.nextCursor)
        const second = await c.imp('economicEvents.evidence', { updateId: c.updateId, eventId: main.eventId, pageSize: 1, cursor: evidence.nextCursor })
        assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null)
        const raw = await Promise.all([...evidence.items, ...second.items].map(item => readRaw(c, main.eventId, item.evidenceId)))
        assert.ok(raw.some(value => JSON.stringify(value).includes(PAIR_LABEL + ' 转分期付款')))
        assert.ok(raw.some(value => JSON.stringify(value).includes('SYNTHETIC-PAIR-DRAW')))
        const persisted = await rows(c, 'catledger_economic_events', 'event_id')
        assert.equal(persisted.length, 2, '合卡不删除内部对行')
        assert.equal((await rows(c, 'catledger_event_evidence', 'evidence_id')).length, 2)
        assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('实际到账账户和已有计划确认后只产生一笔转账，同请求并发及重放不重复', async () => {
        const c = await context()
        await prepare(c, pair())
        const before = await balances(c)
        await reviewAll(c)
        const pending = await events(c, { view: 'review_pending' }), reviewed = await events(c, { view: 'review_completed' })
        assert.equal(pending.total, 0); assert.equal(reviewed.total, 1); assert.equal(reviewed.items[0].evidenceCount, 2)
        const decisions = (await rows(c, 'catledger_economic_events', 'event_id')).map(row => row.field_sources_json.installmentPlan)
        assert.equal(decisions.length, 2); assert.ok(decisions.every(decision => decision.loanId === c.loanId))
        const request = await postingRequest(c)
        const [posted, replay] = await Promise.all([c.imp('financeUpdates.post', request), c.imp('financeUpdates.post', request)])
        assert.deepEqual(replay, posted); assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        const transaction = await liveTransactions(c)
        assert.equal(transaction.length, 1); assert.equal(transaction[0].type, 'transfer')
        assert.equal(transaction[0].source_account_id, c.accountId); assert.equal(transaction[0].destination_account_id, c.assetAccountId)
        assert.equal(String(transaction[0].amount_minor), '120000')
        assert.equal((await rows(c, 'catledger_installment_items', 'item_id')).length, 0)
        assert.equal((await rows(c, 'catledger_installment_bindings', 'reference_key')).length, 0, '无合同号时不伪造合同绑定')
        const after = await balances(c)
        assert.equal(BigInt(after[c.accountId]) - BigInt(before[c.accountId]), -120000n)
        assert.equal(BigInt(after[c.assetAccountId]) - BigInt(before[c.assetAccountId]), 120000n)
        assert.deepEqual((await summary(c)).posting, { createdTransactionCount: 1, reusedTransactionCount: 0 })
      })

      await t.test('单独转分期必须关联计划，完成后零交易、零期次来源且余额不变', async () => {
        const c = await context()
        await prepare(c, registration())
        const event = (await events(c, { view: 'active' })).items[0], before = await balances(c)
        assert.equal(event.disbursement.role, 'registration'); assert.equal(event.economicNature, 'unknown')
        assert.equal(event.status, 'needs_action'); assert.ok(event.reasonCodes.includes('installment_plan_required'))
        await assert.rejects(c.imp('financeUpdates.post', await postingRequest(c)), { publicCode: 'UNRESOLVED_IMPORT' })
        await edit(c, event.eventId, { installmentPlan: planDecision(c, 'skip') })
        assert.equal((await events(c, { view: 'review_pending' })).total, 1)
        await assert.rejects(c.imp('financeUpdates.post', await postingRequest(c)), { publicCode: 'UNRESOLVED_IMPORT' })
        await edit(c, event.eventId, { installmentPlan: planDecision(c) })
        const request = await postingRequest(c), posted = await c.imp('financeUpdates.post', request)
        const planAfterPost = await rows(c, 'catledger_loans', 'loan_id')
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        assert.deepEqual(await rows(c, 'catledger_loans', 'loan_id'), planAfterPost, '零交易请求重放也不能重复更改计划')
        assert.equal((await liveTransactions(c)).length, 0)
        assert.equal((await rows(c, 'catledger_installment_items', 'item_id')).length, 0)
        assert.equal((await rows(c, 'catledger_economic_event_transactions', 'link_id')).length, 0)
        assert.equal((await rows(c, 'catledger_installment_bindings', 'reference_key')).length, 0)
        assert.equal((await rows(c, 'catledger_economic_events', 'event_id'))[0].field_sources_json.installmentPlan.loanId, c.loanId)
        assert.deepEqual(await balances(c), before)
        assert.deepEqual((await summary(c)).posting, { createdTransactionCount: 0, reusedTransactionCount: 0 })
      })

      await t.test('真实计划候选完整事实可命中，首期月未知时保留候选但不预选', async () => {
        const c = await context(), query = { accountId: c.accountId, planLabel: '合成分期计划', totalTerms: 12, principalMinor: '120000' }
        const unknownMonth = await c.api('loans.planCandidates', query)
        assert.equal(unknownMonth.items.length, 1); assert.equal(unknownMonth.items[0].loanId, c.loanId)
        assert.equal(unknownMonth.items[0].matched, false, '登记日和放款日都不能代替首期月')
        const complete = await c.api('loans.planCandidates', { ...query, startMonth: '2026-08' })
        assert.equal(complete.items.length, 1); assert.equal(complete.items[0].matched, true)
        const mismatch = await c.api('loans.planCandidates', { ...query, startMonth: '2026-07' })
        assert.equal(mismatch.items[0].matched, false)
        assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('已处理登记按来源身份防重，改文件字节仍不新记；撤销后可以重新关联另一计划', async () => {
        const c = await context(), originalBill = registration('SYNTHETIC-DURABLE-REGISTER')
        await prepare(c, originalBill); await reviewAll(c)
        const originalUpdate = c.updateId, posted = await c.imp('financeUpdates.post', await postingRequest(c))
        const initial = await balances(c)
        const sameFile = await prepare(c, originalBill)
        assert.equal(sameFile.batch, null); assert.equal(sameFile.duplicateDisposition, 'already_posted')
        const reimported = await prepare(c, originalBill, '\n')
        assert.ok(reimported.batch, '改变文件字节会产生新解析批次')
        assert.notEqual(c.updateId, originalUpdate)
        assert.equal(new Set((await rows(c, 'catledger_import_rows', 'row_id')).map(row => row.identity_id)).size, 1,
          '合成完整账户号和来源编号必须落同一可靠身份')
        const duplicates = await events(c, { status: 'duplicate' })
        assert.equal(duplicates.total, 1)
        assert.ok(duplicates.items[0].reasonCodes.includes('already_posted'))
        assert.equal((await events(c, { view: 'active' })).total, 0)
        assert.equal((await liveTransactions(c)).length, 0); assert.deepEqual(await balances(c), initial)
        const impact = await c.imp('financeUpdates.undoImpact', { updateId: originalUpdate })
        const undo = { requestId: randomUUID(), updateId: originalUpdate, version: posted.appliedVersion, previewToken: impact.previewToken }
        const undone = await c.imp('financeUpdates.undo', undo)
        assert.deepEqual(await c.imp('financeUpdates.undo', undo), undone)
        await prepare(c, originalBill, '\n\n')
        const active = await events(c, { view: 'active' })
        assert.equal(active.total, 1); assert.equal(active.items[0].disbursement.role, 'registration')
        assert.ok(!active.items[0].reasonCodes.includes('already_posted'))
        c.loanId = (await createLoan(c)).loanId
        await reviewAll(c)
        await c.imp('financeUpdates.post', await postingRequest(c))
        assert.equal((await rows(c, 'catledger_installment_bindings', 'reference_key')).length, 0)
        const processed = (await rows(c, 'catledger_economic_events', 'event_id')).find(row => row.update_id === c.updateId)
        assert.equal(processed.status, 'posted'); assert.equal(processed.field_sources_json.installmentPlan.loanId, c.loanId)
        assert.equal((await liveTransactions(c)).length, 0); assert.deepEqual(await balances(c), initial)
      })

      await t.test('已处理借款的对行单独重导也视为重复，原借款撤销后才可独立登记', async () => {
        const c = await context(), originalBill = pair('SYNTHETIC-DURABLE-PAIR')
        await prepare(c, originalBill); await reviewAll(c)
        const originalUpdate = c.updateId, posted = await c.imp('financeUpdates.post', await postingRequest(c))
        const before = await balances(c)
        await prepare(c, [originalBill[1]])
        const duplicate = await events(c, { status: 'duplicate' })
        assert.equal(duplicate.total, 1); assert.equal(duplicate.items[0].disbursement.role, 'registration')
        assert.ok(duplicate.items[0].reasonCodes.includes('already_posted'))
        assert.equal((await events(c, { view: 'active' })).total, 0)
        assert.equal((await liveTransactions(c)).length, 1); assert.deepEqual(await balances(c), before)
        const impact = await c.imp('financeUpdates.undoImpact', { updateId: originalUpdate })
        await c.imp('financeUpdates.undo', { requestId: randomUUID(), updateId: originalUpdate,
          version: posted.appliedVersion, previewToken: impact.previewToken })
        const afterUndo = await balances(c)
        assert.equal((await liveTransactions(c)).length, 0)
        await prepare(c, [originalBill[1]], '\n')
        assert.equal((await events(c, { view: 'active' })).total, 1)
        await reviewAll(c); await c.imp('financeUpdates.post', await postingRequest(c))
        assert.equal((await liveTransactions(c)).length, 0)
        assert.equal((await rows(c, 'catledger_installment_items', 'item_id')).length, 0)
        assert.deepEqual(await balances(c), afterUndo)
      })

      await t.test('主卡拒绝同批无关原文及跨用户读写，其他用户同编号独立处理', async () => {
        const c = await context(), other = await context(), bill = [...pair(), ...registration()]
        await prepare(c, bill); await prepare(other, bill)
        const all = (await events(c, { view: 'active' })).items
        const main = all.find(row => row.disbursement.role === 'disbursement'), register = all.find(row => row.disbursement.role === 'registration')
        const unrelated = (await c.imp('economicEvents.evidence', { eventId: register.eventId })).items[0]
        await assert.rejects(c.imp('economicEvents.detail', { eventId: main.eventId, evidenceId: unrelated.evidenceId }), { publicCode: 'NOT_FOUND' })
        await assert.rejects(other.imp('economicEvents.evidence', { eventId: main.eventId }), { publicCode: 'NOT_FOUND' })
        await assert.rejects(other.imp('economicEvents.detail', { eventId: main.eventId, evidenceId: unrelated.evidenceId }), { publicCode: 'NOT_FOUND' })
        await assert.rejects(other.imp('financeUpdates.post', await postingRequest(c)), { publicCode: 'NOT_FOUND' })
        await assert.rejects(edit(c, register.eventId, { installmentPlan: planDecision(c, 'link', other.loanId) }), { publicCode: 'LOAN_SOURCE_MISMATCH' })
        assert.equal((await events(other, { view: 'active' })).total, 2)
        await reviewAll(c); await c.imp('financeUpdates.post', await postingRequest(c))
        assert.equal((await liveTransactions(other)).length, 0)
        await reviewAll(other); await other.imp('financeUpdates.post', await postingRequest(other))
        assert.equal((await liveTransactions(c)).length, 1); assert.equal((await liveTransactions(other)).length, 1)
      })

      await t.test('同批借款和登记在提交尾部失败时整批回滚，同一请求恢复成功', async () => {
        const c = await context()
        await prepare(c, [...pair(), ...registration()]); await reviewAll(c)
        const tables = [['catledger_transactions', 'transaction_id'], ['catledger_installment_bindings', 'reference_key'],
          ['catledger_installment_items', 'item_id'], ['catledger_economic_event_transactions', 'link_id'],
          ['catledger_economic_events', 'event_id'], ['catledger_finance_updates', 'update_id'],
          ['catledger_finance_update_postings', 'posting_id'], ['catledger_finance_actions', 'action_id'],
          ['catledger_loans', 'loan_id'], ['catledger_mutation_receipts', 'idempotency_key_digest']]
        const snapshots = await Promise.all(tables.map(([table, order]) => rows(c, table, order))), before = await balances(c)
        const request = await postingRequest(c)
        failPosting = true; faultReached = false
        try { await assert.rejects(c.imp('financeUpdates.post', request), { publicCode: 'INTERNAL_ERROR' }) } finally { failPosting = false }
        assert.equal(faultReached, true, '故障确实发生在交易和计划归属写入后的提交尾部')
        for (const [index, [table, order]] of tables.entries()) assert.deepEqual(await rows(c, table, order), snapshots[index], table)
        assert.deepEqual(await balances(c), before)
        const [posted, replay] = await Promise.all([c.imp('financeUpdates.post', request), c.imp('financeUpdates.post', request)])
        assert.deepEqual(posted, replay)
        assert.equal((await liveTransactions(c)).length, 1)
        assert.equal((await rows(c, 'catledger_installment_items', 'item_id')).length, 0)
        assert.equal((await rows(c, 'catledger_installment_bindings', 'reference_key')).length, 0)
      })

      await t.test('携导入来源新建登记计划后放弃草稿，最小权限软删除空计划并取消期次', async () => {
        const c = await context({ createPlan: false })
        await prepare(c, registration('SYNTHETIC-CREATED-ABANDON'))
        const event = (await events(c, { view: 'active' })).items[0]
        c.loanId = (await createLoan(c, { importOrigin: { updateId: c.updateId, eventId: event.eventId } })).loanId
        await edit(c, event.eventId, { ledgerAccountId: c.accountId, installmentPlan: planDecision(c, 'create') })
        assert.equal((await rows(c, 'catledger_loan_periods', 'period_id')).length, 12)
        const before = await balances(c), evidence = await rows(c, 'catledger_import_rows', 'row_id')
        const request = await postingRequest(c), abandoned = await c.imp('financeUpdates.abandon', request)
        assert.deepEqual(await c.imp('financeUpdates.abandon', request), abandoned)
        assert.equal((await summary(c)).update.status, 'abandoned')
        assert.equal((await c.api('loans.list', {})).items.length, 0)
        const removed = await rows(c, 'catledger_loans', 'loan_id')
        assert.equal(removed.length, 1); assert.ok(removed[0].deleted_at); assert.ok(removed[0].archived_at)
        const cancelled = await rows(c, 'catledger_loan_periods', 'period_id')
        assert.equal(cancelled.length, 12); assert.ok(cancelled.every(row => Number(row.cancelled) === 1))
        assert.equal((await rows(c, 'catledger_economic_events', 'event_id')).length, 0)
        assert.deepEqual(await rows(c, 'catledger_import_rows', 'row_id'), evidence)
        assert.deepEqual(await balances(c), before); assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('另一批放弃新建计划记录时，保留已入账零交易登记引用的计划', async () => {
        const c = await context({ createPlan: false }), originalBill = registration('SYNTHETIC-POSTED-PLAN')
        await prepare(c, originalBill)
        const originalEvent = (await events(c, { view: 'active' })).items[0]
        c.loanId = (await createLoan(c, { importOrigin: { updateId: c.updateId, eventId: originalEvent.eventId } })).loanId
        await edit(c, originalEvent.eventId, { ledgerAccountId: c.accountId, installmentPlan: planDecision(c, 'create') })
        await c.imp('financeUpdates.post', await postingRequest(c))
        const originalUpdate = c.updateId, loan = await rows(c, 'catledger_loans', 'loan_id')
        const periods = await rows(c, 'catledger_loan_periods', 'period_id'), before = await balances(c)
        await prepare(c, registration('SYNTHETIC-OTHER-DRAFT', '2026-08-27'))
        const draftEvent = (await events(c, { view: 'active' })).items[0]
        await edit(c, draftEvent.eventId, { ledgerAccountId: c.accountId, installmentPlan: planDecision(c, 'create') })
        const request = { ...await postingRequest(c), planIds: [c.loanId] }
        await c.imp('financeUpdates.abandon', request)
        assert.deepEqual(await rows(c, 'catledger_loans', 'loan_id'), loan)
        assert.deepEqual(await rows(c, 'catledger_loan_periods', 'period_id'), periods)
        assert.equal((await c.imp('financeUpdates.summary', { updateId: originalUpdate })).update.status, 'posted')
        assert.equal((await rows(c, 'catledger_economic_events', 'event_id')).length, 1)
        await prepare(c, originalBill, '\n')
        assert.equal((await events(c, { status: 'duplicate' })).total, 1, '放弃其他草稿不释放已处理来源')
        assert.deepEqual(await balances(c), before); assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('客户端的create决定和planIds不能冒认普通手工空计划为本批新建', async () => {
        const c = await context(), loan = await rows(c, 'catledger_loans', 'loan_id')
        const periods = await rows(c, 'catledger_loan_periods', 'period_id'), before = await balances(c)
        await prepare(c, registration('SYNTHETIC-MANUAL-PLAN-PROTECTION'))
        const event = (await events(c, { view: 'active' })).items[0]
        await edit(c, event.eventId, { ledgerAccountId: c.accountId, installmentPlan: planDecision(c, 'create') })
        await c.imp('financeUpdates.abandon', { ...await postingRequest(c), planIds: [c.loanId] })
        assert.deepEqual(await rows(c, 'catledger_loans', 'loan_id'), loan)
        assert.deepEqual(await rows(c, 'catledger_loan_periods', 'period_id'), periods)
        assert.equal((await c.api('loans.list', {})).items[0].loanId, c.loanId)
        assert.equal((await summary(c)).update.status, 'abandoned')
        assert.deepEqual(await balances(c), before); assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('计划创建成功但尚未保存登记决定时，放弃仍由创建回执注销空计划', async () => {
        const c = await context({ createPlan: false })
        await prepare(c, registration('SYNTHETIC-UNSAVED-PLAN'))
        const event = (await events(c, { view: 'active' })).items[0]
        const importOrigin = { updateId: c.updateId, eventId: event.eventId }
        const created = await createLoan(c, { importOrigin })
        c.loanId = created.loanId
        assert.deepEqual(created.importOrigin, importOrigin)
        const evidence = await rows(c, 'catledger_import_rows', 'row_id'), before = await balances(c)
        assert.equal((await rows(c, 'catledger_economic_events', 'event_id'))[0].field_sources_json.installmentPlan, undefined)
        await c.imp('financeUpdates.abandon', await postingRequest(c))
        assert.equal((await c.api('loans.list', {})).items.length, 0)
        const removed = await rows(c, 'catledger_loans', 'loan_id')
        assert.equal(removed.length, 1); assert.ok(removed[0].deleted_at); assert.ok(removed[0].archived_at)
        const cancelled = await rows(c, 'catledger_loan_periods', 'period_id')
        assert.equal(cancelled.length, 12); assert.ok(cancelled.every(row => Number(row.cancelled) === 1))
        assert.deepEqual(await rows(c, 'catledger_import_rows', 'row_id'), evidence)
        assert.deepEqual(await balances(c), before); assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('新建计划的导入来源拒绝跨用户、已入账与已放弃批次，不留下额外计划', async () => {
        const c = await context(), other = await context({ createPlan: false })
        await prepare(c, registration('SYNTHETIC-CREATE-ORIGIN'))
        const event = (await events(c, { view: 'active' })).items[0]
        const importOrigin = { updateId: c.updateId, eventId: event.eventId }
        await assert.rejects(createLoan(other, { importOrigin }), { publicCode: 'CONFLICT' })
        assert.equal((await rows(other, 'catledger_loans', 'loan_id')).length, 0)
        assert.equal((await rows(other, 'catledger_loan_periods', 'period_id')).length, 0)
        await reviewAll(c); await c.imp('financeUpdates.post', await postingRequest(c))
        const existing = await rows(c, 'catledger_loans', 'loan_id'), periods = await rows(c, 'catledger_loan_periods', 'period_id')
        await assert.rejects(createLoan(c, { importOrigin }), { publicCode: 'CONFLICT' })
        await prepare(c, registration('SYNTHETIC-ABANDONED-ORIGIN', '2026-08-27'))
        const abandonedEvent = (await events(c, { view: 'active' })).items[0]
        const abandonedOrigin = { updateId: c.updateId, eventId: abandonedEvent.eventId }
        await c.imp('financeUpdates.abandon', await postingRequest(c))
        await assert.rejects(createLoan(c, { importOrigin: abandonedOrigin }), { publicCode: 'CONFLICT' })
        assert.deepEqual(await rows(c, 'catledger_loans', 'loan_id'), existing)
        assert.deepEqual(await rows(c, 'catledger_loan_periods', 'period_id'), periods)
        assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('local_v3新信用卡与计划同事务创建，本机保存后合卡仅入一笔转账且账户不重复', async () => {
        const c = await context({ createPlan: false, createCredit: false })
        const local = await localAccountDraft(c, pair('SYNTHETIC-LOCAL-NEW-CREDIT'), '合成本机新信用卡')
        const beforeAccounts = await rows(c, 'catledger_accounts', 'account_id')
        const beforeReceipts = await rows(c, 'catledger_mutation_receipts', 'idempotency_key_digest')
        const create = { requestId: randomUUID(), importOrigin: local.importOrigin, importAccountDraft: local.importAccountDraft }
        assert.equal(beforeAccounts.length, 1, '本机账户决定尚未创建正式信用卡')
        failLoanCreation = true; loanFaultReached = false
        try { await assert.rejects(createLoan(c, create), { publicCode: 'INTERNAL_ERROR' }) } finally { failLoanCreation = false }
        assert.equal(loanFaultReached, true, '故障确实位于新账户及计划写入之后的期次写入')
        assert.deepEqual(await rows(c, 'catledger_accounts', 'account_id'), beforeAccounts)
        assert.deepEqual(await rows(c, 'catledger_mutation_receipts', 'idempotency_key_digest'), beforeReceipts)
        assert.equal((await rows(c, 'catledger_loans', 'loan_id')).length, 0)
        assert.equal((await rows(c, 'catledger_loan_periods', 'period_id')).length, 0)
        const [created, replay] = await Promise.all([createLoan(c, create), createLoan(c, create)])
        assert.deepEqual(replay, created); assert.deepEqual(await createLoan(c, create), created)
        c.loanId = created.loanId
        const accounts = await c.api('accounts.list'), credit = accounts.accounts.filter(row => row.type === 'credit')
        assert.equal(credit.length, 1); assert.equal(credit[0].accountId, c.accountId)
        assert.equal(credit[0].name, local.importAccountDraft.name); assert.equal(credit[0].bookBalanceMinor, '0')
        assert.equal((await rows(c, 'catledger_loans', 'loan_id')).length, 1)
        assert.equal((await rows(c, 'catledger_loan_periods', 'period_id')).length, 12)
        assert.equal((await liveTransactions(c)).length, 0, '新建信用卡及计划本身不伪造放款')
        saveLocalPlan(c, local)
        const localPage = localRead.create(local.model).read('economicEvents.list', {})
        assert.equal(localPage.total, 1); assert.equal(localPage.items[0].evidenceCount, 2)
        assert.equal(local.model.finalState().decisions.accounts.length, 1)
        const request = await stageLocal(c, local.model), posted = await c.imp('financeUpdates.post', request)
        if (posted.outcome === 'recheck') assert.fail(JSON.stringify((await downloadReviewObject(c, posted.recheck.objectId)).facts.problems))
        assert.equal(posted.status, 'posted'); assert.equal(posted.posting.createdTransactionCount, 1)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        const persistedAccounts = await rows(c, 'catledger_accounts', 'account_id')
        assert.equal(persistedAccounts.length, 2); assert.equal(persistedAccounts.filter(row => row.type === 'credit').length, 1)
        const drafts = await rows(c, 'catledger_finance_update_account_drafts', 'draft_account_id')
        assert.equal(drafts.length, 1); assert.equal(drafts[0].draft_account_id, c.accountId); assert.ok(drafts[0].materialized_at)
        const transactions = await liveTransactions(c)
        assert.equal(transactions.length, 1); assert.equal(transactions[0].type, 'transfer')
        assert.equal(transactions[0].source_account_id, c.accountId); assert.equal(transactions[0].destination_account_id, c.assetAccountId)
        assert.equal(String(transactions[0].amount_minor), '120000')
        assert.deepEqual(await balances(c), { [c.accountId]: '-120000', [c.assetAccountId]: '120000' })
        assert.equal((await rows(c, 'catledger_installment_items', 'item_id')).length, 0)
      })

      await t.test('本机新信用卡创建拒绝伪造ID、非本用户快照和未封存快照，失败不留账户或计划', async () => {
        const c = await context({ createPlan: false, createCredit: false })
        const other = await context({ createPlan: false, createCredit: false })
        const local = await localAccountDraft(c, registration('SYNTHETIC-LOCAL-REJECT'), '合成本机验证信用卡')
        const foreign = await localAccountDraft(other, registration('SYNTHETIC-LOCAL-FOREIGN'), '合成另一用户信用卡')
        const before = await rows(c, 'catledger_accounts', 'account_id'), otherBefore = await rows(other, 'catledger_accounts', 'account_id')
        const create = { importOrigin: local.importOrigin, importAccountDraft: local.importAccountDraft }
        await assert.rejects(createLoan(c, { ...create, accountId: randomUUID() }),
          error => ['VALIDATION_ERROR', 'CONFLICT'].includes(error.publicCode))
        await assert.rejects(createLoan(c, { ...create, accountId: other.accountId, importAccountDraft: foreign.importAccountDraft }),
          error => ['VALIDATION_ERROR', 'CONFLICT'].includes(error.publicCode))
        await assert.rejects(createLoan(c, { importAccountDraft: local.importAccountDraft }), { publicCode: 'VALIDATION_ERROR' })
        await lab.owner.execute("UPDATE catledger_import_review_objects SET state='writing' WHERE uid=? AND object_id=?",
          [c.uid, local.snapshot.header.objectId])
        try {
          await assert.rejects(createLoan(c, create), error => ['VALIDATION_ERROR', 'CONFLICT'].includes(error.publicCode))
        } finally {
          await lab.owner.execute("UPDATE catledger_import_review_objects SET state='sealed' WHERE uid=? AND object_id=?",
            [c.uid, local.snapshot.header.objectId])
        }
        for (const current of [c, other]) {
          assert.equal((await rows(current, 'catledger_loans', 'loan_id')).length, 0)
          assert.equal((await rows(current, 'catledger_loan_periods', 'period_id')).length, 0)
          assert.equal((await liveTransactions(current)).length, 0)
        }
        assert.deepEqual(await rows(c, 'catledger_accounts', 'account_id'), before)
        assert.deepEqual(await rows(other, 'catledger_accounts', 'account_id'), otherBefore)
      })

      await t.test('同一新信用卡可承接计划；放弃本机草稿保留明确新建的账户并软删除空计划', async () => {
        const c = await context({ createPlan: false, createCredit: false })
        const local = await localAccountDraft(c, registration('SYNTHETIC-LOCAL-ABANDON'), '合成本机保留信用卡')
        const create = { importOrigin: local.importOrigin, importAccountDraft: local.importAccountDraft }
        c.loanId = (await createLoan(c, create)).loanId
        const another = await createLoan(c, { ...create, name: '合成同卡第二计划' })
        assert.notEqual(another.loanId, c.loanId)
        const before = await rows(c, 'catledger_accounts', 'account_id')
        assert.equal(before.length, 2); assert.equal(before.filter(row => row.type === 'credit').length, 1)
        saveLocalPlan(c, local)
        const request = { requestId: randomUUID(), updateId: c.updateId, version: local.snapshot.header.baseVersion, planIds: [c.loanId] }
        const abandoned = await c.imp('financeUpdates.abandon', request)
        assert.deepEqual(await c.imp('financeUpdates.abandon', request), abandoned)
        assert.deepEqual(await rows(c, 'catledger_accounts', 'account_id'), before)
        assert.equal((await balances(c))[c.accountId], '0')
        const removed = await rows(c, 'catledger_loans', 'loan_id')
        assert.equal(removed.length, 2); assert.ok(removed.every(row => row.deleted_at && row.archived_at))
        const cancelled = await rows(c, 'catledger_loan_periods', 'period_id')
        assert.equal(cancelled.length, 24); assert.ok(cancelled.every(row => Number(row.cancelled) === 1))
        assert.equal((await c.api('loans.list', {})).items.length, 0)
        assert.equal((await summary(c)).update.status, 'abandoned')
        assert.equal((await liveTransactions(c)).length, 0)
      })

      await t.test('提前新建的信用卡属性改变后，最终materialize拒绝冲突并保留原账户及未入账草稿', async () => {
        const c = await context({ createPlan: false, createCredit: false })
        const local = await localAccountDraft(c, pair('SYNTHETIC-LOCAL-ACCOUNT-CONFLICT'), '合成本机原信用卡名')
        c.loanId = (await createLoan(c, { importOrigin: local.importOrigin, importAccountDraft: local.importAccountDraft })).loanId
        saveLocalPlan(c, local)
        const account = (await c.api('accounts.list')).accounts.find(row => row.accountId === c.accountId)
        await c.api('accounts.update', { requestId: randomUUID(), accountId: c.accountId,
          version: account.version, name: '合成其他页面已改名' })
        const beforeAccounts = await rows(c, 'catledger_accounts', 'account_id'), beforeLoans = await rows(c, 'catledger_loans', 'loan_id')
        const request = await stageLocal(c, local.model)
        const rejected = await c.imp('financeUpdates.post', request)
        assert.equal(rejected.outcome, 'recheck')
        const supplement = await downloadReviewObject(c, rejected.recheck.objectId)
        assert.ok(supplement.facts.problems.some(problem => problem.reason === 'CONFLICT'))
        assert.deepEqual(await rows(c, 'catledger_accounts', 'account_id'), beforeAccounts)
        assert.deepEqual(await rows(c, 'catledger_loans', 'loan_id'), beforeLoans)
        assert.equal((await summary(c)).update.status, 'review')
        assert.equal((await liveTransactions(c)).length, 0)
        assert.equal((await balances(c))[c.accountId], '0')
      })
      assert.ok(!JSON.stringify(logs).includes(SYNTHETIC_CARD), '错误日志不包含原始账户字段')
    } finally { await lab.close() }
  })
