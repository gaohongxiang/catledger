const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/categories/model')

test('分类拖拽跨多行时按行高计算目标并限制在列表范围内', function () {
  assert.deepEqual(model.resolveDrag(1, 100, 315, 100, 5), { offset: 215, target: 3 })
  assert.deepEqual(model.resolveDrag(1, 100, -900, 100, 5), { offset: -100, target: 0 })
  assert.deepEqual(model.resolveDrag(1, 100, 900, 100, 5), { offset: 300, target: 4 })
})

test('分类拖拽只移动目标项并重新生成连续序号', function () {
  const result = model.reorder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 0, 2)
  assert.deepEqual(result.map(function (item) { return item.id }), ['b', 'c', 'a'])
  assert.deepEqual(result.map(function (item) { return item.orderText }), ['01', '02', '03'])
  assert.deepEqual(result.map(function (item) { return item.positionIndex }), [0, 1, 2])
})
