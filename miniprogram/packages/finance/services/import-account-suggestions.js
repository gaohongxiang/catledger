const types = require('../domain/import-review/account-type-policy')

const GENERIC_NAME_TOKENS = Object.freeze([
  '信用卡', '贷记卡', '借记卡', '储蓄卡', '银行卡', '银行', '账户', '账号', '支付', '付款'
])
const UNSUPPORTED_CHARACTER_RE = /[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+/g

function normalizePaymentAccountName(value) {
  let normalized = String(value || '')
  normalized = normalized.replace(/\u3000/g, ' ').replace(/[\uff01-\uff5e]/g, function (character) {
    return String.fromCharCode(character.charCodeAt(0) - 0xfee0)
  })
  if (typeof normalized.normalize === 'function') {
    try {
      normalized = normalized.normalize('NFKC')
    } catch (_) {}
  }
  normalized = normalized.replace(/^\s+|\s+$/g, '').toLowerCase()
  normalized = normalized.replace(/(?:末四位|后四位|尾号|卡号)/g, '')
  normalized = normalized.replace(/[xX*＊•·]{2,}/g, '')
  normalized = normalized.replace(/\d{8,}/g, function (digits) { return digits.slice(-4) })
  return normalized.replace(UNSUPPORTED_CHARACTER_RE, '')
}

function paymentAccountTail(value) {
  const match = normalizePaymentAccountName(value).match(/(\d{4})$/)
  return match ? match[1] : ''
}

function paymentAccountBase(value) {
  let normalized = normalizePaymentAccountName(value).replace(/\d+/g, '')
  GENERIC_NAME_TOKENS.forEach(function (token) {
    normalized = normalized.split(token).join('')
  })
  return normalized
}

function stripPaymentPlatform(value, sourceType) {
  let normalized = normalizePaymentAccountName(value)
  if (sourceType === 'wechat') normalized = normalized.replace(/^微信(?:支付)?/, '')
  if (sourceType === 'alipay') normalized = normalized.replace(/^支付宝/, '')
  return normalized === '账户余额' ? '余额' : normalized
}

function paymentAccountMatchScore(context, accountName) {
  const sourceName = normalizePaymentAccountName(context && context.label)
  const candidateName = normalizePaymentAccountName(accountName)
  if (!sourceName || !candidateName) return 0
  if (sourceName === candidateName) return 100

  const sourceTail = paymentAccountTail(context.label)
  const candidateTail = paymentAccountTail(accountName)
  const sourceBase = paymentAccountBase(context.label)
  const candidateBase = paymentAccountBase(accountName)
  if (sourceTail && sourceTail === candidateTail && sourceBase.length >= 2 && candidateBase.length >= 2 &&
      (sourceBase === candidateBase || sourceBase.includes(candidateBase) || candidateBase.includes(sourceBase))) return 90

  const sourceWithoutPlatform = stripPaymentPlatform(context.label, context.sourceType)
  const candidateWithoutPlatform = stripPaymentPlatform(accountName, context.sourceType)
  return sourceWithoutPlatform && sourceWithoutPlatform === candidateWithoutPlatform ? 80 : 0
}

// 页面初始化与全批次显示分组共用建议；建议始终不是已保存的归属决定。
function suggestExistingAccount(context, accounts) {
  if (!context || !context.recognized || !context.label) return null
  const candidates = (accounts || []).filter(account => types.compatible(context, account))
    .map(account => ({ account, score: paymentAccountMatchScore(context, account.name) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || String(left.account.name).localeCompare(String(right.account.name)))
  const best = candidates[0]
  if (!best || candidates.filter(candidate => candidate.score === best.score).length !== 1) return null
  return best.account
}

module.exports = { normalizePaymentAccountName, suggestExistingAccount }
