const SOURCE_LABELS = Object.freeze({
  alipay: '支付宝',
  wechat: '微信',
  bank: '银行'
})
const ACCOUNT_IDENTITY_VERSION = 'account-identity-v2'
const ACCOUNT_REFERENCE_KIND = Object.freeze({
  ATOMIC: 'atomic',
  AGGREGATE: 'aggregate'
})
const AGGREGATE_ACCOUNT_FAMILY = Object.freeze({
  ALIPAY_HUABEI_CREDIT: 'alipay_huabei_credit'
})

const GENERIC_ACCOUNT_NAMES = new Set([
  '无', '未知', '其他', '不详', '未提供', '银行卡', '信用卡', '贷记卡', '借记卡', '储蓄卡',
  '支付方式', '付款方式', 'bankcard', 'creditcard', 'debitcard', 'none', 'unknown'
])

function normalizeText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
}

// 聚合支付导出会把主资金账户与优惠/组合成分写在同一列。
// 当前产品口径固定以 & 前第一段作为账户，其余文本只留在原始证据。
function primaryInstrument(raw) {
  return normalizeText(raw).split('&', 1)[0].trim()
}

function aggregateAccountFamily(sourceType, raw) {
  if (sourceType !== 'alipay') return null
  const value = withoutPlatformPrefix(normalizeText(raw), sourceType)
    .replace(/\s+/g, '')
  return /花呗[|｜]信用购/u.test(value) || /信用购[|｜]花呗/u.test(value)
    ? AGGREGATE_ACCOUNT_FAMILY.ALIPAY_HUABEI_CREDIT
    : null
}

function aggregateFamilyDisplayName(family) {
  if (family === AGGREGATE_ACCOUNT_FAMILY.ALIPAY_HUABEI_CREDIT) return '支付宝花呗｜信用购'
  return ''
}

function safeDisplayName(raw) {
  const compact = normalizeText(raw).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  return compact.replace(/\d{8,}/g, function (digits) {
    return '****' + digits.slice(-4)
  }).slice(0, 128)
}

function canonicalInstrument(raw) {
  let value = normalizeText(raw)
    .replace(/[xX]{2,}/g, '')
    .replace(/\d{8,}/g, function (digits) { return digits.slice(-4) })
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
  ;['末四位', '后四位', '尾号', '卡号', '主卡'].forEach(function (token) {
    value = value.replaceAll(token, '')
  })
  ;['微信支付', '微信', '支付宝'].forEach(function (prefix) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length)
  })
  return value === '账户余额' ? '余额' : value
}

function withoutPlatformPrefix(value, sourceType) {
  if (sourceType === 'alipay') return value.replace(/^支付宝(?:支付)?/, '')
  if (sourceType === 'wechat') return value.replace(/^微信(?:支付)?/, '')
  return value
}

function qualifiedDisplayName(sourceType, instrument) {
  const display = safeDisplayName(instrument)
  const canonical = canonicalInstrument(display)
  const unprefixed = withoutPlatformPrefix(display, sourceType)
  if (sourceType === 'alipay') {
    if (canonical === '余额') return '支付宝账户余额'
    if (/^(余额宝|花呗|借呗|信用购|网商贷|小荷包)/.test(canonical)) {
      return '支付宝' + unprefixed
    }
  }
  if (sourceType === 'wechat') {
    if (canonical === '余额' || canonical === '零钱') return '微信零钱'
    if (/^(零钱通|亲属卡)/.test(canonical)) return '微信' + unprefixed
  }
  return display
}

function paymentAccountDetails(sourceType, raw) {
  const sourceLabel = SOURCE_LABELS[sourceType] || '账单'
  const instrument = primaryInstrument(raw)
  const aggregateFamily = aggregateAccountFamily(sourceType, instrument)
  if (aggregateFamily) {
    return {
      referenceKind: ACCOUNT_REFERENCE_KIND.AGGREGATE,
      aggregateFamily,
      aggregateFamilies: [],
      identityMaterial: '',
      displayName: aggregateFamilyDisplayName(aggregateFamily),
      recognized: false
    }
  }
  if (!instrument) {
    return {
      referenceKind: ACCOUNT_REFERENCE_KIND.ATOMIC,
      aggregateFamily: null,
      aggregateFamilies: [],
      identityMaterial: '',
      displayName: sourceLabel + '支付方式未标明',
      recognized: false
    }
  }
  const displayName = qualifiedDisplayName(sourceType, instrument)
  const canonical = canonicalInstrument(instrument)
  const recognized = Boolean(canonical) && !GENERIC_ACCOUNT_NAMES.has(canonical)
  const aggregateFamilies = sourceType === 'alipay' && (
    canonical === '花呗' || canonical.endsWith('信用购')
  ) ? [AGGREGATE_ACCOUNT_FAMILY.ALIPAY_HUABEI_CREDIT] : []
  return {
    referenceKind: ACCOUNT_REFERENCE_KIND.ATOMIC,
    aggregateFamily: null,
    aggregateFamilies,
    identityMaterial: recognized ? canonical : '',
    displayName: recognized ? displayName : sourceLabel + ' · ' + displayName + '（未识别具体账户）',
    recognized
  }
}

function hasStableAccountLocator(raw) {
  const value = primaryInstrument(raw)
  return /(?:尾号|末四位|后四位|[*＊xX]{2,})\s*\(?\d{4}\)?/u.test(value) ||
    /(?:银行|信用卡|贷记卡|储蓄卡|借记卡)\s*\(\d{4}\)/u.test(value) ||
    /\d{8,}/u.test(value)
}

function accountGroupingKey(sourceType, raw) {
  const account = paymentAccountDetails(sourceType, raw)
  if (!account.identityMaterial) return ''
  // 只有银行主体与稳定尾号同时存在时，才足以证明不同账单引用的是
  // 同一个现实账户。银行泛称没有卡定位，平台信用产品也归属于平台本身。
  const portable = /银行|信用卡|储蓄卡|借记卡|贷记卡/u.test(account.identityMaterial) &&
    hasStableAccountLocator(raw)
  return `${ACCOUNT_IDENTITY_VERSION}:${portable ? 'portable' : sourceType}:${account.identityMaterial}`
}

function paymentReferenceKey(sourceTypeOrReference, paymentMethodKey) {
  const sourceType = typeof sourceTypeOrReference === 'object' && sourceTypeOrReference
    ? sourceTypeOrReference.sourceType
    : sourceTypeOrReference
  const key = typeof sourceTypeOrReference === 'object' && sourceTypeOrReference
    ? sourceTypeOrReference.paymentMethodKey
    : paymentMethodKey
  return sourceType && key ? `${sourceType}:${key}` : ''
}

function accountIdentityKeyForReference(reference) {
  if (!reference) return ''
  return reference.accountIdentityKey || accountGroupingKey(reference.sourceType, reference.label)
}

// 这里只返回能够从支付平台账户标识中确定的强类型。历史映射可以沿用
// 用户自定义账户名，但不能把平台钱包静默套到现金、把信用账户套到资产。
function expectedAccountType(sourceType, raw) {
  const canonical = canonicalInstrument(raw)
  if (!canonical) return null
  if (sourceType === 'alipay') {
    if (canonical === '余额' || canonical.startsWith('小荷包')) return 'wallet'
    if (canonical.startsWith('余额宝')) return 'other_asset'
    if (/^(花呗|借呗|信用购|网商贷)/u.test(canonical)) return 'credit'
  }
  if (sourceType === 'wechat') {
    if (canonical === '余额' || canonical === '零钱' || canonical.startsWith('亲属卡')) return 'wallet'
    if (canonical.startsWith('零钱通')) return 'other_asset'
  }
  if (/(?:信用卡|贷记卡|信用购)/u.test(canonical)) return 'credit'
  if (/(?:储蓄卡|借记卡|银行)/u.test(canonical)) return 'bank'
  if (/现金/u.test(canonical)) return 'cash'
  return null
}

module.exports = {
  ACCOUNT_REFERENCE_KIND,
  ACCOUNT_IDENTITY_VERSION,
  AGGREGATE_ACCOUNT_FAMILY,
  accountIdentityKeyForReference,
  accountGroupingKey,
  aggregateAccountFamily,
  aggregateFamilyDisplayName,
  canonicalInstrument,
  expectedAccountType,
  hasStableAccountLocator,
  paymentAccountDetails,
  paymentReferenceKey,
  primaryInstrument
}
