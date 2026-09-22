const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

test('账户贷款：真实 MySQL 的列表、待办数量、游标和用户隔离一致，查询不改变账务', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-account-loans' })
    const api = (action, data) => call(services.api, action, data)
    const user = await api('bootstrap'), categoryId = user.categories.find(c => c.kind === 'expense').id
    const account = async (type, name) => (await api('accounts.create', { requestId: randomUUID(), type, name, currency: 'CNY', openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const asset = await account('wallet', '合成资金账户'), a = await account('other_liability', '合成负债甲'), b = await account('other_liability', '合成负债乙'), credit = await account('credit', '合成信用卡')
    const balances = async () => (await api('accounts.list')).accounts.map(value => [value.accountId, value.bookBalanceMinor])
    const beforeLoans = await balances()
    for (const [accountId, name] of [[a, '合成甲一'], [a, '合成甲二'], [b, '合成乙一']]) {
      await api('loans.create', { requestId: randomUUID(), accountId, name, kind: 'borrowing', baselinePrincipalMinor: '10000', baselineDate: '2026-08-01' })
    }
    assert.deepEqual(await balances(), beforeLoans, '贷款资料不重复增加负债')
    const payments = []
    for (const liabilityAccountId of [a, a, b]) {
      const input = { requestId: randomUUID(), repayment: { confirmed: true, mode: 'defer', assetAccountId: asset, liabilityAccountId, principalMinor: '80', interestMinor: '20', feeMinor: '0', interestTreatment: 'expense', feeTreatment: 'expense', interestCategoryId: categoryId }, totalMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480 }
      const payment = await api('loans.bookRepayment', input)
      assert.deepEqual(await api('loans.bookRepayment', input), payment)
      payments.push(payment)
    }
    const funds = await balances(), statistics = await api('statistics.get', { month: '2026-09' })
    assert.equal(statistics.summary.expenseMinor, '60', '三次付款的利息各入账一次')
    const first = await api('loans.list', { accountId: a, pageSize: 1 })
    assert.equal(first.items.length, 1); assert.ok(first.nextCursor)
    assert.equal(first.items[0].accountId, a); assert.equal(first.pendingRepaymentCount, 2)
    const second = await api('loans.list', { accountId: a, pageSize: 1, cursor: first.nextCursor })
    assert.equal(second.items[0].accountId, a); assert.equal(second.nextCursor, null)
    assert.equal(second.pendingRepaymentCount, 2); assert.notEqual(first.items[0].loanId, second.items[0].loanId)
    for (const [accountId, expected] of [[a, 2], [b, 1], [credit, 0], [null, 3]]) {
      const list = await api('loans.list', { accountId }), pending = await api('loans.unassigned', { accountId })
      assert.equal(list.pendingRepaymentCount, expected); assert.equal(pending.total, expected)
      if (accountId) assert.ok(list.items.every(item => item.accountId === accountId))
    }
    await assert.rejects(api('loans.list', { accountId: b, pageSize: 1, cursor: first.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
    const stranger = localServices({ apiPool, importPool, subject: 'synthetic-account-loans-stranger' })
    await call(stranger.api, 'bootstrap')
    const foreign = await call(stranger.api, 'loans.list', { accountId: a })
    assert.equal(foreign.items.length, 0); assert.equal(foreign.pendingRepaymentCount, 0)
    await assert.rejects(call(stranger.api, 'loans.list', { accountId: a, cursor: first.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
    assert.deepEqual(await balances(), funds)
    assert.deepEqual((await api('statistics.get', { month: '2026-09' })).summary, statistics.summary)
    const release = { requestId: randomUUID(), paymentId: payments[0].paymentId, version: 1, confirmed: true }
    await api('loans.releaseRepayment', release); await api('loans.releaseRepayment', release)
    assert.equal((await api('loans.list', { accountId: a })).pendingRepaymentCount, 1)
    assert.equal((await api('loans.list', { accountId: b })).pendingRepaymentCount, 1)
    assert.equal((await api('loans.list')).pendingRepaymentCount, 2)
    assert.deepEqual(await balances(), funds, '取消待办只解除确认关系，不改资金流水')
  } finally { await lab.close() }
})
