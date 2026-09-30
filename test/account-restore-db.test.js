const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { chargeLab } = require('./helpers/loan-charges')
const { localServices, call } = require('./helpers/local-services')
const { realPage } = require('./helpers/real-page')

const request = account => ({ requestId: randomUUID(), accountId: account.accountId, version: account.version })
const transfer = (sourceAccountId, destinationAccountId) => ({ requestId: randomUUID(), type: 'transfer', sourceAccountId, destinationAccountId,
  amountMinor: '1000', occurredLocalAt: '2026-04-30T12:00:00', timezoneOffsetMinutes: -480 })

test('账户停用恢复：真实 Page、handler 与隔离 MySQL', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const h = await chargeLab()
  const current = async accountId => (await h.api('accounts.list')).accounts.find(a => a.accountId === accountId)
  const archive = async accountId => h.api('accounts.archive', request(await current(accountId)))
  const snapshot = async () => {
    const rows = {}
    for (const table of ['catledger_transactions', 'catledger_loans', 'catledger_loan_periods', 'catledger_loan_payments',
      'catledger_loan_charge_contracts', 'catledger_loan_charges', 'catledger_loan_charge_allocations', 'catledger_loan_charge_audit']) {
      rows[table] = (await h.owner.execute('SELECT * FROM ' + table + ' WHERE uid=? ORDER BY 1,2', [h.uid]))[0]
    }
    return rows
  }
  try {
    await t.test('有余额银行卡停用后原账户恢复，可以正常转账且恢复本身不写账', async () => {
      const bank = await current(h.assetAccountId)
      const archived = await h.api('accounts.archive', request(bank))
      const tx = transfer(bank.accountId, h.accountId)
      await assert.rejects(h.api('transactions.create', tx), { publicCode: 'ACCOUNT_INACTIVE' })
      const before = (await h.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? ORDER BY transaction_id', [h.uid]))[0]
      const restored = await h.api('accounts.restore', request(archived))
      assert.equal(restored.accountId, bank.accountId)
      assert.equal(restored.archived, false)
      assert.equal(restored.version, archived.version + 1)
      assert.equal(restored.bookBalanceMinor, bank.bookBalanceMinor)
      assert.deepEqual((await h.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? ORDER BY transaction_id', [h.uid]))[0], before)
      await h.api('transactions.create', tx)
      assert.equal((await current(bank.accountId)).bookBalanceMinor, (BigInt(bank.bookBalanceMinor) - 1000n).toString())
    })

    await t.test('未清贷款负债停用恢复不改欠款、本金、费用与授权，恢复后可继续实际还款', async () => {
      const debt = await h.api('accounts.create', { requestId: randomUUID(), type: 'other_liability', name: '合成未清贷款账户',
        openingDisplayBalanceMinor: '600000', occurredLocalAt: '2026-01-01T00:00:00', timezoneOffsetMinutes: -480 })
      let loan = await h.create({ accountId: debt.accountId })
      await h.configure(loan)
      loan = (await h.api('loans.get', { loanId: loan.loanId })).loan
      const repayment = { requestId: randomUUID(), mode: 'new', kind: 'repayment', assetAccountId: h.assetAccountId,
        occurredLocalAt: '2026-04-30T12:00:00', timezoneOffsetMinutes: -480, totalMinor: '1000', confirmed: true,
        allocations: [{ loanId: loan.loanId, version: loan.version, principalMinor: '1000', interestMinor: '0', feeMinor: '0',
          interestTreatment: 'expense', feeTreatment: 'expense' }] }
      const archived = await archive(debt.accountId)
      await assert.rejects(h.api('loans.record', repayment), { publicCode: 'ACCOUNT_INACTIVE' })
      const before = await snapshot()
      const restored = await h.api('accounts.restore', request(archived))
      assert.equal(restored.bookBalanceMinor, '-600000')
      assert.deepEqual(await snapshot(), before)
      assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '600000')
      await h.api('loans.record', repayment)
      assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '599000')
      assert.equal((await current(debt.accountId)).bookBalanceMinor, '-599000')
    })

    await t.test('原请求并发、重复恢复及过期版本；旧恢复回执不能恢复后来再次停用的账户', async () => {
      let bank = await archive(h.assetAccountId)
      const input = request(bank)
      const [first, replay] = await Promise.all([h.api('accounts.restore', input), h.api('accounts.restore', input)])
      assert.deepEqual(first, replay)
      assert.equal(first.version, bank.version + 1)
      assert.deepEqual(await h.api('accounts.restore', request(first)), first)
      await assert.rejects(h.api('accounts.restore', request(bank)), { publicCode: 'CONFLICT' })
      await assert.rejects(h.api('accounts.restore', { ...input, version: first.version }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
      bank = await archive(first.accountId)
      assert.deepEqual(await h.api('accounts.restore', input), first)
      assert.equal((await current(bank.accountId)).archived, true)
      const results = await Promise.allSettled([h.api('accounts.restore', request(bank)), h.api('accounts.restore', request(bank))])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.find(r => r.status === 'rejected').reason.publicCode, 'CONFLICT')
      const receipt = await h.api('transactions.commandResult', { requestId: input.requestId, commandAction: 'accounts.restore' })
      assert.deepEqual(receipt.result, first)
      const other = localServices({ apiPool: h.apiPool, importPool: h.importPool, subject: 'synthetic-account-restore-other' })
      await call(other.api, 'bootstrap')
      await assert.rejects(call(other.api, 'accounts.restore', request(await current(bank.accountId))), { publicCode: 'NOT_FOUND' })
      await assert.rejects(call(other.api, 'transactions.commandResult', { requestId: input.requestId, commandAction: 'accounts.restore' }), { publicCode: 'OPERATION_UNCONFIRMED' })
    })

    await t.test('同名活动账户不能被覆盖，处理冲突后可用原 ID 恢复存量账户', async () => {
      const archived = await archive(h.assetAccountId)
      let replacement = await h.api('accounts.create', { requestId: randomUUID(), type: 'bank', name: archived.name, openingDisplayBalanceMinor: '0' })
      const before = await snapshot()
      const ui = realPage(h), page = ui.page('account-detail')
      page.onLoad({ accountId: archived.accountId }); await page.loadAccount(); await page.restore()
      assert.match(page.data.errorMessage, /同名活动账户/)
      assert.equal(page.data.pendingAccountAction, '')
      assert.equal((await current(archived.accountId)).archived, true)
      assert.deepEqual(await current(replacement.accountId), replacement)
      assert.deepEqual(await snapshot(), before)
      replacement = await h.api('accounts.update', { ...request(replacement), name: '合成同名冲突已处理' })
      await page.restore()
      assert.equal(page.data.account.accountId, archived.accountId)
      assert.equal(page.data.account.archived, false)
      assert.equal((await current(replacement.accountId)).name, '合成同名冲突已处理')
    })

    await t.test('账户状态写入后回执失败整笔回滚，原请求可安全重试', async () => {
      const bank = await archive(h.assetAccountId), input = request(bank)
      const [[identity]] = await h.owner.execute('SELECT provider,subject_hash AS subjectHash FROM catledger_user_identities WHERE uid=?', [h.uid])
      const [[before]] = await h.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [h.uid])
      let updated = false, failed = false
      const pool = new Proxy(h.apiPool, { get(target, key) {
        if (key === 'getConnection') return async () => {
          const connection = await target.getConnection()
          return new Proxy(connection, { get(conn, method) {
            if (method === 'execute') return async (sql, values) => {
              if (/UPDATE catledger_accounts/.test(sql)) updated = true
              if (/UPDATE catledger_mutation_receipts\s+SET result_json/.test(sql) && !failed) { failed = true; throw new Error('合成回执写入失败') }
              return conn.execute(sql, values)
            }
            const value = conn[method]; return typeof value === 'function' ? value.bind(conn) : value
          } })
        }
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value
      } })
      const service = require('../cloudfunctions/catledger-api/src/account-service').createAccountService({ getPool: () => pool })
      await assert.rejects(service.restore({ ...identity, data: input }), /合成回执写入失败/)
      assert.equal(updated && failed, true)
      assert.deepEqual(await current(bank.accountId), bank)
      assert.deepEqual((await h.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [h.uid]))[0][0], before)
      await assert.rejects(h.api('transactions.commandResult', { requestId: input.requestId, commandAction: 'accounts.restore' }), { publicCode: 'OPERATION_UNCONFIRMED' })
      assert.equal((await h.api('accounts.restore', input)).archived, false)
    })

    await t.test('真实停用入口响应丢失后原回执恢复；已恢复但详情读取失败不误报恢复失败', async () => {
      const ui = realPage(h), list = ui.page('accounts'), page = ui.page('account-detail')
      await list.loadAccounts(); list.openAccountDetail({ currentTarget: { dataset: { id: h.assetAccountId } } })
      page.onLoad({ accountId: h.assetAccountId }); await page.loadAccount()
      const stopping = page.archive(); ui.modals[0].success({ confirm: true }); await stopping
      assert.equal(page.data.account.archived, true)
      ui.respond = async (action, data) => {
        const value = await h.services.api({ action, data })
        if (action === 'accounts.restore') throw new Error('合成提交后丢响应')
        return value
      }
      await page.restore()
      assert.equal(page.data.pendingAccountAction, 'accounts.restore')
      const first = ui.calls.find(c => c.action === 'accounts.restore')
      page.onHide(); ui.respond = (action, data) => h.services.api({ action, data }); await page.loadAccount()
      assert.equal(page.data.account.archived, false)
      assert.equal(page.data.pendingAccountAction, '')
      assert.equal(ui.calls.filter(c => c.action === 'accounts.restore').length, 1)
      assert.equal(ui.calls.find(c => c.action === 'transactions.commandResult').data.requestId, first.data.requestId)
      const stoppingAgain = page.archive(); ui.modals[1].success({ confirm: true }); await stoppingAgain
      let restored = false
      ui.respond = async (action, data) => {
        if (action === 'accounts.list' && restored) throw new Error('合成详情读取失败')
        const value = await h.services.api({ action, data })
        if (action === 'accounts.restore') restored = true
        return value
      }
      await page.restore()
      assert.equal(page.data.errorMessage, '')
      assert.equal(page.data.accountStatusMessage, '已恢复，详情待刷新')
      assert.equal(page.data.accountStatusRefresh, true)
      assert.equal(page.data.pendingAccountAction, '')
      assert.equal((await current(h.assetAccountId)).archived, false)
      const restoreCount = ui.calls.filter(c => c.action === 'accounts.restore').length
      await page.restore()
      assert.equal(ui.calls.filter(c => c.action === 'accounts.restore').length, restoreCount)
      ui.respond = (action, data) => h.services.api({ action, data }); await page.loadAccount()
      assert.equal(page.data.accountStatusRefresh, false)
      assert.equal(page.data.account.archived, false)
    })
  } finally { await h.close() }
})
