const test = require('node:test')
const assert = require('node:assert/strict')
const { accountTotals } = require('../cloudfunctions/catledger-api/src/net-worth')
const { buildLiabilityView } = require('../miniprogram/pages/statistics/model')

test('负债率由 accountTotals 派生：负债÷资产（basis points），资产为0返回 null', () => {
  const accounts = [
    { accountId: 'a', nature: 'asset', archived: false, bookBalanceMinor: '1000000' },
    { accountId: 'b', nature: 'liability', archived: false, debtMinor: '250000', installmentTotalInterestMinor: '50000' },
    { accountId: 'arch', nature: 'liability', archived: true, debtMinor: '999999' }
  ]
  const t = accountTotals(accounts)
  assert.equal(t.assetsMinor, '1000000')
  assert.equal(t.liabilitiesMinor, '250000', '归档负债不计入')
  assert.equal(t.liabilitiesRatioBasisPoints, 2500, '250000/1000000 = 25%')
  // 无资产 -> null
  const noAsset = accountTotals([{ accountId: 'c', nature: 'liability', archived: false, debtMinor: '1000' }])
  assert.equal(noAsset.liabilitiesRatioBasisPoints, null)
})

test('前端负债视图：负债率文本、还款压力金额/期数，空值显示「—」', () => {
  const v = buildLiabilityView({
    debtTotalMinor: '25953331', interestTotalMinor: '14953264', paidInterestTotalMinor: '13854109',
    liabilitiesRatioBasisPoints: 4350,
    repaymentPressure: { monthDueMinor: '1705359', monthPeriodCount: 7, upcomingMinor: '8500000', upcomingPeriodCount: 42 },
    accounts: []
  }, null)
  assert.equal(v.ratioText, '43.5%')
  assert.equal(v.ratioEmpty, false)
  assert.equal(v.monthDueText, '¥17,053.59')
  assert.equal(v.monthDueCount, 7)
  assert.equal(v.upcomingText, '¥85,000.00')
  assert.equal(v.upcomingCount, 42)
  const empty = buildLiabilityView({ debtTotalMinor: '0', accounts: [], liabilitiesRatioBasisPoints: null, repaymentPressure: {} }, null)
  assert.equal(empty.ratioText, '—')
  assert.equal(empty.ratioEmpty, true)
  assert.equal(empty.monthDueText, '¥0.00')
})

