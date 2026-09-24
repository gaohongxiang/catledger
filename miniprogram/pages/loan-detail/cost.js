// 沿用 loan-cost-calculator/domain/cashflow 的按月 IRR 口径。
// 金额合计仍使用整数分字符串；浮点数仅用于无量纲的展示利率。
const money = require('../../utils/money')
const { addMinor } = require('../../utils/minor-arithmetic')
const amount = value => value == null ? '—' : money.formatMinor(value).replace('¥', '')
const total = row => ['principalMinor', 'interestMinor', 'feeMinor'].reduce((sum, key) => addMinor(sum, row[key]), '0')
const percent = value => Number.isFinite(value) ? value.toFixed(2) + '%' : '—'

function rates(loan, periods) {
  const principal = loan.installmentSetup ? loan.installmentSetup.originalPrincipalMinor : loan.baselinePrincipalMinor
  const receipt = Number(addMinor(principal, '-' + (loan.feeUpfrontMinor || '0')))
  if (!Number.isSafeInteger(receipt) || receipt <= 0 || !loan.scheduleTerms) return null
  const flows = new Array(loan.scheduleTerms + 1).fill(0)
  flows[0] = 1
  for (const row of periods) {
    const payment = Number(total(row))
    if (!Number.isSafeInteger(payment) || row.periodNumber < 1 || row.periodNumber > loan.scheduleTerms) return null
    // 不压缩免息/全额优惠的零付款月份，保留真实的月度间隔。
    flows[row.periodNumber] = -payment / receipt
  }
  const npv = rate => flows.reduce((sum, cash, index) => sum + cash / Math.pow(1 + rate, index), 0)
  if (Math.abs(npv(0)) < 1e-12) return { simple: 0, effective: 0 }
  if (npv(0) > 0) return null
  let low = 0, high = 1
  while (npv(high) < 0 && high < 1024) high *= 2
  if (npv(high) < 0) return null
  for (let iteration = 0; iteration < 120; iteration++) {
    const middle = (low + high) / 2
    if (npv(middle) > 0) high = middle
    else low = middle
  }
  const monthly = (low + high) / 2
  return { simple: monthly * 1200, effective: (Math.pow(1 + monthly, 12) - 1) * 100 }
}

function build(loan, preview) {
  if (!preview) return null
  const periods = preview.periods
  const upfront = loan.feeUpfrontMinor || '0'
  const cost = periods.reduce((sum, row) => addMinor(sum, addMinor(row.interestMinor, row.feeMinor)), upfront)
  const payment = periods.reduce((sum, row) => addMinor(sum, total(row)), upfront)
  const principal = loan.installmentSetup ? loan.installmentSetup.originalPrincipalMinor : loan.baselinePrincipalMinor
  const annual = rates(loan, periods)
  const level = !annual ? null : annual.effective <= 8 ? ['较低', 'low'] : annual.effective <= 15 ? ['适中', 'medium'] : annual.effective <= 24 ? ['偏高', 'high'] : ['很高', 'very-high']
  return {
    cost: amount(cost), total: amount(payment), ratio: Number(principal) > 0 ? percent(Number(cost) / Number(principal) * 100) : '—',
    apr: percent(annual && annual.effective), simpleApr: percent(annual && annual.simple),
    aprLevel: level ? level[0] : '', aprTone: level ? level[1] : '',
    note: upfront !== '0' ? '含一次性费用 ' + amount(upfront) + ' 元' : '按原分期方案测算',
    discount: loan.installmentSetup && loan.installmentSetup.discountKind ? '已计入约定优惠' : ''
  }
}

module.exports = { amount, total, rates, build }
