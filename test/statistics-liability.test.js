const test = require('node:test')
const assert = require('node:assert/strict')
const { liabilitySummary } = require('../cloudfunctions/catledger-api/src/liability-summary')
const { buildLiabilityView } = require('../miniprogram/pages/statistics/model')
const { runtime } = require('./helpers/read-runtime')

const account = (id, debt, interest, extra) => Object.assign({ accountId: id, name: '账户' + id, nature: 'liability', archived: false, debtMinor: debt, installmentTotalInterestMinor: interest }, extra)

test('负债占比按未归档负债账户欠款合计为分母，忽略资产与归档账户', () => {
  const accounts = [
    account('a', '700000', '400000'),
    account('b', '300000', '100000'),
    account('asset', '999', '999', { nature: 'asset' }),
    account('archived', '888888', '888888', { archived: true })
  ]
  const result = liabilitySummary(accounts, new Map())
  const liabilities = result.liabilities
  assert.equal(liabilities.debtTotalMinor, '1000000')
  assert.deepEqual(liabilities.accounts.map(row => row.accountId), ['a', 'b'])
  assert.equal(liabilities.accounts[0].debtShareBasisPoints, 7000)
  assert.equal(liabilities.accounts[1].debtShareBasisPoints, 3000)
  assert.equal(liabilities.interestTotalMinor, '500000')
  assert.equal(liabilities.accounts[0].interestShareBasisPoints, 8000)
  assert.equal(liabilities.accounts[1].interestShareBasisPoints, 2000)
})

test('零负债/零利息不除零；已还利息不超过全期总利息', () => {
  const empty = liabilitySummary([{ accountId: 'x', name: '零', nature: 'liability', debtMinor: '0', installmentTotalInterestMinor: '0' }], new Map())
  assert.equal(empty.liabilities.accounts[0].debtShareBasisPoints, 0)
  assert.equal(empty.liabilities.accounts[0].interestShareBasisPoints, 0)
  const paid = liabilitySummary([account('a', '1000', '900')], new Map([['a', '950']]))
  assert.equal(paid.liabilities.accounts[0].paidInterestMinor, '950')
  assert.equal(paid.liabilities.accounts[0].unpaidInterestMinor, '0', '已还大于全期总利息时待付利息夹到 0，不出现负数')
})

test('前端展示层把占比格式化为「<1%」并组装区块合计与利息行', () => {
  const view = buildLiabilityView({
    debtTotalMinor: '1000000', interestTotalMinor: '500000', paidInterestTotalMinor: '200000',
    accounts: [
      { accountId: 'a', name: '主力卡', debtMinor: '990000', debtShareBasisPoints: 9900, interestMinor: '500000', interestShareBasisPoints: 10000, paidInterestMinor: '200000', unpaidInterestMinor: '300000' },
      { accountId: 'b', name: '零利息卡', debtMinor: '10000', debtShareBasisPoints: 40, interestMinor: '0', interestShareBasisPoints: 0, paidInterestMinor: '0', unpaidInterestMinor: '0' }
    ]
  }, {})
  assert.equal(view.hasLiabilities, true)
  assert.equal(view.debtTotalText, '¥10,000.00')
  assert.equal(view.interestTotalText, '¥5,000.00')
  assert.equal(view.paidInterestTotalText, '¥2,000.00')
  assert.equal(view.unpaidInterestTotalText, '¥3,000.00')
  assert.equal(view.rows[0].debtShareText, '99%')
  assert.equal(view.rows[1].debtShareText, '<1%')
  assert.equal(view.rows[1].debtBarWidth, '1%')
  assert.equal(view.interestRows.length, 1, '零利息账户不进利息行')
  assert.equal(view.hasInterest, true)
})

test('没有负债账户时整块不渲染标志为 false', () => {
  const view = buildLiabilityView(undefined, {})
  assert.equal(view.hasLiabilities, false)
  assert.equal(view.rows.length, 0)
})

test('传入主题 token 时产出两张环图，长尾合并、图例合计约 100%、无 NaN', () => {
  const src = view => decodeURIComponent(view.src.split(',').slice(1).join(','))
  const accounts = Array.from({ length: 7 }, (_, i) => ({
    accountId: 'a' + i, name: '卡' + i, debtMinor: String((7 - i) * 10000), debtShareBasisPoints: 0,
    interestMinor: i < 3 ? String((3 - i) * 5000) : '0', interestShareBasisPoints: 0,
    paidInterestMinor: '0', unpaidInterestMinor: '0'
  }))
  const view = buildLiabilityView({ debtTotalMinor: '280000', interestTotalMinor: '15000', paidInterestTotalMinor: '0', accounts }, { expense: '#b54738', accent: '#d97732', income: '#477153', line: '#ddd6cc' })
  assert.ok(view.debtRing, '有负债环图')
  assert.equal(view.debtRing.legend.length, 6, '前5 + 其他')
  assert.equal(view.debtRing.legend[5].name, '其他账户')
  assert.doesNotMatch(src(view.debtRing), /NaN|Infinity/)
  const shareSum = view.debtRing.legend.reduce((s, r) => s + Number(r.shareText.replace('%', '')), 0)
  assert.ok(Math.abs(shareSum - 100) < 0.5)
  assert.ok(view.interestRing, '有利息环图')
  assert.doesNotMatch(src(view.interestRing), /NaN|Infinity/)
  // 不带 token 时不出图，仅文字
  const noToken = buildLiabilityView({ accounts }, undefined)
  assert.equal(noToken.debtRing, null)
})

test('统计页加载负债与分期区块，并与所选月份无关', async () => {
  const h = runtime()
  const liabilities = {
    debtTotalMinor: '1000000', interestTotalMinor: '500000', paidInterestTotalMinor: '200000',
    accounts: [{ accountId: 'card-a', name: '合成信用卡', debtMinor: '1000000', debtShareBasisPoints: 10000,
      interestMinor: '500000', interestShareBasisPoints: 10000, paidInterestMinor: '200000', unpaidInterestMinor: '300000' }]
  }
  h.respond = (action, data) => action === 'statistics.get'
    ? { ok: true, data: { month: data.month, trendEndMonth: data.trendEndMonth, summary: { incomeMinor: '0', expenseMinor: '0' }, daily: [], cashFlowTrend: [], liabilities } }
    : undefined
  const page = h.page('statistics')
  await page.loadStatistics()
  assert.equal(page.data.liabilityView.hasLiabilities, true)
  assert.equal(page.data.liabilityView.rows[0].debtText, '¥10,000.00')
  assert.equal(page.data.liabilityView.rows[0].debtShareText, '100%')
  await page.chooseMonth({ detail: { value: '2025-01' } })
  assert.equal(page.data.liabilityView.hasLiabilities, true, '切月后负债区块仍在（当前时点，不随月变化）')
})
