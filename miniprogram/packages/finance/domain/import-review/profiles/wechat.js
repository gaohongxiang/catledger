const { relationHints, action, clean, settlement } = require('./shared')
const {
  accountReference,
  firstAccountOtherThan,
  movement,
  repaymentTargetReference
} = require('../account-reference')

const { SOURCE_ACTION } = require('../semantic-types')
const { mergeActions } = require('../rule-evaluator')

const SETTLED = new Set([
  '支付成功', '交易成功', '交易完成', '已完成', '收款成功', '已收钱',
  '已到账', '提现已到账', '还款成功', '已支付', '已转账', '已领取', '已存入零钱'
])
const FAILED = new Set(['支付失败', '交易失败', '转账失败', '未支付', '未收款'])
const CLOSED = new Set(['已关闭', '交易关闭', '已撤销', '已取消'])
const PAYMENT_TYPES = new Set(['商户消费', '二维码收付款', '二维码付款', '二维码收款', '扫二维码付款'])

function refundAmountMatches(row) {
  const match = /^已退款[¥￥](\d+)(?:\.(\d{1,2}))?$/u.exec(clean(row.rawStatus || row.status))
  return Boolean(match && /^\d+$/u.test(String(row.amountMinor)) && BigInt(row.amountMinor) > 0n &&
    BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0')) === BigInt(row.amountMinor))
}

function resolveAction(row) {
  const type = clean(row.rawTransactionType || row.transactionType)
  const direction = clean(row.direction)
  const candidates = []
  const add = (matches, sourceAction, kind, normalized, ruleId) => {
    if (matches) candidates.push(action(sourceAction, kind, normalized, ruleId))
  }
  add(['手续费', '服务费'].includes(type), SOURCE_ACTION.FEE, 'fee', 'fee', 'wechat.action.fee.v1')
  add(['零钱充值', '余额充值'].includes(type), SOURCE_ACTION.TOP_UP, 'top_up', 'top_up', 'wechat.action.top-up.v1')
  add(['零钱提现', '余额提现'].includes(type), SOURCE_ACTION.WITHDRAWAL, 'withdrawal', 'withdrawal', 'wechat.action.withdrawal.v1')
  add(type === '信用卡还款', SOURCE_ACTION.REPAYMENT, 'repayment', 'transfer', 'wechat.action.repayment.v1')
  add(/^(?:退款|商户退款|(?:转账|微信转账|红包|微信红包|群收款|二维码收付款|二维码付款|二维码收款)[-—–\s]?退款)$/u.test(type),
    SOURCE_ACTION.REFUND_CREDIT, 'refund', 'payment', 'wechat.action.refund-credit.v1')
  add(/^.+平台商户-退款$/u.test(type) && direction === 'income' && refundAmountMatches(row),
    SOURCE_ACTION.REFUND_CREDIT, 'refund', 'payment', 'wechat.action.platform-merchant-refund.v1')
  if (['转账', '微信转账'].includes(type)) {
    add(direction === 'income', SOURCE_ACTION.TRANSFER_RECEIVED, 'external_transfer', 'transfer', 'wechat.action.transfer-received.v1')
    add(direction === 'expense', SOURCE_ACTION.TRANSFER_SENT, 'external_transfer', 'transfer', 'wechat.action.transfer-sent.v1')
  }
  if (['微信红包', '红包', '群收款'].includes(type)) {
    add(direction === 'income', SOURCE_ACTION.RECEIPT, 'external_transfer', 'payment', 'wechat.action.social-receipt.v1')
    add(direction === 'expense', SOURCE_ACTION.PURCHASE, 'external_transfer', 'payment', 'wechat.action.social-payment.v1')
  }
  if (PAYMENT_TYPES.has(type)) {
    add(direction === 'income' && !['二维码付款', '扫二维码付款'].includes(type), SOURCE_ACTION.RECEIPT, 'payment', 'payment', 'wechat.action.receipt.v1')
    add(direction === 'expense', SOURCE_ACTION.PURCHASE, 'payment', 'payment', 'wechat.action.purchase.v1')
  }
  return mergeActions(candidates, action(null, 'unknown', 'unknown', 'wechat.action.unknown.v1'))
}

function resolveSettlement(row, resolvedAction) {
  const status = clean(row.rawStatus || row.status)
  const amountMinor = String(row.amountMinor == null ? '' : row.amountMinor)
  if (FAILED.has(status)) return settlement('failed', 'failed', 'wechat.settlement.failed.v1')
  if (CLOSED.has(status)) return settlement('closed', 'closed', 'wechat.settlement.closed.v1')
  if (status === '等待确认收货') return settlement('financial', 'pending_confirmation', 'wechat.settlement.pending-confirmation.v1')
  if (/^已退款(?:[（(].*[）)])?$/u.test(status) && resolvedAction.sourceAction !== SOURCE_ACTION.REFUND_CREDIT) {
    return settlement('financial', 'settled_with_refund', 'wechat.settlement.original-refunded.v1')
  }
  if ((status === '退款成功' || status === '退款完成' || /^已退款(?:[（(].*[）)])?$/u.test(status) || refundAmountMatches(row)) &&
      resolvedAction.sourceAction === SOURCE_ACTION.REFUND_CREDIT) {
    return settlement('financial', 'refund_settled', 'wechat.settlement.refund-credit.v1')
  }
  const requiredActions = {
    '已存入零钱': [SOURCE_ACTION.TRANSFER_RECEIVED],
    '提现已到账': [SOURCE_ACTION.WITHDRAWAL],
    '还款成功': [SOURCE_ACTION.REPAYMENT],
    '已收钱': [SOURCE_ACTION.TRANSFER_RECEIVED, SOURCE_ACTION.RECEIPT],
    '已领取': [SOURCE_ACTION.RECEIPT, SOURCE_ACTION.PURCHASE]
  }
  if (requiredActions[status] && !requiredActions[status].includes(resolvedAction.sourceAction)) {
    return settlement('unknown', 'unknown', 'wechat.settlement.action-conflict.v1')
  }
  if (SETTLED.has(status)) {
    if (amountMinor === '0') return settlement('unknown', 'unknown', 'wechat.settlement.zero-unknown.v1')
    return settlement('financial', status === '已存入零钱' ? 'settled_to_balance' : 'settled', 'wechat.settlement.settled.v1')
  }
  return settlement('unknown', 'unknown', 'wechat.settlement.unknown.v1')
}

function resolveAccountEndpoints(row, resolvedAction, resolvedSettlement) {
  if (resolvedSettlement.moneyEffect !== 'financial') return null
  const actionType = resolvedAction.sourceAction
  const item = clean(row.item)
  const counterparty = clean(row.counterparty)
  const paymentMethod = clean(row.paymentMethod)
  const change = accountReference('wechat', '零钱', 'platform_balance')
  const payment = accountReference('wechat', paymentMethod, 'payment_method')
  const counterpartyAccount = accountReference('wechat', counterparty, 'counterparty_account')

  if (actionType === SOURCE_ACTION.TRANSFER_RECEIVED && clean(row.direction) === 'income' &&
      (!paymentMethod || paymentMethod === '/') && clean(row.rawStatus || row.status) === '已存入零钱' &&
      /^\d+$/u.test(String(row.amountMinor || '')) && BigInt(row.amountMinor) > 0n) {
    const ledgerAccountRef = {
      ...accountReference('wechat', '零钱', 'ledger_account'),
      inferenceRule: 'wechat_income_deposited_to_change'
    }
    return {
      ledgerAccountRef,
      fromAccountRef: null,
      toAccountRef: ledgerAccountRef,
      fundsProjection: null,
      ruleIds: ['wechat.transfer.received-to-balance.v1']
    }
  }
  if (actionType === SOURCE_ACTION.TOP_UP) {
    const projection = movement('top_up', 'wechat', firstAccountOtherThan(change, payment, counterpartyAccount), change)
    return projection && { fundsProjection: projection, fromAccountRef: projection.from, toAccountRef: projection.to, ruleIds: ['wechat.account.top-up.v1'] }
  }
  if (actionType === SOURCE_ACTION.WITHDRAWAL) {
    const projection = movement('withdrawal', 'wechat', change, firstAccountOtherThan(change, payment, counterpartyAccount))
    return projection && { fundsProjection: projection, fromAccountRef: projection.from, toAccountRef: projection.to, ruleIds: ['wechat.account.withdrawal.v1'] }
  }
  if (actionType === SOURCE_ACTION.REPAYMENT) {
    const projection = movement('repayment', 'wechat', payment, repaymentTargetReference('wechat', counterparty || item))
    return projection && { fundsProjection: projection, fromAccountRef: projection.from, toAccountRef: projection.to, ruleIds: ['wechat.account.repayment.v1'] }
  }
  return null
}

module.exports = {
  relationHints,
  SOURCE_ACTION,
  resolveAccountEndpoints,
  resolveAction,
  resolveSettlement
}
