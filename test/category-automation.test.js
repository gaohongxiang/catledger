const test = require('node:test')
const assert = require('node:assert/strict')
const { DEFAULT_CATEGORIES } = require('../cloudfunctions/catledger-api/src/default-categories')
const { buildCategoryEvidence, suggestedCategory } = require('../cloudfunctions/catledger-import/src/category-mapping')
const { categoryMemory } = require('../cloudfunctions/catledger-import/src/category-memory')
const { digestParts } = require('../cloudfunctions/catledger-import/src/digest')
const { refreshAutomaticCategory } = require('../cloudfunctions/catledger-import/src/semantic-plan-upgrade')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/review/policy')

function row(item, counterparty = '合成商户', rawTransactionType = '商户消费', direction = 'expense', sourceType = 'wechat') {
  return { item, counterparty, rawTransactionType, direction, sourceType }
}
function catalog(mappings = [], omitted = []) {
  const categories = DEFAULT_CATEGORIES.filter(c => !omitted.includes(c.systemKey)).map(c => ({ ...c, categoryId: c.systemKey }))
  categories.push({ categoryId: 'custom', kind: 'expense' })
  return { byId: new Map(categories.map(c => [c.categoryId, c])),
    bySystemKey: new Map(categories.filter(c => c.systemKey).map(c => [`${c.kind}:${c.systemKey}`, c.categoryId])),
    mappings: new Map(mappings.map(([key, id, source = 'wechat']) => [`${source}:${key}`, id])) }
}

test('明确用途细分到当前分类管理中的真实子类，不改变稳定键和层级', () => {
  const samples = [
    ['午餐便当', 'food__meal'], ['奶茶', 'food__drink'], ['水果零食', 'food__snack'],
    ['地铁乘车', 'transport__public'], ['网约车车费', 'transport__taxi'], ['停车费', 'transport__car'],
    ['高铁票', 'transport__train'], ['机票', 'transport__flight'],
    ['门诊挂号费', 'medical__treatment'], ['购买药品', 'medical__medicine'], ['血压计', 'medical__device'],
    ['水电费', 'utilities__water_power'], ['燃气费', 'utilities__gas'], ['物业费', 'utilities__property'], ['供暖费', 'utilities__heating'],
    ['本月房租', 'housing__rent'], ['装修施工', 'housing__repairs'], ['保洁服务', 'housing__housekeeping'],
    ['快递寄件', 'communication__postage'], ['手机话费', 'communication__phone'], ['宽带费', 'communication__internet'],
    ['图书教材', 'education__books'], ['培训课程费', 'education__courses'], ['考试报名费', 'education__exams'],
    ['电影票', 'entertainment__shows'], ['游戏点卡', 'entertainment__games'], ['视频会员', 'entertainment__subscriptions'],
    ['保费', 'finance__insurance'], ['税款', 'finance__tax'], ['手续费', 'finance__service'], ['贷款利息', 'finance__interest'],
    ['公益捐赠', 'social__donations']
  ]
  for (const [text, key] of samples) {
    assert.equal(suggestedCategory(row(text), catalog()), key, text)
    assert.ok(DEFAULT_CATEGORIES.find(c => c.systemKey === key).parentSystemKey, key)
  }
  assert.equal(DEFAULT_CATEGORIES.find(c => c.systemKey === 'food__meal').name, '美食')
  assert.equal(suggestedCategory(row('猫粮'), catalog()), 'entertainment__pets')
  assert.equal(suggestedCategory(row('挂号诊疗费', '合成宠物医院'), catalog()), 'entertainment__pets')
})

test('收支性质限定分类，收入细类与资金动作不混用', () => {
  const samples = [['工资', 'salary__base'], ['加班工资', 'salary__overtime'], ['绩效奖金', 'bonus__performance'],
    ['年终奖', 'bonus__annual'], ['兼职收入', 'part_time__side_job'], ['投资收益', 'investment__returns'],
    ['租金收入', 'investment__rental'], ['存款利息', 'investment__interest'], ['礼金红包', 'gift__gift_money'], ['彩票中奖', 'gift__winnings']]
  for (const [text, key] of samples) assert.equal(suggestedCategory(row(text, '合成商户', '收入', 'income'), catalog()), key)
  assert.equal(suggestedCategory(row('药品', '合成药房', '退款', 'income'), catalog()), null)
  assert.equal(suggestedCategory(row('奶茶', '合成商户', '转账', 'neutral'), catalog()), null)
})

test('商品证据先于商户；混合用途回到共同大类，跨类冲突留待分类', () => {
  assert.equal(suggestedCategory(row('药品', '合成医院'), catalog()), 'medical__medicine')
  assert.equal(suggestedCategory(row('奶茶', '合成餐厅'), catalog()), 'food__drink')
  assert.equal(suggestedCategory(row('午餐和饮料', '合成餐厅'), catalog()), 'food')
  assert.equal(suggestedCategory(row('挂号费和药品'), catalog()), 'medical')
  assert.equal(suggestedCategory(row('奶茶和图书', '合成奶茶店'), catalog()), null)
  for (const text of ['咖啡机', '咖啡杯', '水果刀', '面包机', '保险箱', '苹果手机', '小米手机']) {
    assert.equal(suggestedCategory(row(text), catalog()), null, text)
  }
  assert.equal(suggestedCategory(row('咖啡机', '合成咖啡店'), catalog()), null)
  for (const name of ['美团', '淘宝', '美团平台商户']) assert.equal(suggestedCategory(row('', name), catalog()), null)
})

test('宽泛旧交易类型记忆不能覆盖细类；旧商品记忆先于商户，只读有效同类型分类', () => {
  const input = row('奶茶', '合成餐馆', '餐饮美食', 'expense', 'alipay')
  const oldType = digestParts('category-alias-v1', 'alipay', '餐饮美食')
  const memory = categoryMemory('alipay', input)
  const indexes = catalog([[oldType, 'food', 'alipay'], [memory.legacyMerchantKey, 'shopping', 'alipay']])
  assert.equal(suggestedCategory(input, indexes), 'food__drink')
  assert.equal(suggestedCategory({ ...input, item: '合成未知商品', counterparty: '' }, indexes), 'food')
  const unknown = row('合成商品'), saved = categoryMemory('wechat', unknown)
  assert.equal(suggestedCategory(unknown, catalog([[saved.legacyItemKey, 'custom'], [saved.legacyMerchantKey, 'shopping']])), 'custom')
  assert.equal(suggestedCategory(unknown, catalog([[saved.pairKey, 'salary']])), null)
  assert.equal(suggestedCategory(row('奶茶'), catalog([], ['food__drink'])), 'food')
  assert.equal(suggestedCategory(row('奶茶'), catalog([], ['food__drink', 'food'])), null)
})

test('新的具体记忆可保留用户细类/自定义选择，不扩散到同平台、别的商品或来源', () => {
  const input = row('奶茶'), memory = categoryMemory('wechat', input)
  const indexes = catalog([[memory.pairKey, 'custom']])
  assert.equal(suggestedCategory(input, indexes), 'custom')
  assert.equal(suggestedCategory({ ...input, item: '午餐' }, indexes), 'food__meal')
  assert.equal(suggestedCategory({ ...input, sourceType: 'alipay' }, indexes), 'food__drink')
  assert.deepEqual(categoryMemory('wechat', row('商品', '美团')).aliasKeys, [])
  assert.deepEqual(categoryMemory('wechat', row('咖啡', '美团')).aliasKeys, [])
  assert.deepEqual(categoryMemory('wechat', row('', '合成商户')).aliasKeys, [memory.merchantKey])
  const apiMemory = require('../cloudfunctions/catledger-api/src/category-memory').categoryMemory
  assert.deepEqual(apiMemory('wechat', input), memory)
  assert.ok(!JSON.stringify(buildCategoryEvidence('wechat', input)).includes('合成商户'))
})

test('旧草稿只更新未人工决定的自动分类，已入账、排除和资金字段保持原状', () => {
  const event = { status: 'ready', economicNature: 'expense', categoryId: 'food', manualFieldMask: 0,
    ledgerAccountId: 'account', amountMinor: '100', localAt: '2026-10-01 12:00:00.000', version: 4,
    fieldSources: {}, reasonCodes: [] }
  const rows = [{ ...row('奶茶'), suggestedCategoryId: 'food__drink' }]
  const updated = refreshAutomaticCategory(event, rows)
  assert.equal(updated.categoryId, 'food__drink')
  for (const key of ['ledgerAccountId', 'amountMinor', 'localAt', 'version', 'manualFieldMask']) assert.equal(updated[key], event[key])
  for (const mask of [FIELD_MASK.categoryId, FIELD_MASK.economicNature, FIELD_MASK.flowDirection, FIELD_MASK.paymentResolution]) {
    const manual = { ...event, manualFieldMask: mask }
    assert.equal(refreshAutomaticCategory(manual, rows), manual)
  }
  for (const status of ['posted', 'excluded', 'corrected']) {
    const saved = { ...event, status }
    assert.equal(refreshAutomaticCategory(saved, rows), saved)
  }
  const unclassified = refreshAutomaticCategory(event, [{ ...rows[0], suggestedCategoryId: null }])
  assert.equal(unclassified.categoryId, null)
})
