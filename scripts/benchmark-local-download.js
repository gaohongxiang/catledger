// P0 client download benchmark. Uses synthetic facts only; never reads a real
// bill or logs raw fields. Delay per chunk simulates network RTT, not a device.
const { facts, packed, filesystem } = require('../test/helpers/local-review')
const files = require('../miniprogram/packages/finance/services/import-local-files')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function downloadMeasure(value, object, concurrency, rttMs) {
  const lab = filesystem()
  try {
    const store = files.create({ ...lab, scope: 'bench:download:' + concurrency,
      updateId: value.update.updateId, chunkConcurrency: concurrency })
    let final = null
    const startedAt = Date.now()
    await store.download(object.header, async (action, data) => {
      if (action.endsWith('Chunk')) await wait(rttMs)
      return object.call(action, data)
    }, update => { final = update })
    if (!final || !final.stats) throw new Error('benchmark did not receive download stats')
    return { wallMs: Date.now() - startedAt, ...final.stats }
  } finally { lab.cleanup() }
}

async function resumeMeasure(value, object, rttMs) {
  const lab = filesystem()
  try {
    const store = files.create({ ...lab, scope: 'bench:resume', updateId: value.update.updateId, chunkConcurrency: 2 })
    const failAt = Math.floor(object.parts.length / 2)
    let failed = true, retryCalls = 0
    const network = async (action, data) => {
      if (action.endsWith('Chunk') && failed && data.index === failAt) {
        failed = false
        throw new Error('synthetic disconnect')
      }
      if (action.endsWith('Chunk')) retryCalls += 1
      await wait(rttMs)
      return object.call(action, data)
    }
    try { await store.download(object.header, network) } catch (_) { /* expected */ }
    retryCalls = 0
    let final = null
    await store.download(object.header, network, update => { final = update })
    return { retryChunkCalls: retryCalls, reused: final.stats.reused }
  } finally { lab.cleanup() }
}

async function main() {
  const rows = Number(process.argv[2] || 3000)
  const rttMs = Number(process.argv[3] || 8)
  if (![600, 3000].includes(rows) || !Number.isFinite(rttMs) || rttMs < 0) throw new Error('usage: benchmark-local-download.js <600|3000> [rttMs]')
  const value = await facts({ count: rows })
  const object = packed(value)
  const serial = await downloadMeasure(value, object, 1, rttMs)
  const parallel = await downloadMeasure(value, object, 4, rttMs)
  const resume = await resumeMeasure(value, object, rttMs)
  process.stdout.write(JSON.stringify({ rows, rttMs, parts: object.parts.length,
    bytes: object.header.bytes, serial, parallel, resume }) + '\n')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
