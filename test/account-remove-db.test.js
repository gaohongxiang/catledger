const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { chargeLab } = require('./helpers/loan-charges')

const emptyAccount = (api, type = 'bank', name = '合成空账户') => api('accounts.create', {
  requestId: randomUUID(), type, name, openingDisplayBalanceMinor: '0',
  occurredLocalAt: '2026-01-01T00:00:00', timezoneOffsetMinutes: -480
})
const remove = account => ({ requestId: randomUUID(), accountId: account.accountId, version: account.version })
const current = async (api, accountId) => (await api('accounts.list')).accounts.find(a => a.accountId === accountId)

test('账户彻底删除：无流水可删、有流水只允许归档、版本冲突、用户隔离', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const h = await chargeLab()
  const api = h.api

  await t.test('没有任何流水或关联记录的账户可以彻底删除', async () => {
    const account = await emptyAccount(api)
    const result = await api('accounts.remove', remove(account))
    assert.equal(result.accountId, account.accountId)
    assert.equal(await current(api, account.accountId), undefined)
    const [[row]] = await h.owner.execute('SELECT COUNT(*) AS n FROM catledger_accounts WHERE uid=? AND account_id=?', [h.uid, account.accountId])
    assert.equal(Number(row.n), 0)
  })

  await t.test('只有期初余额调整的账户可删：余额调整随账户一并清理', async () => {
    const { accountId } = await api('accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成有余额账户',
      openingDisplayBalanceMinor: '50000', occurredLocalAt: '2026-01-01T00:00:00', timezoneOffsetMinutes: -480 })
    const account = await current(api, accountId)
    const result = await api('accounts.remove', remove(account))
    assert.equal(result.accountId, accountId)
    assert.equal(await current(api, accountId), undefined)
    const [[row]] = await h.owner.execute("SELECT COUNT(*) AS n FROM catledger_transactions WHERE uid=? AND type='balance_adjustment' AND (source_account_id=? OR destination_account_id=?)", [h.uid, accountId, accountId])
    assert.equal(Number(row.n), 0)
  })

  await t.test('有真实收支流水的账户不能删，返回 ACCOUNT_HAS_RECORDS，账户仍在', async () => {
    const { accountId } = await api('accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成有流水账户',
      openingDisplayBalanceMinor: '50000', occurredLocalAt: '2026-01-01T00:00:00', timezoneOffsetMinutes: -480 })
    await api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: accountId, categoryId: h.categoryId,
      amountMinor: '2000', occurredLocalAt: '2026-02-01T12:00:00', timezoneOffsetMinutes: -480 })
    const account = await current(api, accountId)
    await assert.rejects(api('accounts.remove', remove(account)), { publicCode: 'ACCOUNT_HAS_RECORDS' })
    assert.ok(await current(api, accountId))
  })

  await t.test('绑定了贷款/分期的负债账户不能删（外键依赖）', async () => {
    const debit = await emptyAccount(api, 'other_liability', '合成有贷款负债')
    const loan = await api('loans.create', { requestId: randomUUID(), name: '合成分期', kind: 'installment', accountId: debit.accountId,
      principalMinor: '120000', scheduleMethod: 'equal_principal', scheduleTerms: 12, measurementKind: 'interest', quoteType: 'annual',
      ratePpm: '120000', firstPaymentDate: '2026-01-15', installmentSetup: { schema: 1, originalPrincipalMinor: '120000', historicalPaidTerms: 0 } })
    assert.ok(loan.loanId)
    const account = await current(api, debit.accountId)
    await assert.rejects(api('accounts.remove', remove(account)), { publicCode: 'ACCOUNT_HAS_RECORDS' })
    assert.ok(await current(api, debit.accountId))
  })

  await t.test('版本过期的删除请求返回 CONFLICT，不误删新状态', async () => {
    const account = await emptyAccount(api, 'bank', '合成版本账户')
    const stale = { requestId: randomUUID(), accountId: account.accountId, version: account.version - 1 }
    await assert.rejects(api('accounts.remove', stale), { publicCode: 'CONFLICT' })
    assert.ok(await current(api, account.accountId))
  })

  await t.test('删除后无法再读到，且重复删除按幂等回执处理不报内部错误', async () => {
    const account = await emptyAccount(api, 'wallet', '合成重复删除账户')
    const input = remove(account)
    const first = await api('accounts.remove', input)
    const replay = await api('accounts.remove', input)
    assert.deepEqual(replay, first)
    assert.equal(await current(api, account.accountId), undefined)
  })
})
