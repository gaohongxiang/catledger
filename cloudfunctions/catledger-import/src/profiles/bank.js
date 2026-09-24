const { action, clean, relationHints, settlement } = require('./shared')
const { SOURCE_ACTION } = require('../semantic-types')
const { installmentEvidence } = require('./bank-installment')

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
    sourceType: 'bank', container, profileVersion: 'bank-profile-v2', adapterVersion: 'bank-adapter-v3',
    policyVersion: 'bank-policy-v2', parserName: 'bank-table-evidence', parserVersion: 'bank-parser-v3',
    normalizationVersion: 'bank-normalization-v3', resolveAction, resolveSettlement,
    relationHints: (row, settled) => ({ ...relationHints(row, settled), installment: row.direction === 'expense' ? installmentEvidence(row) : null }) })
}

module.exports = { bankProfile }
