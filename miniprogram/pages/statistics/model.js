const money = require('../../utils/money')
const { addMinor } = require('../../utils/minor-arithmetic')
const negate = value => String(value || '0').charAt(0) === '-' ? String(value).slice(1) : '-' + String(value || '0')
const amount = value => Number(value || 0) // 只用于绘图坐标；金额累加与展示使用十进制字符串。
const svg = (body, width, height) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + body + '</svg>')
const point = (x, y) => x.toFixed(2) + ',' + y.toFixed(2)
function chart(rows, colors, line) {
  const width = 600, height = 200, top = 12, bottom = 178
  const rawValues = line ? rows.map(row => row.cumulativeMinor) : rows.reduce((all, row) => all.concat([row.incomeMinor || '0', row.expenseMinor || '0']), [])
  const values = rawValues.map(amount)
  const maximum = Math.max(0, ...values), minimum = Math.min(0, ...values)
  const range = maximum - minimum || 1
  const y = value => top + (maximum - value) / range * (bottom - top)
  const zero = y(0), step = 576 / Math.max(rows.length, 1)
  let body = [top, (top + bottom) / 2, bottom].map(value => '<path d="M12 ' + value + 'H588" stroke="' + colors.line + '" stroke-dasharray="3 5"/>').join('')
  body += '<path d="M12 ' + zero + 'H588" stroke="' + colors.muted + '" opacity=".5"/>'
  if (line && rows.length) {
    const points = rows.map((row, index) => point(12 + step * (index + .5), y(amount(row.cumulativeMinor))))
    body += '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + colors.accent + '" stroke-width="3" stroke-linejoin="round"/>'
    rows.forEach((row, index) => { body += '<circle cx="' + (12 + step * (index + .5)) + '" cy="' + y(amount(row.cumulativeMinor)) + '" r="2.5" fill="' + colors.accent + '"/>' })
  } else {
    rows.forEach((row, index) => {
      const barWidth = Math.min(16, step * .28)
      ;['income', 'expense'].forEach((kind, offset) => {
        const value = amount(row[kind + 'Minor'])
        if (!value) return
        const x = 12 + step * (index + .5) + (offset ? 2 : -barWidth - 2)
        body += '<rect x="' + x + '" y="' + Math.min(zero, y(value)) + '" width="' + barWidth + '" height="' + Math.max(1, Math.abs(y(value) - zero)) + '" rx="2" fill="' + colors[kind] + '"/>'
      })
    })
  }
  return { src: svg(body, width, height), maxText: money.formatMinor(rawValues.reduce((a, b) => amount(b) > amount(a) ? b : a, '0')), minText: money.formatMinor(rawValues.reduce((a, b) => amount(b) < amount(a) ? b : a, '0')) }
}
function distribution(rows, colors) {
  const positive = (rows || []).filter(row => amount(row.amountMinor) > 0)
  const palette = [colors.expense, colors.accent, colors.income, '#c9a563', '#779da3', '#a68b77']
  const groups = positive.slice(0, 5).map(row => ({ name: row.name, amountMinor: row.amountMinor }))
  if (positive.length > 5) groups.push({ name: '其他分类', amountMinor: positive.slice(5).reduce((sum, row) => addMinor(sum, row.amountMinor), '0') })
  const total = groups.reduce((sum, row) => addMinor(sum, row.amountMinor), '0')
  let offset = 0
  let body = '<circle cx="100" cy="100" r="72" fill="none" stroke="' + colors.line + '" stroke-width="24"/>'
  const legend = groups.map((row, index) => {
    const share = amount(row.amountMinor) / amount(total)
    const length = share * Math.PI * 144
    body += '<circle cx="100" cy="100" r="72" fill="none" stroke="' + palette[index] + '" stroke-width="24" stroke-dasharray="' + length + ' ' + Math.PI * 144 + '" stroke-dashoffset="' + -offset + '" transform="rotate(-90 100 100)"/>'
    offset += length
    return { name: row.name, amountText: money.formatMinor(row.amountMinor), shareText: (share * 100).toFixed(1) + '%', color: palette[index] }
  })
  return { src: svg(body, 200, 200), legend, totalMinor: total, totalText: money.formatMinor(total), hasNegative: (rows || []).some(row => amount(row.amountMinor) < 0) }
}
function buildStatisticsView(result, tokens) {
  const colors = { income: tokens.income || '#477153', expense: tokens.expense || '#b54738', accent: tokens.accent || '#d97732', line: '#ddd6cc', muted: '#958b82' }
  let cumulative = '0'
  const daily = (result.daily || []).map(row => {
    cumulative = addMinor(cumulative, addMinor(row.incomeMinor || '0', negate(row.expenseMinor)))
    return Object.assign({}, row, { cumulativeMinor: cumulative, cumulativeText: money.formatMinor(cumulative), dayText: String(Number(row.date.slice(8))) })
  })
  const maxExpense = Math.max(0, ...daily.map(row => amount(row.expenseMinor)))
  const cells = []
  if (daily.length) {
    const weekday = new Date(daily[0].date + 'T00:00:00Z').getUTCDay()
    for (let index = 0; index < (weekday + 6) % 7; index++) cells.push({ key: 'blank-' + index, blank: true })
  }
  daily.forEach((row, index) => cells.push({ key: row.date, index, date: row.date, dayText: row.dayText,
    level: amount(row.expenseMinor) < 0 ? 'refund' : (!amount(row.expenseMinor) ? '0' : String(Math.max(1, Math.ceil(amount(row.expenseMinor) / maxExpense * 4)))),
    expenseText: money.formatMinor(row.expenseMinor), cumulativeText: row.cumulativeText }))
  const trend = result.cashFlowTrend || []
  const recent = trend.slice().reverse().find(row => amount(row.incomeMinor) !== 0 || amount(row.expenseMinor) !== 0)
  return {
    monthlyChart: chart(trend, colors, false), cumulativeChart: chart(daily, colors, true),
    expenseRing: distribution(result.expenseCategories, colors), incomeRing: distribution(result.incomeCategories, Object.assign({}, colors, { expense: colors.income })),
    calendar: cells, cumulativeDays: daily, cumulativeEndText: money.formatMinor(cumulative),
    emptyCashflow: !daily.some(row => amount(row.incomeMinor) !== 0 || amount(row.expenseMinor) !== 0),
    recentMonth: recent && recent.month !== result.month ? recent.month : '',
    recentMonthLabel: recent ? recent.month.slice(0, 4) + '年' + Number(recent.month.slice(5)) + '月' : ''
  }
}
module.exports = { buildStatisticsView }
