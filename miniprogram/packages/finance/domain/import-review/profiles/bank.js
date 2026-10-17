const { action, clean, relationHints, settlement } = require('./shared')
const { SOURCE_ACTION } = require('../semantic-types')
const { installmentEvidence } = require('./bank-installment')

const REPAYMENT_LABELS = new Set([
  '还款', '信用卡还款', '贷记卡还款', '贷款还款', '自动还款', '信用卡自动还款',
  '本行还款', '跨行还款', '网上还款', '自助还款', '支付宝还款', '财付通还款', '微信还款', '微信支付还款'
])
const REPAYMENT_SUMMARY_TYPES = new Set(['', 'unknown', 'transfer', '其他', '其它', '转账', '转入', '转出'])

function repaymentRule(row, type) {
  // 摘要只能完整命中银行业务标签；商品、对方名称和自由备注中的“还款”不是动作证据。
  const summary = clean(row.item)
  const rule = REPAYMENT_LABELS.has(type) ? 'repayment-type'
    : REPAYMENT_SUMMARY_TYPES.has(type) && REPAYMENT_LABELS.has(summary) ? 'repayment-summary' : null
  if (!rule) return null
  // 退回和冲正不是新还款；有矛盾证据时保留人工核对，不用明确标签覆盖它。
  const evidence = [type, summary, clean(row.note || row.sourceNote)]
  if (evidence.some(value => /退款|退回|退还|返还|退汇|冲正|撤销|取消/u.test(value))) return null
  return rule
}

function resolveAction(row) {
  const type = clean(row.rawTransactionType || row.transactionType)
  const direction = row.direction
  const result = (source, kind, normalized, rule) => action(source, kind, normalized, `bank.action.${rule}.v1`)
  const installment = installmentEvidence(row)
  if (installment && direction === 'expense') return installment.component === 'principal'
    ? result(SOURCE_ACTION.INSTALLMENT_PRINCIPAL, 'installment_principal', 'repayment', 'installment-principal')
    : result(SOURCE_ACTION.FEE, 'fee', 'fee', 'installment-cost')
  if (/^(消费|刷卡消费|快捷支付|POS消费|购买)$/iu.test(type) && direction === 'expense') {
    return result(SOURCE_ACTION.PURCHASE, 'payment', 'payment', 'purchase')
  }
  if (/^(工资|代发工资|薪资|工资收入)$/u.test(type) && direction === 'income') {
    return result(SOURCE_ACTION.RECEIPT, 'payment', 'payment', 'salary')
  }
  if (/^(利息收入|结息|存款利息)$/u.test(type) && direction === 'income') {
    return result(SOURCE_ACTION.YIELD, 'payment', 'payment', 'yield')
  }
  if (/^(手续费|服务费|年费)$/u.test(type) && direction === 'expense') {
    return result(SOURCE_ACTION.FEE, 'fee', 'fee', 'fee')
  }
  if (/^(退款|退货|消费退款)$/u.test(type) && direction === 'income') {
    return result(SOURCE_ACTION.REFUND_CREDIT, 'refund', 'payment', 'refund')
  }
  const repayment = repaymentRule(row, type)
  if (repayment) return result(SOURCE_ACTION.REPAYMENT, 'repayment', 'transfer', repayment)
  // A bank inflow may be a transfer, loan or refund. A direction alone never
  // establishes income/expense; the existing organizer asks for its nature.
  return result(null, 'unknown', 'unknown', 'review')
}

function resolveSettlement(row) {
  const status = clean(row.rawStatus || row.status)
  if (/^(失败|交易失败|支付失败|未支付)$/u.test(status)) return settlement('failed', 'failed', 'bank.settlement.failed.v1')
  if (/^(已撤销|已取消|已关闭|交易关闭|冲正)$/u.test(status)) return settlement('closed', 'closed', 'bank.settlement.closed.v1')
  if (!status || /^(成功|交易成功|已入账|已记账|已完成|完成|正常|入账|已结算|posted|completed|success)$/iu.test(status)) {
    return settlement('financial', 'settled', 'bank.settlement.posted.v1')
  }
  return settlement('unknown', 'unknown', 'bank.settlement.review.v1')
}

function bankProfile(container) {
  return Object.freeze({ profileId: `bank_${container}`, sourceFormat: `bank_${container}`,
    sourceType: 'bank', container, profileVersion: 'bank-profile-v4', adapterVersion: 'bank-adapter-v3',
    policyVersion: 'bank-policy-v4', parserName: 'bank-table-evidence', parserVersion: 'bank-parser-v3',
    normalizationVersion: 'bank-normalization-v3', resolveAction, resolveSettlement,
    relationHints: (row, settled) => ({ ...relationHints(row, settled), installment: row.direction === 'expense' ? installmentEvidence(row) : null }) })
}

module.exports = { bankProfile }
