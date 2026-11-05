const test = require('node:test')
const assert = require('node:assert/strict')
const { facts } = require('./helpers/local-review')
const local = require('../miniprogram/packages/finance/services/import-local-model')
const read = require('../miniprogram/packages/finance/services/import-local-read')
const presentation = require('../miniprogram/packages/finance/pages/import-workbench/presentation')
const { categoryGoodsText, categoryLikenessKey } = require('../cloudfunctions/catledger-import/src/category-likeness')

function wechat(lines) {
  return Buffer.from(['微信支付账单明细,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    ...lines].join('\n'))
}
function line(time, counterparty, item, direction, amount, method, id) {
  return `${time},商户消费,${counterparty},${item},${direction},${amount},${method},支付成功,${id},,,`
}

test('同一商品去掉发生日期后归为一类，金额和账户不拆开', () => {
  const income = { economicNature: 'income', counterparty: '天弘基金管理有限公司', primaryEvidence: { sourceType: 'alipay', counterparty: '天弘基金管理有限公司', item: '余额宝-2026.08.25-收益发放' } }
  const nextDay = { ...income, primaryEvidence: { ...income.primaryEvidence, item: '余额宝-2026.08.26-收益发放' } }
  const otherCard = { ...nextDay }
  assert.equal(categoryLikenessKey(income), categoryLikenessKey(nextDay))
  assert.equal(categoryLikenessKey(income), categoryLikenessKey(otherCard))
  assert.notEqual(categoryLikenessKey(income), categoryLikenessKey({ ...income, economicNature: 'expense' }))
  assert.notEqual(categoryLikenessKey(income), categoryLikenessKey({ ...income, primaryEvidence: { ...income.primaryEvidence, sourceType: 'wechat' } }))
  assert.notEqual(categoryLikenessKey(income), categoryLikenessKey({ ...income, counterparty: '另一家基金', primaryEvidence: { ...income.primaryEvidence, counterparty: '另一家基金' } }))
  assert.equal(categoryGoodsText('会议11:48记录'), categoryGoodsText('会议11:49记录'))
  assert.equal(categoryLikenessKey({ economicNature: 'expense', primaryEvidence: { item: '2026-08-01', counterparty: '', sourceType: 'wechat' } }), '')
})

test('待分类把同一商品收成一张卡，一次选择写到每一笔', async () => {
  const content = wechat([
    line('2026-08-26 08:00:00', '天弘基金管理有限公司', '余额宝-2026.08.25-收益发放', '收入', '0.01', '微信零钱', 'Y-1'),
    line('2026-08-27 08:00:00', '天弘基金管理有限公司', '余额宝-2026.08.26-收益发放', '收入', '0.01', '微信零钱', 'Y-2'),
    line('2026-08-28 08:00:00', '天弘基金管理有限公司', '余额宝-2026.08.27-收益发放', '收入', '0.02', '微信零钱', 'Y-3'),
    line('2026-08-30 08:00:00', '天弘基金管理有限公司', '余额宝-2026.08.29-收益发放', '收入', '0.01', '招商银行储蓄卡(1234)', 'Y-5'),
    line('2026-08-29 08:00:00', '另一家基金', '余额宝-2026.08.28-收益发放', '收入', '0.01', '零钱', 'Y-4'),
    line('2026-08-12 12:00:00', '合成餐馆', '午餐', '支出', '20.00', '零钱', 'E-1'),
    line('2026-08-12 18:00:00', '合成餐馆', '晚餐', '支出', '30.00', '零钱', 'E-2'),
    line('2026-08-01 09:00:00', '只有日期', '2026-08-01', '支出', '1.00', '零钱', 'D-1'),
    line('2026-08-02 09:00:00', '只有日期', '2026年8月2日', '支出', '1.00', '零钱', 'D-2'),
    line('2026-08-03 09:00:00', '', '2026-08-03', '支出', '1.00', '零钱', 'D-3'),
    line('2026-08-04 09:00:00', '', '11:48', '支出', '1.00', '零钱', 'D-4'),
    line('2026-08-05 09:00:00', '合成商户', '订单4200002026082512345678', '支出', '1.00', '零钱', 'O-1'),
    line('2026-08-06 09:00:00', '合成商户', '订单4200002026082612345678', '支出', '1.00', '零钱', 'O-2'),
    line('2026-08-07 09:00:00', '合成商户', '会议11:48记录', '支出', '1.00', '零钱', 'M-1'),
    line('2026-08-08 09:00:00', '合成商户', '会议11:49记录', '支出', '1.00', '零钱', 'M-2')
  ])
  const value = await facts({ content, mapped: true })
  const model = local.create(value)
  const reader = read.create(model)
  const page = reader.read('economicEvents.list', { view: 'category_pending', pageSize: 50 })
  const primary = eventId => {
    const link = [...model.evidence.values()].find(row => row.eventId === eventId && row.evidenceRole === 'primary')
    return model.rows.get(link.rowId)
  }
  const yields = [...model.events.values()].filter(event => primary(event.eventId).counterparty === '天弘基金管理有限公司')
  assert.equal(yields.length, 4)
  const booked = yields.filter(event => event.ledgerAccountId)
  assert.equal(booked.length, 3)
  const yieldIssues = [...model.issues.values()].filter(issue => issue.issueType === 'category_assignment' &&
    booked.every(event => issue.subjectEventIds.includes(event.eventId)))
  assert.equal(yieldIssues.length, 1)
  const card = page.items.find(item => item.categoryPeerCount === 4)
  assert.ok(card)
  assert.equal(card.categorySameAmount, false)
  assert.equal(card.primaryEvidence.item.includes('收益发放'), true)
  assert.equal(page.eventTotal, page.items.reduce((sum, item) => sum + (item.categoryPeerCount || 1), 0))
  const shown = presentation.pendingCard(card, true)
  assert.equal(shown.subjects[0].displayTitle, '余额宝-收益发放')
  assert.equal(shown.subjects[0].displayDate, '')
  assert.equal(shown.subjects[0].amountText, '')
  assert.equal(shown.categoryPeerCount, 4)
  assert.equal(shown.hiddenSubjectCount, 0)
  const peers = model.categoryPeerRows(card.eventId)
  assert.equal(peers.length, 4)
  assert.deepEqual(peers.map(row => row.primaryEvidence.item).sort(), [
    '余额宝-2026.08.25-收益发放', '余额宝-2026.08.26-收益发放', '余额宝-2026.08.27-收益发放', '余额宝-2026.08.29-收益发放'
  ].sort())
  const titles = page.items.map(item => primary(item.eventId).item)
  assert.equal(titles.filter(item => item === '午餐' || item === '晚餐').length, 2)
  assert.equal(page.items.filter(item => primary(item.eventId).counterparty === '只有日期').length, 1)
  assert.equal(page.items.filter(item => !primary(item.eventId).counterparty && !primary(item.eventId).item.replace(/\d|[-:年月日.]/g, '')).length, 2)
  assert.equal(page.items.filter(item => String(primary(item.eventId).item).startsWith('订单')).length, 2)
  assert.equal(page.items.filter(item => String(primary(item.eventId).item).startsWith('会议')).length, 1)
  const searched = reader.read('economicEvents.list', { view: 'category_pending', query: '2026.08.26', pageSize: 50 })
  assert.equal(searched.items.length, 1)
  assert.equal(searched.items[0].categoryPeerCount, 4)
  assert.equal(searched.eventTotal, 1)
  const categoryId = value.categories.find(category => category.kind === 'income').categoryId
  model.edit({ eventId: card.eventId, eventVersion: card.version, editorVersion: 1, fields: { categoryId }, sameCategory: true })
  for (const event of yields) assert.equal(model.events.get(event.eventId).categoryId, categoryId)
  const lunch = [...model.events.values()].find(event => primary(event.eventId).item === '午餐')
  assert.equal(lunch.categoryId, null)
  const again = reader.read('economicEvents.list', { view: 'category_pending', pageSize: 50 })
  assert.equal(again.items.some(item => primary(item.eventId).counterparty === '天弘基金管理有限公司'), false)
})
