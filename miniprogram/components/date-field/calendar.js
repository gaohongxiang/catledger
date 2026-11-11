// 日期面板纯函数：月历网格、年月计算。无副作用，便于单测。
const pad = n => (n < 10 ? '0' + n : String(n))

function ymd(year, month, day) { return year + '-' + pad(month) + '-' + pad(day) }
function ym(year, month) { return year + '-' + pad(month) }

// 解析 "YYYY-MM-DD" / "YYYY-MM" → {year, month, day?}；非法返回 null
function parse(value) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(value == null ? '' : value))
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: m[3] ? Number(m[3]) : null }
}

// 某年某月的 6×7 网格（含前后月补白，共 42 格）。每格 {day, inMonth, date}
function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const weekday = first.getUTCDay() // 0=周日
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells = []
  // 前置补白（上月末尾）
  const prevMonthDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate()
  for (let i = weekday - 1; i >= 0; i -= 1) {
    const day = prevMonthDays - i
    const pm = month === 1 ? 12 : month - 1
    const py = month === 1 ? year - 1 : year
    cells.push({ day, inMonth: false, date: ymd(py, pm, day) })
  }
  for (let day = 1; day <= daysInMonth; day += 1) cells.push({ day, inMonth: true, date: ymd(year, month, day) })
  // 后置补白（下月开头）补满 42
  let next = 1
  while (cells.length < 42) {
    const nm = month === 12 ? 1 : month + 1
    const ny = month === 12 ? year + 1 : year
    cells.push({ day: next, inMonth: false, date: ymd(ny, nm, next) })
    next += 1
  }
  return cells
}

function shiftMonth(year, month, delta) {
  const idx = (year * 12 + (month - 1)) + delta
  return { year: Math.floor(idx / 12), month: idx % 12 + 1 }
}

function todayParts(now) {
  const d = now ? new Date(now) : new Date()
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
}

module.exports = { pad, ymd, ym, parse, monthGrid, shiftMonth, todayParts }
