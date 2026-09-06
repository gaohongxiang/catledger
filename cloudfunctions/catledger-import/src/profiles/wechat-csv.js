const semantic = require('./wechat')

module.exports = Object.freeze({
  profileId: 'wechat_csv',
  profileVersion: 'wechat-csv-profile-v2',
  adapterVersion: 'wechat-csv-adapter-v4',
  policyVersion: 'wechat-semantic-policy-v3',
  sourceType: 'wechat',
  sourceFormat: 'wechat_csv',
  container: 'csv',
  parserName: 'wechat-pay-csv-evidence',
  parserVersion: 'wechat-csv-parser-v4',
  normalizationVersion: 'wechat-normalization-v8',
  markers: ['微信支付账单明细'],
  uniqueHeaders: ['微信交易单号', '当前状态'],
  requiredFields: ['transactionTime', 'transactionType', 'counterparty', 'item', 'direction', 'amount', 'paymentMethod', 'status', 'transactionId'],
  fieldAliases: {
    transactionTime: ['交易时间', '交易日期'],
    transactionType: ['交易类型', '业务类型'],
    counterparty: ['交易对方', '交易对象', '对方'],
    item: ['商品', '商品说明', '商品名称'],
    direction: ['收/支', '收支', '收支类型'],
    amount: ['金额(元)', '交易金额(元)', '金额'],
    paymentMethod: ['支付方式', '付款方式'],
    status: ['当前状态', '交易状态', '状态'],
    transactionId: ['交易单号', '微信交易单号'],
    orderId: ['订单号'],
    merchantOrderId: ['商户单号', '商家单号'],
    note: ['备注', '交易备注']
  },
  ...semantic
})
