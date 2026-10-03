const { createHash } = require('node:crypto')

const CATEGORY_ALIAS_VERSION = 'category-alias-v2'
const GENERIC = new Set([
  '', '-', '/', '商品', '商品详情', '消费', '支付', '付款', '订单', '交易', '食品', '其他',
  '商户消费', '扫二维码付款', '二维码付款', '扫码付款', '收款', '收款码',
  '充值', '提现', '转账', '红包', '微信红包', '转账退款', '零钱提现', '零钱充值',
  '信用卡还款', '不计收支', '二维码收款', '暂无', '详见账单'
])
const PLATFORM = /^(?:微信|微信支付|支付宝|财付通|淘宝|天猫|美团|饿了么|京东|拼多多|抖音|银联|网联)(?:平台|平台商户|商户|支付|订单)?$/

function canonicalName(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/[\s\-—]+/g, '')
}

function digest(...values) {
  return createHash('sha256').update(values.map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('')).digest('hex')
}

function sourceFields(row) {
  return row.raw || { transactionType: row.rawTransactionType, counterparty: row.counterparty, item: row.item }
}

function categoryMemory(sourceType, row) {
  const raw = sourceFields(row), type = canonicalName(raw.transactionType)
  const meaningful = value => {
    const name = canonicalName(value)
    return !GENERIC.has(name) && !PLATFORM.test(name) && name !== type ? name : ''
  }
  const merchant = meaningful(raw.counterparty), item = meaningful(raw.item)
  const pairKey = merchant && item ? digest(CATEGORY_ALIAS_VERSION, sourceType, 'merchant-item', merchant, item) : null
  const merchantKey = merchant ? digest(CATEGORY_ALIAS_VERSION, sourceType, 'merchant', merchant) : null
  return {
    version: CATEGORY_ALIAS_VERSION,
    // 有商品时只记住商户+商品，不把一次选择推广到该商户的所有消费。
    aliasKeys: pairKey ? [pairKey] : merchantKey && !item ? [merchantKey] : [],
    pairKey,
    merchantKey,
    legacyItemKey: item ? digest('category-alias-v1', sourceType, item) : null,
    legacyMerchantKey: merchant ? digest('category-alias-v1', sourceType, merchant) : null
  }
}

module.exports = { CATEGORY_ALIAS_VERSION, canonicalName, categoryMemory, sourceFields }
