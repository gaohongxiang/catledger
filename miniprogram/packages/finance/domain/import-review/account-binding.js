const { digestParts } = require('./portable-digest')
const { paymentAccountDetails, primaryInstrument, canonicalInstrument, expectedAccountType } = require('./payment-account')

const VERSION = 'account-binding-v1'
const SUBJECT_TOOLS = Object.freeze({
  alipay: new Set(['余额', '余额宝', '花呗', '借呗', '网商贷', '1688先采后付']),
  wechat: new Set(['余额', '零钱', '零钱通'])
})

// 显示名称可以脱敏，身份依据不能先截成尾号。只接受明确的卡/账户数字，
// 不把昵称中的长数字或账单日期当成账户号码；原始账单与来源交易身份均不改写。
const DATE_LABEL = /(?:19|20)\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:0?[1-9]|[12]\d|3[01])\s*日?/gu
const DATE_ONLY = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/
function fullAccountNumber(sourceType, value) {
  const raw = String(value || '').normalize('NFKC').trim().replace(/^'+/, '')
  // 先移除带分隔符的日期，避免它与相邻卡号在去空格后粘成一个数字；不带分隔符的
  // 纯日期由下方候选过滤处理。日期不是账户身份，卡号本身仍按原样读取。
  const compact = raw.replace(DATE_LABEL, ' ').replace(/(\d)[ -]+(?=\d)/g, '$1')
  if (sourceType !== 'bank' && !/银行|信用卡|贷记卡|储蓄卡|借记卡/u.test(compact)) return null
  if (/[*＊•xX]{2,}/u.test(compact)) return null
  const numbers = (compact.match(/\d{8,32}/g) || []).filter(number => !DATE_ONLY.test(number))
  return numbers.length === 1 ? numbers[0] : null
}

function reliableProfile(row) {
  return typeof row.sourceProfileKey === 'string' && row.sourceProfileKey.length === 64 &&
    row.sourceProfileKey !== digestParts('source-profile-v1', row.sourceType, 'unbound')
}

function scopeFor(row, sourceType, number, subjectTool) {
  if (number) return { kind: 'instrument', key: digestParts(VERSION, sourceType, 'number', number) }
  if (subjectTool && reliableProfile(row)) return { kind: 'profile', key: row.sourceProfileKey }
  const file = row.importId || row.batchId || row.fileSha256 || row.contentSha256
  if (file) return { kind: 'file', key: digestParts(VERSION, 'file', file) }
  if (row.rowId) return { kind: 'row', key: digestParts(VERSION, 'row', row.rowId) }
  return null
}

function scopeReference(reference, row = {}) {
  if (!reference) return reference
  const sourceType = reference.sourceType || row.sourceType
  const value = reference.value || reference.label || ''
  const details = paymentAccountDetails(sourceType, value)
  let number = fullAccountNumber(sourceType, value)
  // 银行长数字曾以数值单元格读入时可能已丢精度。旧解析只有通过数字精度
  // 检查才会使用此保护键；不匹配的完整数字仍只作文件内线索。
  if (number && sourceType === 'bank' && row.paymentMethodKey &&
      row.paymentMethodKey !== digestParts('bank-payment-v1', digestParts('bank-own-account-v1', number), '')) number = null
  const canonical = canonicalInstrument(primaryInstrument(value))
  const subjectTool = Boolean(SUBJECT_TOOLS[sourceType]?.has(canonical) || details.aggregateFamilies?.length)
  const scope = scopeFor(row, sourceType, number, subjectTool)
  if (!scope) return reference
  const identityKind = number ? 'full_number' : subjectTool ? 'subject_tool' : 'source_label'
  const identityKey = digestParts(VERSION, identityKind, number || details.identityMaterial || reference.paymentMethodKey)
  const binding = {
    version: VERSION, scopeKind: scope.kind, scopeKey: scope.key, identityKind, identityKey,
    currency: row.currency || 'CNY', reusable: Boolean(number || scope.kind === 'profile' && subjectTool),
    legacyPaymentMethodKey: reference.paymentMethodKey || null
  }
  const bindingKey = digestParts(VERSION, sourceType, scope.kind, scope.key, identityKey, binding.currency)
  return { ...reference, bindingKey, binding,
    accountIdentityKey: 'account-reference-v3:' + bindingKey,
    expectedAccountType: reference.expectedAccountType ||
      (sourceType === 'bank' && row.bankStatementKind === 'credit' ? 'credit' : expectedAccountType(sourceType, value)) }
}

function scopeSemantic(semantic, row) {
  const bind = reference => scopeReference(reference, row)
  const projection = semantic.fundsProjection
  return { ...semantic, accountBindingVersion: VERSION,
    ledgerAccountRef: bind(semantic.ledgerAccountRef),
    fromAccountRef: bind(semantic.fromAccountRef), toAccountRef: bind(semantic.toAccountRef),
    fundsProjection: projection ? { ...projection, from: bind(projection.from), to: bind(projection.to) } : null }
}

function confirmedBinding(reference) {
  return reference?.binding?.version === VERSION ? { ...reference.binding, confirmedBy: 'user' } : null
}

function bindingFor(mapping) {
  const value = mapping && mapping.binding
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch (_) { return null }
}

function bindingMatches(mapping, reference, { reusable = false } = {}) {
  const binding = bindingFor(mapping), expected = reference && reference.binding
  return Boolean(binding && expected && binding.version === VERSION && binding.confirmedBy === 'user' &&
    (!reusable || binding.reusable === true && expected.reusable === true) &&
    ['scopeKind', 'scopeKey', 'identityKind', 'identityKey', 'currency'].every(key => binding[key] === expected[key]))
}

function compatibleAccount(reference, account) {
  if (!account || !account.accountId || account.archivedAt != null || account.disabledAt != null || account.supersededAt != null) return false
  const expected = reference.expectedAccountType || expectedAccountType(reference.sourceType, reference.value || reference.label)
  return account.currency === (reference.binding?.currency || reference.currency || 'CNY') && (!expected || account.type === expected)
}

module.exports = { VERSION, bindingFor, bindingMatches, compatibleAccount, confirmedBinding, fullAccountNumber,
  reliableProfile, scopeReference, scopeSemantic }
