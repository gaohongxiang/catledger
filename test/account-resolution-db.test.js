const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

const FULL_CARD = '9900000000003811'
const MASKED_CARD = '****3811'
const ledger = accountId => ({ kind: 'ledger', accountId })
const external = () => ({ kind: 'external' })
const ownership = (source, destination, extra = {}) => ({ source, destination, ...extra })

test('账户归属：真实处理器保持方向、绑定范围、原始来源、原子性和回执',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 240000 }, async t => {
    const lab = await isolatedMysql(), logs = []
    try {
      const apiPool = await lab.role('api', grants.api), importer = await lab.role('import', grants.importer)
      let failure = null
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failure && failure.pattern.test(sql) && ++failure.matches === failure.at) throw new Error('synthetic account-resolution rollback')
            const result = await target.execute(sql, values)
            if (failure && /INSERT\s+INTO\s+catledger_transactions\b/i.test(sql)) failure.insertedTransactions += Number(result[0].affectedRows)
            return result
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function setup() {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-account-resolution-' + randomUUID(),
          logger: { warn: value => logs.push(value), error: value => logs.push(value) } })
        const c = { services, accounts: {}, api: (action, data) => call(services.api, action, data),
          imp: (action, data) => call(services.import, action, data) }
        c.uid = (await c.api('bootstrap')).uid
        for (const [name, type] of [['bank', 'bank'], ['bankOther', 'bank'], ['wallet', 'wallet'], ['credit', 'credit']]) {
          c.accounts[name] = (await c.api('accounts.create', { requestId: randomUUID(), type,
            name: '合成归属-' + name, currency: 'CNY', openingDisplayBalanceMinor: '0',
            occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        }
        return c
      }
      const summary = c => c.imp('financeUpdates.summary', { updateId: c.updateId })
      const events = async c => (await c.imp('economicEvents.list', { updateId: c.updateId })).items
      const issues = async c => (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', status: 'open' })).items.filter(item => item.issueType === 'account_mapping')
      const dump = async (c, table, order) => (await lab.owner.execute('SELECT * FROM ' + table + ' WHERE uid=? ORDER BY ' + order, [c.uid]))[0]
      const balances = async c => Object.fromEntries((await c.api('accounts.list')).accounts.map(row => [row.accountId, row.bookBalanceMinor]))
      const imported = async c => (await dump(c, 'catledger_transactions', 'transaction_id')).filter(row => row.origin === 'import')
      async function sourceRows(c) {
        return (await lab.owner.execute(`SELECT row_id,batch_id,payment_method_key,payment_method_raw,observed_identity_key,observed_core_digest,
          source_transaction_id_raw,transaction_time_raw,amount_raw,direction_raw,status_raw,transaction_type_raw,counterparty_raw,item_raw,note_raw,
          raw_fields_json,normalized_direction,normalized_amount_minor,normalized_local_at FROM catledger_import_rows WHERE uid=? ORDER BY row_id`, [c.uid]))[0]
      }
      async function state(c) {
        const tables = [['catledger_finance_updates', 'update_id'], ['catledger_economic_events', 'event_id'],
          ['catledger_finance_actions', 'action_id'], ['catledger_review_issues', 'issue_id'],
          ['catledger_review_issue_members', 'issue_id,object_id,member_role'],
          ['catledger_finance_update_account_mapping_drafts', 'draft_mapping_id'],
          ['catledger_import_account_mappings', 'mapping_id'], ['catledger_transactions', 'transaction_id'],
          ['catledger_mutation_receipts', 'idempotency_key_digest']]
        return Object.fromEntries(await Promise.all(tables.map(async ([table, order]) => [table, await dump(c, table, order)])))
      }
      async function parseBank(c, { direction = 'expense', card = FULL_CARD, amount = '1000.00', day = '03', count = 1 } = {}) {
        const incoming = direction === 'income'
        const content = Buffer.from(['交易日期,交易金额,收支,交易类型,卡号,流水号,摘要',
          ...Array.from({ length: count }, (_, index) => [`2026-09-${day}`, amount, incoming ? '收入' : '支出',
            incoming ? '合成收款' : '消费', card, 'SYNTHETIC-OWNERSHIP-' + randomUUID(), '合成归属记录' + index].join(','))].join('\n'))
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成归属.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        const preview = (await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })).bankPreview
        assert.ok(preview, '银行文件由真实解析器确认列映射')
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: { ...preview.suggested,
          statementKind: incoming ? 'credit' : 'standard', schemaVersion: 1, sheetIndex: preview.sheetIndex,
          headerRow: preview.headerRow, headerToken: preview.headerToken } })
        return parsed.batch.batchId
      }
      async function prepare(c, options = {}, map = true) {
        const batchId = await parseBank(c, options)
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [batchId] })).updateId
        if (map) await mapAll(c, options.direction === 'income' ? c.accounts.credit : c.accounts.bank)
        c.eventId = (await events(c))[0].eventId
        return c
      }
      function mappingDecision(issue, accountId) {
        return { issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields',
          ...(accountId === 'external' ? { paymentRuleAction: 'external', fields: {} } : { fields: { mappingAccountId: accountId } }) }
      }
      async function mapAll(c, accountId) {
        const pending = await issues(c)
        if (pending.length) await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: pending.map(issue => mappingDecision(issue, accountId)) })
      }
      async function editInput(c, change = {}) {
        const event = (await events(c)).find(row => row.eventId === c.eventId)
        return { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await summary(c)).update.version,
          eventId: c.eventId, eventVersion: event.version, editorVersion: 1, fields: {}, ...change }
      }
      async function setOwnership(c, value, fields = {}) {
        return c.imp('financeUpdates.setReview', await editInput(c, { fields, decisions: { accountOwnership: value } }))
      }
      const postInput = async c => ({ requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })
      async function post(c) { return c.imp('financeUpdates.post', await postInput(c)) }
      function assertBalanceChanges(c, before, after, expected) {
        for (const [name, accountId] of Object.entries(c.accounts)) {
          assert.equal(BigInt(after[accountId]) - BigInt(before[accountId]), BigInt(expected[name] || 0), name + ' 的余额差额')
        }
      }
      async function current(c) { return (await events(c)).find(row => row.eventId === c.eventId) }

      for (const direction of ['expense', 'income']) await t.test(`${direction} 来源：本人资产到本人债务全额转账，原请求重试只记一次`, async () => {
        const c = await prepare(await setup(), { direction }), raw = await sourceRows(c), before = await balances(c)
        await setOwnership(c, ownership(ledger(c.accounts.bank), ledger(c.accounts.credit)), { economicNature: 'repayment' })
        assert.equal((await current(c)).status, 'ready')
        assert.equal((await imported(c)).length, 0, '核对保存不提前动账')
        const request = await postInput(c), [posted, replay] = await Promise.all([c.imp('financeUpdates.post', request), c.imp('financeUpdates.post', request)])
        assert.deepEqual(replay, posted)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        const rows = await imported(c)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].type, 'transfer'); assert.equal(String(rows[0].amount_minor), '100000')
        assert.equal(rows[0].source_account_id, c.accounts.bank); assert.equal(rows[0].destination_account_id, c.accounts.credit)
        assertBalanceChanges(c, before, await balances(c), { bank: -100000, credit: 100000 })
        assert.deepEqual(await sourceRows(c), raw)
        assert.equal((await dump(c, 'catledger_loan_payments', 'payment_id')).length, 0)
      })

      for (const direction of ['expense', 'income']) await t.test(`${direction} 来源：两种代还只改变本人的实际账户，往返编辑不倒置端点`, async () => {
        const c = await prepare(await setup(), { direction }), raw = await sourceRows(c), before = await balances(c)
        const mine = ownership(ledger(c.accounts.bank), ledger(c.accounts.credit))
        const delegated = direction === 'expense' ? ownership(ledger(c.accounts.bank), external()) : ownership(external(), ledger(c.accounts.credit))
        await setOwnership(c, mine, { economicNature: 'repayment' })
        await setOwnership(c, delegated)
        assert.equal((await current(c)).economicNature, direction)
        await c.imp('financeUpdates.setReview', await editInput(c, { fields: { note: '合成代还编辑' } }))
        assert.equal((await current(c)).economicNature, direction, '普通文本编辑不恢复已清除的对端')
        await setOwnership(c, mine)
        assert.equal((await current(c)).economicNature, 'repayment')
        await setOwnership(c, delegated)
        const request = await postInput(c), posted = await c.imp('financeUpdates.post', request)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        const [entry] = await imported(c)
        assert.equal((await imported(c)).length, 1); assert.equal(entry.type, direction); assert.equal(String(entry.amount_minor), '100000')
        assert.equal(entry.source_account_id, direction === 'expense' ? c.accounts.bank : null)
        assert.equal(entry.destination_account_id, direction === 'income' ? c.accounts.credit : null)
        assertBalanceChanges(c, before, await balances(c), direction === 'expense' ? { bank: -100000 } : { credit: 100000 })
        assert.deepEqual(await sourceRows(c), raw)
        assert.equal((await dump(c, 'catledger_loan_payments', 'payment_id')).length, 0)
      })

      await t.test('未知归属保留待核对，跨用户账户和未明确的双外部决定失败不改草稿', async () => {
        const c = await prepare(await setup()), other = await setup(), raw = await sourceRows(c)
        await setOwnership(c, ownership(ledger(c.accounts.bank), { kind: 'unknown' }), { economicNature: 'repayment' })
        assert.equal((await current(c)).status, 'needs_action')
        await assert.rejects(post(c), { publicCode: 'UNRESOLVED_IMPORT' })
        const before = await state(c)
        for (const value of [ownership(ledger(other.accounts.bank), ledger(c.accounts.credit)), ownership(external(), external()),
          ownership(ledger(c.accounts.bank), ledger(c.accounts.credit), { noLedgerImpact: true })]) {
          await assert.rejects(setOwnership(c, value), { publicCode: 'VALIDATION_ERROR' })
          assert.deepEqual(await state(c), before)
        }
        await setOwnership(c, ownership(external(), external(), { noLedgerImpact: true }))
        assert.equal((await current(c)).status, 'excluded')
        const beforeBalances = await balances(c)
        await post(c)
        assert.equal((await imported(c)).length, 0)
        assert.deepEqual(await balances(c), beforeBalances)
        assert.deepEqual(await sourceRows(c), raw)
      })

      await t.test('普通单笔可在账户核对中明确外部，不能创建虚拟账户或改来源字段', async () => {
        const c = await prepare(await setup(), { card: MASKED_CARD }, false), raw = await sourceRows(c), before = await balances(c)
        assert.equal((await issues(c)).length, 1)
        await mapAll(c, 'external')
        assert.equal((await current(c)).status, 'excluded')
        const drafts = await dump(c, 'catledger_finance_update_account_mapping_drafts', 'draft_mapping_id')
        assert.equal(drafts.length, 1); assert.equal(drafts[0].mapping_action, 'external'); assert.equal(drafts[0].account_id, null)
        await post(c)
        assert.deepEqual(await balances(c), before)
        assert.equal((await imported(c)).length, 0)
        assert.equal((await dump(c, 'catledger_import_account_mappings', 'mapping_id')).length, 0, '文件范围确认不发布历史规则')
        assert.deepEqual(await sourceRows(c), raw)
      })

      await t.test('完整卡号的账本外确认只在本批有效，下一批重新询问', async () => {
        const c = await prepare(await setup(), { card: FULL_CARD }, false), raw = await sourceRows(c)
        assert.equal((await issues(c)).length, 1)
        await mapAll(c, 'external')
        const [draft] = await dump(c, 'catledger_finance_update_account_mapping_drafts', 'draft_mapping_id')
        assert.equal(draft.mapping_action, 'external'); assert.equal(draft.binding_json.reusable, true)
        await post(c)
        assert.equal((await dump(c, 'catledger_import_account_mappings', 'mapping_id')).length, 0, '账本外确认不发布历史规则')
        assert.deepEqual(await sourceRows(c), raw)
        await prepare(c, { card: FULL_CARD, amount: '880.00', day: '19' }, false)
        assert.equal((await issues(c)).length, 1, '下一批仍需确认归属')
        assert.equal((await current(c)).ledgerAccountId, null)
        assert.equal((await current(c)).status, 'needs_action')
      })

      await t.test('真实组合付款不接受把成分账户直接标为外部，失败保持全部证据和决定', async () => {
        const c = await setup()
        const content = Buffer.from(['微信支付账单明细',
          '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号',
          '2026-09-01 12:00:00,商户消费,合成商户,合成商品,支出,10.00,零钱&招商银行储蓄卡(3811),支付成功,SYNTHETIC-OWNERSHIP-SPLIT-' + randomUUID()].join('\n'))
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成组合归属.csv', size: content.length }] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
          fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })).updateId
        const pending = await issues(c), before = await state(c), raw = await sourceRows(c)
        assert.equal(pending.length, 2)
        for (const issue of pending) {
          await assert.rejects(c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
            updateVersion: (await summary(c)).update.version, decisions: [mappingDecision(issue, 'external')] }), { publicCode: 'VALIDATION_ERROR' })
          assert.deepEqual(await state(c), before)
        }
        assert.deepEqual(await sourceRows(c), raw)
      })

      await t.test('旧无 binding 历史仅建议，完整卡号经用户确认并入账后才可跨文件复用', async () => {
        const c = await setup(), batchId = await parseBank(c), raw = await sourceRows(c)
        assert.equal(raw.length, 1)
        await lab.owner.execute(`INSERT INTO catledger_import_account_mappings
          (uid,mapping_id,source_type,payment_method_key,payment_method_hint,mapping_action,account_id)
          VALUES(?,?,'bank',?,'合成旧账户线索','account',?)`, [c.uid, randomUUID(), raw[0].payment_method_key, c.accounts.bankOther])
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [batchId] })).updateId
        c.eventId = (await events(c))[0].eventId
        assert.equal((await current(c)).ledgerAccountId, null)
        assert.equal((await issues(c)).length, 1, '旧历史存在也不能替用户确认归属')
        await mapAll(c, c.accounts.bank)
        assert.equal((await dump(c, 'catledger_import_account_mappings', 'mapping_id')).length, 1, '保存草稿不发布长期绑定')
        const [draft] = await dump(c, 'catledger_finance_update_account_mapping_drafts', 'draft_mapping_id')
        assert.ok(draft.binding_json); assert.equal(draft.binding_json.reusable, true); assert.equal(draft.binding_json.confirmedBy, 'user')
        assert.notEqual(draft.payment_method_key, raw[0].payment_method_key, '绑定键另存，原来源付款键不重写')
        await post(c)
        const history = await dump(c, 'catledger_import_account_mappings', 'mapping_id')
        assert.equal(history.length, 2); assert.equal(history.find(row => row.binding_json)?.account_id, c.accounts.bank)
        assert.equal(history.find(row => row.binding_json === null).account_id, c.accounts.bankOther)
        assert.deepEqual(await sourceRows(c), raw)
        await prepare(c, { amount: '730.00', day: '18' }, false)
        assert.equal((await issues(c)).length, 0)
        assert.equal((await current(c)).ledgerAccountId, c.accounts.bank)
        assert.equal((await current(c)).status, 'ready', '普通付款不新增归属问题')
        await post(c)
        const all = await imported(c)
        assert.equal(all.length, 2); assert.ok(all.every(row => row.source_account_id === c.accounts.bank))
      })

      await t.test('可靠绑定撤销恢复原账户和依据，过期预览拒绝且后来修改不被撤销覆盖', async () => {
        const c = await prepare(await setup()), before = await balances(c)
        const [draft] = await dump(c, 'catledger_finance_update_account_mapping_drafts', 'draft_mapping_id')
        // 已确认历史绑定没有其他活动导入引用，才允许本次撤销恢复；
        // 另一张仍在使用该绑定的导入会保留当前规则，不能拿它模拟可回退场景。
        await lab.owner.execute(`INSERT INTO catledger_import_account_mappings
          (uid,mapping_id,source_type,payment_method_key,payment_method_hint,mapping_action,account_id,binding_json)
          VALUES(?,?,'bank',?,'合成可靠历史绑定','account',?,?)`,
        [c.uid, randomUUID(), draft.payment_method_key, c.accounts.bankOther, JSON.stringify(draft.binding_json)])
        const original = (await dump(c, 'catledger_import_account_mappings', 'mapping_id'))[0]
        await post(c)
        assert.equal((await dump(c, 'catledger_import_account_mappings', 'mapping_id'))[0].account_id, c.accounts.bank)
        const impact = await c.imp('financeUpdates.undoImpact', { updateId: c.updateId })
        const request = { requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version, previewToken: impact.previewToken }
        assert.equal(impact.canUndo, true)
        const undone = await c.imp('financeUpdates.undo', request)
        assert.deepEqual(await c.imp('financeUpdates.undo', request), undone)
        const restored = (await dump(c, 'catledger_import_account_mappings', 'mapping_id'))[0]
        assert.equal(restored.account_id, original.account_id)
        assert.deepEqual(restored.binding_json, original.binding_json)
        await prepare(c, { amount: '730.00', day: '18' }, false)
        const [issue] = (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts' })).items
        assert.equal(issue.status, 'resolved')
        await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version,
          decisions: [{ ...mappingDecision(issue, c.accounts.bank), operation: 'revise' }] })
        await post(c)
        const firstUpdate = c.updateId
        const stale = await c.imp('financeUpdates.undoImpact', { updateId: firstUpdate })
        await lab.owner.execute('UPDATE catledger_import_account_mappings SET version=version+1 WHERE uid=? AND mapping_id=?', [c.uid, original.mapping_id])
        await assert.rejects(c.imp('financeUpdates.undo', { requestId: randomUUID(), updateId: firstUpdate,
          version: (await summary(c)).update.version, previewToken: stale.previewToken }), { publicCode: 'CONFLICT' })
        const fresh = await c.imp('financeUpdates.undoImpact', { updateId: firstUpdate })
        assert.ok(fresh.sideEffects.retainedMappingCount > 0)
        await c.imp('financeUpdates.undo', { requestId: randomUUID(), updateId: firstUpdate,
          version: (await summary(c)).update.version, previewToken: fresh.previewToken })
        const retained = (await dump(c, 'catledger_import_account_mappings', 'mapping_id'))[0]
        assert.equal(retained.account_id, c.accounts.bank)
        assert.deepEqual(retained.binding_json, original.binding_json)
        assert.deepEqual(await balances(c), before)
        assert.equal((await imported(c)).filter(row => row.deleted_at == null).length, 0)
      })

      await t.test('同尾号两文件不串账户，本批保存后重整按原成员恢复，下一批仍须确认', async () => {
        const c = await setup()
        const batchIds = [await parseBank(c, { card: MASKED_CARD, amount: '310.00', day: '08' }),
          await parseBank(c, { card: MASKED_CARD, amount: '470.00', day: '19' })]
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds })).updateId
        const raw = await sourceRows(c), pending = await issues(c)
        assert.equal(pending.length, 2, '同尾号只能在各自文件内分组')
        await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: pending.map((issue, index) => mappingDecision(issue, index ? c.accounts.bankOther : c.accounts.bank)) })
        const before = (await events(c)).map(row => [row.eventId, row.ledgerAccountId]).sort()
        assert.deepEqual(before.map(row => row[1]).sort(), [c.accounts.bank, c.accounts.bankOther].sort())
        const drafts = await dump(c, 'catledger_finance_update_account_mapping_drafts', 'draft_mapping_id')
        assert.equal(drafts.length, 2); assert.equal(new Set(drafts.map(row => row.payment_method_key)).size, 2)
        assert.ok(drafts.every(row => row.binding_json.reusable === false && row.binding_json.scopeKind === 'file'))
        await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })
        assert.deepEqual((await events(c)).map(row => [row.eventId, row.ledgerAccountId]).sort(), before)
        assert.equal((await issues(c)).length, 0)
        await post(c)
        assert.equal((await dump(c, 'catledger_import_account_mappings', 'mapping_id')).length, 0)
        assert.deepEqual(await sourceRows(c), raw)
        await prepare(c, { card: MASKED_CARD, amount: '890.00', day: '27' }, false)
        assert.equal((await issues(c)).length, 1)
        assert.equal((await current(c)).ledgerAccountId, null)
      })

      await t.test('一个错误令整批核对回滚，入账中断后同键恢复且回执不重复', async () => {
        const c = await setup(), other = await setup()
        const batchIds = [await parseBank(c, { card: MASKED_CARD, amount: '210.00', day: '11' }),
          await parseBank(c, { card: '****7092', amount: '690.00', day: '23' })]
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds })).updateId
        const pending = await issues(c), initial = await state(c), raw = await sourceRows(c)
        assert.equal(pending.length, 2)
        const mapping = { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await summary(c)).update.version,
          decisions: pending.map((issue, index) => mappingDecision(issue, index ? other.accounts.bank : c.accounts.bank)) }
        await assert.rejects(c.imp('reviewIssues.resolveAccountMappings', mapping), { publicCode: 'VALIDATION_ERROR' })
        assert.deepEqual(await state(c), initial)
        await mapAll(c, c.accounts.bank)
        const request = await postInput(c), ready = await state(c), before = await balances(c)
        failure = { pattern: /UPDATE\s+catledger_finance_updates\s+SET\s+status\s*=\s*'posted'/i, at: 1, matches: 0, insertedTransactions: 0 }
        try {
          await assert.rejects(c.imp('financeUpdates.post', request))
          assert.equal(failure.matches, 1, '确实到达入账完成前的故障边界')
          assert.equal(failure.insertedTransactions, 2, '两笔交易已在同一事务执行，必须一起回滚')
        } finally { failure = null }
        assert.deepEqual(await state(c), ready)
        assert.deepEqual(await balances(c), before)
        const posted = await c.imp('financeUpdates.post', request)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        assert.equal((await imported(c)).length, 2)
        assertBalanceChanges(c, before, await balances(c), { bank: -90000 })
        assert.deepEqual(await sourceRows(c), raw)
      })
      assert.ok(!JSON.stringify(logs).includes(FULL_CARD), '处理器诊断不输出原账户号码')
    } finally { await lab.close() }
  })
