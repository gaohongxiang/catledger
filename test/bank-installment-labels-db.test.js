const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/review/policy')

const CASH_PRINCIPAL = '电销现分按月收6期第3期共6期'
const BILL_PRINCIPAL = '电销总账分月6期第3期共6期'
const INTEREST = '分期付款利息第3期共6期'
const plan = {
  scheduleMethod: 'flat', scheduleTerms: 6, measurementKind: 'repayment', repaymentMinor: '10300',
  firstPaymentDate: '2026-07-03', kind: 'installment', name: '合成摘要分期',
  baselinePrincipalMinor: '60000', baselineDate: '2026-07-01', generatePlan: true, confirmed: true,
  installmentSetup: { schema: 1, originalPrincipalMinor: '60000', historicalPaidTerms: 0,
    recordType: 'credit_card', customRecordType: '', discountKind: null, discountValue: null }
}

function bankFile(rows, explicit = false) {
  const headers = ['交易日期', '交易金额', '收支', '交易类型', '卡号', '流水号', '摘要']
  if (explicit) headers.push('分期编号', '当前期数', '总期数', '分期分项')
  return Buffer.from([headers.join(','), ...rows.map(row => [
    '2026-09-03', row.amount || '100.00', '支出', row.label, 'SYNTHETIC-LABEL-CARD', row.flow,
    '合成摘要回归', ...(explicit ? [row.reference || '', row.period || '', row.terms || '', row.component || ''] : [])
  ].join(','))].join('\n'))
}

test('银行分期摘要：真实解析、最小权限 MySQL、独立来源与 v32 草稿原位升级',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql(), logs = []
    try {
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      const createCredit = (c, name = '合成摘要信用卡') => c.api('accounts.create', {
        requestId: randomUUID(), type: 'credit', name, openingDisplayBalanceMinor: '0',
        occurredLocalAt: '2026-07-01T00:00:00', timezoneOffsetMinutes: -480
      })
      async function context() {
        const subject = 'synthetic-bank-label-' + randomUUID()
        const services = localServices({ apiPool, importPool, subject,
          logger: { error: value => logs.push(value), warn: value => logs.push(value) } })
        const c = { services, api: (action, data) => call(services.api, action, data),
          imp: async (action, data) => {
            try { return await call(services.import, action, data) }
            catch (error) {
              throw Object.assign(error, { diagnostic: logs.findLast(row => row.action === action) })
            }
          } }
        c.uid = (await c.api('bootstrap')).uid
        c.accountId = (await createCredit(c)).accountId
        return c
      }
      const events = async (c, updateId) => (await c.imp('economicEvents.list', { updateId })).items
      const issues = async (c, updateId) => (await c.imp('reviewIssues.list', { updateId, status: 'open' })).items
      const sources = async c => (await c.api('loans.installmentSources', {})).items
      const ledger = async c => (await lab.owner.execute(
        'SELECT * FROM catledger_transactions WHERE uid=? AND deleted_at IS NULL ORDER BY transaction_id', [c.uid]))[0]
      const rawRows = async c => (await lab.owner.execute(
        'SELECT * FROM catledger_import_rows WHERE uid=? ORDER BY row_id', [c.uid]))[0]
      const evidence = async (c, updateId) => (await lab.owner.execute(
        'SELECT * FROM catledger_event_evidence WHERE uid=? AND update_id=? ORDER BY evidence_id', [c.uid, updateId]))[0]
      const summary = async (c, updateId) => (await c.imp('financeUpdates.summary', { updateId })).update

      async function prepare(c, rows, { explicit = false, replay = false } = {}) {
        const content = bankFile(rows, explicit)
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(),
          files: [{ fileName: '合成银行分期摘要.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        const first = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })
        assert.equal(first.mappingRequired, true)
        const p = first.bankPreview
        const bankMapping = { ...p.suggested, statementKind: 'credit', schemaVersion: 1,
          sheetIndex: p.sheetIndex, headerRow: p.headerRow, headerToken: p.headerToken }
        if (explicit) for (const key of ['installmentReference', 'installmentPeriod', 'installmentTerms', 'installmentComponent']) {
          assert.equal(Number.isInteger(bankMapping.columns[key]), true, key)
        }
        const parseRequest = { requestId: randomUUID(), ...input, bankMapping }
        const parsed = await c.imp('imports.parseFile', parseRequest)
        assert.equal(parsed.batch.summary.valid, rows.length)
        if (replay) {
          const repeated = await c.imp('imports.parseFile', parseRequest)
          assert.deepEqual(repeated.import, parsed.import); assert.deepEqual(repeated.batch, parsed.batch)
        }
        let update = await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
        const accountIssues = (await c.imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })).items.filter(row => row.status === 'open')
        if (accountIssues.length) update = await c.imp('reviewIssues.resolveAccountMappings', {
          requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
          decisions: accountIssues.map(row => ({ issueId: row.issueId, issueVersion: row.version,
            operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.accountId } }))
        })
        // 夹具的每行都有独立来源；相似候选必须明确确认，不能自动合并后再补齐数量。
        assert.equal((await events(c, update.updateId)).length, rows.length)
        for (let i = 0; i < rows.length; i++) {
          const candidate = (await issues(c, update.updateId)).find(row => row.issueType === 'same_event')
          if (!candidate) break
          update = await c.imp('reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId,
            updateVersion: (await summary(c, update.updateId)).version, issueId: candidate.issueId,
            issueVersion: candidate.version, decision: 'confirm_distinct' })
        }
        return { ...update, batchId: parsed.batch.batchId }
      }
      async function post(c, updateId, replay = false) {
        const request = { requestId: randomUUID(), updateId, version: (await summary(c, updateId)).version }
        assert.deepEqual((await issues(c, updateId)).filter(row => row.blocking).map(row => row.primaryReasonCode), [])
        if (!replay) return c.imp('financeUpdates.post', request)
        const [first, repeat] = await Promise.all([c.imp('financeUpdates.post', request), c.imp('financeUpdates.post', request)])
        assert.deepEqual(repeat, first)
        return first
      }
      function billing(event, component, originKind = 'unconfirmed') {
        assert.deepEqual(event.installment, {
          creditStatement: true, factKind: 'billing', component, periodNumber: 3, totalTerms: 6, originKind
        })
      }
      const loan = (c, extra = {}) => c.api('loans.create', { ...plan, accountId: c.accountId, requestId: randomUUID(), ...extra })
      async function unpaid(c, loanId) {
        const view = await c.api('loans.installments', { loanId })
        assert.equal(view.summary.paidPeriods, 0)
        assert.equal(view.items.length, 6)
        assert.ok(view.items.every(item => !item.complete), '出账和关联不能确认已还')
      }

      await t.test('两类固定本金只保留来源，连写利息只记一笔费用；正常消费不暴露分期投影', async () => {
        const c = await context(), before = await ledger(c)
        const update = await prepare(c, [
          { flow: 'SYNTHETIC-CASH', label: CASH_PRINCIPAL },
          { flow: 'SYNTHETIC-BILL', label: BILL_PRINCIPAL },
          { flow: 'SYNTHETIC-INTEREST', label: INTEREST, amount: '3.00' },
          { flow: 'SYNTHETIC-PURCHASE', label: '消费', amount: '4.00' }
        ], { replay: true })
        const rows = await events(c, update.updateId)
        assert.equal(rows.length, 4)
        const cash = rows.find(row => row.installment && row.installment.originKind === 'cash_borrowing')
        const bill = rows.find(row => row.installment && row.installment.component === 'principal' && row !== cash)
        const interest = rows.find(row => row.installment && row.installment.component === 'interest')
        billing(cash, 'principal', 'cash_borrowing'); billing(bill, 'principal'); billing(interest, 'interest')
        for (const row of [cash, bill]) {
          assert.equal(row.economicNature, 'repayment')
          assert.equal(row.ledgerAccountId, c.accountId)
          assert.equal(row.counterpartyLedgerAccountId, null)
        }
        const purchase = rows.find(row => row.eventId !== cash.eventId && row.eventId !== bill.eventId && row.eventId !== interest.eventId)
        assert.equal(Object.hasOwn(purchase, 'installment'), false)
        assert.ok(!(await issues(c, update.updateId)).some(row => row.issueType === 'transfer_accounts'))
        assert.deepEqual(await ledger(c), before, '解析和整理不能写入正式交易')
        assert.deepEqual(await sources(c), [], '未入账来源不提前进入待关联列表')
        const posted = await post(c, update.updateId, true)
        assert.equal(posted.posting.createdTransactionCount, 2)
        const items = await sources(c)
        assert.equal(items.length, 3)
        assert.equal(new Set(items.map(row => row.identityId)).size, 3)
        assert.ok(items.every(row => row.active && row.accountId === c.accountId && row.loanId === null && row.referenceKey === null && row.referenceLabel === null))
        for (const event of [cash, bill]) assert.equal(items.find(row => row.eventId === event.eventId).transactionId, null)
        const cost = items.find(row => row.eventId === interest.eventId)
        assert.equal(cost.component, 'interest'); assert.equal(cost.amountMinor, '300'); assert.ok(cost.transactionId)
        const booked = (await ledger(c)).filter(row => !before.some(prior => prior.transaction_id === row.transaction_id))
        assert.equal(booked.length, 2); assert.ok(booked.every(row => row.type === 'expense'))
        assert.equal(booked.filter(row => row.transaction_id === cost.transactionId).length, 1)
        const [links] = await lab.owner.execute(`SELECT event_id AS eventId FROM catledger_economic_event_transactions
          WHERE uid=? AND update_id=? AND superseded_at IS NULL`, [c.uid, update.updateId])
        assert.ok(links.every(row => ![cash.eventId, bill.eventId].includes(row.eventId)), '本金不能伪造转账或支出')
      })

      await t.test('无合同号的同额同一期独立来源不归一，关联与新建计划只影响明确选中的来源', async () => {
        const c = await context()
        const update = await prepare(c, [
          { flow: 'SYNTHETIC-INDEPENDENT-P1', label: CASH_PRINCIPAL },
          { flow: 'SYNTHETIC-INDEPENDENT-P2', label: CASH_PRINCIPAL },
          { flow: 'SYNTHETIC-INDEPENDENT-I1', label: INTEREST, amount: '3.00' },
          { flow: 'SYNTHETIC-INDEPENDENT-I2', label: INTEREST, amount: '3.00' }
        ])
        assert.equal((await events(c, update.updateId)).length, 4)
        await post(c, update.updateId)
        const pending = await sources(c), principals = pending.filter(row => row.component === 'principal'), costs = pending.filter(row => row.component === 'interest')
        assert.equal(pending.length, 4); assert.equal(principals.length, 2); assert.equal(costs.length, 2)
        assert.ok(pending.every(row => row.referenceKey === null && row.referenceLabel === null))
        assert.equal(new Set(pending.map(row => row.identityId)).size, 4)
        assert.equal(new Set(costs.map(row => row.transactionId)).size, 2)
        const before = await ledger(c), existing = await loan(c)
        const request = { requestId: randomUUID(), loanId: existing.loanId, version: existing.version, itemId: principals[0].itemId }
        const linked = await c.api('loans.linkInstallmentSource', request)
        assert.deepEqual(await c.api('loans.linkInstallmentSource', request), linked)
        assert.equal(linked.linked, 1); assert.equal((await sources(c)).length, 3)
        const linkedCost = await c.api('loans.linkInstallmentSource', { requestId: randomUUID(), loanId: existing.loanId,
          version: linked.version, itemId: costs[0].itemId })
        assert.equal(linkedCost.linked, 1)
        await assert.rejects(c.api('loans.linkInstallmentSource', { requestId: randomUUID(), loanId: existing.loanId,
          version: linkedCost.version, itemId: costs[1].itemId }), { publicCode: 'LOAN_SOURCE_MISMATCH' })
        const created = await loan(c, { sourceItemId: principals[1].itemId })
        assert.deepEqual((await sources(c)).map(row => row.itemId), [costs[1].itemId])
        await unpaid(c, existing.loanId); await unpaid(c, created.loanId)
        assert.deepEqual(await ledger(c), before, '关联、拒绝错误合并及新建都不改真实账目')
        const [[bindings]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_installment_bindings WHERE uid=?', [c.uid])
        assert.equal(Number(bindings.n), 0, '没有合同编号不能建立自动绑定')
      })

      await t.test('来源和请求结果按用户隔离，相同合成文件可由另一用户独立入账', async () => {
        const a = await context(), b = await context()
        const rows = [{ flow: 'SYNTHETIC-SHARED-FILE', label: CASH_PRINCIPAL }]
        const update = await prepare(a, rows)
        const postRequest = { requestId: randomUUID(), updateId: update.updateId, version: (await summary(a, update.updateId)).version }
        await a.imp('financeUpdates.post', postRequest)
        const [source] = await sources(a), bLoan = await loan(b)
        assert.deepEqual((await b.api('loans.installmentSources', { itemId: source.itemId })).items, [])
        await assert.rejects(b.api('loans.linkInstallmentSource', { requestId: randomUUID(), loanId: bLoan.loanId,
          version: bLoan.version, itemId: source.itemId }), { publicCode: 'NOT_FOUND' })
        await assert.rejects(b.imp('economicEvents.list', { updateId: update.updateId }), { publicCode: 'NOT_FOUND' })
        await assert.rejects(b.imp('financeUpdates.post', postRequest), { publicCode: 'NOT_FOUND' })
        const own = await prepare(b, rows); await post(b, own.updateId, true)
        const [otherSource] = await sources(b)
        assert.ok(otherSource); assert.notEqual(otherSource.itemId, source.itemId)
        assert.notEqual(otherSource.identityId, source.identityId); assert.equal(otherSource.accountId, b.accountId)
        assert.deepEqual(await sources(a), [source])
        await unpaid(b, bLoan.loanId)
      })

      // 只在本次隔离库内复原旧版持久化状态；原始列和证据关系不改写。
      async function legacyState(c, update, alternateAccountId, staleRowIds) {
        const current = await events(c, update.updateId), issueIds = []
        for (const event of current) {
          const [[stored]] = await lab.owner.execute('SELECT field_sources_json AS fields FROM catledger_economic_events WHERE uid=? AND event_id=?', [c.uid, event.eventId])
          const fields = { ...stored.fields }; delete fields.installment
          await lab.owner.execute(`UPDATE catledger_economic_events SET state='needs_action',status='needs_action',
            economic_nature='internal_transfer',flow_direction='neutral',ledger_account_id=?,counterparty_ledger_account_id=NULL,
            manual_field_mask=manual_field_mask|?,field_sources_json=?,reason_codes_json=? WHERE uid=? AND event_id=?`,
          [alternateAccountId, FIELD_MASK.ledgerAccountId, JSON.stringify(fields), JSON.stringify(['transfer_account_required']), c.uid, event.eventId])
          const issueId = randomUUID(); issueIds.push(issueId)
          await lab.owner.execute(`INSERT INTO catledger_review_issues
            (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,version,blocking,primary_reason_code,member_count,candidate_count,rule_version,reason_codes_json)
            VALUES (?,?,?,?,?,'transfer_accounts','open',1,1,'transfer_account_required',1,0,?,?)`,
          [c.uid, issueId, update.updateId, createHash('sha256').update(issueId).digest('hex'), 'review-issue-v13',
            'organizer-plan-v32', JSON.stringify(['transfer_account_required'])])
          await lab.owner.execute(`INSERT INTO catledger_review_issue_members
            (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order)
            VALUES (?,?,?,?,'event',?,?,'subject',0)`, [c.uid, randomUUID(), update.updateId, issueId, event.eventId, event.version])
        }
        for (const row of await rawRows(c)) if (staleRowIds.has(row.row_id)) {
          const semantic = { ...row.semantic_json, profileVersion: 'bank-profile-v2', policyVersion: 'bank-policy-v2',
            relationHints: { ...row.semantic_json.relationHints } }
          delete semantic.relationHints.installment
          await lab.owner.execute('UPDATE catledger_import_rows SET semantic_json=? WHERE uid=? AND row_id=?', [JSON.stringify(semantic), c.uid, row.row_id])
        }
        await lab.owner.execute(`UPDATE catledger_finance_updates SET plan_version='organizer-plan-v32',ready_event_count=0,needs_action_event_count=?
          WHERE uid=? AND update_id=?`, [current.length, c.uid, update.updateId])
        return { current, issueIds }
      }

      async function assertUpgraded(c, update, before, alternateAccountId) {
        const after = await events(c, update.updateId)
        assert.deepEqual(after.map(row => row.eventId).sort(), before.map(row => row.eventId).sort())
        for (const row of after) {
          const original = before.find(event => event.eventId === row.eventId)
          for (const key of ['amountMinor', 'localAt', 'currency', 'primaryEvidence', 'evidenceCount']) assert.deepEqual(row[key], original[key], key)
          assert.equal(row.ledgerAccountId, alternateAccountId)
          assert.equal(row.economicNature, 'repayment'); assert.equal(row.status, 'ready')
          assert.ok(!row.reasonCodes.includes('transfer_account_required'))
        }
        const [manual] = await lab.owner.execute('SELECT manual_field_mask AS mask FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, update.updateId])
        assert.ok(manual.every(row => Number(row.mask) & FIELD_MASK.ledgerAccountId))
        assert.ok(!(await issues(c, update.updateId)).some(row => row.issueType === 'transfer_accounts'))
        const state = await summary(c, update.updateId)
        assert.equal(state.planVersion, 'organizer-plan-v33'); assert.equal(state.requiresReorganization, false)
        return after
      }

      await t.test('v32 未入账草稿原位补齐旧语义及遗漏字段，升级失败回滚且重试保留人工账户与证据', async () => {
        const c = await context(), update = await prepare(c, [
          { flow: 'SYNTHETIC-LEGACY-CASH', label: CASH_PRINCIPAL },
          { flow: 'SYNTHETIC-LEGACY-BILL', label: BILL_PRINCIPAL }
        ])
        const alternate = (await createCredit(c, '合成人工保留信用卡')).accountId
        const currentRows = await rawRows(c)
        const staleRow = currentRows.find(row => row.source_transaction_id_raw === 'SYNTHETIC-LEGACY-CASH')
        const legacy = await legacyState(c, update, alternate, new Set([staleRow.row_id]))
        const rawBefore = await rawRows(c), evidenceBefore = await evidence(c, update.updateId), ledgerBefore = await ledger(c)
        const [eventsBefore] = await lab.owner.execute('SELECT * FROM catledger_economic_events WHERE uid=? ORDER BY event_id', [c.uid])
        const [issuesBefore] = await lab.owner.execute('SELECT * FROM catledger_review_issues WHERE uid=? ORDER BY issue_id', [c.uid])
        const old = await summary(c, update.updateId)
        assert.equal(old.requiresReorganization, true)
        assert.ok((await events(c, update.updateId)).every(row => !Object.hasOwn(row, 'installment')))
        const request = { requestId: randomUUID(), updateId: update.updateId, version: old.version }
        await lab.owner.query(`CREATE TRIGGER fail_synthetic_bank_labels_upgrade BEFORE UPDATE ON catledger_economic_events FOR EACH ROW
          BEGIN IF JSON_EXTRACT(NEW.field_sources_json,'$.installment') IS NOT NULL THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic bank installment upgrade fault'; END IF; END`)
        try { await assert.rejects(c.imp('financeUpdates.organize', request), { publicCode: 'INTERNAL_ERROR' }) }
        finally { await lab.owner.query('DROP TRIGGER fail_synthetic_bank_labels_upgrade') }
        assert.deepEqual((await lab.owner.execute('SELECT * FROM catledger_economic_events WHERE uid=? ORDER BY event_id', [c.uid]))[0], eventsBefore)
        assert.deepEqual((await lab.owner.execute('SELECT * FROM catledger_review_issues WHERE uid=? ORDER BY issue_id', [c.uid]))[0], issuesBefore)
        assert.equal((await summary(c, update.updateId)).version, old.version)
        const result = await c.imp('financeUpdates.organize', request)
        assert.deepEqual(await c.imp('financeUpdates.organize', request), result)
        const after = await assertUpgraded(c, update, legacy.current, alternate)
        for (const row of after) billing(row, 'principal', row.primaryEvidence.rowId === staleRow.row_id ? 'cash_borrowing' : 'unconfirmed')
        assert.deepEqual(await rawRows(c), rawBefore); assert.deepEqual(await evidence(c, update.updateId), evidenceBefore)
        assert.deepEqual(await ledger(c), ledgerBefore)
        const [superseded] = await lab.owner.execute("SELECT status FROM catledger_review_issues WHERE uid=? AND issue_type='transfer_accounts'", [c.uid])
        assert.ok(superseded.every(row => row.status === 'superseded'))
        const posted = await post(c, update.updateId)
        assert.equal(posted.posting.createdTransactionCount, 0)
        assert.equal((await sources(c)).length, 2)
        assert.ok((await sources(c)).every(row => row.accountId === alternate && row.transactionId === null))
        assert.deepEqual(await ledger(c), ledgerBefore)
      })

      await t.test('显式分期列在旧语义重算时保留编号、期号和分项，不依赖摘要猜测', async () => {
        const c = await context(), update = await prepare(c, [{ flow: 'SYNTHETIC-EXPLICIT-COLUMNS',
          label: '合成账单分项', reference: 'SYNTHETIC-EXPLICIT-CONTRACT', period: '3', terms: '6', component: 'principal' }], { explicit: true })
        const before = await events(c, update.updateId)
        billing(before[0], 'principal')
        const legacy = await legacyState(c, update, c.accountId, new Set((await rawRows(c)).map(row => row.row_id)))
        const rawBefore = await rawRows(c), evidenceBefore = await evidence(c, update.updateId)
        await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: update.updateId, version: (await summary(c, update.updateId)).version })
        const [after] = await assertUpgraded(c, update, legacy.current, c.accountId)
        billing(after, 'principal')
        assert.deepEqual(await rawRows(c), rawBefore); assert.deepEqual(await evidence(c, update.updateId), evidenceBefore)
        await post(c, update.updateId)
        const [source] = await sources(c)
        assert.equal(source.referenceLabel, 'SYNTHETIC-EXPLICIT-CONTRACT')
        assert.equal(source.referenceKey, createHash('sha256').update('bank-installment-v1:SYNTHETIC-EXPLICIT-CONTRACT').digest('hex'))
        assert.equal(source.component, 'principal'); assert.equal(source.periodNumber, 3); assert.equal(source.totalTerms, 6)
        assert.equal(source.transactionId, null)
      })
      assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC-LABEL-CARD|SYNTHETIC-EXPLICIT-CONTRACT/)
    } finally { await lab.close() }
  })
