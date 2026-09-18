function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

function today(reference) {
  const date = reference instanceof Date ? reference : new Date()
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function isDate(value) {
  const text = String(value || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parts = text.split('-')
  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  return date.getFullYear() === Number(parts[0]) && date.getMonth() === Number(parts[1]) - 1 && date.getDate() === Number(parts[2])
}

function addMonths(dateString, months) {
  const parts = String(dateString).split('-')
  const year = Number(parts[0])
  const month = Number(parts[1]) - 1
  const day = Number(parts[2])
  const target = new Date(year, month + Number(months || 0), 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(day, lastDay))
  return target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate())
}

function scheduleAnchor({ firstPaymentDate, baselineDate, startDate, createdDate, referenceDate } = {}) {
  if (isDate(firstPaymentDate)) return String(firstPaymentDate)
  const base = isDate(baselineDate) ? baselineDate : isDate(startDate) ? startDate : isDate(createdDate) ? createdDate : today(referenceDate)
  return addMonths(base, 1)
}

module.exports = { today, isDate, addMonths, scheduleAnchor }
