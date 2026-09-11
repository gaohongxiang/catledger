const test = require('node:test')
const assert = require('node:assert/strict')
const { changedData } = require('../miniprogram/services/view-patch')
test('同长度列表只传改变的叶字段，不重建未改变的输入行', () => {
  const before = { rows: [{ id: 'a', name: '输入中' }, { id: 'b', name: '旧' }] }
  assert.deepEqual(changedData(before, { rows: [{ id: 'a', name: '输入中' }, { id: 'b', name: '新' }] }), { 'rows[1].name': '新' })
})
test('新增删除行或对象字段仍整体替换，明确清空不能遗漏', () => {
  assert.deepEqual(changedData({ rows: [{ id: 'a' }] }, { rows: [] }), { rows: [] })
  assert.deepEqual(changedData({ form: { a: 1, b: 2 } }, { form: { a: 1 } }), { form: { a: 1 } })
  assert.deepEqual(changedData({ name: '清空我' }, { name: '' }), { name: '' })
})
