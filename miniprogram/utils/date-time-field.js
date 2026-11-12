// date-field 组件 datetime 粒度的共用辅助：把组件的 change 事件拆成独立的日期、时间字段，
// 让原本用「日期 picker + 时间 picker」两个字段保存的页面可以平滑迁移到统一控件。
//   组件 datetime change 事件 detail: { value: 'YYYY-MM-DD HH:mm', date, time }
// 各页面在 data 里有 date/time 两个键时，用 splitDateTimeEvent 直接拿到可 setData 的对象。

function pad2(value) {
  return String(value).padStart(2, '0')
}

// 把 'YYYY-MM-DD HH:mm' 或组件 detail 拆成 { date: 'YYYY-MM-DD', time: 'HH:mm' }。
// 缺时间时保留原 time（默认 12:00）；缺日期时不覆盖（返回空 date，交由调用方决定）。
function splitDateTime(detail, previousTime) {
  const source = detail && typeof detail === 'object' ? detail : { value: detail }
  let date = source.date
  let time = source.time
  const value = String(source.value == null ? '' : source.value).trim()
  if (!date && value) {
    const parts = value.split(' ')
    date = parts[0] || ''
    if (!time) time = parts[1] || ''
  }
  return {
    date: date || '',
    time: time || previousTime || '12:00'
  }
}

module.exports = { splitDateTime, pad2 }
