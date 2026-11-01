const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

test('复杂账户归属：真实解析、外部份额、逐笔重核与原子入账',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const apiPool = await lab.role('api', grants.api), importer = await lab.role('import', grants.importer)
      let failure = null
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (failure && /UPDATE\s+catledger_finance_updates\s+SET\s+status\s*=\s*'posted'/i.test(sql)) {
              failure.attempts++; throw Error('synthetic complex rollback')
            }
            const result = await target.execute(sql, values)
            if (failure && /INSERT\s+INTO\s+catledger_transactions\b/i.test(sql)) failure.inserted += Number(result[0].affectedRows)
            return result
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function setup(rows) {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-complex-ownership-' + randomUUID() })
        const c = { services, api: (action, data) => call(services.api, action, data),
          imp: (action, data) => call(services.import, action, data) }
        c.uid = (await c.api('bootstrap')).uid
        for (const type of ['bank', 'wallet', 'credit']) c[type] = (await c.api('accounts.create', {
          requestId: randomUUID(), type, name: '合成复杂归属-' + type, currency: 'CNY', openingDisplayBalanceMinor: '1000000',
          occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
        const prefix = randomUUID(), content = Buffer.from(['微信支付账单明细',
          '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号',
          ...rows.map((row, index) => `2026-09-0${index + 1} 12:00:00,${row.refund ? '退款' : '商户消费'},合成商户,合成商品${index},${row.refund ? '收入' : '支出'},${row.amount},${row.method},${row.refund ? '退款成功' : '支付成功'},SYNTH-COMPLEX-${prefix}-${index}`)
        ].join('\n'))
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成复杂归属.csv', size: content.length }] })).files[0]
        services.objects.set(file.cloudPath, content)
        const parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
          fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })).updateId
        c.summary = () => c.imp('financeUpdates.summary', { updateId: c.updateId })
        c.events = async () => (await c.imp('economicEvents.list', { updateId: c.updateId })).items
        c.issues = async () => (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', pageSize: 100 })).items
        c.balance = async () => Object.fromEntries((await c.api('accounts.list')).accounts.map(row => [row.accountId, String(row.bookBalanceMinor)]))
        c.transactions = async () => (await lab.owner.execute("SELECT type,source_account_id AS source,destination_account_id AS destination,amount_minor AS amount FROM catledger_transactions WHERE uid=? AND origin='import' AND deleted_at IS NULL ORDER BY type,amount_minor", [c.uid]))[0]
        c.postInput = async () => ({ requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
        c.edit = async (eventId, change) => {
          const row = (await c.events()).find(item => item.eventId === eventId)
          return c.imp('financeUpdates.setReview', { requestId: randomUUID(), updateId: c.updateId,
            updateVersion: (await c.summary()).update.version, eventId, eventVersion: row.version, editorVersion: 1, fields: {}, ...change })
        }
        c.map = async (issue, accountId) => c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await c.summary()).update.version, decisions: [{ issueId: issue.issueId, issueVersion: issue.version,
            operation: issue.status === 'resolved' ? 'revise' : 'resolve', decision: 'apply_fields',
            ...(accountId === 'external' ? { paymentRuleAction: 'external', fields: {} } : { fields: { mappingAccountId: accountId } }) }] })
        return c
      }

      await t.test('真实组合与普通支出共享外部引用，普通成员排除、组合保留本人份额，修复后幂等入账', async () => {
        const c = await setup([{ amount: '100.00', method: '零钱&招商银行储蓄卡(3811)' },
          { amount: '10.00', method: '招商银行储蓄卡(3811)' }])
        const raw = (await lab.owner.execute('SELECT raw_fields_json,normalized_amount_minor FROM catledger_import_rows WHERE uid=? ORDER BY row_id', [c.uid]))[0]
        for (const issue of await c.issues()) {
          assert.equal(issue.accountContext.canExternal, true)
          const fresh = (await c.issues()).find(row => row.issueId === issue.issueId)
          await c.map(fresh, /招商/.test(issue.accountContext.label) ? 'external' : c.wallet)
        }
        const rows = await c.events(), combo = rows.find(row => row.amountMinor === '10000'), ordinary = rows.find(row => row.amountMinor === '1000')
        assert.equal(ordinary.status, 'excluded'); assert.equal(combo.status, 'needs_action')
        assert.ok(combo.reasonCodes.includes('account_ownership_recheck_required'))
        assert.equal((await c.transactions()).length, 0)
        await assert.rejects(c.imp('financeUpdates.post', await c.postInput()), { publicCode: 'UNRESOLVED_IMPORT' })
        const before = await c.balance()
        await c.edit(combo.eventId, { composition: { kind: 'payment', evidenceNote: '合成详情：本人60，外部40', parts: [
          { accountId: c.wallet, amountMinor: '6000' }, { kind: 'external', accountId: null, amountMinor: '4000', referenceRole: 'payment_component_1' }] } })
        assert.equal((await c.events()).find(row => row.eventId === combo.eventId).status, 'ready')
        const request = await c.postInput(), posted = await c.imp('financeUpdates.post', request)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        assert.deepEqual(await c.transactions(), [{ type: 'expense', source: c.wallet, destination: null, amount: '6000' }])
        assert.equal(BigInt((await c.balance())[c.wallet]) - BigInt(before[c.wallet]), -6000n)
        assert.deepEqual((await lab.owner.execute('SELECT raw_fields_json,normalized_amount_minor FROM catledger_import_rows WHERE uid=? ORDER BY row_id', [c.uid]))[0], raw)
      })

      await t.test('多目标还款600转账+400支出，余额只扣1000且回执重试不重复', async () => {
        const c = await setup([{ amount: '1000.00', method: '零钱' }])
        for (const issue of await c.issues()) await c.map(issue, c.wallet)
        const row = (await c.events())[0], before = await c.balance()
        await c.edit(row.eventId, { fields: { economicNature: 'repayment', ledgerAccountId: c.wallet, counterpartyLedgerAccountId: null },
          composition: { kind: 'repayment', parts: [{ accountId: c.credit, amountMinor: '60000' },
            { kind: 'external', accountId: null, amountMinor: '40000' }] } })
        assert.equal((await c.events())[0].status, 'ready')
        const request = await c.postInput(), posted = await c.imp('financeUpdates.post', request)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        assert.deepEqual(await c.transactions(), [{ type: 'expense', source: c.wallet, destination: null, amount: '40000' },
          { type: 'transfer', source: c.wallet, destination: c.credit, amount: '60000' }])
        const after = await c.balance()
        assert.equal(BigInt(after[c.wallet]) - BigInt(before[c.wallet]), -100000n)
        assert.equal(BigInt(after[c.credit]) - BigInt(before[c.credit]), 60000n)
      })

      await t.test('全部账目写入后完成失败时整批回滚，原请求重试完整入账', async () => {
        const c = await setup([{ amount: '100.00', method: '零钱' }, { amount: '10.00', method: '零钱' }])
        for (const issue of await c.issues()) await c.map(issue, c.wallet)
        const row = (await c.events()).find(item => item.amountMinor === '10000')
        await c.edit(row.eventId, { composition: { kind: 'payment', evidenceNote: '合成共同付款', parts: [
          { accountId: c.wallet, amountMinor: '6000' }, { kind: 'external', accountId: null, amountMinor: '4000' }] } })
        const before = await c.balance(), eventBefore = await c.events(), request = await c.postInput()
        failure = { attempts: 0, inserted: 0 }
        try { await assert.rejects(c.imp('financeUpdates.post', request)); assert.equal(failure.inserted, 2); assert.equal(failure.attempts, 1) }
        finally { failure = null }
        assert.deepEqual(await c.balance(), before); assert.deepEqual(await c.transactions(), [])
        assert.deepEqual((await c.events()).map(row => [row.eventId, row.version, row.status]), eventBefore.map(row => [row.eventId, row.version, row.status]))
        const posted = await c.imp('financeUpdates.post', request)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        assert.equal((await c.transactions()).reduce((sum, row) => sum + BigInt(row.amount), 0n), 7000n)
        assert.equal(BigInt((await c.balance())[c.wallet]) - BigInt(before[c.wallet]), -7000n)
      })

      await t.test('已编辑的组合仍可修订真实外部归属，再重核剩余本人份额', async () => {
        const c = await setup([{ amount: '100.00', method: '零钱' }])
        for (const issue of await c.issues()) await c.map(issue, c.wallet)
        const row = (await c.events())[0]
        await c.edit(row.eventId, { composition: { kind: 'payment', evidenceNote: '合成共同付款', parts: [
          { accountId: c.wallet, amountMinor: '6000' }, { accountId: c.bank, amountMinor: '4000' }] } })
        for (const issue of await c.issues()) await c.map(issue, 'external')
        assert.equal((await c.events())[0].status, 'needs_action')
        await assert.rejects(c.imp('financeUpdates.post', await c.postInput()), { publicCode: 'UNRESOLVED_IMPORT' })
        await c.edit(row.eventId, { composition: { kind: 'payment', evidenceNote: '合成付款归属重核', parts: [
          { kind: 'external', accountId: null, amountMinor: '6000', referenceRole: 'subject' },
          { accountId: c.bank, amountMinor: '4000' }] } })
        assert.equal((await c.events())[0].status, 'ready')
        await c.imp('financeUpdates.post', await c.postInput())
        assert.deepEqual(await c.transactions(), [{ type: 'expense', source: c.bank, destination: null, amount: '4000' }])
      })

      await t.test('已关联退款变更为外部先保留原关系并阻断，显式解除后才确认无账本影响', async () => {
        const c = await setup([{ amount: '100.00', method: '零钱' }, { amount: '30.00', method: '零钱', refund: true }])
        for (const issue of await c.issues()) await c.map(issue, c.wallet)
        const rows = await c.events(), original = rows.find(row => row.economicNature === 'expense'), refund = rows.find(row => row.economicNature === 'refund')
        assert.ok(refund)
        await c.edit(refund.eventId, { decisions: { refund: { mode: 'link', kind: 'event', id: original.eventId, version: original.version } } })
        for (const issue of await c.issues()) await c.map(issue, 'external')
        const pending = (await c.events()).find(row => row.eventId === refund.eventId)
        assert.equal(pending.status, 'needs_action')
        const relation = async () => (await lab.owner.execute("SELECT status FROM catledger_economic_event_relations WHERE uid=? AND source_event_id=? AND relation_type='refund_of'", [c.uid, refund.eventId]))[0]
        assert.ok((await relation()).some(row => row.status === 'confirmed'))
        await assert.rejects(c.imp('financeUpdates.post', await c.postInput()), { publicCode: 'UNRESOLVED_IMPORT' })
        await c.edit(refund.eventId, { decisions: { accountOwnership: { source: { kind: 'external' }, destination: { kind: 'external' }, noLedgerImpact: true },
          refund: { mode: 'unlinked' } }, acknowledgedChanges: ['refund'] })
        assert.equal((await c.events()).find(row => row.eventId === refund.eventId).status, 'excluded')
        assert.ok((await relation()).every(row => row.status === 'rejected'))
        await c.imp('financeUpdates.post', await c.postInput())
        assert.deepEqual(await c.transactions(), [])
      })
    } finally { await lab.close() }
  })
