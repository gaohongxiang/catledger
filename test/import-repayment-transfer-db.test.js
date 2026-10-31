const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const { PLAN_VERSION } = require('../cloudfunctions/catledger-import/src/domain-versions')

const OLD_PLAN_VERSION = 'organizer-plan-v42'
const SYNTHETIC_CARD = '9900000000000088'

test('普通导入还款：全额转账、计划隔离、旧决定升级及幂等',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql(), logs = []
    try {
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      async function setup() {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-repayment-transfer-' + randomUUID(),
          logger: { warn: value => logs.push(value), error: value => logs.push(value) } })
        const c = { services, accounts: {}, loans: {}, api: (action, data) => call(services.api, action, data),
          imp: (action, data) => call(services.import, action, data) }
        const user = await c.api('bootstrap')
        c.uid = user.uid; c.categoryId = user.categories.find(row => row.kind === 'expense').id
        for (const type of ['bank', 'wallet', 'credit', 'other_liability']) {
          c.accounts[type] = (await c.api('accounts.create', { requestId: randomUUID(), type,
            name: '合成普通还款-' + type, currency: 'CNY', openingDisplayBalanceMinor: '0',
            occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        }
        for (const type of ['credit', 'other_liability']) {
          c.loans[type] = await c.api('loans.create', { requestId: randomUUID(), accountId: c.accounts[type],
            name: '合成独立分期-' + type, kind: 'installment', baselinePrincipalMinor: '600000', baselineDate: '2026-08-01',
            scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'repayment', repaymentMinor: '52000',
            firstPaymentDate: '2026-09-25', generatePlan: true, confirmed: true,
            installmentSetup: { schema: 1, originalPrincipalMinor: '600000', historicalPaidTerms: 0,
              recordType: type === 'credit' ? 'credit_card' : 'bank_loan', customRecordType: '', discountKind: null, discountValue: null } })
        }
        return c
      }
      const summary = c => c.imp('financeUpdates.summary', { updateId: c.updateId })
      const events = async c => (await c.imp('economicEvents.list', { updateId: c.updateId })).items
      const balances = async c => Object.fromEntries((await c.api('accounts.list')).accounts.map(row => [row.accountId, row.bookBalanceMinor]))
      const rows = async (c, table, order) => (await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${order}`, [c.uid]))[0]
      const financeTables = [
        ['catledger_loans', 'loan_id'], ['catledger_loan_periods', 'period_id'], ['catledger_loan_payments', 'payment_id'],
        ['catledger_loan_repayment_details', 'payment_id'], ['catledger_loan_payment_allocations', 'payment_id,loan_id'],
        ['catledger_loan_payment_transactions', 'payment_id,transaction_id'], ['catledger_loan_payment_sources', 'payment_id,event_id'],
        ['catledger_loan_charges', 'charge_id'], ['catledger_loan_charge_allocations', 'payment_id,charge_id']
      ]
      const planState = async c => Object.fromEntries(await Promise.all(financeTables.map(async ([table, order]) => [table, await rows(c, table, order)])))
      async function prepare(c, { direction = 'expense', target = 'credit' } = {}) {
        const incoming = direction === 'income', identity = 'SYNTHETIC-REPAYMENT-' + randomUUID()
        const content = Buffer.from(['交易日期,交易金额,收支,交易类型,卡号,流水号,摘要',
          ['2026-09-03', '1000.00', incoming ? '收入' : '支出', incoming ? '合成收款' : '合成付款',
            SYNTHETIC_CARD, identity, '合成普通资金记录'].join(',')].join('\n'))
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(),
          files: [{ fileName: '合成普通还款.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        const preview = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })
        assert.ok(preview.bankPreview)
        const p = preview.bankPreview
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: {
          ...p.suggested, statementKind: incoming ? 'credit' : 'standard', schemaVersion: 1,
          sheetIndex: p.sheetIndex, headerRow: p.headerRow, headerToken: p.headerToken
        } })
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })).updateId
        c.direction = direction; c.target = target
        const ledgerAccountId = incoming ? c.accounts[target] : c.accounts.bank
        const mappings = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', status: 'open' })).items
          .filter(issue => issue.issueType === 'account_mapping')
        if (mappings.length) await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: mappings.map(issue => ({ issueId: issue.issueId,
            issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: ledgerAccountId } })) })
        const event = (await events(c))[0]
        c.eventId = event.eventId
        const imported = await rows(c, 'catledger_import_rows', 'row_id')
        assert.equal(imported.length, 1); assert.equal(imported[0].normalized_direction, direction,
          '来源方向来自真实解析，不由测试修改数据库替代')
        return c
      }
      async function editorInput(c, extra = {}) {
        const event = (await events(c)).find(row => row.eventId === c.eventId)
        return { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await summary(c)).update.version,
          eventId: c.eventId, eventVersion: event.version, editorVersion: 1, fields: {}, ...extra }
      }
      async function confirmTransfer(c, extra = {}) {
        const incoming = c.direction === 'income'
        await c.imp('financeUpdates.setReview', await editorInput(c, {
          fields: { economicNature: 'repayment', ledgerAccountId: incoming ? c.accounts[c.target] : c.accounts.bank,
            counterpartyLedgerAccountId: incoming ? c.accounts.bank : c.accounts[c.target] },
          decisions: { ownership: { owner: 'self' } }, ...extra
        }))
        assert.equal((await events(c)).find(row => row.eventId === c.eventId).status, 'ready')
      }
      const postInput = async c => ({ requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })
      async function assertTransfer(c, before, plans, expected = [{ accountId: c.accounts[c.target], amountMinor: '100000' }]) {
        const transactions = (await rows(c, 'catledger_transactions', 'transaction_id')).filter(row => row.deleted_at == null)
        assert.equal(transactions.length, expected.length)
        assert.ok(transactions.every(row => row.type === 'transfer' && row.origin === 'import'))
        assert.ok(transactions.every(row => row.source_account_id === c.accounts.bank))
        assert.deepEqual(transactions.map(row => [row.destination_account_id, String(row.amount_minor)]).sort(),
          expected.map(row => [row.accountId, row.amountMinor]).sort())
        const after = await balances(c)
        assert.equal(BigInt(after[c.accounts.bank]) - BigInt(before[c.accounts.bank]), -100000n)
        for (const accountId of Object.values(c.accounts).filter(id => id !== c.accounts.bank)) {
          const amount = expected.find(row => row.accountId === accountId)?.amountMinor || '0'
          assert.equal(BigInt(after[accountId]) - BigInt(before[accountId]), BigInt(amount))
        }
        assert.deepEqual(await planState(c), plans, '普通还款不能产生贷款付款、分摊、收费清偿或修改任何计划期次')
        assert.equal((await c.api('loans.unassigned')).total, 0)
        for (const loan of Object.values(c.loans)) assert.equal((await c.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '600000')
      }
      function oldDecision(c, mode = 'associate') {
        return { confirmed: true, mode, ...(mode === 'associate' ? { loanId: c.loans[c.target].loanId, loanVersion: 1 } : {}),
          assetAccountId: c.accounts.bank, liabilityAccountId: c.accounts[c.target], principalMinor: '90000', interestMinor: '8000', feeMinor: '2000',
          interestTreatment: 'expense', feeTreatment: 'expense', interestCategoryId: c.categoryId, feeCategoryId: c.categoryId, chargeAllocations: [] }
      }
      async function seedLegacy(c, value, { posted = false } = {}) {
        // 仅播种 v42 已持久化的决定形状；导入、账户与计划仍全部由真实接口创建。
        const stored = (await rows(c, 'catledger_economic_events', 'event_id')).find(row => row.event_id === c.eventId)
        const source = { ...stored.field_sources_json, ...value,
          editorOverrides: { ...stored.field_sources_json.editorOverrides, ...value.editorOverrides } }
        await lab.owner.execute(`UPDATE catledger_economic_events SET field_sources_json=?
          ${posted ? '' : ",status='ready',state='ready',reason_codes_json=JSON_ARRAY()"}
          WHERE uid=? AND event_id=?`, [JSON.stringify(source), c.uid, c.eventId])
        await lab.owner.execute('UPDATE catledger_finance_updates SET plan_version=? WHERE uid=? AND update_id=?',
          [OLD_PLAN_VERSION, c.uid, c.updateId])
        return source
      }

      for (const target of ['credit', 'other_liability']) for (const direction of ['expense', 'income']) {
        await t.test(`${target} / ${direction}：100000分只转一次，全额减少付款账户并增加还入账户`, async () => {
          const c = await prepare(await setup(), { target, direction })
          const before = await balances(c), plans = await planState(c)
          await confirmTransfer(c)
          assert.equal((await rows(c, 'catledger_transactions', 'transaction_id')).length, 0, '核对保存不提前动账')
          const request = await postInput(c)
          const [posted, replay] = await Promise.all([c.imp('financeUpdates.post', request), c.imp('financeUpdates.post', request)])
          assert.deepEqual(replay, posted); assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
          assert.equal(posted.posting.createdTransactionCount, 1)
          await assertTransfer(c, before, plans)
        })
      }

      await t.test('普通还款保留多负债账户分配，100000分按40000和60000转账且不拆本息费用', async () => {
        const c = await prepare(await setup()), before = await balances(c), plans = await planState(c)
        const allocations = [{ accountId: c.accounts.credit, amountMinor: '40000' },
          { accountId: c.accounts.other_liability, amountMinor: '60000' }]
        await confirmTransfer(c, { composition: { kind: 'repayment', parts: allocations } })
        await c.imp('financeUpdates.post', await postInput(c))
        await assertTransfer(c, before, plans, allocations)
      })

      await t.test('新编辑和旧setRepayment入口都拒绝非null本息或计划决定，失败不改草稿及账务', async () => {
        const c = await prepare(await setup(), { target: 'other_liability' })
        await confirmTransfer(c)
        const before = await rows(c, 'catledger_economic_events', 'event_id'), plans = await planState(c), funds = await balances(c)
        for (const repayment of [oldDecision(c, 'defer'), oldDecision(c), { mode: 'review' }, { mode: 'ordinary' }]) {
          await assert.rejects(c.imp('financeUpdates.setReview', await editorInput(c, { decisions: { repayment } })), { publicCode: 'VALIDATION_ERROR' })
          const input = await editorInput(c)
          await assert.rejects(c.imp('financeUpdates.setRepayment', { requestId: input.requestId, updateId: input.updateId,
            updateVersion: input.updateVersion, eventId: input.eventId, eventVersion: input.eventVersion, repayment }), { publicCode: 'VALIDATION_ERROR' })
        }
        assert.deepEqual(await rows(c, 'catledger_economic_events', 'event_id'), before)
        assert.deepEqual(await planState(c), plans); assert.deepEqual(await balances(c), funds)
        assert.equal((await rows(c, 'catledger_transactions', 'transaction_id')).length, 0)
      })

      for (const legacy of ['associate', 'defer', 'incomplete']) {
        await t.test(`v42 ${legacy}旧决定原位升级后阻断入账，确认清除后全额转账且原请求幂等`, async () => {
          const c = await prepare(await setup(), { target: 'other_liability' })
          await confirmTransfer(c)
          const plans = await planState(c), before = await balances(c)
          const evidence = await rows(c, 'catledger_event_evidence', 'evidence_id'), raw = await rows(c, 'catledger_import_rows', 'row_id')
          const value = legacy === 'incomplete' ? { editorOverrides: { version: 1, incompleteRepayment: {
            mode: 'defer', principalMinor: '90000', interestMinor: null, feeMinor: '2000', interestTreatment: null, feeTreatment: 'expense', chargeAllocations: []
          } } } : { loanRepayment: oldDecision(c, legacy) }
          const source = await seedLegacy(c, value)
          const organize = { requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version }
          const upgraded = await c.imp('financeUpdates.organize', organize)
          assert.deepEqual(await c.imp('financeUpdates.organize', organize), upgraded)
          const state = await summary(c), event = (await events(c)).find(row => row.eventId === c.eventId)
          assert.equal(state.update.planVersion, PLAN_VERSION); assert.notEqual(PLAN_VERSION, OLD_PLAN_VERSION)
          assert.equal(event.status, 'needs_action'); assert.ok(event.reasonCodes.includes('loan_repayment_required'))
          const stored = (await rows(c, 'catledger_economic_events', 'event_id')).find(row => row.event_id === c.eventId)
          assert.deepEqual(stored.field_sources_json.loanRepayment, source.loanRepayment)
          assert.deepEqual(stored.field_sources_json.editorOverrides.incompleteRepayment, source.editorOverrides.incompleteRepayment)
          assert.deepEqual(await rows(c, 'catledger_event_evidence', 'evidence_id'), evidence)
          assert.deepEqual(await rows(c, 'catledger_import_rows', 'row_id'), raw)
          await assert.rejects(c.imp('financeUpdates.post', await postInput(c)), { publicCode: 'UNRESOLVED_IMPORT' })
          await c.imp('financeUpdates.setReview', await editorInput(c, { fields: { note: '合成仅改备注' } }))
          await assert.rejects(c.imp('financeUpdates.post', await postInput(c)), { publicCode: 'UNRESOLVED_IMPORT' })
          if (legacy === 'defer') {
            const input = await editorInput(c)
            await c.imp('financeUpdates.setRepayment', { requestId: input.requestId, updateId: input.updateId,
              updateVersion: input.updateVersion, eventId: input.eventId, eventVersion: input.eventVersion, repayment: null })
          } else {
            await assert.rejects(c.imp('financeUpdates.setReview', await editorInput(c, { decisions: { repayment: null } })), { publicCode: 'VALIDATION_ERROR' })
            await c.imp('financeUpdates.setReview', await editorInput(c, { decisions: { repayment: null }, acknowledgedChanges: ['repayment'] }))
          }
          const cleared = (await rows(c, 'catledger_economic_events', 'event_id')).find(row => row.event_id === c.eventId)
          assert.equal(cleared.field_sources_json.loanRepayment, null)
          assert.equal(cleared.field_sources_json.editorOverrides.incompleteRepayment, undefined)
          assert.equal(cleared.status, 'ready'); assert.ok(!cleared.reason_codes_json.includes('loan_repayment_required'))
          const request = await postInput(c), posted = await c.imp('financeUpdates.post', request)
          assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
          await assertTransfer(c, before, plans)
        })
      }

      await t.test('posted旧记录保留原决定和账务，不可被整理、编辑或清除入口改写', async () => {
        const c = await prepare(await setup(), { target: 'other_liability' })
        await confirmTransfer(c)
        const request = await postInput(c), posted = await c.imp('financeUpdates.post', request)
        await seedLegacy(c, { loanRepayment: oldDecision(c) }, { posted: true })
        const beforeEvents = await rows(c, 'catledger_economic_events', 'event_id'), beforeUpdates = await rows(c, 'catledger_finance_updates', 'update_id')
        const beforeTransactions = await rows(c, 'catledger_transactions', 'transaction_id'), plans = await planState(c), funds = await balances(c)
        const input = await editorInput(c)
        await assert.rejects(c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: input.updateVersion }), { publicCode: 'CONFLICT' })
        await assert.rejects(c.imp('financeUpdates.setReview', { ...input, decisions: { repayment: null }, acknowledgedChanges: ['repayment'] }), { publicCode: 'CONFLICT' })
        await assert.rejects(c.imp('financeUpdates.setRepayment', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: input.updateVersion, eventId: c.eventId, eventVersion: input.eventVersion, repayment: null }), { publicCode: 'CONFLICT' })
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted, '规则版本改变不破坏已确认原请求的回执重放')
        assert.deepEqual(await rows(c, 'catledger_economic_events', 'event_id'), beforeEvents)
        assert.deepEqual(await rows(c, 'catledger_finance_updates', 'update_id'), beforeUpdates)
        assert.deepEqual(await rows(c, 'catledger_transactions', 'transaction_id'), beforeTransactions)
        assert.deepEqual(await planState(c), plans); assert.deepEqual(await balances(c), funds)
      })
      assert.ok(!JSON.stringify(logs).includes(SYNTHETIC_CARD), '诊断日志不包含原始账户字段')
    } finally { await lab.close() }
  })
