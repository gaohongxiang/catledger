const test = require('node:test'), assert = require('node:assert/strict')
const api = require('../cloudfunctions/catledger-api/src/installment-plan-fingerprint')
const imp = require('../cloudfunctions/catledger-import/src/installment-plan-fingerprint')

test('计划级合成绑定键稳定且按 计划名/起始月/总期数 区分（两支云函数一致）', () => {
  const a = api.planBindingKey('电销现分', '2026-01', 12)
  assert.match(a, /^[0-9a-f]{64}$/)
  // 与导入侧同一实现，保证跨函数写入/读取能对上。
  assert.equal(a, api.planBindingKey('电销现分', '2026-01', 12))
  assert.equal(imp.planBindingKey('电销现分', '2026-01', 12), a)
  // 总期数、起始月、名称任一不同即不同键。
  assert.notEqual(api.planBindingKey('电销现分', '2026-01', 12), api.planBindingKey('电销现分', '2026-01', 24))
  assert.notEqual(api.planBindingKey('电销现分', '2026-01', 12), api.planBindingKey('电销现分', '2026-02', 12))
  assert.notEqual(api.planBindingKey('电销现分', '2026-01', 12), api.planBindingKey('总账分', '2026-01', 12))
  // 同名同起始月同期数但本金不同的两笔会得到同一键——这是"判不准"的边界，读取方只在唯一命中时采用。
  assert.equal(api.planBindingKey('电销现分', '2026-01', 12), api.planBindingKey('电销现分', '2026-01', 12))
})
