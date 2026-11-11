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
function buildView(loan, savedPeriods = [], items = [], today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10), prepaid = []) {
  const progress = progressOf(loan), exceptions = progress.exceptions || {}, original = fullPlan(loan)
  // 兼容旧数据：历史用「标记已结清」写入的 progress.settled 仍按已还展示（该入口已下线，改用编辑改已还期数）。
  const settled = progress.settled === true
  const saved = new Map(savedPeriods.map(row => [Number(row.periodNumber), row]))
  const through=Math.min(Number(loan.scheduleTerms),Math.max(Number(progress.through)||0,0))
  const currentNumber = (original.find(row => row.dueDate >= today) || original.at(-1) || {}).periodNumber
  const sourcesByNumber=new Map(),prepaidByNumber=new Map()
  for(const item of items)if(item.active!==false){const n=Number(item.periodNumber);if(!sourcesByNumber.has(n))sourcesByNumber.set(n,[]);sourcesByNumber.get(n).push(item)}
  for(const item of prepaid){const n=Number(item.periodNumber);prepaidByNumber.set(n,(prepaidByNumber.get(n)||0n)+BigInt(item.amountMinor))}
  // 账单锚点：导入账单里出现的最早期次。它之前的期次视为已还（账单能到第 N 期，前面都过了）。
  let anchorTerm = null
  for (const item of items) if (item.active !== false) { const n = Number(item.periodNumber); if (anchorTerm == null || n < anchorTerm) anchorTerm = n }
  const rows = original.map(plan => {
    const old = saved.get(plan.periodNumber), row = { ...plan, ...old }, exception = exceptions[plan.periodNumber]
    const prepaidFee=prepaidByNumber.get(plan.periodNumber)||0n
    if(prepaidFee>0n){row.paidFeeMinor=String(BigInt(row.paidFeeMinor||'0')+prepaidFee);row.unpaidFeeMinor=String(BigInt(row.feeMinor)>BigInt(row.paidFeeMinor)?BigInt(row.feeMinor)-BigInt(row.paidFeeMinor):0n)}
    const sources = sourcesByNumber.get(plan.periodNumber)||[]
    const differences = sources.filter(item => item.amountMinor != null && String(item.amountMinor) !== String(row[item.component + 'Minor'])).map(item => item.component)
    const actualPaid=old&&(old.status==='paid'||prepaidFee>0n&&FIELDS.every(f=>BigInt(row['paid'+f[0].toUpperCase()+f.slice(1)+'Minor']||'0')>=BigInt(row[f+'Minor']))),actualPartial=old&&!actualPaid&&old.status==='partial'
    const historyFact = (progress.historyFacts||{})[plan.periodNumber]
    const partial = Boolean(!historyFact && (actualPartial || !actualPaid && exception === 'partial'))
    // 账单锚点及之前的期次（未被显式标为未还/部分）按已还处理：
    // 账单里出现第 N 期，说明第 1~N 期都已到期发生、视为已还，待核对从 N+1 起。
    const beforeAnchor = anchorTerm != null && plan.periodNumber <= anchorTerm
    const complete = Boolean(!row.cancelled && (settled || actualPaid || exception !== 'unpaid' && !partial && (exception === 'completed' || plan.periodNumber <= through || beforeAnchor)))
    const amounts = Object.fromEntries(FIELDS.map(field => {
      const key = 'unpaid' + field[0].toUpperCase() + field.slice(1) + 'Minor'
      return [key, complete || row.cancelled ? '0' : String(row[key] != null ? row[key] : row[field + 'Minor'])]
    }))
    return { ...row, ...amounts, historicalPrincipalMinor:historyFact?String(historyFact.principalMinor):null, periodNumber: plan.periodNumber, sourceCount: sources.length, differences,
      recordedComponents: [...new Set(sources.map(item => item.component))],
      status: row.cancelled ? 'cancelled' : complete ? 'paid' : partial ? 'partial' : exception === 'unpaid' ? 'unpaid' : 'missing',
      complete, current: !complete && plan.periodNumber === currentNumber,
      stateText: row.cancelled ? '已取消' : complete ? '已还' : partial ? '部分未还' : exception === 'unpaid' ? (row.dueDate < today ? '已逾期' : '未还') : '未还',
      completedByProgress: complete && !actualPaid,paymentConfirmed:!!actualPaid,billed:sources.length>0 }
  })
  const upcoming = rows.find(row => !row.complete && !row.cancelled)
  let completedThrough=0
  for(const row of rows){if(!row.complete)break;completedThrough=row.periodNumber}
  const historyNeedsReview = false
  const summary = { completedThrough, manualThrough: through,legacyProgress:progress.legacy,legacyNeedsReview:progress.legacyNeedsReview||historyNeedsReview,historyNeedsReview,
    actualPaidPeriods:rows.filter(r=>r.paymentConfirmed).length,manualPaidPeriods:rows.filter(r=>r.completedByProgress).length,
    paidPeriods: rows.filter(row => row.complete).length, totalTerms: Number(loan.scheduleTerms),
    unpaidPrincipalMinor: sum(rows, 'unpaidPrincipalMinor'), unpaidInterestMinor: sum(rows, 'unpaidInterestMinor'),
    unpaidFeeMinor: sum(rows, 'unpaidFeeMinor'), nextDueDate: upcoming ? upcoming.dueDate : null, settled }
  // 全期合计（未取消期次）：用于账户页汇总「所有分期的总利息/总费用」。不随已还变化。
  const liveRows = rows.filter(r => !r.cancelled)
  summary.totalInterestMinor = sum(liveRows, 'interestMinor')
  summary.totalFeeMinor = sum(liveRows, 'feeMinor')
  summary.totalPaymentMinor = sum(liveRows, 'paymentMinor')
  summary.estimatedPrincipalMinor = summary.unpaidPrincipalMinor
  const lastBilled = Math.max(0, ...rows.filter(r => r.billed).map(r => r.periodNumber))
  // 只询问「新出现账单之前、尚未选择」的期次；用户明确选过未还的期次不反复询问。
  // 已按账单锚点/已还期数算作已还的期次视为既成事实，不再强制弹出逐期复核（新口径唯一）。
  summary.repaymentPrompts = rows.filter(r => !r.cancelled && !r.paymentConfirmed && r.status !== 'partial' &&
    r.periodNumber <= lastBilled && !Object.hasOwn(exceptions, r.periodNumber) && r.periodNumber > through)
    .map(r => ({ periodNumber:r.periodNumber, dueDate:r.dueDate, paid:true }))
  // 剩余本金只有一个口径：本笔「未还期次」的本金合计（按账单锚点动态算）。
  // 不再取 loans.baseline_principal_minor——那是创建时静态填入的原始本金起点，
  // 不随账单/已还变化，作为"剩余"展示会让顶部与逐期表打架（见 C1/C2）。
  summary.remainingPrincipalMinor = summary.unpaidPrincipalMinor
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
