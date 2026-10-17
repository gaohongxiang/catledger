const { relationHints, action, clean, settlement, startsAction } = require('./shared')
const {
  accountReference,
  firstAccountOtherThan,
  movement,
  repaymentTargetReference,
  sameReference
} = require('../account-reference')

const { SOURCE_ACTION } = require('../semantic-types')
const { paymentAccountDetails, expectedAccountType } = require('../payment-account')
const { mergeActions } = require('../rule-evaluator')

const NON_FINANCIAL_STATES = new Set(['芝麻免押下单成功', '解冻成功'])
const SETTLED = new Set([
  '交易成功', '支付成功', '交易完成', '已完成', '收款成功', '还款成功',
  '已支付', '已到账', '提现已到账', '退款成功', '退款完成'
])
const FAILED = new Set(['支付失败', '交易失败', '还款失败', '未支付', '未收款'])
const CLOSED = new Set(['已关闭', '交易关闭', '已撤销', '已取消'])

function officialAction(transactionType, item, value) {
  return startsAction(transactionType, value) ||
    (transactionType === '账户存取' && startsAction(item, value))
}

function savingsAction(transactionType, item, actions) {
  const itemMayDescribeAction = ['账户存取', '不计收支', '理财', '投资理财', 'transfer'].includes(transactionType)
  return (itemMayDescribeAction ? [transactionType, item] : [transactionType]).some((candidate) => (
    /^余额宝(?:[-—–\s]|$)/u.test(candidate) && actions.some((value) => candidate.includes(value))
  ))
}

const APP_PAYMENT_TYPES = new Set([
  '餐饮美食', '日用百货', '购物', '即时到账交易', '其他', '交通出行', '服饰装扮',
  '充值缴费', '文化休闲', '医疗健康', '生活服务', '数码电器', '家居家装',
  '美容美发', '教育培训', '酒店旅游', '运动户外', '商业服务', '爱车养车',
  '工资福利', '经营所得', '奖金', '退款', '宠物', '保险'
])
const WEB_PAYMENT_TYPES = new Set(['购物', '即时到账交易', '担保交易', '消费', '收款'])
const TRANSFER_TYPES = new Set(['转账红包', '转账', '转账付款', '转账收款', '转账到银行卡', '转账到支付宝账户'])

function resolveAction(row, profile = {}) {
  const type = clean(row.rawTransactionType || row.transactionType)
  const item = clean(row.item)
  const direction = clean(row.direction)
  const candidates = []
  const add = (matches, sourceAction, kind, normalized, ruleId) => {
    if (matches) candidates.push(action(sourceAction, kind, normalized, ruleId))
  }
  const financialType = ['账户存取', '不计收支', '理财', '投资理财', 'transfer'].includes(type)
  const yieldText = financialType ? `${type} ${item}` : type
  add((direction === 'income' || (financialType && /^余额宝(?:[-—–\s]|$)/u.test(item))) &&
    /收益发放|收益结转|利息发放/u.test(yieldText), SOURCE_ACTION.YIELD, 'yield_income', 'payment', 'alipay.action.yield.v1')
  add(['手续费', '服务费'].includes(type), SOURCE_ACTION.FEE, 'fee', 'fee', 'alipay.action.fee.v1')
  add(['退款', '交易退款', '商户退款', '转账退款'].includes(type), SOURCE_ACTION.REFUND_CREDIT, 'refund', 'payment', 'alipay.action.refund-credit.v1')
  add(savingsAction(type, item, ['转出', '提现']), SOURCE_ACTION.TRANSFER_SENT, 'savings_out', 'transfer', 'alipay.action.savings-out.v1')
  add(savingsAction(type, item, ['转入', '买入']), SOURCE_ACTION.TRANSFER_RECEIVED, 'savings_in', 'transfer', 'alipay.action.savings-in.v1')
  add(officialAction(type, item, '提现'), SOURCE_ACTION.WITHDRAWAL, 'withdrawal', 'withdrawal', 'alipay.action.withdrawal.v1')
  add(officialAction(type, item, '充值'), SOURCE_ACTION.TOP_UP, 'top_up', 'top_up', 'alipay.action.top-up.v1')
  add((type === '信用借还' && (/还款|偿还.*欠款/u.test(item) ||
      (/账单付款/u.test(item) && expectedAccountType('alipay', row.counterparty) === 'credit'))) ||
    ['自动还款', '还款', '花呗还款', '信用购还款', '借呗还款'].includes(type),
    SOURCE_ACTION.REPAYMENT, 'repayment', 'transfer', 'alipay.action.repayment.v1')
  add((type === '信用借还' && /借款|借入/u.test(item)) || ['借款', '借入'].includes(type),
    SOURCE_ACTION.BORROW, 'borrow', 'transfer', 'alipay.action.borrow.v1')
  if (TRANSFER_TYPES.has(type)) {
    add(direction === 'income', SOURCE_ACTION.TRANSFER_RECEIVED, 'external_transfer', 'payment', 'alipay.action.transfer-received.v1')
    add(direction === 'expense', SOURCE_ACTION.TRANSFER_SENT, 'external_transfer', 'payment', 'alipay.action.transfer-sent.v1')
  }
  // 分类是平台对服务用途的归类；动作字段则是封闭协议。强动作证据已在上层裁决。
  const categoryRole = profile.transactionTypeRole === 'category' ||
    (!profile.transactionTypeRole && row.sourceFormat !== 'alipay_web_csv')
  const ordinaryPayment = categoryRole ? Boolean(type) && !financialType : WEB_PAYMENT_TYPES.has(type)
  if (candidates.length === 0 && ordinaryPayment && !TRANSFER_TYPES.has(type) && type !== '退款') {
    add(direction === 'income', SOURCE_ACTION.RECEIPT, 'payment', 'payment', categoryRole ? 'alipay.category.explicit-income.v1' : 'alipay.action.receipt.v1')
    add(direction === 'expense', SOURCE_ACTION.PURCHASE, 'payment', 'payment', categoryRole ? 'alipay.category.explicit-expense.v1' : 'alipay.action.purchase.v1')
    const account = paymentAccountDetails('alipay', row.paymentMethod)
    add(row.sourceFormat === 'alipay_app_csv' && APP_PAYMENT_TYPES.has(type) && direction === 'neutral' && account.recognized &&
      account.identityMaterial.startsWith('小荷包') && ['支付成功', '交易成功'].includes(clean(row.rawStatus || row.status)) &&
      /^\d+$/u.test(String(row.amountMinor)) && BigInt(row.amountMinor) > 0n,
    SOURCE_ACTION.PURCHASE, 'payment', 'payment', 'alipay.action.pocket-purchase.v1')
  }
  return mergeActions(candidates, action(null, 'unknown', 'unknown', 'alipay.action.unknown.v1'))
}

function resolveSettlement(row, resolvedAction) {
  const type = clean(row.rawTransactionType || row.transactionType)
  const status = clean(row.rawStatus || row.status)
  const direction = clean(row.direction)
  const amountMinor = String(row.amountMinor == null ? '' : row.amountMinor)
  if (type === '信用借还' && direction === 'neutral' && amountMinor === '0' && NON_FINANCIAL_STATES.has(status)) {
    return settlement('non_financial', 'non_financial_lifecycle', 'alipay.settlement.non-financial-lifecycle.v1')
  }
  if (status === '等待确认收货' && resolvedAction.sourceAction === SOURCE_ACTION.PURCHASE &&
      direction === 'expense' && /^\d+$/u.test(amountMinor) && BigInt(amountMinor) > 0n) {
    return settlement('financial', 'pending_confirmation', 'alipay.settlement.pending-confirmation.v1')
  }
  if (FAILED.has(status)) return settlement('failed', 'failed', 'alipay.settlement.failed.v1')
  if (CLOSED.has(status)) return settlement('closed', 'closed', 'alipay.settlement.closed.v1')
  if (/^已退款(?:[（(].*[）)])?$/u.test(status) && resolvedAction.sourceAction !== SOURCE_ACTION.REFUND_CREDIT) {
    return settlement('financial', 'settled_with_refund', 'alipay.settlement.original-refunded.v1')
  }
  if ((status === '退款成功' || status === '退款完成' || /^已退款(?:[（(].*[）)])?$/u.test(status)) &&
      resolvedAction.sourceAction === SOURCE_ACTION.REFUND_CREDIT) {
    return settlement('financial', 'refund_settled', 'alipay.settlement.refund-credit.v1')
  }
  const requiredActions = {
    '还款成功': [SOURCE_ACTION.REPAYMENT],
    '提现已到账': [SOURCE_ACTION.WITHDRAWAL],
    '退款成功': [SOURCE_ACTION.REFUND_CREDIT],
    '退款完成': [SOURCE_ACTION.REFUND_CREDIT],
    '收款成功': [SOURCE_ACTION.RECEIPT, SOURCE_ACTION.TRANSFER_RECEIVED]
  }
  if (requiredActions[status] && !requiredActions[status].includes(resolvedAction.sourceAction)) {
    return settlement('unknown', 'unknown', 'alipay.settlement.action-conflict.v1')
  }
  if (SETTLED.has(status)) {
    if (amountMinor === '0') return settlement('unknown', 'unknown', 'alipay.settlement.zero-unknown.v1')
    return settlement('financial', 'settled', 'alipay.settlement.settled.v1')
  }
  return settlement('unknown', 'unknown', 'alipay.settlement.unknown.v1')
}

function resolveAccountEndpoints(row, resolvedAction, resolvedSettlement) {
  if (resolvedSettlement.moneyEffect !== 'financial') return null
  const actionType = resolvedAction.sourceAction
  const transactionType = clean(row.rawTransactionType || row.transactionType)
  const item = clean(row.item)
  const counterparty = clean(row.counterparty)
  const text = `${transactionType} ${item}`
  const balance = accountReference('alipay', '账户余额', 'platform_balance')
  const yuEBao = accountReference('alipay', '余额宝', 'platform_savings')
  const payment = accountReference('alipay', row.paymentMethod, 'payment_method')
  const counterpartyAccount = accountReference('alipay', counterparty, 'counterparty_account')
  let projection = null
  let ruleId = null

  if (resolvedAction.legacyKind === 'savings_out') {
    const destination = firstAccountOtherThan(yuEBao, payment, counterpartyAccount) ||
      (/(?:转出到|转至)(?:账户)?余额/u.test(text) ? balance : null)
    projection = movement('platform_savings_out', 'alipay', yuEBao, destination)
    ruleId = 'alipay.account.savings-out.v1'
  } else if (resolvedAction.legacyKind === 'savings_in') {
    const source = firstAccountOtherThan(yuEBao, payment, counterpartyAccount) ||
      (/(?:账户)?余额.*转入.*余额宝/u.test(text) ? balance : null)
    projection = movement('platform_savings_in', 'alipay', source, yuEBao)
    ruleId = 'alipay.account.savings-in.v1'
  } else if (actionType === SOURCE_ACTION.WITHDRAWAL) {
    const explicitPlatformSource = sameReference(payment, balance) || sameReference(payment, yuEBao) ? payment : null
    const source = explicitPlatformSource || balance
    const destination = firstAccountOtherThan(source, explicitPlatformSource ? counterpartyAccount : payment, counterpartyAccount)
    projection = movement('withdrawal', 'alipay', source, destination)
    ruleId = 'alipay.account.withdrawal.v1'
  } else if (actionType === SOURCE_ACTION.TOP_UP) {
    const explicitPlatformTarget = sameReference(payment, balance) || sameReference(payment, yuEBao) ? payment : null
    const target = explicitPlatformTarget || balance
    const source = firstAccountOtherThan(target, explicitPlatformTarget ? counterpartyAccount : payment, counterpartyAccount)
    projection = movement('top_up', 'alipay', source, target)
    ruleId = 'alipay.account.top-up.v1'
  } else if (actionType === SOURCE_ACTION.REPAYMENT) {
    projection = movement('repayment', 'alipay', payment, repaymentTargetReference('alipay', counterparty || item))
    ruleId = 'alipay.account.repayment.v1'
  }

  // 组合付款没有单一付款端，但还款目标仍是同一语义结果的一部分。
  if (!projection && actionType === SOURCE_ACTION.REPAYMENT) return {
    fundsProjection: null, fromAccountRef: payment,
    toAccountRef: repaymentTargetReference('alipay', counterparty || item), ruleIds: [ruleId]
  }
  return projection && {
    fundsProjection: projection,
    fromAccountRef: projection.from,
    toAccountRef: projection.to,
    ruleIds: [ruleId]
  }
}

module.exports = {
  relationHints,
  NON_FINANCIAL_STATES,
  APP_PAYMENT_TYPES,
  WEB_PAYMENT_TYPES,
  SOURCE_ACTION,
  resolveAccountEndpoints,
  resolveAction,
  resolveSettlement
}
