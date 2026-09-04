const assert = require('node:assert/strict')
const test = require('node:test')

const {
  ECONOMIC_NATURE,
  EVENT_STATUS,
  FLOW_DIRECTION,
  classifyReviewIssue,
  economicNatureForRow,
  evaluatePostability
} = require('../src/organizer-model')

function event(patch = {}) {
  return {
    eventId: 'event-1',
    status: EVENT_STATUS.NEEDS_ACTION,
    economicNature: ECONOMIC_NATURE.EXPENSE,
    flowDirection: FLOW_DIRECTION.OUTFLOW,
    ledgerAccountId: 'account-1',
    counterpartyLedgerAccountId: null,
    localAt: '2026-08-31 12:00:00.000',
    utcAt: '2026-08-31 04:00:00.000',
    amountMinor: '1234',
    currency: 'CNY',
    categoryId: 'category-expense',
    reasonCodes: [],
    ...patch
  }
}

test('ready 只能由服务端根据完整经济字段推导', function () {
  assert.deepEqual(evaluatePostability(event()), { status: EVENT_STATUS.READY, reasonCodes: [] })
  const unresolved = evaluatePostability(event({ ledgerAccountId: null, status: EVENT_STATUS.READY }))
  assert.equal(unresolved.status, EVENT_STATUS.NEEDS_ACTION)
  assert.ok(unresolved.reasonCodes.includes('ledger_account_required'))
})

test('退款必须确认原交易关系，转账必须有两个不同账户', function () {
  const refund = event({ economicNature: ECONOMIC_NATURE.REFUND, flowDirection: FLOW_DIRECTION.INFLOW })
  assert.ok(evaluatePostability(refund).reasonCodes.includes('refund_relation_required'))

  const transfer = event({ economicNature: ECONOMIC_NATURE.INTERNAL_TRANSFER, flowDirection: FLOW_DIRECTION.NEUTRAL })
  assert.ok(evaluatePostability(transfer).reasonCodes.includes('transfer_account_required'))
  assert.equal(evaluatePostability({ ...transfer, counterpartyLedgerAccountId: 'account-2' }).status, EVENT_STATUS.READY)
})

test('用户明确暂记的零候选退款可入账但仍保留结构化待关联状态', function () {
  const refund = event({
    economicNature: ECONOMIC_NATURE.REFUND,
    flowDirection: FLOW_DIRECTION.INFLOW,
    fieldSources: {
      refundRelation: {
        version: 'refund-relation-state-v1',
        status: 'pending',
        confirmedBy: 'user'
      }
    }
  })
  assert.deepEqual(evaluatePostability(refund), { status: EVENT_STATUS.READY, reasonCodes: [] })
})

test('聚合还款只有在分配金额守恒后才可入账', function () {
  const aggregate = event({
    economicNature: ECONOMIC_NATURE.REPAYMENT,
    flowDirection: FLOW_DIRECTION.NEUTRAL,
    ledgerAccountId: '51000000-0000-4000-8000-000000000201',
    fieldSources: {
      fundsProjection: {
        to: {
          referenceKind: 'aggregate',
          candidates: [
            { accountId: '51000000-0000-4000-8000-000000000202' },
            { accountId: '51000000-0000-4000-8000-000000000203' }
          ]
        }
      }
    }
  })
  assert.ok(evaluatePostability(aggregate).reasonCodes.includes('repayment_allocation_required'))

  const allocated = {
    ...aggregate,
    fieldSources: {
      ...aggregate.fieldSources,
      repaymentAllocationVersion: 'repayment-allocation-v1',
      repaymentAllocations: [
        { accountId: '51000000-0000-4000-8000-000000000202', amountMinor: '734' },
        { accountId: '51000000-0000-4000-8000-000000000203', amountMinor: '500' }
      ]
    }
  }
  assert.equal(evaluatePostability(allocated).status, EVENT_STATUS.READY)
  assert.equal(evaluatePostability({
    ...allocated,
    fieldSources: { ...allocated.fieldSources, repaymentAllocations: [
      { accountId: '51000000-0000-4000-8000-000000000202', amountMinor: '733' },
      { accountId: '51000000-0000-4000-8000-000000000203', amountMinor: '500' }
    ] }
  }).reasonCodes.includes('repayment_allocation_amount_mismatch'), true)
})

test('ReviewIssue 类型优先级与原 organizer 一致', function () {
  assert.equal(classifyReviewIssue(event({
    economicNature: ECONOMIC_NATURE.REFUND,
    ledgerAccountId: null,
    reasonCodes: ['ledger_account_required', 'refund_relation_required']
  })).issueType, 'account_mapping')
  assert.equal(classifyReviewIssue(event({
    economicNature: ECONOMIC_NATURE.REFUND,
    reasonCodes: ['same_event_candidate', 'relation_ambiguous', 'refund_relation_required']
  })).issueType, 'refund_relation')
  assert.equal(classifyReviewIssue(event({
    economicNature: ECONOMIC_NATURE.INTERNAL_TRANSFER,
    reasonCodes: ['same_event_candidate', 'relation_ambiguous', 'transfer_account_required']
  })).issueType, 'transfer_accounts')
  assert.equal(classifyReviewIssue(event({
    economicNature: ECONOMIC_NATURE.INTERNAL_TRANSFER,
    ledgerAccountId: null,
    reasonCodes: ['ledger_account_required', 'transfer_account_required']
  })).issueType, 'transfer_accounts')
  assert.equal(classifyReviewIssue(event({
    economicNature: ECONOMIC_NATURE.REPAYMENT,
    ledgerAccountId: null,
    reasonCodes: ['ledger_account_required', 'repayment_account_required'],
    fieldSources: { fundsProjection: {
      from: { sourceType: 'wechat', paymentMethodKey: 'wechat-change', label: '微信零钱' },
      to: { sourceType: 'wechat', paymentMethodKey: null, label: '兴业银行信用卡' }
    } }
  })).issueType, 'account_mapping')
  assert.equal(classifyReviewIssue(event({
    reasonCodes: ['same_event_candidate', 'relation_ambiguous', 'core_fields_conflict']
  })).issueType, 'field_conflict')
})

test('支付平台与外部对手方的普通转账按方向记为收入或支出', function () {
  assert.equal(economicNatureForRow({
    sourceType: 'alipay', transactionType: 'transfer', direction: 'expense'
  }), ECONOMIC_NATURE.EXPENSE)
  assert.equal(economicNatureForRow({
    sourceType: 'wechat', transactionType: 'transfer', direction: 'income'
  }), ECONOMIC_NATURE.INCOME)
})

test('旧批次的过宽提现分类按冻结原始字段纠正为普通支出', function () {
  assert.equal(economicNatureForRow({
    sourceType: 'alipay', transactionType: 'withdrawal', rawTransactionType: '购物',
    item: '商家提现优惠券', direction: 'expense'
  }), ECONOMIC_NATURE.EXPENSE)
})

test('整理层不再根据商品文案中的余额宝或还款二次猜测资金性质', function () {
  for (const item of ['余额宝周边礼品', '余额宝-提现活动', '还款-优惠券', '转入会员活动']) {
    assert.equal(economicNatureForRow({
      sourceType: 'alipay', transactionType: 'payment', rawTransactionType: '购物',
      item, direction: 'expense', economicEffect: 'normal'
    }), ECONOMIC_NATURE.EXPENSE, item)
  }
})
