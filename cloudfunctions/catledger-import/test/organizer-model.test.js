const assert = require('node:assert/strict')
const test = require('node:test')

const { EVENT_STATUS, classifyReviewIssue, economicNatureForRow, evaluatePostability } = require('../src/organizer-model')
const { ECONOMIC_NATURE, FLOW_DIRECTION } = require('../src/organizer-values')
const { FIELD_MASK } = require('../src/review/policy')
const { SEMANTIC_HARD_BLOCKERS } = require('../src/semantic-policy')

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

test('缺分类是建议，账户、方向和身份等核对仍阻止入账', () => {
  const optional = evaluatePostability(event({ categoryId: null }))
  assert.equal(optional.status, EVENT_STATUS.READY)
  assert.deepEqual(optional.reasonCodes, ['category_required'])
  for (const patch of [{ ledgerAccountId: null }, { flowDirection: 'inflow' },
    { amountMinor: null }, { reasonCodes: ['identity_conflict'] }]) {
    const blocked = evaluatePostability(event({ categoryId: null, ...patch }))
    assert.equal(blocked.status, EVENT_STATUS.NEEDS_ACTION)
    assert.notEqual(classifyReviewIssue({ ...event(patch), ...blocked }).issueType, 'category_assignment')
  }
})

test('ready 只能由服务端根据完整经济字段推导', function () {
  assert.deepEqual(evaluatePostability(event()), { status: EVENT_STATUS.READY, reasonCodes: [] })
  const unresolved = evaluatePostability(event({ ledgerAccountId: null, status: EVENT_STATUS.READY }))
  assert.equal(unresolved.status, EVENT_STATUS.NEEDS_ACTION)
  assert.ok(unresolved.reasonCodes.includes('ledger_account_required'))
})

test('人工性质只解除类型未知，填账户或分类不代替确认，其他语义与关系门禁保持', () => {
  const unknown = event({ economicNature: 'unknown', categoryId: null,
    reasonCodes: ['row_transaction_type_unknown'], fieldSources: { semanticBlockers: ['row_transaction_type_unknown'] } })
  const confirmed = { ...unknown, economicNature: 'repayment', flowDirection: 'neutral', counterpartyLedgerAccountId: 'account-2',
    manualFieldMask: FIELD_MASK.economicNature | FIELD_MASK.flowDirection }
  const before = JSON.stringify(confirmed)
  assert.deepEqual(evaluatePostability(confirmed), { status: 'ready', reasonCodes: [] })
  assert.equal(JSON.stringify(confirmed), before, '原始语义证据不被人工决定擦除')
  for (const manualFieldMask of [0, FIELD_MASK.ledgerAccountId, FIELD_MASK.categoryId]) {
    assert.ok(evaluatePostability({ ...confirmed, manualFieldMask }).reasonCodes.includes('row_transaction_type_unknown'))
  }
  assert.ok(evaluatePostability({ ...confirmed, economicNature: 'unknown' }).reasonCodes.includes('row_transaction_type_unknown'))
  for (const blocker of SEMANTIC_HARD_BLOCKERS.filter(reason => reason !== 'row_transaction_type_unknown')
    .concat(['identity_conflict', 'core_fields_conflict', 'refund_source_conflict'])) {
    const guarded = { ...confirmed, reasonCodes: [blocker], fieldSources: { semanticBlockers: ['row_transaction_type_unknown', blocker] } }
    const evaluated = evaluatePostability(guarded), issue = classifyReviewIssue({ ...guarded, ...evaluated })
    assert.equal(evaluated.status, 'needs_action', blocker)
    assert.ok(evaluated.reasonCodes.includes(blocker), blocker)
    assert.ok(issue.primaryReason, '未解决问题必须有明确原因，不能写入 undefined')
    assert.notEqual(issue.primaryReason, 'repayment_account_required', '两端已齐不能误报缺还款账户')
  }
  assert.ok(evaluatePostability({ ...confirmed, counterpartyLedgerAccountId: null }).reasonCodes.includes('repayment_account_required'))
  assert.ok(evaluatePostability({ ...confirmed, economicNature: 'refund', flowDirection: 'inflow' }).reasonCodes.includes('refund_relation_required'))
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
