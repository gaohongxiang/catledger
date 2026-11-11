// 账户合计的展示层：dashboard.get 与 accounts.list 共用同一份口径与格式，避免两页各写一套。
// 后端 accountTotals 已给出唯一真源（assetsMinor/liabilitiesMinor/netWorthMinor/liabilitiesInterestMinor）；
// 这里只负责把它格式化成页面直接可渲染的文本，不再做任何加减。
const money = require('./money')

function isNegative(value) {
  return String(value == null ? '0' : value).charAt(0) === '-'
}

// totals 可能是：后端对象（accounts.list 的 result.totals）、dashboard 的 totals 对象，
// 或旧响应的平铺字段。统一取值，缺项按 0；金额一律按分（minor-unit 字符串）格式化。
function presentTotals(totals) {
  const sum = totals || {}
  const assetsMinor = sum.assetsMinor == null ? '0' : String(sum.assetsMinor)
  const liabilitiesMinor = sum.liabilitiesMinor == null ? '0' : String(sum.liabilitiesMinor)
  const netWorthMinor = sum.netWorthMinor == null ? '0' : String(sum.netWorthMinor)
  const interestMinor = sum.liabilitiesInterestMinor == null ? '0' : String(sum.liabilitiesInterestMinor)
  return {
    // 原始分单位，供需要再计算的地方（如判负）使用
    assetsMinor: assetsMinor,
    liabilitiesMinor: liabilitiesMinor,
    netWorthMinor: netWorthMinor,
    liabilitiesInterestMinor: interestMinor,
    // 渲染文本
    assetsText: money.formatMinor(assetsMinor),
    liabilitiesText: money.formatMinor(liabilitiesMinor),
    netWorthText: money.formatMinor(netWorthMinor),
    netWorthTone: isNegative(netWorthMinor) ? 'amount-liability' : '',
    // 总利息（所有负债账户分期全期总利息）：独立一格时始终显示金额（0 也给 ¥0.00）。
    totalInterestText: money.formatMinor(interestMinor),
    // 兼容「其中利息」这种 0 时省略的次要展示：为 0 时返回空串。
    liabilitiesInterestText: interestMinor === '0' ? '' : money.formatMinor(interestMinor)
  }
}

module.exports = { presentTotals }
