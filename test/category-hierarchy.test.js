const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tree = require('../miniprogram/utils/category-tree')
const palette = require('../miniprogram/utils/category-palette')
const { DEFAULT_CATEGORIES } = require('../cloudfunctions/catledger-api/src/default-categories')
const { rollupCategories } = require('../cloudfunctions/catledger-api/src/reporting-service')
const rows = [
  { id: 'child', parentId: 'parent', name: '午餐' },
  { id: 'parent', name: '餐饮' },
  { id: 'other', name: '自定义' },
  { id: 'archived', parentId: 'parent', name: '停用', archived: true }
]
test('可选层级搜索保留原索引，选择子类展开所属大类，允许再收起', () => {
  const groups = tree.selectionGroups(rows, '', {}, 0)
  assert.equal(groups[0].optionIndex, 1)
  assert.equal(groups[0].children[0].optionIndex, 0)
  assert.equal(groups[0].expanded, true)
  assert.equal(groups[0].children.length, 1)
  assert.equal(tree.selectionGroups(rows, '', { parent: false }, 0)[0].expanded, false)
  assert.equal(tree.selectionGroups(rows, '午餐', {}, -1)[0].children[0].displayName, '餐饮 / 午餐')
  assert.equal(tree.selectionGroups(rows, '餐饮', {}, -1)[0].children.length, 1)
  assert.equal(tree.selectionGroups(rows, '餐饮', { parent: false }, -1)[0].expanded, false)
  assert.equal(tree.selectionGroups(rows, '找不到', {}, -1).length, 0)
  assert.equal(tree.selectionGroups([{ categoryId: 'c', parentId: 'p', parentName: '大类', name: '子类' }], '大类', {}, -1)[0].displayName, '大类 / 子类')
})
test('真实预设目录每项有图标，改名保持图标，子类沿用所属大类视觉', () => {
  const keys = new Set(DEFAULT_CATEGORIES.map(row => row.systemKey))
  assert.equal(keys.size, DEFAULT_CATEGORIES.length)
  for (const row of DEFAULT_CATEGORIES) {
    if (row.parentSystemKey) { assert.ok(keys.has(row.parentSystemKey)); assert.equal(DEFAULT_CATEGORIES.find(p => p.systemKey === row.parentSystemKey).kind, row.kind) }
    const icon = palette.iconFor(row.name, row.systemKey)
    assert.ok(fs.existsSync(path.join(__dirname, '../miniprogram', icon)))
    assert.equal(palette.iconFor('重命名后的合成分类', row.systemKey), icon)
    assert.equal(palette.colorNameFor('重命名后的合成分类', row.systemKey), palette.colorNameFor(row.name, row.systemKey))
  }
  assert.equal(palette.iconFor('自定义类别'), '/assets/icons/categories/other.svg')
})
test('统计汇总只计算一次，未细分与未分类分开，跨期退款净额保持整数精度', () => {
  const result = rollupCategories([
    { categoryId: 'p', categoryName: '餐饮', amountMinor: '100', hasChildren: true },
    { categoryId: 'a', parentId: 'p', parentName: '餐饮', categoryName: '餐食', amountMinor: '9007199254740993' },
    { categoryId: 'b', parentId: 'p', parentName: '餐饮', categoryName: '饮品', amountMinor: '-80' },
    { categoryId: null, categoryName: '未分类', amountMinor: '3', hasChildren: '0' }
  ], 9007199254741016n)
  assert.equal(result[0].amountMinor, '9007199254741013')
  assert.equal(result[0].children.reduce((n,r) => n + BigInt(r.amountMinor), 0n).toString(), result[0].amountMinor)
  assert.ok(result[0].children.some(row => row.direct && row.name === '未细分'))
  assert.equal(result[1].name, '未分类'); assert.deepEqual(result[1].children, [])
})

test('未分类不会把所有根类误认为子类，分页导入选择直接打开完整目录', () => {
  const options = [{ id: null, name: '未分类' }, { id: 'root', parentId: null, name: '大类' }]
  assert.equal(tree.selectionGroups(options, '', {}, 0)[0].children.length, 0)
  let definition
  const vm = require('node:vm')
  const filename = path.join(__dirname, '../miniprogram/components/category-picker/index.js')
  vm.runInNewContext(fs.readFileSync(filename,'utf8'), { Component: value => { definition = value }, require: () => tree })
  const events = [], component = { data: { remote: true, disabled: false, open: false }, triggerEvent: name => events.push(name) }
  definition.methods.show.call(component)
  assert.deepEqual(events,['browse']); assert.equal(component.data.open,false)
  component.data.disabled = true; definition.methods.show.call(component); assert.equal(events.length,1)
  const local = { data: { range: rows, value: 0, query: '', groups: [], open: false },
    setData: function(value) { Object.assign(this.data,value) } }
  Object.assign(local,definition.methods)
  local.show(); assert.equal(local.data.groups[0].expanded,true)
  local.toggle({currentTarget:{dataset:{key:'parent'}}}); assert.equal(local.data.groups[0].expanded,false)
  local.search({detail:{value:'午餐'}}); assert.equal(local.data.groups[0].expanded,true)
  local.toggle({currentTarget:{dataset:{key:'parent'}}}); assert.equal(local.data.groups[0].expanded,false)
  local.search({detail:{value:'餐饮'}}); assert.equal(local.data.groups[0].expanded,true)
})
