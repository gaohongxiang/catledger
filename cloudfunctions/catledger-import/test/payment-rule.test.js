const assert = require('node:assert/strict')
const test = require('node:test')

const { validateDecisions } = require('../src/ledger-writer')

const EVENT_ID = '11111111-1111-4111-8111-111111111111'

test('永久忽略只随跳过决定提交', function () {
  const decisions = validateDecisions([{
    eventId: EVENT_ID,
    disposition: 'skip',
    accountId: null,
    categoryId: null,
    paymentRuleAction: 'ignore'
  }])
  assert.deepEqual(decisions.get(EVENT_ID), {
    eventId: EVENT_ID,
    disposition: 'skip',
    accountId: null,
    categoryId: null,
    paymentRuleAction: 'ignore'
  })
  assert.throws(function () {
    validateDecisions([{
      eventId: EVENT_ID,
      disposition: 'post',
      accountId: 'account-1',
      categoryId: 'category-1',
      paymentRuleAction: 'ignore'
    }])
  }, { publicCode: 'VALIDATION_ERROR' })
})

test('停用永久忽略使用显式 forget，未知规则动作被拒绝', function () {
  assert.equal(validateDecisions([{
    eventId: EVENT_ID,
    disposition: 'skip',
    paymentRuleAction: 'forget'
  }]).get(EVENT_ID).paymentRuleAction, 'forget')
  assert.throws(function () {
    validateDecisions([{
      eventId: EVENT_ID,
      disposition: 'skip',
      paymentRuleAction: 'forever'
    }])
  }, { publicCode: 'VALIDATION_ERROR' })
})
