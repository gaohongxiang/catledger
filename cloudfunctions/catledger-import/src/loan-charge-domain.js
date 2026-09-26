// 费用键属于原合同收费项，金额、请求号和方案版本都不能改变其身份。
const { createHash } = require('node:crypto')
const fail = code => { throw Object.assign(new Error(code), { publicCode: code }) }
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const today = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0, 10)
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail('VALIDATION_ERROR')
  return value
}
function monthDate(first, offset) {
  date(first)
  const [y,m,d] = first.split('-').map(Number), end = new Date(Date.UTC(y,m+offset,0)).getUTCDate()
  return new Date(Date.UTC(y,m-1+offset,Math.min(d,end))).toISOString().slice(0,10)
}
function amount(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('VALIDATION_ERROR')
  return value
}
function reference(label) {
  if (label == null || label === '') return null
  if (typeof label !== 'string' || label.trim().length > 80) fail('VALIDATION_ERROR')
  const text = label.normalize('NFKC').trim()
  if (!text) fail('VALIDATION_ERROR')
  return createHash('sha256').update('bank-installment-v1:' + text).digest('hex')
}
function authorization(data) {
  if (!['auto','once','paused'].includes(data.mode) || !['continue','catch_up'].includes(data.historyChoice) ||
      data.fixedConfirmed !== true || data.coverageConfirmed !== true || data.dateConfirmed !== true) fail('VALIDATION_ERROR')
  const value = { schema:1, mode:data.mode, fromDate:date(data.fromDate), throughDate:date(data.throughDate),
    firstChargeDate:date(data.firstChargeDate), historyChoice:data.historyChoice,
    baselineCoveredThrough:data.baselineCoveredThrough ? date(data.baselineCoveredThrough) : null,
    interestCategoryId:data.interestCategoryId || null, feeCategoryId:data.feeCategoryId || null,
    fixedConfirmed:true, coverageConfirmed:true, dateConfirmed:true }
  if (value.fromDate > value.throughDate || value.baselineCoveredThrough && value.baselineCoveredThrough >= value.fromDate) fail('VALIDATION_ERROR')
  return value
}
function plannedCharges(periods, auth, overrides) {
  if (!periods.length || periods.length > 600) fail('VALIDATION_ERROR')
  const selected = overrides == null ? periods : overrides
  if (!Array.isArray(selected) || selected.length !== periods.length || new Set(selected.map(p=>p.periodNumber)).size !== periods.length) fail('VALIDATION_ERROR')
  return selected.flatMap(row => {
    if (!periods.some(p=>p.periodNumber===row.periodNumber)) fail('VALIDATION_ERROR')
    return ['interest','fee'].flatMap(component => {
      const minor = String(row[component+'Minor'])
      if (minor === '0') return []
      return [{ chargeKey:'period:'+row.periodNumber+':'+component, periodNumber:row.periodNumber, component,
        amountMinor:amount(minor), chargeDate:monthDate(auth.firstChargeDate,row.periodNumber-1), categoryId:auth[component+'CategoryId'] }]
    })
  })
}
function eligible(charge, auth, cutoff) {
  return charge.state === 'planned' && charge.chargeDate >= auth.fromDate && charge.chargeDate <= auth.throughDate && charge.chargeDate <= cutoff
}
module.exports = { parse,today,date,monthDate,amount,reference,authorization,plannedCharges,eligible }
