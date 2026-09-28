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
test('真实预设目录每项有图标，改名保持图标，两级关系不依赖键名前缀', () => {
  const keys = new Set(DEFAULT_CATEGORIES.map(row => row.systemKey))
  assert.equal(keys.size, DEFAULT_CATEGORIES.length)
  for (const row of DEFAULT_CATEGORIES) {
    if (row.parentSystemKey) {
      assert.ok(keys.has(row.parentSystemKey))
      const parent = DEFAULT_CATEGORIES.find(p => p.systemKey === row.parentSystemKey)
      assert.equal(parent.kind, row.kind); assert.ok(!parent.parentSystemKey)
    }
    const icon = palette.iconFor(row.name, row.systemKey)
    assert.ok(fs.existsSync(path.join(__dirname, '../miniprogram', icon)))
    assert.equal(palette.iconFor('重命名后的合成分类', row.systemKey), icon)
    assert.equal(palette.colorNameFor('重命名后的合成分类', row.systemKey), palette.colorNameFor(row.name, row.systemKey))
  }
  assert.equal(palette.iconFor('自定义类别'), '/assets/icons/categories/other.svg')
  assert.notEqual(palette.iconFor('', 'food__drink'), palette.iconFor('', 'food__meal'))
  assert.notEqual(palette.iconFor('', 'entertainment__pets'), palette.iconFor('', 'entertainment'))
  assert.notEqual(palette.iconFor('', 'shopping__clothing'), palette.iconFor('', 'shopping__electronics'))
})
test('统计汇总只计算一次，未细分与未分类分开，跨期退款净额保持整数精度', () => {
  const result = rollupCategories([
    { categoryId: 'p', categoryName: '餐饮', amountMinor: '100', hasChildren: true },
    { categoryId: 'a', parentId: 'p', parentName: '餐饮', categoryName: '吃饭', amountMinor: '9007199254740993' },
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

test('真实明细入口区分资金动作与分类，退款保留原分类文字，同名分类不冒充动作', async () => {
  const { runtime } = require('./helpers/read-runtime')
  const fixtures = [
    { type: 'transfer', expected: 'transfer' },
    { type: 'refund', refundLinkStatus: 'pending', expected: 'refund' },
    { type: 'refund', category: { categoryId: 'food', name: '吃饭', systemKey: 'food__meal' }, expected: 'refund' },
    { type: 'balance_adjustment', expected: 'balance-adjustment' },
    { type: 'expense', expected: 'uncategorized' },
    { type: 'income', expected: 'uncategorized' },
    { type: 'expense', category: { categoryId: 'food', name: '转账', systemKey: 'food__meal' }, expected: 'meal' },
    { type: 'expense', category: { categoryId: 'custom', name: '退款' }, expected: 'other' },
    { type: 'income', category: { categoryId: 'custom-income', name: '未分类' }, expected: 'other' }
  ]
  for (const route of ['transactions', 'account-transactions']) {
    const h = runtime(), page = h.page(route)
    h.respond = action => action === 'transactions.list' ? { ok: true, data: {
      transactions: fixtures.map((row, index) => ({ ...row, transactionId: 'synthetic-' + index,
        amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00' })), nextCursor: null,
      summary: { incomeMinor: '200', expenseMinor: '200', netIncomeMinor: '0' }
    } } : undefined
    page.onLoad({ accountId: 'account-a' }); page.onShow(); await page.prepareAndLoad()
    const tile = h.load('components/category-tile/index')
    const component = { data: {}, setData(patch) { Object.assign(this.data, patch) } }
    page.data.transactions.forEach((row, index) => {
      tile.observers['name, color, systemKey, iconKind'].call(component, row.label, '', row.category && row.category.systemKey, row.iconKind)
      assert.equal(component.data.icon, '/assets/icons/categories/' + fixtures[index].expected + '.svg', route + ': ' + index)
      assert.ok(fs.existsSync(path.join(__dirname, '../miniprogram', component.data.icon)))
      assert.equal(component.data.resolvedColor, index === 0 ? 'blue' : index === 1 || index === 2 ? 'teal' : index === 6 ? 'orange' : 'grey')
    })
    assert.equal(page.data.transactions[2].label, '吃饭')
    assert.equal(page.data.transactions[1].typeLabel, '待关联退款')
    assert.equal(page.data.transactions[3].amountClass, 'amount-neutral')
    const picker = tree.selectionGroups(page.data.categoryFilters, '', {}, 0)
    assert.equal(palette.iconFor(picker[0].name, '', picker[0].iconKind), '/assets/icons/categories/all-categories.svg')
    assert.equal(palette.iconFor(picker[1].name, '', picker[1].iconKind), '/assets/icons/categories/uncategorized.svg')
    page.onUnload()
  }
  const { buildReadonlyDetail } = require('../miniprogram/pages/transaction-editor/readonly-detail')
  const detail = buildReadonlyDetail({ type: 'expense', amountMinor: '100' }, [], true)
  assert.equal(detail.categories[detail.categoryIndex].iconKind, 'uncategorized')
})
