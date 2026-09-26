const cost = require('./cost')
const { addMinor } = require('../../utils/minor-arithmetic')
const { METHOD_LABELS } = require('./schedule-form')

function today() {
  const date = new Date(), pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}
function previewInput(loan) {
  const principal = loan.installmentSetup ? loan.installmentSetup.originalPrincipalMinor : loan.baselinePrincipalMinor
  if (!loan.scheduleMethod || !loan.scheduleTerms || !principal || principal === '0' || !loan.firstPaymentDate) return null
  const fields = ['scheduleMethod', 'scheduleTerms', 'measurementKind', 'quoteType', 'ratePpm', 'repaymentMinor', 'feePerTermMinor', 'feeUpfrontMinor', 'firstPaymentDate']
  const input = { principalMinor: principal }
  fields.forEach(key => { if (loan[key] != null) input[key] = loan[key] })
  // 仅恢复原方案的历史展示行；不生成期次、不修改已还记录。
  if (loan.installmentSetup) input.installmentSetup = Object.assign({}, loan.installmentSetup, { historicalPaidTerms: 0 })
  return input
}
function historicalRows(loan, preview) {
  const count = loan.installmentSetup ? loan.installmentSetup.historicalPaidTerms : 0
  return preview ? preview.periods.filter(row => row.periodNumber <= count).map(row => Object.assign({}, row, { status: 'historical' })) : []
}
function rowView(row, date) {
  const paid = row.status === 'paid' || row.status === 'historical'
  const manualConfirmed = paid && !row.paymentConfirmed && (Boolean(row.completedByProgress) || row.status === 'historical')
  const overdue = row.stateText ? row.stateText === '已逾期' : !paid && !row.cancelled && row.dueDate <= date
  return {
    key: row.periodId || 'history-' + row.periodNumber, term: row.periodNumber, date: String(row.dueDate || '').replace(/-/g, '.'),
    payment: cost.amount(cost.total(row)), principal: cost.amount(row.principalMinor), interestFee: cost.amount(addMinor(row.interestMinor, row.feeMinor)),
    paid, manualConfirmed, overdue, current: Boolean(row.current), cancelled: Boolean(row.cancelled), historical: row.status === 'historical',
    difference: Boolean(row.differences && row.differences.length),
    state: row.cancelled ? '已取消' : manualConfirmed ? '已还' : row.paymentConfirmed ? '已还' : row.stateText || (row.status === 'partial' ? '部分已还' : paid ? '已还' : overdue ? '待确认' : '')
  }
}
function build(loan, view, preview, date) {
  date = date || today()
  const summary = view && view.summary
  const history = loan.installmentSetup ? loan.installmentSetup.historicalPaidTerms : 0
  const paid = (view && view.tracking ? 0 : history) + (summary ? Number(summary.paidPeriods || 0) : 0)
  const terms = loan.scheduleTerms || 0
  const remaining = summary ? ['unpaidPrincipalMinor', 'unpaidInterestMinor', 'unpaidFeeMinor'].reduce((sum, key) => addMinor(sum, summary[key]), '0') : null
  const complete = !!summary && (view.tracking || loan.remainingPrincipalMinor === '0') && remaining === '0'
  const next = summary && summary.nextDueDate
  const dueRow = next && view.items.find(row => !row.cancelled && row.status !== 'paid' && row.dueDate === next)
  const noPlan = !!summary && !next && !complete
  const pending = !summary
  const amountOf = key => dueRow ? cost.amount(dueRow[key]) : '—'
  const original = loan.installmentSetup ? loan.installmentSetup.originalPrincipalMinor : loan.baselinePrincipalMinor
  const first = loan.firstPaymentDate || loan.startDate
  const last = preview && preview.periods.length ? preview.periods[preview.periods.length - 1].dueDate : loan.endDate
  return {
    status: loan.archived ? '已删除' : complete ? '已完成' : view && view.tracking ? '还款中' : loan.status === 'settled' ? '本金已结清' : loan.statusText || '还款中',
    kind: loan.kindText, mode: loan.measurementKind === 'repayment' ? '按还款额记录' : loan.measurementKind === 'rate' ? '按利率记录' : '',
    principal: cost.amount(original), terms, paid, progress: terms ? Math.min(100, Math.round(paid / terms * 100)) : 0,
    progressText: summary ? '已还' : '历史已还',
    tracking: !!(view && view.tracking),
    progressNote: '',
    timeRange: first ? first + (last ? ' 至 ' + last : ' 起') : '还款日期待补充',
    method: METHOD_LABELS[loan.scheduleMethod] || loan.repaymentMethod || '方式待补充',
    complete, overdue: view && view.tracking ? Boolean(dueRow && dueRow.stateText === '已逾期') : Boolean(next && next <= date),
    dueLabel: pending ? '正在读取还款计划' : complete ? '本笔已完成' : noPlan ? '还款计划待补充' : next <= date ? view && view.tracking ? '付款待确认' : '待确认还款' : '近期应还',
    dueDate: next ? next.replace(/-/g, '.') : '', dueTerm: dueRow ? dueRow.periodNumber : null,
    duePayment: dueRow ? cost.amount(['unpaidPrincipalMinor', 'unpaidInterestMinor', 'unpaidFeeMinor'].reduce((sum, key) => addMinor(sum, dueRow[key]), '0')) : '',
    dueTitle: complete ? '已全部记录' : noPlan ? '待补充计划' : pending ? '—' : '查看待还期次',
    dueNote: complete ? '已记录全部期次' : noPlan ? '补充后查看每期应还' : '在下方列表记录每期还款',
    duePrincipal: amountOf('unpaidPrincipalMinor'), dueCost: dueRow ? cost.amount(addMinor(dueRow.unpaidInterestMinor, dueRow.unpaidFeeMinor)) : '—',
    remaining: cost.amount(noPlan ? null : remaining), remainingPrincipal: cost.amount(loan.remainingPrincipalMinor),
    remainingCost: summary && !noPlan ? cost.amount(addMinor(summary.unpaidInterestMinor, summary.unpaidFeeMinor)) : '—',
    principalGap: summary && summary.principalGapMinor != null && summary.principalGapMinor !== '0' ? '计划本金与账本剩余本金相差 ' + cost.amount(summary.principalGapMinor) + ' 元，需核对计划。' : '',
    cost: cost.build(loan, preview)
  }
}
module.exports = { today, previewInput, historicalRows, rowView, build }
