const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeRow } = require('../src/parsers/normalize')
const { buildOrganizePlan } = require('../src/organizer-planner')
const { publicIssue } = require('../src/review-presentation')

function planRow(sourceType, values) {
  const raw = { transactionTime: '2026-08-01 12:00:00', amount: '12.34',
    direction: '不计收支', status: '交易成功', item: '/', note: '', ...values }
  const normalized = normalizeRow(sourceType, raw, -480)
  const row = { ...normalized.normalized, rowId: 'synthetic-row', batchId: 'synthetic-batch',
    importId: 'synthetic-import', identityId: 'synthetic-identity', identityState: 'new',
    sourceOrder: 0, rowNumber: 1, parseState: normalized.parseState, sourceType,
    sourceFormat: sourceType === 'alipay' ? 'alipay_app_csv' : 'wechat_csv',
    paymentMethod: raw.paymentMethod, rawStatus: raw.status, rawTransactionType: raw.transactionType,
    semantic: normalized.semantic, sourceTransactionId: 'SYNTHETIC-PRESENTATION-001',
    sourceOrderId: '', sourceMerchantOrderId: '' }
  let id = 0
  const plan = buildOrganizePlan({ updateId: 'synthetic-update', rows: [row], accounts: [],
    idFactory: () => 'synthetic-plan-' + (++id) })
  return { row, plan }
}

function accountViews({ row, plan }) {
  return plan.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => {
    const member = plan.members.find(item => item.issueId === issue.issueId && item.sortOrder === 0)
    const event = plan.events.find(item => item.eventId === member.objectId)
    return publicIssue({ ...issue, subjectEventId: event.eventId, subjectMemberRole: member.memberRole,
      subjectEventStatus: event.status, subjectEconomicNature: event.economicNature,
      subjectFlowDirection: event.flowDirection, subjectSourceDirection: event.sourceDirection,
      subjectCurrency: event.currency, subjectFieldSources: event.fieldSources,
      subjectLedgerAccountId: event.ledgerAccountId, subjectCounterpartyLedgerAccountId: event.counterpartyLedgerAccountId,
      subjectSourceType: row.sourceType, subjectPaymentMethod: row.paymentMethod,
      subjectFileName: '合成来源账单.csv', subjectItem: row.item, subjectCounterparty: row.counterparty })
  })
}

for (const value of [
  { name: '支付宝余额自动转入余额宝', sourceType: 'alipay',
    raw: { transactionType: '投资理财', item: '余额宝-自动转入', counterparty: '余额宝', paymentMethod: '账户余额' },
    expected: { from: ['支付宝账户余额', 'wallet'], to: ['支付宝余额宝', 'other_asset'] } },
  { name: '余额宝转出到支付宝余额', sourceType: 'alipay',
    raw: { transactionType: '余额宝-转出到余额', item: '余额宝-转出到余额', counterparty: '支付宝', paymentMethod: '账户余额' },
    expected: { from: ['支付宝余额宝', 'other_asset'], to: ['支付宝账户余额', 'wallet'] } },
  { name: '微信零钱提现到银行卡', sourceType: 'wechat',
    raw: { transactionType: '零钱提现', counterparty: '合成银行储蓄卡(5564)', paymentMethod: '合成银行储蓄卡(5564)',
      direction: '/', status: '提现已到账' },
    expected: { from: ['微信零钱', 'wallet'], to: ['合成银行储蓄卡(5564)', 'bank'] } }
]) test(value.name + '的两个账户来源在首次规划就完整展示', () => {
  const built = planRow(value.sourceType, value.raw), views = accountViews(built)
  assert.equal(built.plan.events.length, 1)
  assert.equal(built.plan.events[0].economicNature, 'internal_transfer')
  assert.equal(views.length, 2)
  const bySide = new Map(views.map(issue => [issue.accountContext?.fundsSide, issue]))
  assert.deepEqual([...bySide.keys()].sort(), ['from', 'to'])
  for (const [side, [label, type]] of Object.entries(value.expected)) {
    const issue = bySide.get(side), context = issue.accountContext
    assert.equal(context.label, label)
    assert.equal(context.sourceType, value.sourceType)
    assert.equal(context.fundsRole, side === 'from' ? 'source' : 'destination')
    assert.equal(context.defaultAccountType, type)
    assert.deepEqual(context.allowedAccountTypes, [type])
    assert.equal(context.accountId, null)
    assert.equal(context.recognized, true)
    assert.ok(context.paymentMethodKey)
    assert.equal(issue.subject.economicNature, 'internal_transfer')
    assert.equal(issue.subject.primaryEvidence.fileName, '合成来源账单.csv')
  }
})

test('普通付款来源保持实际钱包，商户名称不进入账户标题', () => {
  const built = planRow('wechat', { transactionType: '商户消费', direction: '支出', status: '支付成功',
    counterparty: '合成商家', item: '合成商品', paymentMethod: '零钱' })
  const views = accountViews(built)
  assert.equal(views.length, 1)
  const context = views[0].accountContext
  assert.equal(context.label, '微信零钱')
  assert.equal(context.sourceType, 'wechat')
  assert.equal(context.fundsSide, 'ordinary')
  assert.equal(context.fundsRole, 'source')
  assert.equal(context.defaultAccountType, 'wallet')
  assert.deepEqual(context.allowedAccountTypes, ['wallet'])
  assert.equal(views[0].subject.primaryEvidence.counterparty, '合成商家')
})
