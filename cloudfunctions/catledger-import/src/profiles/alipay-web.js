const app = require('./alipay-app')

module.exports = Object.freeze({
  ...app,
  profileId: 'alipay_web_csv',
  transactionTypeRole: 'action',
  profileVersion: 'alipay-web-profile-v2',
  adapterVersion: 'alipay-web-adapter-v4',
  sourceFormat: 'alipay_web_csv',
  parserName: 'alipay-web-csv-evidence',
  markers: ['支付宝交易记录明细查询', '交易记录明细列表'],
  uniqueHeaders: ['交易创建时间', '金额(元)'],
  fieldAliases: {
    transactionTime: ['交易创建时间'],
    transactionType: ['类型', '交易类型'],
    counterparty: ['交易对方'],
    item: ['商品名称', '商品说明'],
    direction: ['收/支'],
    amount: ['金额(元)', '金额'],
    paymentMethod: ['收/付款方式', '付款方式', '资金渠道'],
    status: ['交易状态'],
    transactionId: ['交易号', '支付宝交易号', '交易订单号'],
    orderId: ['订单号'],
    merchantOrderId: ['商户订单号', '商家订单号'],
    note: ['备注']
  }
})
