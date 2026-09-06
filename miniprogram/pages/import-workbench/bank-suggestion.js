// 仅供人工确认的候选范围，不参与服务端账户身份识别或历史映射。
const BANK_ALIASES = [
  ['中国工商银行', '工商银行'], ['中国农业银行', '农业银行'],
  ['中国建设银行', '建设银行'], ['中国邮政储蓄银行', '邮政储蓄银行'],
  ['上海浦东发展银行', '浦发银行'], ['中国光大银行', '光大银行'],
  ['中国民生银行', '民生银行']
]

function bankName(value) {
  const text = String(value || '').replace(/[\s·•-]/g, '')
  const match = text.match(/^([\u4e00-\u9fff]{2,20}银行)/)
  if (!match) return ''
  const alias = BANK_ALIASES.find(function (names) { return names.includes(match[1]) })
  return alias ? alias[1] : match[1]
}

function referenceFor(event) {
  const projection = event && event.fundsProjection
  if (!projection) return null
  const side = event.ledgerAccountId && !event.counterpartyLedgerAccountId ? 'to'
    : !event.ledgerAccountId && event.counterpartyLedgerAccountId ? 'from' : ''
  const reference = projection[side]
  if (!reference || reference.referenceKind === 'aggregate') return null
  const label = reference.value || reference.label || ''
  // 此入口只处理缺少尾号；显式数字、组合资金及不确定类型不降级匹配。
  if (/[0-9０-９&＆+＋]/.test(label)) return null
  const bank = bankName(label)
  const credit = /信用卡|贷记卡/.test(label)
  const debit = /储蓄卡|借记卡/.test(label)
  if (credit && debit) return null
  const type = debit ? 'bank' : credit || (side === 'to' && event.economicNature === 'repayment') ? 'credit' : ''
  if (!bank || !type) return null
  return { bank: bank, type: type, side: side, key: bank + ':' + type + ':' + side,
    label: bank + (type === 'credit' ? '信用卡' : '储蓄卡') }
}

function suggest(events, accounts) {
  if (!events || !events.length) return null
  const reference = referenceFor(events[0])
  if (!reference || events.some(function (event) {
    const other = referenceFor(event)
    return !other || other.key !== reference.key
  })) return null
  const knownIds = events.map(function (event) {
    return reference.side === 'to' ? event.ledgerAccountId : event.counterpartyLedgerAccountId
  })
  const candidates = (accounts || []).filter(function (account) {
    return account.accountId && account.type === reference.type && bankName(account.name) === reference.bank &&
      !knownIds.includes(account.accountId) && !account.archived && account.status !== 'archived'
  })
  return Object.assign({}, reference, { candidates: candidates,
    reason: '账单显示' + reference.label + '，未提供尾号，请核对。' })
}

module.exports = { bankName: bankName, referenceFor: referenceFor, suggest: suggest }
