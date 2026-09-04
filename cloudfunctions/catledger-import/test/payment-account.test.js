const assert = require('node:assert/strict')
const test = require('node:test')

const { buildPaymentMethodKey } = require('../src/identity')
const { accountGroupingKey, paymentAccountDetails, primaryInstrument } = require('../src/payment-account')

test('组合支付方式只用 & 前第一段建立账户候选', function () {
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

test('组合字段的后续成分不参与账户身份', function () {
  assert.equal(paymentAccountDetails('alipay', '花呗&余额宝').displayName, '支付宝花呗')
  assert.equal(paymentAccountDetails('alipay', '余额宝&红包').displayName, '支付宝余额宝')
})

test('平台余额带来源前缀且泛称不可自动复用', function () {
  assert.equal(paymentAccountDetails('alipay', '余额').displayName, '支付宝账户余额')
  assert.equal(paymentAccountDetails('alipay', '账户余额').displayName, '支付宝账户余额')
  assert.equal(paymentAccountDetails('wechat', '零钱').displayName, '微信零钱')
  assert.equal(paymentAccountDetails('wechat', '零钱通').displayName, '微信零钱通')
  assert.equal(paymentAccountDetails('alipay', '花呗').displayName, '支付宝花呗')
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

test('花呗｜信用购是聚合还款引用，不得创建第三个账户身份', function () {
  for (const raw of ['花呗|信用购', '花呗｜信用购', '支付宝花呗｜信用购']) {
    const details = paymentAccountDetails('alipay', raw)
    assert.equal(details.referenceKind, 'aggregate')
    assert.equal(details.aggregateFamily, 'alipay_huabei_credit')
    assert.equal(details.displayName, '支付宝花呗｜信用购')
    assert.equal(details.recognized, false)
    assert.equal(details.identityMaterial, '')
    assert.equal(buildPaymentMethodKey('alipay', raw), null)
    assert.equal(accountGroupingKey('alipay', raw), '')
  }

  assert.equal(paymentAccountDetails('alipay', '花呗').referenceKind, 'atomic')
  assert.equal(paymentAccountDetails('alipay', '江苏银行信用购').referenceKind, 'atomic')
})
