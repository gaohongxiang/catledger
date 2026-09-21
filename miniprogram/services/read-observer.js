// 显式开启、内存有界、白名单指标；不采集查询参数、身份或财务值。
let enabled = false
const samples = []
const events = new Set(['request', 'cache', 'setData', 'snapshot', 'fresh', 'interactive'])
const sources = new Set(['network', 'memory', 'storage'])
function bytes(value) {
  return encodeURIComponent(JSON.stringify(value)).replace(/%[A-F\d]{2}/g, 'x').length
}
function record(event, value) {
  if (!enabled || !events.has(event)) return
  const sample = { event }
  if (/^(bootstrap|(?:dashboard|statistics|catalog|accounts|categories|transactions|loans|profile|reads)\.[a-zA-Z]+)$/.test(value.action || '')) sample.action = value.action
  if (/^pages\/[a-z-]+\/index$/.test(value.page || '')) sample.page = value.page
  if (sources.has(value.source)) sample.source = value.source
  for (const key of ['ms', 'bytes', 'attempt', 'elapsedMs']) if (Number.isFinite(value[key]) && value[key] >= 0) sample[key] = value[key]
  for (const key of ['hit', 'ok']) if (typeof value[key] === 'boolean') sample[key] = value[key]
  samples.push(sample)
  if (samples.length > 300) samples.shift()
}
function attach(page) {
  if (page._readObserverAttached) return
  page._readObserverAttached = true
  const original = page.setData
  page.setData = function (patch, callback) {
    if (!enabled) return original.call(this, patch, callback)
    const start = Date.now(), size = bytes(patch)
    return original.call(this, patch, function () {
      record('setData', { page: page.route, ms: Date.now() - start, bytes: size })
      if (callback) callback.call(page)
    })
  }
}
module.exports = { bytes, record, attach, active: () => enabled,
  enable(value) { enabled = value === true; samples.length = 0 },
  snapshot: () => samples.map(sample => Object.assign({}, sample)) }
