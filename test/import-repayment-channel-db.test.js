const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const { parseJson } = require('../cloudfunctions/catledger-import/src/finance-update-repository')

test('还款渠道核对：真实解析、最小权限、手续费守恒与原子恢复', {
  skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 240000
}, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    async function setup({ count = 1, mapPayer = true, mapTarget = true, differentTarget = false, extraPlatform = false,
      target = '合成银行信用卡(1234)', direction = '支出', feeCategory = true, total = '500.50' } = {}) {
      const subject = 'synthetic-repayment-channel-' + randomUUID()
      const services = localServices({ apiPool, importPool, subject })
      const api = (action, data) => call(services.api, action, data)
      const imp = (action, data) => call(services.import, action, data)
      const user = await api('bootstrap')
      const account = async (type, name) => (await api('accounts.create', { requestId: randomUUID(), type, name,
        openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
      const creditId = await account('credit', '合成银行信用卡1234')
      const payerId = await account('wallet', '合成支付宝余额')
      const otherCreditId = differentTarget ? await account('credit', '合成另一信用卡5678') : creditId
      const [[category]] = await lab.owner.execute(`SELECT category_id AS id FROM catledger_categories
        WHERE uid = ? AND system_key = 'finance__service' AND archived_at IS NULL`, [user.uid])
      assert.ok(category, '合成用户应具有系统手续费分类')
      if (!feeCategory) await lab.owner.execute('UPDATE catledger_categories SET archived_at = CURRENT_TIMESTAMP(3) WHERE uid = ? AND category_id = ?', [user.uid, category.id])
      const prefix = randomUUID()
      const contents = [
        Buffer.from(['导出信息:合成还款验收',
          '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
          ...Array.from({ length: count }, (_, i) => `2026-09-02 08:${String(35 + i).padStart(2, '0')}:45,信用借还,${target},信用卡还款,${direction},${total},余额,还款成功,SYNTHETIC-REPAYMENT-${prefix}-${i},,`),
          ...(extraPlatform ? [`2026-09-03 08:35:45,信用借还,${target},信用卡还款,支出,200.00,余额,还款成功,SYNTHETIC-REPAYMENT-${prefix}-UNPAIRED,,`] : [])
        ].join('\n')),
        Buffer.from(['交易日期,交易金额,收支,交易类型,摘要,账户,交易流水号',
          ...Array.from({ length: count }, (_, i) => `2026-09-02 09:${String(10 + i).padStart(2, '0')},500.00,收入,,支付宝还款,9999000011111234,SYNTHETIC-BANK-REPAYMENT-${prefix}-${i}`)
        ].join('\n'))
      ]
      const c = { services, subject, api, imp, uid: user.uid, creditId, payerId, otherCreditId,
        feeCategoryId: feeCategory ? category.id : null, contents }
      c.prepare = async ({ reexport = false } = {}) => {
        const batchIds = []
        const exports = reexport ? contents.map(content => Buffer.concat([content, Buffer.from('\n')])) : contents
        for (const [index, content] of exports.entries()) {
          const file = (await imp('imports.prepareMany', { requestId: randomUUID(),
            files: [{ fileName: `合成还款渠道${index}.csv`, size: content.length }] })).files[0]
          services.objects.set(file.cloudPath, content)
          const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
          let parsed = await imp('imports.parseFile', { requestId: randomUUID(), ...input })
          if (parsed.bankPreview) {
            const p = parsed.bankPreview
            parsed = await imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: { ...p.suggested,
              schemaVersion: 1, headerRow: p.headerRow, sheetIndex: p.sheetIndex, headerToken: p.headerToken, statementKind: 'credit' } })
          }
          assert.ok(parsed.batch, '不同导出字节应进入交易身份去重，不能提前命中整文件去重')
          batchIds.push(parsed.batch.batchId)
        }
        return (await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds })).updateId
      }
      c.updateId = await c.prepare()
      c.summary = () => imp('financeUpdates.summary', { updateId: c.updateId })
      c.pairings = (data = {}) => imp('reviewIssues.pairings', { updateId: c.updateId, mode: 'ambiguous', pageSize: 20, ...data })
      c.resolve = data => imp('reviewIssues.resolvePairings', { requestId: randomUUID(), updateId: c.updateId, ...data })
      c.recheck = async () => imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
      c.postInput = async () => ({ requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
      c.post = async input => imp('financeUpdates.post', input || await c.postInput())
      c.map = async ({ payer = mapPayer, targetAccount = mapTarget } = {}) => {
        const page = await imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', pageSize: 100 })
        const decisions = []
        for (const issue of page.items.filter(item => item.status === 'open')) {
          const context = issue.accountContext
          assert.ok(context)
          const bank = context.sourceType === 'bank'
          const targetSide = ['to', 'payment_target'].includes(context.fundsSide)
          if (!bank && (targetSide ? !targetAccount : !payer)) continue
          decisions.push({ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve',
            decision: 'apply_fields', fields: { mappingAccountId: bank ? creditId : targetSide ? otherCreditId : payerId } })
        }
        if (decisions.length) await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(),
          updateId: c.updateId, updateVersion: (await c.summary()).update.version, decisions })
      }
      c.events = async () => (await lab.owner.execute(`SELECT event_id AS eventId, economic_nature AS nature,
        amount_minor AS amountMinor, ledger_account_id AS ledgerAccountId,
        counterparty_ledger_account_id AS counterpartId, version, status, field_sources_json AS sources
        FROM catledger_economic_events WHERE uid = ? AND update_id = ? ORDER BY event_id`, [c.uid, c.updateId]))[0]
        .map(row => ({ ...row, amountMinor: String(row.amountMinor), version: Number(row.version), sources: parseJson(row.sources, {}) }))
      c.transactions = async () => (await lab.owner.execute(`SELECT transaction_id AS id, type, amount_minor AS amountMinor,
        source_account_id AS sourceId, destination_account_id AS destinationId, category_id AS categoryId
        FROM catledger_transactions WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL ORDER BY type, transaction_id`, [c.uid]))[0]
        .map(row => ({ ...row, amountMinor: String(row.amountMinor) }))
      c.drafts = async () => (await lab.owner.execute(`SELECT source_type AS sourceType, payment_method_key AS referenceKey,
        account_id AS accountId, event_id AS eventId FROM catledger_finance_update_account_mapping_drafts
        WHERE uid = ? AND update_id = ? ORDER BY source_type, payment_method_key, event_id`, [c.uid, c.updateId]))[0]
      c.balance = async id => (await api('accounts.list')).accounts.find(row => row.accountId === id).bookBalanceMinor
      c.confirm = async (pairIndex = 0) => {
        const page = await c.pairings(), pair = page.items[pairIndex]
        assert.ok(pair, '应有明确可核对的还款候选')
        await c.resolve({ scopeToken: page.scopeToken, selection: { mode: 'include',
          pairs: [{ pairKey: pair.pairKey, decision: 'same', repaymentConfirmed: true }] } })
        return pair
      }
      await c.map()
      return c
    }

    async function assertMoney(c, count = 1) {
      const transactions = await c.transactions()
      assert.equal(transactions.length, 2 * count)
      const transfers = transactions.filter(row => row.type === 'transfer'), fees = transactions.filter(row => row.type === 'expense')
      assert.equal(transfers.length, count); assert.equal(fees.length, count)
      assert.ok(transfers.every(row => row.amountMinor === '50000' && row.sourceId === c.payerId && row.destinationId === c.creditId && row.categoryId === null))
      assert.ok(fees.every(row => row.amountMinor === '50' && row.sourceId === c.payerId && row.destinationId === null && row.categoryId === c.feeCategoryId))
      assert.equal(await c.balance(c.payerId), String(100000n - BigInt(count) * 50050n))
      assert.equal(await c.balance(c.creditId), String(-100000n + BigInt(count) * 50000n))
      const [links] = await lab.owner.execute(`SELECT role FROM catledger_economic_event_transactions
        WHERE uid = ? AND update_id = ?`, [c.uid, c.updateId])
      assert.equal(links.length, 2 * count)
      assert.ok(links.every(link => link.role === 'payment_allocation'))
      const listed = await c.api('transactions.list', { month: '2026-09', importUpdateId: c.updateId })
      assert.equal(listed.transactions.length, 2 * count)
      assert.equal(listed.summary.expenseMinor, String(50 * count))
      assert.equal(listed.summary.incomeMinor, '0', '还入信用卡的500元不是收入')
      const feesListed = await c.api('transactions.list', { month: '2026-09', importUpdateId: c.updateId,
        ...(c.feeCategoryId ? { categoryId: c.feeCategoryId } : { uncategorized: true }) })
      assert.equal(feesListed.transactions.length, count)
      assert.ok(feesListed.transactions.every(row => row.type === 'expense' && row.amountMinor === '50'))
      const statistics = await c.api('statistics.get', { month: '2026-09' })
      assert.equal(statistics.summary.expenseMinor, String(50 * count))
      assert.equal(statistics.summary.incomeMinor, '0')
    }

    await t.test('同日异时的500元到账与500.50元扣款由用户确认，一次还款加一次手续费且双来源保留', async () => {
      const c = await setup({ mapTarget: false })
      const page = await c.pairings()
      assert.equal(page.total, 1)
      const pair = page.items[0]
      assert.equal(pair.pairKind, 'repayment')
      const bank = (await c.events()).find(event => event.eventId === pair.bank.eventId)
      assert.equal(bank.ledgerAccountId, c.creditId)
      assert.equal(bank.counterpartId, null, '银行自己的到账引用不能再扩展为另一端账户')
      const accountIssues = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts' })).items
      assert.equal(accountIssues.filter(issue => issue.accountContext?.sourceType === 'bank').length, 1,
        '银行到账只产生一组自身账户映射，不重复要求 payment_target')
      const targetIssue = accountIssues.find(issue => issue.accountContext?.sourceType === 'alipay' && issue.accountContext?.fundsSide === 'to')
      assert.ok(targetIssue); assert.equal(targetIssue.status, 'open')
      assert.deepEqual(pair.repayment, { version: 1, totalMinor: '50050', repaymentMinor: '50000', feeMinor: '50',
        targetAccountId: c.creditId, targetAccountName: '合成银行信用卡1234', targetConfirmed: false })
      assert.equal((await c.pairings({ mode: 'suggested' })).total, 0)
      const issues = (await c.imp('reviewIssues.list', { updateId: c.updateId, status: 'open' })).items
      const issue = issues.find(item => item.primaryReasonCode === 'bank_channel_same_event_candidate')
      assert.ok(issue)
      assert.equal((await c.pairings({ issueId: issue.issueId })).total, 1)
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      await c.confirm()
      const [merged] = await c.events()
      assert.equal(merged.eventId, pair.platform.eventId)
      assert.equal(merged.amountMinor, '50050'); assert.equal(merged.nature, 'repayment')
      assert.equal(merged.ledgerAccountId, c.payerId); assert.equal(merged.counterpartId, c.creditId)
      assert.ok(merged.sources.repaymentChannelResolution)
      const drafts = await c.drafts(), targets = drafts.filter(row => row.accountId === c.creditId)
      assert.deepEqual(targets.map(row => row.sourceType), ['alipay', 'bank'])
      assert.ok(drafts.every(row => row.eventId === merged.eventId))
      assert.equal(drafts.find(row => row.referenceKey === targetIssue.accountContext.paymentMethodKey).accountId, c.creditId,
        '原支付宝目标引用与银行到账引用均应保存到还入信用卡')
      const [[completedTarget]] = await lab.owner.execute(`SELECT status, member_count AS count, blocking
        FROM catledger_review_issues WHERE uid = ? AND issue_id = ?`, [c.uid, targetIssue.issueId])
      assert.equal(completedTarget.status, 'resolved'); assert.equal(Number(completedTarget.count), 0)
      assert.equal(Number(completedTarget.blocking), 0)
      const [evidence] = await lab.owner.execute(`SELECT evidence_role AS role FROM catledger_event_evidence
        WHERE uid = ? AND update_id = ? AND event_id = ?`, [c.uid, c.updateId, merged.eventId])
      assert.deepEqual(evidence.map(row => row.role).sort(), ['primary', 'supporting'])
      assert.equal((await c.transactions()).length, 0)
      assert.equal(await c.balance(c.payerId), '100000', '配对保存不得提前扣款')
      const summary = await c.summary()
      assert.equal(summary.workbench.finalSummary.expenseCount, 1)
      assert.equal(summary.workbench.finalSummary.expenseText, '¥0.50')
      assert.equal(summary.workbench.finalSummary.incomeText, '¥0.00')
      assert.equal(summary.workbench.fundsFlowGroups.find(group => group.nature === 'repayment').amountText, '¥500.00')
      const expenses = await c.imp('economicEvents.list', { updateId: c.updateId, status: 'ready', view: 'expense' })
      assert.equal(expenses.total, 1)
      assert.equal(expenses.items[0].summaryExpenseMinor, '50')
      const feeView = require('../miniprogram/pages/import-workbench/model').eventView(expenses.items[0])
      assert.equal(feeView.displayTitle, '还款手续费'); assert.equal(feeView.amountText, '¥0.50')
      const request = await c.postInput(), result = await c.post(request)
      assert.equal(result.posting.createdTransactionCount, 2)
      assert.deepEqual(await c.post(request), result)
      await assertMoney(c)
    })

    await t.test('逐对确认移除本记录的旧目标账户成员，同目标组的其他记录仍需自行核对', async () => {
      const c = await setup({ mapTarget: false, extraPlatform: true })
      const targetIssue = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts' })).items
        .find(issue => issue.accountContext?.sourceType === 'alipay' && issue.accountContext?.fundsSide === 'to')
      assert.ok(targetIssue); assert.equal(targetIssue.memberCount, 2)
      const pair = await c.confirm()
      const [[remaining]] = await lab.owner.execute(`SELECT status, member_count AS count, blocking
        FROM catledger_review_issues WHERE uid = ? AND issue_id = ?`, [c.uid, targetIssue.issueId])
      const [members] = await lab.owner.execute(`SELECT object_id AS eventId FROM catledger_review_issue_members
        WHERE uid = ? AND issue_id = ? AND object_type = 'event'`, [c.uid, targetIssue.issueId])
      assert.equal(remaining.status, 'open'); assert.equal(Number(remaining.count), 1)
      assert.equal(Number(remaining.blocking), 1); assert.equal(members.length, 1)
      assert.notEqual(members[0].eventId, pair.platform.eventId)
      assert.equal((await c.events()).find(event => event.eventId === members[0].eventId).amountMinor, '20000')
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      assert.equal((await c.transactions()).length, 0)
    })

    await t.test('未明确确认差额、批量全选均拒绝；原请求并发与重试只保存一次', async () => {
      const c = await setup({ direction: '不计收支' }), page = await c.pairings(), pair = page.items[0]
      assert.ok(pair); assert.equal(pair.repayment.targetConfirmed, true)
      const before = await c.events(), version = (await c.summary()).update.version
      for (const selection of [
        { mode: 'include', pairs: [{ pairKey: pair.pairKey, decision: 'same' }] },
        { mode: 'include', pairs: [{ pairKey: pair.pairKey, decision: 'same', repaymentConfirmed: false }] },
        { mode: 'all_except', excludedPairKeys: [] }
      ]) await assert.rejects(c.resolve({ scopeToken: page.scopeToken, selection }), { publicCode: 'VALIDATION_ERROR' })
      assert.deepEqual(await c.events(), before)
      assert.equal((await c.summary()).update.version, version)
      const request = { requestId: randomUUID(), scopeToken: page.scopeToken, selection: { mode: 'include',
        pairs: [{ pairKey: pair.pairKey, decision: 'same', repaymentConfirmed: true }] } }
      const [first, replay] = await Promise.all([c.resolve(request), c.resolve(request)])
      assert.deepEqual(replay, first); assert.deepEqual(await c.resolve(request), first)
      assert.equal((await c.events()).length, 1)
      await c.post(); await assertMoney(c)
    })

    await t.test('已确认不同目标或原目标尾号冲突不生成还款候选', async () => {
      for (const options of [{ differentTarget: true }, { mapTarget: false, target: '合成银行信用卡(5678)' }]) {
        const c = await setup(options)
        assert.equal((await c.pairings()).total, 0)
        assert.equal((await c.events()).length, 2)
        assert.equal((await c.transactions()).length, 0)
      }
    })

    await t.test('已明确代还保留用户决定，不用相似来源建立本人还款', async () => {
      const c = await setup({ mapTarget: false }), pair = (await c.pairings()).items[0]
      assert.ok(pair)
      const platform = (await c.events()).find(event => event.eventId === pair.platform.eventId)
      await c.imp('financeUpdates.setReview', { requestId: randomUUID(), updateId: c.updateId,
        updateVersion: (await c.summary()).update.version, eventId: platform.eventId, eventVersion: platform.version,
        editorVersion: 1, fields: {}, decisions: { ownership: { owner: 'other', treatment: 'pending' } } })
      assert.equal((await c.pairings()).total, 0)
      const saved = (await c.events()).find(event => event.eventId === platform.eventId)
      assert.equal(saved.sources.repaymentOwnership.owner, 'other')
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
    })

    await t.test('付款账户未知仍可核对同笔，确认后继续阻止入账，补齐付款账户才允许扣款', async () => {
      const c = await setup({ mapPayer: false })
      await c.confirm()
      const [merged] = await c.events()
      assert.equal(merged.ledgerAccountId, null)
      assert.equal(merged.counterpartId, c.creditId)
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      assert.equal((await c.transactions()).length, 0)
      await c.map({ payer: true, targetAccount: true })
      await c.post(); await assertMoney(c)
    })

    await t.test('同日两条银行加两条平台保留四个候选，只接受不重叠的一对一人工选择', async () => {
      const c = await setup({ count: 2 }), page = await c.pairings()
      assert.equal(page.total, 4)
      const a = page.items[0]
      const b = page.items.find(pair => pair.bank.eventId !== a.bank.eventId && pair.platform.eventId !== a.platform.eventId)
      const overlap = page.items.find(pair => pair.pairKey !== a.pairKey && pair.bank.eventId === a.bank.eventId)
      const selection = pairs => ({ mode: 'include', pairs: pairs.map(pair => ({ pairKey: pair.pairKey, decision: 'same', repaymentConfirmed: true })) })
      await assert.rejects(c.resolve({ scopeToken: page.scopeToken, selection: selection([a, overlap]) }), { publicCode: 'VALIDATION_ERROR' })
      assert.equal((await c.events()).length, 4)
      await c.resolve({ scopeToken: page.scopeToken, selection: selection([a, b]) })
      assert.equal((await c.events()).length, 2)
      await c.post(); await assertMoney(c, 2)
    })

    await t.test('他人不能读取或裁决本用户的配对范围', async () => {
      const c = await setup(), other = await setup(), page = await c.pairings()
      await assert.rejects(other.imp('reviewIssues.pairings', { updateId: c.updateId, mode: 'ambiguous' }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(other.imp('reviewIssues.resolvePairings', { requestId: randomUUID(), updateId: c.updateId,
        scopeToken: page.scopeToken, selection: { mode: 'include', pairs: [{ pairKey: page.items[0].pairKey, decision: 'same', repaymentConfirmed: true }] } }), { publicCode: 'NOT_FOUND' })
      assert.equal((await c.events()).length, 2)
      assert.equal((await other.transactions()).length, 0)
    })

    await t.test('v33旧草稿升级后可核对；保存的新合同再次升级不拆分、不覆盖金额或账户', async () => {
      const c = await setup({ mapTarget: false }), before = await c.events()
      const bank = before.find(row => row.amountMinor === '50000')
      const [sourceRows] = await lab.owner.execute(`SELECT r.row_id AS rowId, r.semantic_json AS semantic
        FROM catledger_import_rows r JOIN catledger_event_evidence e ON e.uid = r.uid AND e.row_id = r.row_id
        WHERE e.uid = ? AND e.update_id = ? AND e.event_id = ?`, [c.uid, c.updateId, bank.eventId])
      for (const row of sourceRows) {
        const semantic = { ...parseJson(row.semantic, {}), profileVersion: 'bank-profile-v3', policyVersion: 'bank-policy-v3',
          sourceAction: null, legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'normal', rule: 'bank.action.review.v1' },
          issues: [{ code: 'row_transaction_type_unknown', field: 'transaction_type', severity: 'warning' }] }
        await lab.owner.execute('UPDATE catledger_import_rows SET semantic_json = ? WHERE uid = ? AND row_id = ?',
          [JSON.stringify(semantic), c.uid, row.rowId])
      }
      await lab.owner.execute(`UPDATE catledger_economic_events SET economic_nature = 'unknown', flow_direction = 'inflow',
        field_sources_json = ?, reason_codes_json = ? WHERE uid = ? AND update_id = ? AND event_id = ?`,
      [JSON.stringify({ ...bank.sources, semanticBlockers: ['row_transaction_type_unknown'] }),
        JSON.stringify(['row_transaction_type_unknown', 'economic_nature_required']), c.uid, c.updateId, bank.eventId])
      await lab.owner.execute(`UPDATE catledger_review_issues SET status = 'superseded', blocking = 0
        WHERE uid = ? AND update_id = ? AND issue_type = 'same_event'`, [c.uid, c.updateId])
      await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v33' WHERE uid = ? AND update_id = ?", [c.uid, c.updateId])
      await c.recheck()
      assert.deepEqual((await c.events()).map(row => row.eventId), before.map(row => row.eventId))
      assert.equal((await c.events()).find(event => event.eventId === bank.eventId).nature, 'repayment')
      assert.equal((await c.pairings()).total, 1)
      await c.confirm()
      const [merged] = await c.events()
      for (let attempt = 0; attempt < 2; attempt++) {
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version = 'organizer-plan-v33' WHERE uid = ? AND update_id = ?", [c.uid, c.updateId])
        await c.recheck()
        const events = await c.events()
        assert.equal(events.length, 1)
        assert.equal(events[0].eventId, merged.eventId)
        assert.equal(events[0].amountMinor, '50050')
        assert.equal(events[0].ledgerAccountId, c.payerId)
        assert.equal(events[0].counterpartId, c.creditId)
        assert.deepEqual(events[0].sources.repaymentChannelResolution, merged.sources.repaymentChannelResolution)
      }
      await c.post(); await assertMoney(c)
    })

    await t.test('入账前拆回两条记录恢复各自账户，再次合并仍需明确确认还款与手续费', async () => {
      const c = await setup({ mapTarget: false }), before = await c.events(), pair = await c.confirm()
      const preview = await c.imp('economicEvents.duplicateReview', { updateId: c.updateId, eventId: pair.platform.eventId })
      assert.equal(preview.canSplit, true)
      await c.imp('financeUpdates.reviseDuplicate', { requestId: randomUUID(), updateId: c.updateId,
        updateVersion: (await c.summary()).update.version, eventId: pair.platform.eventId,
        eventVersion: preview.eventVersion, decision: 'distinct' })
      const events = await c.events()
      assert.equal(events.length, 2)
      for (const event of events) {
        const original = before.find(row => row.amountMinor === event.amountMinor)
        assert.ok(original)
        assert.equal(event.ledgerAccountId, original.ledgerAccountId)
        assert.equal(event.counterpartId, original.counterpartId)
        assert.equal(event.sources.repaymentChannelResolution, undefined)
      }
      assert.equal((await c.pairings()).total, 0)
      assert.equal((await c.transactions()).length, 0)
      assert.equal(await c.balance(c.payerId), '100000')
      assert.equal(await c.balance(c.creditId), '-100000')
      await assert.rejects(c.post(), { publicCode: 'UNRESOLVED_IMPORT' })
      const distinct = await c.imp('economicEvents.duplicateReview', { updateId: c.updateId, eventId: pair.platform.eventId })
      assert.equal(distinct.kind, 'distinct'); assert.equal(distinct.canMerge, true)
      assert.equal(distinct.pairs[0].pairKind, 'repayment')
      assert.equal(distinct.pairs[0].repayment.feeMinor, '50')
      const repeat = { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await c.summary()).update.version,
        eventId: pair.platform.eventId, eventVersion: distinct.eventVersion, decision: 'same',
        pairKey: distinct.pairs[0].pairKey, otherEventId: distinct.pairs[0].otherEventId,
        otherEventVersion: distinct.pairs[0].otherEventVersion }
      await assert.rejects(c.imp('financeUpdates.reviseDuplicate', repeat), { publicCode: 'VALIDATION_ERROR' })
      const confirmed = { ...repeat, requestId: randomUUID(), repaymentConfirmed: true }
      const result = await c.imp('financeUpdates.reviseDuplicate', confirmed)
      assert.deepEqual(await c.imp('financeUpdates.reviseDuplicate', confirmed), result)
      assert.equal((await c.events()).length, 1)
      await c.post(); await assertMoney(c)
    })

    await t.test('确认还款分项后禁止改总额和目标，允许修正付款账户与文字且分项金额保持', async () => {
      const c = await setup(), pair = await c.confirm()
      const alternateCredit = (await c.api('accounts.create', { requestId: randomUUID(), type: 'credit', name: '合成禁止改入另一卡' })).accountId
      const alternatePayer = (await c.api('accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成更正付款账户',
        openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
      const edit = async fields => c.imp('financeUpdates.setReview', { requestId: randomUUID(), updateId: c.updateId,
        updateVersion: (await c.summary()).update.version, eventId: pair.platform.eventId,
        eventVersion: (await c.events())[0].version, editorVersion: 1, fields })
      const before = await c.events()
      const targetMappings = (await c.drafts()).filter(row => row.accountId === c.creditId)
      assert.deepEqual(targetMappings.map(row => row.sourceType), ['alipay', 'bank'])
      for (const fields of [{ amountMinor: '50060' }, { counterpartyLedgerAccountId: alternateCredit }]) {
        await assert.rejects(edit(fields), { publicCode: 'VALIDATION_ERROR' })
        assert.deepEqual(await c.events(), before)
      }
      await edit({ ledgerAccountId: alternatePayer, counterparty: '合成核对说明', note: '合成付款账户已核实' })
      const [after] = await c.events()
      assert.equal(after.ledgerAccountId, alternatePayer)
      assert.equal(after.counterpartId, c.creditId)
      assert.equal(after.amountMinor, '50050')
      assert.deepEqual(after.sources.repaymentChannelResolution, before[0].sources.repaymentChannelResolution)
      assert.equal(after.sources.editorOverrides.note, '合成付款账户已核实')
      assert.equal(after.sources.editorOverrides.counterparty, '合成核对说明')
      assert.deepEqual((await c.drafts()).filter(row => row.accountId === c.creditId), targetMappings,
        '修改付款账户不得将银行到账引用或平台原目标引用污染成付款资产')
      const bankIssue = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts' })).items
        .find(issue => issue.accountContext?.sourceType === 'bank')
      assert.ok(bankIssue); assert.equal(bankIssue.accountContext.accountId, c.creditId)
      await assert.rejects(c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
        updateVersion: (await c.summary()).update.version, decisions: [{ issueId: bankIssue.issueId,
          issueVersion: bankIssue.version, operation: 'revise', decision: 'apply_fields', fields: { mappingAccountId: alternateCredit } }] }),
      error => ['VALIDATION_ERROR', 'CONFLICT'].includes(error.publicCode))
      assert.deepEqual(await c.events(), [after])
      assert.deepEqual((await c.drafts()).filter(row => row.accountId === c.creditId), targetMappings)
      assert.equal(await c.balance(c.payerId), '100000')
      c.payerId = alternatePayer
      await c.post(); await assertMoney(c)
    })

    await t.test('已入账同身份来源重导不重复还款或手续费，余额保持', async () => {
      const c = await setup()
      await c.confirm(); await c.post()
      const transactions = await c.transactions(), balance = [await c.balance(c.payerId), await c.balance(c.creditId)]
      c.updateId = await c.prepare({ reexport: true }); await c.map()
      const page = await c.pairings()
      if (page.total) { assert.equal(page.total, 1); await c.confirm() }
      const result = await c.post()
      assert.equal(result.posting.createdTransactionCount, 0)
      assert.deepEqual(await c.transactions(), transactions)
      assert.deepEqual([await c.balance(c.payerId), await c.balance(c.creditId)], balance)
    })

    await t.test('系统手续费分类不可用时记未分类费用，仍然保持两端金额守恒', async () => {
      const c = await setup({ feeCategory: false })
      await c.confirm(); await c.post(); await assertMoney(c)
    })

    await t.test('零费用和有费用的已入账还款均禁止局部更正，整批撤销恢复两端余额且可幂等重试', async () => {
      for (const total of ['500.00', '500.50']) {
        const c = await setup({ total })
        if (total === '500.00') {
          const [[relation]] = await lab.owner.execute(`SELECT relation_id AS id FROM catledger_economic_event_relations
            WHERE uid=? AND update_id=? AND relation_type='repayment_of' AND status='proposed' AND manual=0`, [c.uid, c.updateId])
          assert.ok(relation, '等额记录应覆盖原有系统还款关系候选')
          await lab.owner.execute(`UPDATE catledger_economic_event_relations SET status='confirmed',manual=1 WHERE uid=? AND relation_id=?`, [c.uid, relation.id])
          const before = await c.events()
          await assert.rejects(c.confirm(), { publicCode: 'VALIDATION_ERROR' })
          assert.deepEqual(await c.events(), before, '不能用同笔确认覆盖已人工确认的独立关系')
          await lab.owner.execute(`UPDATE catledger_economic_event_relations SET status='proposed',manual=0 WHERE uid=? AND relation_id=?`, [c.uid, relation.id])
        }
        const pair = await c.confirm()
        const [[selfLinks]] = await lab.owner.execute(`SELECT COUNT(*) AS count FROM catledger_economic_event_relations
          WHERE uid=? AND update_id=? AND source_event_id=target_event_id AND status NOT IN ('rejected','undone')`, [c.uid, c.updateId])
        assert.equal(Number(selfLinks.count), 0)
        const posted = await c.post(), [event] = await c.events(), before = await c.transactions()
        assert.equal(before.length, total === '500.00' ? 1 : 2)
        const otherCredit = (await c.api('accounts.create', { requestId: randomUUID(), type: 'credit', name: '合成禁止作为付款端' })).accountId
        const fields = { ledgerAccountId: otherCredit }
        const correction = await c.imp('economicEvents.correctionImpact', { eventId: pair.platform.eventId, fields })
        assert.equal(correction.canCorrect, false)
        assert.ok(correction.conflicts.includes('WHOLE_UPDATE_UNDO_REQUIRED'))
        await assert.rejects(c.imp('economicEvents.correct', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: posted.appliedVersion, eventId: event.eventId, eventVersion: event.version,
          fields, previewToken: correction.previewToken }), { publicCode: 'CONFLICT' })
        assert.deepEqual(await c.transactions(), before)
        const impact = await c.imp('financeUpdates.undoImpact', { updateId: c.updateId })
        assert.equal(impact.canUndo, true)
        const undo = { requestId: randomUUID(), updateId: c.updateId, version: posted.appliedVersion, previewToken: impact.previewToken }
        const result = await c.imp('financeUpdates.undo', undo)
        assert.deepEqual(await c.imp('financeUpdates.undo', undo), result)
        assert.equal((await c.transactions()).length, 0)
        assert.equal(await c.balance(c.payerId), '100000')
        assert.equal(await c.balance(c.creditId), '-100000')
      }
    })

    await t.test('合并搬移证据及入账费用分别注入故障，整组回滚后原请求可重试', async () => {
      const c = await setup(), page = await c.pairings(), before = await c.events()
      const merge = { requestId: randomUUID(), scopeToken: page.scopeToken, selection: { mode: 'include',
        pairs: [{ pairKey: page.items[0].pairKey, decision: 'same', repaymentConfirmed: true }] } }
      let failed = false
      const faultPool = { async getConnection() {
        const connection = await importPool.getConnection()
        return new Proxy(connection, { get(target, property) {
          if (property === 'execute') return async (sql, values) => {
            if (!failed && sql.includes('DELETE FROM catledger_economic_events')) { failed = true; throw new Error('synthetic-repayment-merge-fault') }
            return target.execute(sql, values)
          }
          return typeof target[property] === 'function' ? target[property].bind(target) : target[property]
        } })
      } }
      const fault = localServices({ apiPool, importPool: faultPool, subject: c.subject, objects: c.services.objects })
      await assert.rejects(call(fault.import, 'reviewIssues.resolvePairings', { updateId: c.updateId, ...merge }), { publicCode: 'INTERNAL_ERROR' })
      assert.equal(failed, true)
      assert.deepEqual(await c.events(), before)
      const [[evidence]] = await lab.owner.execute(`SELECT COUNT(*) AS n, COUNT(DISTINCT event_id) AS events
        FROM catledger_event_evidence WHERE uid = ? AND update_id = ?`, [c.uid, c.updateId])
      assert.equal(Number(evidence.n), 2); assert.equal(Number(evidence.events), 2)
      await c.resolve(merge)
      const posting = await c.postInput(), merged = await c.events()
      await lab.owner.query(`CREATE TRIGGER synthetic_repayment_fee_rollback BEFORE INSERT ON catledger_transactions FOR EACH ROW
        BEGIN IF NEW.uid = '${c.uid}' AND NEW.type = 'expense' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic repayment fee rollback'; END IF; END`)
      try { await assert.rejects(c.post(posting), { publicCode: 'INTERNAL_ERROR' }) }
      finally { await lab.owner.query('DROP TRIGGER synthetic_repayment_fee_rollback') }
      assert.deepEqual(await c.events(), merged)
      assert.equal((await c.transactions()).length, 0)
      assert.equal(await c.balance(c.payerId), '100000')
      assert.equal(await c.balance(c.creditId), '-100000')
      await c.post(posting); await assertMoney(c)
    })
  } finally { await lab.close() }
})
