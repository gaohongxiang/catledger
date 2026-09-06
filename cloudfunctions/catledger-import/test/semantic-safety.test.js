const assert = require('node:assert/strict')
const test = require('node:test')
const { parseEvidenceFile } = require('../src/parsers')
const { resolveRowSemantic } = require('../src/row-semantic-resolver')
const { buildOrganizePlan } = require('../src/organizer-planner')
const { evaluatePostability } = require('../src/organizer-model')
const { buildCoverageReport } = require('../src/coverage-report')

const HEADER = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号'
const parse = (lines) => parseEvidenceFile({
  content: Buffer.from(lines.join('\n')), extension: 'csv', timezoneOffsetMinutes: -480
})
function semanticRow(overrides = {}) {
  return {
    sourceType: 'alipay', sourceFormat: 'alipay_app_csv', rawTransactionType: '餐饮美食',
    direction: 'expense', rawStatus: '交易成功', paymentMethod: '账户余额', amountMinor: '1000',
    ...overrides
  }
}

test('交易文本中的控制词不能使有效或损坏的交易静默丢失', async () => {
  const doc = await parse(['微信支付账单明细', HEADER,
    '2026-09-01 12:00:00,商户消费,测试商户,商品合计两件,支出,1.00,零钱,支付成功,SYNTHETIC001',
    '2026-09-01 13:00:00,商户消费,测试商户,支付宝账号服务,支出,2.00,零钱,支付成功,SYNTHETIC002',
    '损坏日期,商户消费,测试商户,共3笔,支出,3.00,零钱,支付成功,SYNTHETIC003'
  ])
  assert.equal(doc.rows.length, 3)
  assert.equal(doc.rows[2].parseState, 'invalid')
  assert.equal(doc.records.controlFields.length, 0)
})

test('可选列缺失与明确空值不同，未知额外单元格保留', async () => {
  const doc = await parse(['微信支付账单明细', HEADER,
    '2026-09-01 12:00:00,商户消费,测试商户,,支出,1.00,零钱,支付成功,SYNTHETIC001,额外值'
  ])
  assert.equal(doc.rows[0].observations.note.state, 'column_missing')
  assert.equal(doc.rows[0].observations.item.state, 'explicit_blank')
  assert.equal(doc.rows[0].rawFields.at(-1).value, '额外值')
  assert.ok(doc.rows[0].issues.some((issue) => issue.code === 'row_extra_columns'))
})

test('控制笔数不相等必须有文件级诊断，前置控制记录也须读取', async () => {
  const doc = await parse(['微信支付账单明细', '共3笔记录', HEADER,
    '2026-09-01 12:00:00,商户消费,测试商户,商品,支出,1.00,零钱,支付成功,SYNTHETIC001'
  ])
  assert.equal(doc.records.controlFields.length, 1)
  assert.ok(doc.issues.some((issue) => issue.code === 'statement_count_mismatch'))
})

test('支付宝 Web 未登记动作和已知动作的未知后缀均不得退化为普通收支', () => {
  for (const type of ['全新未知资金动作', '未知退款业务', '转账-尚未认证子类型']) {
    const semantic = resolveRowSemantic(semanticRow({ sourceFormat: 'alipay_web_csv', rawTransactionType: type }))
    assert.notEqual(semantic.resolutionStatus, 'resolved', type)
  }
})

test('动作和到账状态不匹配时不能输出确定资金语义', () => {
  const semantic = resolveRowSemantic(semanticRow({
    sourceType: 'wechat', sourceFormat: 'wechat_csv', rawTransactionType: '商户消费',
    rawStatus: '已存入零钱', paymentMethod: '零钱'
  }))
  assert.notEqual(semantic.resolutionStatus, 'resolved')
})

test('生产 Resolver 对同一行的不同动作证据报告冲突', () => {
  const semantic = resolveRowSemantic(semanticRow({ rawTransactionType: '信用借还', item: '借款并还款' }))
  assert.equal(semantic.resolutionStatus, 'conflict')
  assert.ok(semantic.ruleIds.includes('alipay.action.borrow.v1'))
  assert.ok(semantic.ruleIds.includes('alipay.action.repayment.v1'))
})

test('多资金账户歧义不能通过绑定单账户和填写分类解除', () => {
  const row = {
    ...semanticRow({ paymentMethod: '余额宝&招商银行储蓄卡(1234)' }),
    rowId: 'row-1', batchId: 'batch-1', sourceOrder: 0, rowNumber: 1, parseState: 'valid',
    identityId: 'identity-1', identityState: 'new', transactionType: 'payment', economicEffect: 'normal',
    localAt: '2026-09-01 12:00:00.000', utcAt: '2026-09-01 04:00:00.000',
    localDate: '2026-09-01', currency: 'CNY', timezoneOffsetMinutes: -480
  }
  const plan = buildOrganizePlan({ updateId: 'update-1', rows: [row] })
  const evaluated = evaluatePostability({ ...plan.events[0], reasonCodes: [], ledgerAccountId: 'account-1', categoryId: 'category-1' })
  assert.equal(evaluated.status, 'needs_action')
  assert.ok(evaluated.reasonCodes.includes('payment_components_ambiguous'))
})

test('覆盖报告缺少逐行归宿时不能用总行数补成全部识别', () => {
  const report = buildCoverageReport({
    sources: [{ summary: { total: 3, invalid: 0 } }],
    events: [{ eventId: 'event-1', status: 'ready', reasonCodes: [], evidenceCount: 1 }]
  })
  assert.equal(report.statementFullyRecognized, false)
})

test('多个完整模板同时出现时拒绝选择置信分最高者', async () => {
  const { DESCRIPTORS, choosePlatform } = require('../src/parsers/platform')
  const records = [DESCRIPTORS.wechat, DESCRIPTORS.alipay_app].map((profile) => ({
    values: Object.values(profile.fieldAliases).map((aliases) => aliases[0])
  }))
  assert.equal(choosePlatform(records), null)
})

test('支付宝退款、还款及提现专属状态不能搭配普通消费', () => {
  for (const rawStatus of ['退款成功', '退款完成', '还款成功', '提现已到账']) {
    assert.notEqual(resolveRowSemantic(semanticRow({ rawStatus })).resolutionStatus, 'resolved', rawStatus)
  }
})


test('表头之前的交易结构仍保留为来源行', async () => {
  const doc = await parse(['微信支付账单明细',
    '2026-09-01 12:00:00,商户消费,测试商户,商品,支出,1.00,零钱,支付成功,SYNTHETIC001', HEADER,
    '2026-09-01 13:00:00,商户消费,测试商户,商品,支出,2.00,零钱,支付成功,SYNTHETIC002'])
  assert.equal(doc.rows.length, 2)
  assert.ok(doc.rows.every((row) => row.parseState === 'valid'))
})


test('分类字段按明确收支解释，同类信用免押服务不依赖商户或金额白名单', () => {
  for (const item of ['充电宝使用费', '雨伞租借服务', '免押相机使用费', '普通服务']) {
    const row = semanticRow({ rawTransactionType: '信用借还', item, amountMinor: '600' })
    const semantic = resolveRowSemantic(row)
    assert.equal(semantic.sourceAction, 'purchase')
    assert.equal(semantic.moneyEffect, 'financial')
    assert.equal(semantic.transactionTypeRole, 'category')
    assert.ok(semantic.ruleIds.includes('alipay.category.explicit-expense.v1'))
  }
  for (const [direction, expected] of [['expense', 'purchase'], ['income', 'receipt']]) {
    assert.equal(resolveRowSemantic(semanticRow({ rawTransactionType: '新增服务分类', direction })).sourceAction, expected)
  }
  for (const type of ['账户存取', '不计收支', '理财', '投资理财', '']) {
    assert.equal(resolveRowSemantic(semanticRow({ rawTransactionType: type })).sourceAction, null)
  }
})

test('信用免押生命周期、失败和到账状态不能被普通收支回退覆盖', () => {
  for (const status of ['芝麻免押下单成功', '解冻成功']) {
    const zero = resolveRowSemantic(semanticRow({ rawTransactionType: '信用借还', rawStatus: status, direction: 'neutral', amountMinor: '0' }))
    assert.equal(zero.moneyEffect, 'non_financial')
    assert.equal(zero.sourceAction, null)
    assert.equal(resolveRowSemantic(semanticRow({ rawTransactionType: '信用借还', rawStatus: status })).moneyEffect, 'unknown')
  }
  for (const [rawStatus, moneyEffect] of [['交易失败', 'failed'], ['交易关闭', 'closed'], ['未登记状态', 'unknown']]) {
    assert.equal(resolveRowSemantic(semanticRow({ rawTransactionType: '信用借还', rawStatus })).moneyEffect, moneyEffect)
  }
  assert.equal(resolveRowSemantic(semanticRow({ rawTransactionType: '信用借还', amountMinor: '0' })).moneyEffect, 'unknown')
})

test('显式债务动作优先于分类收支，组合付款和账户引用共用服务端结果', () => {
  const { referencesForRows } = require('../src/payment-account-groups')
  const { paymentResolutionDefaults } = require('../../../miniprogram/pages/import-workbench/model')
  const row = semanticRow({ rawTransactionType: '信用借还', counterparty: '1688先采后付', item: '先采后付账单付款', paymentMethod: '账户余额&测试银行储蓄卡(1234)' })
  const semantic = resolveRowSemantic(row)
  assert.equal(semantic.sourceAction, 'repayment')
  assert.ok(semantic.issues.some(issue => issue.code === 'payment_components_ambiguous'))
  assert.equal(referencesForRows([row]).find(ref => ref.memberRole === 'payment_target').paymentMethodKey, semantic.toAccountRef.paymentMethodKey)
  assert.equal(paymentResolutionDefaults({ economicNature: 'repayment', primaryEvidence: {} }, []).natureIndex, 2)
  assert.equal(paymentResolutionDefaults({ economicNature: 'expense', primaryEvidence: { item: '信用卡还款教程' } }, []).natureIndex, 1)
  assert.equal(paymentResolutionDefaults({ economicNature: 'unknown', primaryEvidence: { item: '先采后付账单付款' } }, []).natureIndex, 0)
  for (const [item, expected] of [['本期还款', 'repayment'], ['借款到账', 'borrow']]) {
    assert.equal(resolveRowSemantic(semanticRow({ rawTransactionType: '信用借还', item })).sourceAction, expected)
  }
  assert.equal(resolveRowSemantic({ ...row, counterparty: '账户余额' }).sourceAction, 'purchase')
})
