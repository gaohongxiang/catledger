const assert = require('node:assert/strict')
const test = require('node:test')

const { buildPaymentMethodKey } = require('../src/identity')
const { accountGroupingKey, paymentAccountDetails, primaryInstrument } = require('../src/payment-account')

test('一个资金账户加优惠成分时只建立唯一资金账户候选', function () {
  assert.equal(primaryInstrument('光大银行信用卡(2690)&两轮充电券'), '光大银行信用卡(2690)')
  const plain = paymentAccountDetails('alipay', '光大银行信用卡(2690)')
  const combined = paymentAccountDetails('alipay', '光大银行信用卡(2690)&两轮充电券')
  assert.equal(combined.displayName, plain.displayName)
  assert.equal(combined.identityMaterial, plain.identityMaterial)
  assert.equal(
    buildPaymentMethodKey('alipay', '光大银行信用卡(2690)&两轮充电券'),
    buildPaymentMethodKey('alipay', '光大银行信用卡(2690)')
  )
})

test('多个资金账户没有分项金额时不得默认使用第一个账户', function () {
  const ambiguous = paymentAccountDetails('alipay', '花呗&余额宝')
  assert.equal(primaryInstrument('花呗&余额宝'), '')
  assert.equal(ambiguous.recognized, false)
  assert.equal(ambiguous.identityMaterial, '')
  assert.equal(ambiguous.ambiguous, true)
  assert.equal(buildPaymentMethodKey('alipay', '花呗&余额宝'), null)
  assert.equal(paymentAccountDetails('alipay', '余额宝&红包').displayName, '支付宝余额宝')
})

test('平台余额带来源前缀且泛称不可自动复用', function () {
  assert.equal(paymentAccountDetails('alipay', '余额').displayName, '支付宝账户余额')
  assert.equal(paymentAccountDetails('alipay', '账户余额').displayName, '支付宝账户余额')
  assert.equal(paymentAccountDetails('wechat', '零钱').displayName, '微信零钱')
  assert.equal(paymentAccountDetails('wechat', '零钱通').displayName, '微信零钱通')
  // 花呗与信用购是同一套账单口径的两种品牌，统一显示为族名，避免按写法各建账户。
  assert.equal(paymentAccountDetails('alipay', '花呗').displayName, '支付宝花呗｜信用购')
  assert.equal(paymentAccountDetails('alipay', '支付宝小荷包(树与草)').displayName, '支付宝小荷包(树与草)')
  assert.equal(paymentAccountDetails('wechat', '亲属卡').displayName, '微信亲属卡')
  assert.equal(paymentAccountDetails('alipay', '光大银行信用卡(2690)').displayName, '光大银行信用卡(2690)')
  assert.equal(buildPaymentMethodKey('alipay', '余额'), buildPaymentMethodKey('alipay', '账户余额'))
  assert.equal(paymentAccountDetails('alipay', '银行卡').recognized, false)
  assert.equal(paymentAccountDetails('alipay', '').displayName, '支付宝支付方式未标明')
  assert.equal(buildPaymentMethodKey('alipay', '银行卡'), null)
})

test('长卡号只用尾号安全展示并归一身份', function () {
  const full = paymentAccountDetails('alipay', '兴业银行信用卡 6222600000006106')
  const tail = paymentAccountDetails('alipay', '兴业银行信用卡(6106)')
  assert.equal(full.displayName, '兴业银行信用卡 ****6106')
  assert.equal(full.identityMaterial, tail.identityMaterial)
})

test('账户决策身份只合并有稳定定位的同一银行卡', function () {
  const wechatCard = accountGroupingKey('wechat', '光大银行信用卡(2690)')
  assert.equal(wechatCard, accountGroupingKey('alipay', '光大银行信用卡(2690)'))
  assert.equal(wechatCard, accountGroupingKey('bank', '光大银行信用卡(2690)'))
  assert.notEqual(accountGroupingKey('wechat', '兴业银行信用卡'), accountGroupingKey('alipay', '兴业银行信用卡'))
})

test('平台自有账户始终按来源隔离', function () {
  assert.notEqual(accountGroupingKey('wechat', '零钱'), accountGroupingKey('alipay', '余额'))
  assert.notEqual(accountGroupingKey('alipay', '信用购'), accountGroupingKey('bank', '信用购'))
})

test('花呗与信用购的各种写法收敛到同一族账户，不按写法各建账户', function () {
  // 品牌隔离后花呗与信用购可合并还款、共用一套账单口径；资金方因用户而异
  // （江苏银行、其他银行），判族只看产品名。所有写法必须得到同一个账户标识，
  // 否则导入时会为每种写法各建一个账户。
  const wordings = ['花呗', '信用购', '花呗|信用购', '花呗｜信用购', '支付宝花呗｜信用购',
    '江苏银行信用购', '宁波银行信用购', '花呗分期', '信用购分期']
  const seen = new Set()
  for (const raw of wordings) {
    const details = paymentAccountDetails('alipay', raw)
    // 技术上是普通原子账户（可映射到账本账户），身份收敛到族键。
    assert.equal(details.referenceKind, 'atomic', raw)
    assert.deepEqual(details.aggregateFamilies, ['alipay_huabei_credit'], raw)
    assert.equal(details.displayName, '支付宝花呗｜信用购', raw)
    seen.add(buildPaymentMethodKey('alipay', raw))
    seen.add(accountGroupingKey('alipay', raw))
  }
  assert.equal(seen.size, 2, '不同写法必须收敛为同一付款方式键与同一账户键')

  // 其他信用产品不并入本族，仍各自独立。
  assert.equal(paymentAccountDetails('alipay', '借呗').referenceKind, 'atomic')
  assert.equal(paymentAccountDetails('alipay', '网商贷').referenceKind, 'atomic')
  assert.equal(paymentAccountDetails('alipay', '1688先采后付').referenceKind, 'atomic')
})
