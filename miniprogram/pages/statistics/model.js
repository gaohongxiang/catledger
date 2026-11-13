const money = require('../../utils/money')
const time = require('../../utils/time')
const { bandColorFor } = require('../../utils/category-palette')
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
  const groups = positive.slice(0, 5).map(row => ({ name: row.name, amountMinor: row.amountMinor, categoryId: row.categoryId == null ? null : row.categoryId }))
  if (positive.length > 5) groups.push({ name: '其他分类', amountMinor: positive.slice(5).reduce((sum, row) => addMinor(sum, row.amountMinor), '0'), categoryId: '' })
  const total = groups.reduce((sum, row) => addMinor(sum, row.amountMinor), '0')
  let offset = 0
  let body = '<circle cx="100" cy="100" r="72" fill="none" stroke="' + colors.line + '" stroke-width="24"/>'
  const legend = groups.map((row, index) => {
    const share = amount(row.amountMinor) / amount(total)
    const length = share * Math.PI * 144
    body += '<circle cx="100" cy="100" r="72" fill="none" stroke="' + palette[index] + '" stroke-width="24" stroke-dasharray="' + length + ' ' + Math.PI * 144 + '" stroke-dashoffset="' + -offset + '" transform="rotate(-90 100 100)"/>'
    offset += length
    return { name: row.name, categoryId: row.categoryId == null ? null : row.categoryId, amountText: money.formatMinor(row.amountMinor), shareText: (share * 100).toFixed(1) + '%', color: palette[index] }
  })
  return { src: svg(body, 200, 200), legend, totalMinor: total, totalText: money.formatMinor(total), hasNegative: (rows || []).some(row => amount(row.amountMinor) < 0) }
}
function buildStatisticsView(result, tokens) {
  const colors = { income: tokens.income || '#477153', expense: tokens.expense || '#b54738', accent: tokens.accent || '#d97732', line: tokens.line || '#ddd6cc', muted: tokens.textMuted || '#958b82' }
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
  // 日历同时表达收支：按「净额」判别方向（净赚 income / 净花 expense / 无收支 none），
  // 支出按相对最大单日支出的比例分档上色；当天收入/支出/净额都进格子和点开的详情，一份日历看全。
  daily.forEach((row, index) => {
    const inc = amount(row.incomeMinor), exp = amount(row.expenseMinor)
    const net = inc - exp
    const tone = (inc === 0 && exp === 0) ? 'none' : (net > 0 ? 'net-income' : (net < 0 ? 'net-expense' : 'net-even'))
    const hasRefund = exp < 0
    cells.push({ key: row.date, index, date: row.date, dayText: row.dayText, today: row.date === time.today(),
      tone: hasRefund ? 'refund' : tone,
      level: (exp <= 0 || !maxExpense) ? '0' : String(Math.max(1, Math.ceil(exp / maxExpense * 4))),
      incomeText: money.formatMinor(row.incomeMinor || '0'),
      expenseText: money.formatMinor(row.expenseMinor),
      netText: money.formatMinor(String(net)),
      hasIncome: inc !== 0, hasExpense: exp !== 0,
      ariaText: row.date + (inc ? ' 收入' + money.formatMinor(row.incomeMinor) : '') + (exp ? ' 支出' + money.formatMinor(row.expenseMinor) : '') + ' 净' + money.formatMinor(String(net)) })
  })
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
function shareText(bp) {
  const value = Number(bp || 0) / 100
  if (!value) return '0%'
  if (value < 0.5) return '<1%'
  return (value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)) + '%'
}

// 负债/利息共用一套环形图：正数金额按分累加，长尾（前5名 + 其他）合并，
// 与「收支构成」的 distribution 同一视觉语言——不引入新的绘图库。
function liabilityRing(entries, colors) {
  const positive = (entries || []).filter(row => amount(row.amountMinor) > 0).sort((a, b) => amount(b.amountMinor) - amount(a.amountMinor))
  const palette = [colors.expense, colors.accent, colors.income, '#c9a563', '#779da3', '#a68b77']
  const groups = positive.slice(0, 5).map(row => ({ name: row.name, amountMinor: row.amountMinor }))
  if (positive.length > 5) groups.push({ name: '其他账户', amountMinor: positive.slice(5).reduce((sum, row) => addMinor(sum, row.amountMinor), '0') })
  const total = groups.reduce((sum, row) => addMinor(sum, row.amountMinor), '0')
  const circumference = Math.PI * 144
  let offset = 0
  let body = '<circle cx="100" cy="100" r="72" fill="none" stroke="' + colors.line + '" stroke-width="24"/>'
  const legend = groups.map((row, index) => {
    const share = amount(row.amountMinor) / amount(total)
    const length = share * circumference
    // 段之间留 1.5 单位缺口，避免相邻同色相混；短于缺口的极小段至少画 1 单位。
    const dash = Math.max(1, length - 1.5)
    body += '<circle cx="100" cy="100" r="72" fill="none" stroke="' + palette[index] + '" stroke-width="24" stroke-dasharray="' + dash.toFixed(2) + ' ' + circumference.toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 100 100)"/>'
    offset += length
    return { name: row.name, categoryId: row.categoryId == null ? null : row.categoryId, amountText: money.formatMinor(row.amountMinor), shareText: (share * 100).toFixed(1) + '%', color: palette[index] }
  })
  return { src: svg(body, 200, 200), legend, totalText: money.formatMinor(total), empty: !groups.length }
}

// 负债占比与分期利息：只做展示格式化，占比由服务端按 basis points 给出（唯一真源见 liability-summary.js）。
// 没有任何未归档负债账户时 hasLiabilities=false，页面整块不渲染，不留空位。
// tokens 传入时额外产出两张环图（负债占比 / 利息占比）；缺 token 只出文字列表，图表为 null。
function buildLiabilityView(liabilities, tokens) {
  const source = liabilities || {}
  const colors = { income: (tokens && tokens.income) || '#477153', expense: (tokens && tokens.expense) || '#b54738',
    accent: (tokens && tokens.accent) || '#d97732', line: (tokens && tokens.line) || '#ddd6cc', muted: (tokens && tokens.textMuted) || '#958b82' }
  // 占比条宽：按 basis points 换算为百分比，极小占比保留最小 1% 以可见，不出现空条。
  const barWidth = bp => {
    const percent = Number(bp || 0) / 100
    return (percent > 0 && percent < 1 ? 1 : Math.max(0, Math.min(100, percent))) + '%'
  }
  const rows = (source.accounts || []).map(row => {
    return Object.assign({}, row, {
      nameText: row.name || '未命名账户',
      debtText: money.formatMinor(row.debtMinor),
      debtShareText: shareText(row.debtShareBasisPoints),
      debtBarWidth: barWidth(row.debtShareBasisPoints),
      interestText: money.formatMinor(row.interestMinor),
      interestShareText: shareText(row.interestShareBasisPoints),
      interestBarWidth: barWidth(row.interestShareBasisPoints),
      paidInterestText: money.formatMinor(row.paidInterestMinor),
      unpaidInterestText: money.formatMinor(row.unpaidInterestMinor),
      hasInterest: amount(row.interestMinor) > 0
    })
  })
  // 利息行只列真正含分期的账户，避免一排 ¥0.00 噪音；合计与已还/待付仍用服务端全量。
  const interestRows = rows.filter(row => row.hasInterest)
  const interestTotal = BigInt(source.interestTotalMinor || '0')
  const paidInterestTotal = BigInt(source.paidInterestTotalMinor || '0')
  const unpaidInterest = interestTotal > paidInterestTotal ? interestTotal - paidInterestTotal : 0n
  // 两张环图：负债占比按各卡欠款；利息占比按各卡全期利息。缺 token 时留 null，模板按空处理。
  const debtRing = tokens ? liabilityRing(rows.map(row => ({ name: row.nameText, amountMinor: row.debtMinor })), colors) : null
  const interestRing = tokens ? liabilityRing(rows.filter(row => row.hasInterest).map(row => ({ name: row.nameText, amountMinor: row.interestMinor })), colors) : null
  // 负债率：basis points → 百分比文本；资产为 0（null）显示「—」。
  const ratioBp = source.liabilitiesRatioBasisPoints
  const ratioText = ratioBp == null ? '—' : (Number(ratioBp) / 100).toFixed(1) + '%'
  // 还款压力：本月待还 + 未来 12 个月合计。
  const pressure = source.repaymentPressure || {}
  return {
    hasLiabilities: rows.length > 0,
    debtTotalText: money.formatMinor(source.debtTotalMinor || '0'),
    interestTotalText: money.formatMinor(source.interestTotalMinor || '0'),
    paidInterestTotalText: money.formatMinor(source.paidInterestTotalMinor || '0'),
    unpaidInterestTotalText: money.formatMinor(unpaidInterest),
    ratioText: ratioText,
    ratioEmpty: ratioBp == null,
    monthDueText: money.formatMinor(pressure.monthDueMinor || '0'),
    monthDueCount: Number(pressure.monthPeriodCount || 0),
    upcomingText: money.formatMinor(pressure.upcomingMinor || '0'),
    upcomingCount: Number(pressure.upcomingPeriodCount || 0),
    debtRing: debtRing,
    interestRing: interestRing,
    rows: rows,
    interestRows: interestRows,
    hasInterest: interestRows.length > 0,
    // 用于小标题上的「N 个负债账户」
    accountCount: rows.length
  }
}

// 环比/同比：把服务端 deltaMinor/ratePpm 转成「↑12.3%」这类可渲染片段。
// 基期无数据（comparison 为 null 或 ratePpm 为 null 且 delta 为 0）时不显示，避免假 0%。
function formatDelta(delta) {
  if (!delta) return null
  const minor = String(delta.deltaMinor || '0')
  const negative = minor.charAt(0) === '-'
  const absolute = negative ? minor.slice(1) : minor
  const pct = delta.ratePpm == null ? null : Number(delta.ratePpm) / 10000
  const zero = BigInt(absolute) === 0n
  return {
    // 正 = 增加，负 = 减少，0 = 持平；用于着色与箭头
    tone: zero ? 'flat' : (negative ? 'down' : 'up'),
    arrow: zero ? '' : (negative ? '↓' : '↑'),
    text: zero ? '持平' : (pct == null ? money.formatMinor(absolute) : Math.abs(pct).toFixed(1) + '%')
  }
}

// 本月指标卡：服务端已算好的笔数/活跃天/日均/单笔最大，加上环比同比，组装成一行直读的小卡。
// 任何一项缺省按 0/空处理，不显示 undefined。
function buildMetricsView(metrics, comparisons, month) {
  const m = metrics || {}
  const cmp = comparisons || {}
  return {
    transactionCount: m.transactionCount || 0,
    activeDayCount: m.activeDayCount || 0,
    averageDailyExpenseText: money.formatMinor(m.averageDailyExpenseMinor || '0'),
    largestExpenseText: money.formatMinor(m.largestExpenseMinor || '0'),
    expenseVsPrevious: formatDelta(cmp.previousMonth && cmp.previousMonth.expense),
    expenseVsLastYear: formatDelta(cmp.lastYearMonth && cmp.lastYearMonth.expense),
    incomeVsPrevious: formatDelta(cmp.previousMonth && cmp.previousMonth.income),
    incomeVsLastYear: formatDelta(cmp.lastYearMonth && cmp.lastYearMonth.income),
    previousMonthLabel: cmp.previousMonth ? monthLabelOf(cmp.previousMonth.month) : '',
    lastYearMonthLabel: cmp.lastYearMonth ? monthLabelOf(cmp.lastYearMonth.month) : ''
  }
}

function monthLabelOf(month) {
  if (!month) return ''
  return Number(month.slice(0, 4)) + '年' + Number(month.slice(5)) + '月'
}

// 分类环比展示：把服务端 deltaMinor/ratePpm 转成「↑12%」「新增」这类片段。
// 上月无此分类（ratePpm=null 且 previousMinor=0）时显示「新增」；持平不显示。退款抵减分类不做环比。
function categoryDeltaText(comparison) {
  if (!comparison) return null
  const previousMinor = String(comparison.previousMinor || '0')
  const minor = String(comparison.deltaMinor || '0')
  const negative = minor.charAt(0) === '-'
  const absolute = negative ? minor.slice(1) : minor
  if (BigInt(absolute) === 0n) return null
  if (comparison.ratePpm == null) {
    // 上月为 0：本期新增支出，只标方向，不编百分比。
    return negative ? null : { tone: 'up', text: '新增' }
  }
  const pct = Math.abs(Number(comparison.ratePpm) / 10000)
  return { tone: negative ? 'down' : 'up', text: (negative ? '↓' : '↑') + pct.toFixed(0) + '%' }
}

module.exports = { buildStatisticsView, buildLiabilityView, buildMetricsView, formatDelta, categoryDeltaText }
