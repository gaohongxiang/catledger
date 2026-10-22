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
    .replace(/[\s!-/:-@\[-`{-~\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2010-\u2027\u2030-\u205e\u00b7\u2026\u2014\u2018\u2019\u201c\u201d\u3001\u3002\uff0c\uff1b\uff1a\uff1f\uff01]+/g, '').slice(0, 160)
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
