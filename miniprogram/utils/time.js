function pad(value) {
  return String(value).padStart(2, '0')
}

function currentMonth() {
  const now = new Date()
  return now.getFullYear() + '-' + pad(now.getMonth() + 1)
}

function today() {
  const now = new Date()
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
}

function currentClock() {
  const now = new Date()
  return pad(now.getHours()) + ':' + pad(now.getMinutes())
}

function shiftMonth(month, delta) {
  const parts = month.split('-').map(Number)
  const date = new Date(parts[0], parts[1] - 1 + delta, 1)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1)
}

function monthLabel(month) {
  const parts = month.split('-')
  return parts[0] + '年' + Number(parts[1]) + '月'
}

module.exports = {
  currentClock: currentClock,
  currentMonth: currentMonth,
  monthLabel: monthLabel,
  shiftMonth: shiftMonth,
  today: today
}
