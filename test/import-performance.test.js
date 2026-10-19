const test = require('node:test')
const assert = require('node:assert/strict')
const performance = require('../miniprogram/services/import-performance')

test('导入诊断只记录阶段、时长和计数，不接收原始字段', () => {
  let now = 1000
  const trace = performance.create({ now: () => now })
  now = 1042
  trace.mark('upload_start')
  trace.mark('parsed', { rows: 12, bytes: 2048, secret: 'raw', inline: true })
  now = 1100
  const value = trace.finish()
  assert.equal(value.totalMs, 100)
  assert.deepEqual(value.marks, [
    { stage: 'upload_start', at: 42 },
    { stage: 'parsed', at: 42, rows: 12, bytes: 2048, inline: true }
  ])
  assert.equal(JSON.stringify(value).includes('raw'), false)
})

test('导入诊断环形保存最近记录，存储失败不影响导入', () => {
  const values = [], store = {
    getStorageSync: key => values,
    setStorageSync: (key, value) => { values.splice(0, values.length, ...value) }
  }
  const previousWx = global.wx
  global.wx = store
  try {
    for (let index = 0; index < performance.MAX_RECORDS + 2; index += 1) {
      const trace = performance.create({ now: () => index })
      trace.mark('review_ready', { files: index })
      performance.record(trace)
    }
    assert.equal(values.length, performance.MAX_RECORDS)
    assert.equal(values[0].marks[0].files, performance.MAX_RECORDS + 1)
    store.setStorageSync = () => { throw new Error('storage full') }
    assert.doesNotThrow(() => performance.record(performance.create()))
  } finally {
    if (previousWx === undefined) delete global.wx
    else global.wx = previousWx
  }
})
