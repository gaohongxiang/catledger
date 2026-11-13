const test = require('node:test')
const assert = require('node:assert/strict')
const { adaptiveWindowCount, monthSequence } = require('../cloudfunctions/catledger-api/src/reporting-service')

test('自适应窗口：夹在 6~12，按最早有数据月到结束月', () => {
  assert.equal(adaptiveWindowCount(null, '2026-11'), 6, '无数据补 6')
  assert.equal(adaptiveWindowCount('2026-11', '2026-11'), 6, '仅当月补 6')
  assert.equal(adaptiveWindowCount('2026-09', '2026-11'), 6, '3 个月补到 6')
  assert.equal(adaptiveWindowCount('2026-06', '2026-11'), 6, '6 个月=6')
  assert.equal(adaptiveWindowCount('2026-01', '2026-11'), 11, '11 个月按实际')
  assert.equal(adaptiveWindowCount('2025-12', '2026-11'), 12, '12 个月=12')
  assert.equal(adaptiveWindowCount('2024-01', '2026-11'), 12, '超 12 封顶 12')
})

test('自适应窗口生成的月份序列正确覆盖到结束月', () => {
  const n = adaptiveWindowCount('2026-01', '2026-11')
  const seq = monthSequence('2026-11', n)
  assert.equal(seq.length, 11)
  assert.equal(seq[0], '2026-01')
  assert.equal(seq[seq.length - 1], '2026-11')
  const capped = monthSequence('2026-11', adaptiveWindowCount('2020-01', '2026-11'))
  assert.equal(capped.length, 12)
  assert.equal(capped[capped.length - 1], '2026-11')
})
