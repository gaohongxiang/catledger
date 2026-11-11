const test = require('node:test')
const assert = require('node:assert/strict')

const { netWorthTotals } = require('../cloudfunctions/catledger-api/src/net-worth')

test('净资产只算未归档账户：资产含负余额照减，负债取 debtMinor', function () {
  const totals = netWorthTotals([
    { nature: 'asset', bookBalanceMinor: '100000', archived: false },
    { nature: 'asset', bookBalanceMinor: '-15834', archived: false }, // 透支/待校正，照实相减
    { nature: 'liability', bookBalanceMinor: '-50000', debtMinor: '60000', archived: false },
    { nature: 'asset', bookBalanceMinor: '999999', archived: true },  // 归档不计
    { nature: 'liability', bookBalanceMinor: '-1', debtMinor: '88888', archived: true } // 归档不计
  ])
  assert.equal(totals.assetsMinor, '84166')       // 100000 - 15834
  assert.equal(totals.liabilitiesMinor, '60000')
  assert.equal(totals.netWorthMinor, '24166')     // 84166 - 60000
})

test('全部归档或空账本时各项为 0', function () {
  assert.deepEqual(netWorthTotals([]), { assetsMinor: '0', liabilitiesMinor: '0', netWorthMinor: '0' })
  assert.deepEqual(
    netWorthTotals([{ nature: 'asset', bookBalanceMinor: '5000', archived: true }]),
    { assetsMinor: '0', liabilitiesMinor: '0', netWorthMinor: '0' }
  )
})

test('负债缺失 debtMinor 视为 0', function () {
  const totals = netWorthTotals([
    { nature: 'asset', bookBalanceMinor: '300', archived: false },
    { nature: 'liability', bookBalanceMinor: '-0', debtMinor: null, archived: false }
  ])
  assert.equal(totals.liabilitiesMinor, '0')
  assert.equal(totals.netWorthMinor, '300')
})

const { accountTotals } = require('../cloudfunctions/catledger-api/src/net-worth')

test('accountTotals 汇总负债全期总利息（含已还），缺失按 0，且不影响净资产', function () {
  const totals = accountTotals([
    { nature: 'asset', bookBalanceMinor: '100000', archived: false },
    { nature: 'liability', debtMinor: '60000', installmentTotalInterestMinor: '66917', archived: false },
    { nature: 'liability', debtMinor: '0', installmentTotalInterestMinor: null, archived: false },
    { nature: 'liability', debtMinor: '88888', installmentTotalInterestMinor: '100000', archived: true } // 归档不计
  ])
  assert.equal(totals.liabilitiesMinor, '60000')
  assert.equal(totals.liabilitiesInterestMinor, '66917')
  assert.equal(totals.netWorthMinor, '40000') // 利息不进净资产
})

test('netWorthTotals 与 accountTotals 的三项口径完全一致（单一真源）', function () {
  const accounts = [
    { nature: 'asset', bookBalanceMinor: '12345', archived: false },
    { nature: 'liability', debtMinor: '7000', installmentTotalInterestMinor: '500', archived: false }
  ]
  const a = netWorthTotals(accounts), b = accountTotals(accounts)
  assert.equal(a.assetsMinor, b.assetsMinor)
  assert.equal(a.liabilitiesMinor, b.liabilitiesMinor)
  assert.equal(a.netWorthMinor, b.netWorthMinor)
})
