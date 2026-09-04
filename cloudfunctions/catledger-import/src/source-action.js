const SOURCE_ACTION_VERSION = 'source-action-v1'

function clean(value) {
  return String(value || '').normalize('NFKC').trim()
}

function containsAny(value, candidates) {
  return candidates.some((candidate) => value.includes(candidate))
}

function startsAction(value, action) {
  return new RegExp(`^${action}(?:[-—–\\s]|$)`, 'u').test(clean(value))
}

function result(kind, normalizedTransactionType, rule) {
  return { kind, normalizedTransactionType, rule, ruleVersion: SOURCE_ACTION_VERSION }
}

function alipayOfficialAction(transactionType, item, action) {
  return startsAction(transactionType, action) ||
    (clean(transactionType) === '账户存取' && startsAction(item, action))
}

function alipaySavingsAction(transactionType, item, actions) {
  const type = clean(transactionType)
  const description = clean(item)
  const itemMayDescribeAccountAction = ['账户存取', '不计收支', '理财', '投资理财', 'transfer'].includes(type)
  const candidates = itemMayDescribeAccountAction ? [type, description] : [type]
  return candidates.some((candidate) => {
    if (!/^余额宝(?:[-—–\\s]|$)/u.test(candidate)) return false
    return actions.some((action) => candidate.includes(action))
  })
}

function classifyAlipayAction(row) {
  const transactionType = clean(row.rawTransactionType || row.transactionType)
  const item = clean(row.item)
  const direction = clean(row.direction)
  const text = `${transactionType} ${item}`

  if (containsAny(transactionType, ['手续费', '服务费'])) {
    return result('fee', 'fee', 'alipay_type_fee')
  }
  const itemMayDescribeYield = ['账户存取', '不计收支', '理财', '投资理财', 'transfer'].includes(transactionType)
  if ((direction === 'income' || (itemMayDescribeYield && /^余额宝(?:[-—–\\s]|$)/u.test(item))) &&
      containsAny(text, ['收益发放', '收益结转', '利息发放'])) {
    return result('yield_income', 'payment', 'alipay_yield_income')
  }
  if (transactionType.includes('退款')) {
    return result('refund', 'payment', 'alipay_refund')
  }
  if (alipaySavingsAction(transactionType, item, ['转出', '提现'])) {
    return result('savings_out', 'transfer', 'alipay_savings_out')
  }
  if (alipaySavingsAction(transactionType, item, ['转入', '买入'])) {
    return result('savings_in', 'transfer', 'alipay_savings_in')
  }
  if (alipayOfficialAction(transactionType, item, '提现')) {
    return result('withdrawal', 'withdrawal', 'alipay_official_withdrawal')
  }
  if (alipayOfficialAction(transactionType, item, '充值')) {
    return result('top_up', 'top_up', 'alipay_official_top_up')
  }
  if ((transactionType === '信用借还' && /还款/u.test(item)) ||
      ['自动还款', '还款', '花呗还款', '信用购还款', '借呗还款'].some((action) => startsAction(transactionType, action))) {
    return result('repayment', 'transfer', 'alipay_repayment')
  }
  if ((transactionType === '信用借还' && /借款|借入/u.test(item)) ||
      ['借款', '借入'].some((action) => startsAction(transactionType, action))) {
    return result('borrow', 'transfer', 'alipay_borrow')
  }
  if (containsAny(transactionType, ['理财', '投资', '资金调拨', '买入', '卖出'])) {
    return result('internal_transfer', 'transfer', 'alipay_financial_transfer')
  }
  if (transactionType.includes('转账')) {
    return result('external_transfer', direction === 'income' || direction === 'expense' ? 'payment' : 'transfer', 'alipay_external_transfer')
  }
  if (containsAny(transactionType, ['消费', '购物', '餐饮', '出行', '缴费', '付款', '收款', '退款', '收入', '支出', '红包', '交易', '医疗', '教育', '娱乐']) ||
      direction === 'income' || direction === 'expense') {
    return result('payment', 'payment', 'alipay_payment')
  }
  return result('unknown', 'unknown', 'alipay_unknown')
}

function classifyWechatAction(row) {
  const transactionType = clean(row.rawTransactionType || row.transactionType)

  if (containsAny(transactionType, ['手续费', '服务费'])) {
    return result('fee', 'fee', 'wechat_type_fee')
  }
  if (['零钱充值', '余额充值'].some((action) => startsAction(transactionType, action))) {
    return result('top_up', 'top_up', 'wechat_balance_top_up')
  }
  if (['零钱提现', '余额提现'].some((action) => startsAction(transactionType, action))) {
    return result('withdrawal', 'withdrawal', 'wechat_balance_withdrawal')
  }
  if (startsAction(transactionType, '信用卡还款')) {
    return result('repayment', 'transfer', 'wechat_credit_card_repayment')
  }
  if (transactionType.includes('退款')) {
    return result('refund', 'payment', 'wechat_refund')
  }
  if (containsAny(transactionType, ['转账', '红包', '群收款'])) {
    return result('external_transfer', 'transfer', 'wechat_external_transfer')
  }
  if (containsAny(transactionType, ['消费', '付款', '收款', '支付', '退款'])) {
    return result('payment', 'payment', 'wechat_payment')
  }
  if (containsAny(transactionType, ['零钱通', '理财通'])) {
    return result('internal_transfer', 'other', 'wechat_financial_transfer')
  }
  return result('unknown', 'unknown', 'wechat_unknown')
}

function classifySourceAction(row) {
  if (row.sourceType === 'alipay') return classifyAlipayAction(row)
  if (row.sourceType === 'wechat') return classifyWechatAction(row)
  return result('unknown', clean(row.transactionType) || 'unknown', 'unsupported_source')
}

module.exports = {
  SOURCE_ACTION_VERSION,
  classifyAlipayAction,
  classifySourceAction,
  classifyWechatAction
}
