const { storedScheduleInput, parseSetup } = require('./loan-installment')
const { buildSchedule } = require('./loan-schedule/schedule-engine')
const { ledgerError } = require('./ledger-errors')
const FIELDS = ['principal', 'interest', 'fee']
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key] || '0'), 0n).toString()

function progressOf(loan) {
  const saved = parse(loan.progress)
  if(saved && saved.schema===2)return saved
  const historical=(parseSetup(loan.installmentSetup)||{}).historicalPaidTerms||0
  // 旧 through 无法区分单期扩散与批量确认，保留原值供核对；不推断成实付。
  return {schema:2,through:historical,exceptions:{...(saved&&saved.exceptions||{})},legacy:saved||null,
    legacyNeedsReview:!!(saved&&Number(saved.through)>historical),historicalConfirmedThrough:historical}
}
function fullPlan(loan) {
  const input = storedScheduleInput(loan), setup = parseSetup(loan.installmentSetup)
  return buildSchedule({ ...input, ...(setup ? { discountKind: setup.discountKind, discountValue: setup.discountValue } : {}) }).periods
    .map(row => ({ ...row, ...Object.fromEntries(FIELDS.map(field => [field + 'Minor', String(row[field + 'Minor'])])) }))
}
function buildView(loan, savedPeriods = [], items = [], today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)) {
  const progress = progressOf(loan), exceptions = progress.exceptions || {}, original = fullPlan(loan)
  const saved = new Map(savedPeriods.map(row => [Number(row.periodNumber), row]))
  const through=Math.min(Number(loan.scheduleTerms),Math.max(Number(progress.through)||0,0))
  const currentNumber = (original.find(row => row.dueDate >= today) || original.at(-1) || {}).periodNumber
  const rows = original.map(plan => {
    const old = saved.get(plan.periodNumber), row = { ...plan, ...old }, exception = exceptions[plan.periodNumber]
    const sources = items.filter(item => Number(item.periodNumber) === plan.periodNumber && item.active !== false)
    const differences = sources.filter(item => item.amountMinor != null && String(item.amountMinor) !== String(row[item.component + 'Minor'])).map(item => item.component)
    const partial = exception === 'partial' || !exception && old && old.status === 'partial'
    const complete = Boolean(!row.cancelled && exception !== 'unpaid' && !partial && (exception === 'completed' || plan.periodNumber <= through || old && old.status==='paid'))
    const amounts = Object.fromEntries(FIELDS.map(field => {
      const key = 'unpaid' + field[0].toUpperCase() + field.slice(1) + 'Minor'
      return [key, complete || row.cancelled ? '0' : String(partial && old && old[key] != null ? old[key] : row[field + 'Minor'])]
    }))
    return { ...row, ...amounts, periodNumber: plan.periodNumber, sourceCount: sources.length, differences,
      recordedComponents: [...new Set(sources.map(item => item.component))],
      status: row.cancelled ? 'cancelled' : complete ? 'paid' : partial ? 'partial' : exception === 'unpaid' ? 'unpaid' : 'missing',
      complete, current: !complete && plan.periodNumber === currentNumber,
      stateText: row.cancelled ? '已取消' : complete ? '已完成' : partial ? '部分未还' : exception === 'unpaid' ? (row.dueDate < today ? '已逾期' : '未还')
        : sources.length ? '已出账，付款待确认' : '付款待确认',
      completedByProgress: complete && (!old || old.status !== 'paid'),paymentConfirmed:!!(old&&old.status==='paid'),billed:sources.length>0 }
  })
  const upcoming = rows.find(row => !row.complete && !row.cancelled)
  let completedThrough=0
  for(const row of rows){if(!row.complete)break;completedThrough=row.periodNumber}
  const summary = { completedThrough, manualThrough: through,legacyProgress:progress.legacy,legacyNeedsReview:progress.legacyNeedsReview,
    actualPaidPeriods:rows.filter(r=>r.paymentConfirmed).length,manualPaidPeriods:rows.filter(r=>r.completedByProgress).length,
    paidPeriods: rows.filter(row => row.complete).length, totalTerms: Number(loan.scheduleTerms),
    unpaidPrincipalMinor: sum(rows, 'unpaidPrincipalMinor'), unpaidInterestMinor: sum(rows, 'unpaidInterestMinor'),
    unpaidFeeMinor: sum(rows, 'unpaidFeeMinor'), nextDueDate: upcoming ? upcoming.dueDate : null }
  summary.estimatedPrincipalMinor = summary.unpaidPrincipalMinor
  summary.remainingPrincipalMinor = loan.remainingPrincipalMinor==null?null:String(loan.remainingPrincipalMinor)
  return { rows, summary, original }
}
function updateProgress(loan, input) {
  const previous = progressOf(loan), result = { ...previous,schema:2,exceptions:{...previous.exceptions} }
  const terms = Number(loan.scheduleTerms)
  if (input.completedThrough !== undefined) {
    if (!Number.isInteger(input.completedThrough) || input.completedThrough < 0 || input.completedThrough > terms) throw ledgerError('VALIDATION_ERROR')
    if(input.confirmedBatch!==true)throw ledgerError('VALIDATION_ERROR')
    result.through = input.completedThrough
    result.legacyNeedsReview=false
  }
  if (input.periodNumber !== undefined) {
    if (!Number.isInteger(input.periodNumber) || input.periodNumber < 1 || input.periodNumber > terms ||
      !['completed', 'unpaid', 'partial', 'clear'].includes(input.status)) throw ledgerError('VALIDATION_ERROR')
    if (input.status === 'clear') delete result.exceptions[input.periodNumber]
    else result.exceptions[input.periodNumber] = input.status
  }
  return result
}
module.exports = { fullPlan, progressOf, buildView, updateProgress }
