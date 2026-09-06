const semantic = require('./alipay')

module.exports = Object.freeze({
  profileId: 'alipay_app_csv',
  profileVersion: 'alipay-app-profile-v2',
  adapterVersion: 'alipay-app-adapter-v4',
  policyVersion: 'alipay-semantic-policy-v4',
  transactionTypeRole: 'category',
  sourceType: 'alipay',
  sourceFormat: 'alipay_app_csv',
  container: 'csv',
  parserName: 'alipay-app-csv-evidence',
  parserVersion: 'alipay-evidence-parser-v4',
  normalizationVersion: 'alipay-normalization-v10',
  controlExcludedStatuses: ['交易关闭', '已关闭', '支付失败', '交易失败'],
  markers: ['导出信息:', '支付宝(中国)网络技术有限公司 电子客户回单', '支付宝支付科技有限公司 电子客户回单'],
  uniqueHeaders: ['交易分类', '支付宝交易号', '交易订单号'],
  requiredFields: ['transactionTime', 'transactionType', 'counterparty', 'item', 'direction', 'amount', 'paymentMethod', 'status', 'transactionId'],
  fieldAliases: {
    transactionTime: ['交易时间'],
    transactionType: ['交易分类', '交易类型'],
    counterparty: ['交易对方'],
    counterpartyAccount: ['对方账号'],
    item: ['商品说明', '商品名称'],
    direction: ['收/支'],
    amount: ['金额'],
    paymentMethod: ['收/付款方式', '付款方式', '资金渠道'],
    status: ['交易状态'],
    transactionId: ['交易订单号', '支付宝交易号', '交易号'],
    orderId: ['订单号'],
    merchantOrderId: ['商家订单号', '商户订单号'],
    note: ['备注']
  },
  ...semantic
})
