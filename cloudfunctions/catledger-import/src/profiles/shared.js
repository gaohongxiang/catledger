function clean(value) {
  return String(value || '').normalize('NFKC').trim()
}

function startsAction(value, action) {
  return new RegExp(`^${action}(?:[-—–\\s]|$)`, 'u').test(clean(value))
}

function action(sourceAction, legacyKind, legacyTransactionType, ruleId) {
  return { sourceAction, legacyKind, legacyTransactionType, ruleId }
}

function settlement(moneyEffect, value, ruleId) {
  return { moneyEffect, settlement: value, ruleId }
}

function relationHints(row, settled) {
  const status = clean(row.rawStatus || row.status)
  const originalRefunded = settled.settlement === 'settled_with_refund' ||
    row.economicEffect === 'refund' && row.direction === 'expense'
  const amount = originalRefunded && /^已退款/u.test(status) && status.match(/[¥￥]\s*(\d+)(?:\.(\d{1,2}))?/u)
  const itemKey = clean(row.item).toLowerCase()
    .replace(/^(?:(?:退款|全款交易|交易商品|商品)(?:成功|到账)?[\s:：\-—_|｜]*)+/u, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 160)
  return {
    originalRefunded,
    explicitRefundAmountMinor: amount ? (BigInt(amount[1]) * 100n + BigInt((amount[2] || '').padEnd(2, '0'))).toString() : null,
    itemKey
  }
}

module.exports = {
  action,
  clean,
  settlement,
  startsAction,
  relationHints
}
