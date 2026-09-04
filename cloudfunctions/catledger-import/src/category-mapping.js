const { digestParts } = require('./digest')

const CATEGORY_ALIAS_VERSION = 'category-alias-v1'

const FORBIDDEN_NAMES = new Set([
  '商户消费', '扫二维码付款', '充值', '提现', '转账', '红包', '微信红包',
  '转账退款', '零钱提现', '零钱充值', '信用卡还款', '不计收支', '二维码收款', '其他'
].map(canonicalName))

const ALIPAY_SYSTEM_KEYS = Object.freeze({
  餐饮美食: 'food',
  交通出行: 'transport',
  爱车养车: 'transport',
  服饰装扮: 'shopping',
  日用百货: 'shopping',
  家居家装: 'shopping',
  数码电器: 'shopping',
  美容美发: 'shopping',
  宠物: 'shopping',
  教育培训: 'education',
  医疗健康: 'medical',
  保险: 'utilities',
  投资理财: 'investment'
})

function canonicalName(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[\s\-—]+/g, '')
}

function categoryCandidates(row) {
  const values = [row.raw.transactionType, row.raw.counterparty, row.raw.item]
  const seen = new Set()
  const result = []
  values.forEach((value) => {
    const display = String(value || '').normalize('NFKC').trim()
    const canonical = canonicalName(display)
    if (!canonical || FORBIDDEN_NAMES.has(canonical) || seen.has(canonical)) return
    seen.add(canonical)
    result.push(display)
  })
  return result
}

function aliasKeys(sourceType, row) {
  return categoryCandidates(row).map((value) => (
    digestParts(CATEGORY_ALIAS_VERSION, sourceType, canonicalName(value))
  ))
}

function deterministicSystemKey(sourceType, row) {
  if (sourceType === 'alipay') {
    const key = ALIPAY_SYSTEM_KEYS[canonicalName(row.raw.transactionType)]
    if (key) return key
  }
  const evidence = canonicalName(`${row.raw.counterparty || ''} ${row.raw.item || ''}`)
  if (sourceType === 'wechat') {
    if (evidence.includes('美团')) return 'food'
    if (evidence.includes('寄件') || evidence.includes('快递')) return 'shopping'
    if (evidence.includes('保险') || evidence.includes('保费')) return 'utilities'
  }
  return null
}

function buildCategoryEvidence(sourceType, row) {
  return {
    version: CATEGORY_ALIAS_VERSION,
    aliasKeys: aliasKeys(sourceType, row),
    deterministicSystemKey: deterministicSystemKey(sourceType, row)
  }
}

module.exports = {
  CATEGORY_ALIAS_VERSION,
  buildCategoryEvidence,
  canonicalName
}
