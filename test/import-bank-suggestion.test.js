const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/import-workbench/model')

function repayment(label = '平安银行信用卡') {
  return { economicNature: 'repayment', ledgerAccountId: 'wallet',
    fundsProjection: { to: { label, referenceKind: 'atomic' } } }
}
const accounts = [
  { accountId: 'credit1', name: '平安银行信用卡(1234)', type: 'credit' },
  { accountId: 'debit', name: '平安银行储蓄卡(1234)', type: 'bank' },
  { accountId: 'other', name: '兴业银行信用卡(1234)', type: 'credit' }
]

test('缺少尾号仅推荐同银行同类型，唯一候选也只是建议', () => {
  const result = model.bankAccountSuggestion([repayment()], accounts)
  assert.deepEqual(result.candidates.map(x => x.accountId), ['credit1'])
  assert.match(result.reason, /未提供尾号，请核对/)
  assert.equal(result.side, 'to')
  assert.equal(repayment().counterpartyLedgerAccountId, undefined)
})

test('多张同银行信用卡全部作为候选；无候选不跨银行降级', () => {
  assert.equal(model.bankAccountSuggestion([repayment()], accounts.concat({ accountId: 'credit2', name: '平安银行信用卡(5678)', type: 'credit' })).candidates.length, 2)
  assert.equal(model.bankAccountSuggestion([repayment('招商银行信用卡')], accounts).candidates.length, 0)
})

test('已有尾号、聚合账户、不明类型、双端未知与混合银行均不走无尾号推荐', () => {
  assert.equal(model.bankAccountSuggestion([repayment('平安银行信用卡(9999)')], accounts), null)
  const aggregate = repayment(); aggregate.fundsProjection.to.referenceKind = 'aggregate'
  assert.equal(model.bankAccountSuggestion([aggregate], accounts), null)
  const unknown = repayment('平安银行'); unknown.economicNature = 'internal_transfer'
  assert.equal(model.bankAccountSuggestion([unknown], accounts), null)
  const both = repayment(); delete both.ledgerAccountId
  assert.equal(model.bankAccountSuggestion([both], accounts), null)
  assert.equal(model.bankAccountSuggestion([repayment(), repayment('兴业银行信用卡')], accounts), null)
})

test('已知端点及归档账户排除，银行全名别名可匹配且不做模糊包含', () => {
  const source = repayment(); source.ledgerAccountId = 'credit1'
  assert.equal(model.bankAccountSuggestion([source], accounts).candidates.length, 0)
  assert.equal(model.bankAccountSuggestion([repayment()], accounts.map(x => ({ ...x, archived: true }))).candidates.length, 0)
  const result = model.bankAccountSuggestion([repayment('中国光大银行信用卡')], [
    { accountId: 'a', name: '光大银行信用卡(1234)', type: 'credit' },
    { accountId: 'b', name: '光大银行储蓄卡(1234)', type: 'bank' }
  ])
  assert.deepEqual(result.candidates.map(x => x.accountId), ['a'])
})

test('占位标题回退对方，原始商品仍保留；仅日期字段转换 Excel 序号', () => {
  const event = { economicNature: 'repayment', primaryEvidence: { item: '/', counterparty: '平安银行信用卡还款' } }
  assert.equal(model.eventView(event).displayTitle, '平安银行信用卡还款')
  assert.equal(event.primaryEvidence.item, '/')
  assert.deepEqual(model.evidenceFields({ '交易时间': 46240.58918981482, '交易单号': '46240.58918981482', '商品': '/' }), [
    { key: '交易时间', value: '2026-08-06 14:08:26' },
    { key: '交易单号', value: '46240.58918981482' },
    { key: '商品', value: '/' }
  ])
  assert.equal(model.evidenceFields([{ name: '交易时间', value: '46240.58918981482' }])[0].value, '2026-08-06 14:08:26')
  assert.equal(model.evidenceFields({ '交易时间': '2026-08-06 14:08:26' })[0].value, '2026-08-06 14:08:26')
})
