const assert = require('node:assert/strict')
const test = require('node:test')

const { buildOrganizePlan } = require('../src/organizer-planner')
const { buildPaymentMethodKey } = require('../src/identity')

function ids() {
  let value = 1
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`
}

function row(overrides = {}) {
  return {
    rowId: '10000000-0000-4000-8000-000000000001',
    batchId: '20000000-0000-4000-8000-000000000001',
    importId: '30000000-0000-4000-8000-000000000001',
    sourceOrder: 0,
    sourceType: 'wechat',
    rowNumber: 1,
    parseState: 'valid',
    identityId: '40000000-0000-4000-8000-000000000001',
    identityState: 'new',
    sourceTransactionId: 'WX-STRONG-000001',
    sourceOrderId: null,
    sourceMerchantOrderId: null,
    localDate: '2026-08-01',
    localAt: '2026-08-01 12:00:00.000',
    utcAt: '2026-08-01 04:00:00.000',
    timezoneOffsetMinutes: -480,
    amountMinor: '1234',
    currency: 'CNY',
    direction: 'expense',
    transactionType: 'payment',
    economicEffect: 'normal',
    paymentMethodKey: 'a'.repeat(64),
    paymentMethod: '微信零钱',
    mappingAction: 'account',
    mappedAccountId: '50000000-0000-4000-8000-000000000001',
    suggestedCategoryId: '70000000-0000-4000-8000-000000000001',
    counterparty: '便利店',
    item: '午餐',
    sourceNote: '',
    existingTransactionId: null,
    ...overrides
  }
}

test('收入支出没有分类时生成独立分类问题并阻止入账', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000090',
    idFactory: ids(),
    rows: [row({ suggestedCategoryId: null })]
  })

  assert.equal(plan.events[0].status, 'needs_action')
  assert.ok(plan.events[0].reasonCodes.includes('category_required'))
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'category_assignment')
})

test('同一分类证据的多笔交易合并成一个分类决定组', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000091',
    idFactory: ids(),
    rows: [
      row({ suggestedCategoryId: null, sourceTransactionId: 'WX-CATEGORY-000001' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000091',
        identityId: '40000000-0000-4000-8000-000000000091',
        sourceTransactionId: 'WX-CATEGORY-000002',
        localAt: '2026-08-02 12:00:00.000',
        utcAt: '2026-08-02 04:00:00.000',
        localDate: '2026-08-02',
        suggestedCategoryId: null
      })
    ]
  })

  assert.equal(plan.events.length, 2)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'category_assignment')
  assert.equal(plan.issues[0].memberCount, 2)
})

test('同身份证据合并为一个事件并保留 duplicate Evidence', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000001',
    idFactory: ids(),
    rows: [
      row(),
      row({
        rowId: '10000000-0000-4000-8000-000000000002',
        batchId: '20000000-0000-4000-8000-000000000002',
        importId: '30000000-0000-4000-8000-000000000002',
        sourceOrder: 1,
        rowNumber: 2
      })
    ]
  })

  assert.equal(plan.events.length, 1)
  assert.equal(plan.evidence.length, 2)
  assert.deepEqual(plan.evidence.map((item) => item.evidenceRole), ['primary', 'duplicate'])
  assert.equal(plan.counts.duplicateEvidenceCount, 1)
})

test('同额近时文本相似只生成 same_event 候选，不自动合并', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000002',
    idFactory: ids(),
    rows: [
      row({ sourceTransactionId: 'WX-ONLY-000001' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000003',
        batchId: '20000000-0000-4000-8000-000000000003',
        importId: '30000000-0000-4000-8000-000000000003',
        sourceOrder: 1,
        sourceType: 'alipay',
        identityId: '40000000-0000-4000-8000-000000000003',
        sourceTransactionId: 'ALI-ONLY-000001',
        localAt: '2026-08-01 12:05:00.000',
        utcAt: '2026-08-01 04:05:00.000'
      })
    ]
  })

  assert.equal(plan.events.length, 2)
  assert.equal(plan.events.every((event) => event.status === 'needs_action'), true)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'same_event')
})

test('跨来源共享稳定流水号且核心字段一致时才自动合并', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000003',
    idFactory: ids(),
    rows: [
      row(),
      row({
        rowId: '10000000-0000-4000-8000-000000000004',
        batchId: '20000000-0000-4000-8000-000000000004',
        importId: '30000000-0000-4000-8000-000000000004',
        sourceOrder: 1,
        sourceType: 'alipay',
        identityId: '40000000-0000-4000-8000-000000000004'
      })
    ]
  })

  assert.equal(plan.events.length, 1)
  assert.deepEqual(plan.evidence.map((item) => item.evidenceRole), ['primary', 'supporting'])
  assert.equal(plan.events[0].status, 'ready')
})

test('账户未归属只投影 account_mapping，客户端不能把事件设为 ready', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000004',
    idFactory: ids(),
    rows: [row({ mappingAction: null, mappedAccountId: null })]
  })

  assert.equal(plan.events[0].status, 'needs_action')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
})

test('余额宝转出到余额且两端已映射时直接 ready，不再人工确认', () => {
  const yuEBaoId = '51000000-0000-4000-8000-000000000001'
  const balanceId = '51000000-0000-4000-8000-000000000002'
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000018',
    idFactory: ids(),
    paymentMappings: [
      { sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', '余额宝'), mappingAction: 'account', accountId: yuEBaoId },
      { sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', '账户余额'), mappingAction: 'account', accountId: balanceId }
    ],
    rows: [row({
      sourceType: 'alipay', transactionType: 'transfer', rawTransactionType: '余额宝-转出到余额',
      item: '余额宝转出', paymentMethod: '账户余额',
      paymentMethodKey: buildPaymentMethodKey('alipay', '账户余额'), mappingAction: 'account', mappedAccountId: balanceId
    })]
  })
  assert.equal(plan.events[0].economicNature, 'internal_transfer')
  assert.equal(plan.events[0].ledgerAccountId, yuEBaoId)
  assert.equal(plan.events[0].counterpartyLedgerAccountId, balanceId)
  assert.equal(plan.events[0].status, 'ready')
  assert.equal(plan.issues.filter((issue) => issue.status === 'open').length, 0)
  assert.equal(plan.issues.filter((issue) => issue.status === 'resolved').length, 2)
})

test('余额宝转出到余额未映射时按两个资金端分别生成账户归属项', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000118',
    idFactory: ids(),
    rows: [row({
      sourceType: 'alipay', transactionType: 'transfer', rawTransactionType: '余额宝-转出到余额',
      item: '余额宝-转出到余额', paymentMethod: '账户余额',
      paymentMethodKey: buildPaymentMethodKey('alipay', '账户余额'), mappingAction: null, mappedAccountId: null
    })]
  })

  assert.equal(plan.events[0].fieldSources.fundsProjection.from.label, '支付宝余额宝')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.label, '支付宝账户余额')
  assert.deepEqual(plan.issues.map((issue) => issue.issueType), ['account_mapping', 'account_mapping'])
  assert.deepEqual(plan.members.map((member) => member.memberRole).sort(), ['mapping_from', 'mapping_to'])
})

test('微信零钱提现未映射时银行卡支付方式不得冒充转出账户', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000119',
    idFactory: ids(),
    rows: [row({
      sourceType: 'wechat', transactionType: 'withdrawal', rawTransactionType: '零钱提现',
      item: '/', counterparty: '浙江农商联合银行(5564)',
      paymentMethod: '浙江农商联合银行储蓄卡(5564)',
      paymentMethodKey: buildPaymentMethodKey('wechat', '浙江农商联合银行储蓄卡(5564)'),
      mappingAction: null, mappedAccountId: null
    })]
  })

  assert.equal(plan.events[0].fieldSources.fundsProjection.from.label, '微信零钱')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.label, '浙江农商联合银行储蓄卡(5564)')
  assert.deepEqual(plan.issues.map((issue) => issue.issueType), ['account_mapping', 'account_mapping'])
  assert.deepEqual(plan.members.map((member) => member.memberRole).sort(), ['mapping_from', 'mapping_to'])
})

test('支付宝提现只在银行卡未知时生成转入账户待确认', () => {
  const balanceId = '51000000-0000-4000-8000-000000000003'
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000019',
    idFactory: ids(),
    paymentMappings: [
      { sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', '账户余额'), mappingAction: 'account', accountId: balanceId }
    ],
    rows: [row({
      sourceType: 'alipay', transactionType: 'withdrawal', rawTransactionType: '提现-实时提现',
      item: '提现', paymentMethod: '浙江农商联合银行',
      paymentMethodKey: buildPaymentMethodKey('alipay', '浙江农商联合银行'), mappingAction: null, mappedAccountId: null
    })]
  })
  assert.equal(plan.events[0].ledgerAccountId, balanceId)
  assert.equal(plan.events[0].counterpartyLedgerAccountId, null)
  assert.equal(plan.issues[0].issueType, 'transfer_accounts')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.label, '浙江农商联合银行')
})

test('支付宝提现的支付方式为余额、银行在交易对方时仍只缺转入端', () => {
  const balanceId = '51000000-0000-4000-8000-000000000030'
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000030',
    idFactory: ids(),
    paymentMappings: [
      { sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', '账户余额'), mappingAction: 'account', accountId: balanceId }
    ],
    rows: [row({
      sourceType: 'alipay', transactionType: 'withdrawal', rawTransactionType: '账户存取',
      item: '提现-实时提现', counterparty: '浙江农商联合银行', paymentMethod: '余额',
      paymentMethodKey: buildPaymentMethodKey('alipay', '余额'), mappingAction: 'account', mappedAccountId: balanceId
    })]
  })
  assert.equal(plan.events[0].economicNature, 'internal_transfer')
  assert.equal(plan.events[0].ledgerAccountId, balanceId)
  assert.equal(plan.events[0].counterpartyLedgerAccountId, null)
  assert.equal(plan.events[0].fieldSources.fundsProjection.from.label, '支付宝账户余额')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.label, '浙江农商联合银行')
  assert.equal(plan.issues[0].issueType, 'transfer_accounts')
})

test('微信零钱还信用卡先确认零钱归属，无尾号信用卡留到资金流转步骤', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000031',
    idFactory: ids(),
    rows: [row({
      sourceType: 'wechat', transactionType: 'transfer', rawTransactionType: '信用卡还款',
      item: '/', counterparty: '兴业银行信用卡还款', paymentMethod: '零钱',
      paymentMethodKey: buildPaymentMethodKey('wechat', '零钱'), mappingAction: null, mappedAccountId: null
    })]
  })
  assert.equal(plan.events[0].economicNature, 'repayment')
  assert.equal(plan.events[0].ledgerAccountId, null)
  assert.equal(plan.events[0].counterpartyLedgerAccountId, null)
  assert.equal(plan.events[0].fieldSources.fundsProjection.from.label, '微信零钱')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.label, '兴业银行信用卡')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.paymentMethodKey, null)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
})

test('支付宝提现唯一精确命中已有平台账户时只确认未知银行端', () => {
  const balanceId = '51000000-0000-4000-8000-000000000004'
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000021',
    idFactory: ids(),
    accounts: [
      { accountId: balanceId, name: '支付宝账户余额', currency: 'CNY' }
    ],
    rows: [row({
      sourceType: 'alipay', transactionType: 'withdrawal', rawTransactionType: '提现-实时提现',
      item: '提现', paymentMethod: '浙江农商联合银行',
      paymentMethodKey: buildPaymentMethodKey('alipay', '浙江农商联合银行'), mappingAction: null, mappedAccountId: null
    })]
  })
  assert.equal(plan.events[0].ledgerAccountId, balanceId)
  assert.equal(plan.events[0].counterpartyLedgerAccountId, null)
  const openIssues = plan.issues.filter((issue) => issue.status === 'open')
  assert.equal(openIssues.length, 1)
  assert.equal(openIssues[0].issueType, 'transfer_accounts')
  assert.equal(plan.events[0].fieldSources.fundsProjection.to.label, '浙江农商联合银行')
})

test('普通支付工具唯一精确命中已有账户时直接沿用', () => {
  const accountId = '51000000-0000-4000-8000-000000000005'
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000022',
    idFactory: ids(),
    accounts: [{ accountId, name: '光大银行信用卡(2690)', currency: 'CNY' }],
    rows: [row({
      sourceType: 'wechat', paymentMethod: '光大银行信用卡(2690)',
      paymentMethodKey: buildPaymentMethodKey('wechat', '光大银行信用卡(2690)'),
      mappingAction: null, mappedAccountId: null
    })]
  })
  assert.equal(plan.events[0].ledgerAccountId, accountId)
  assert.equal(plan.events[0].status, 'ready')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
  assert.equal(plan.issues[0].status, 'resolved')
  assert.equal(plan.issues[0].blocking, false)
  assert.equal(plan.members[0].objectId, plan.events[0].eventId)
})

test('本批账户选择必须覆盖旧的永久映射', () => {
  const oldAccountId = '51000000-0000-4000-8000-000000000031'
  const draftAccountId = '51000000-0000-4000-8000-000000000032'
  const paymentMethodKey = buildPaymentMethodKey('alipay', '余额')
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000031',
    idFactory: ids(),
    paymentMappings: [
      { sourceType: 'alipay', paymentMethodKey, mappingAction: 'account', accountId: draftAccountId }
    ],
    rows: [row({
      sourceType: 'alipay', paymentMethod: '余额', paymentMethodKey,
      mappingAction: 'account', mappedAccountId: oldAccountId
    })]
  })
  assert.equal(plan.events[0].ledgerAccountId, draftAccountId)
})

test('支付宝余额错误历史映射到现金账户时不得隐藏并沿用', () => {
  const wrongCashAccountId = '51000000-0000-4000-8000-000000000033'
  const paymentMethodKey = buildPaymentMethodKey('alipay', '余额')
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000033',
    idFactory: ids(),
    accounts: [{
      accountId: wrongCashAccountId,
      name: '开发验收现金(已验证)',
      type: 'cash',
      nature: 'asset',
      currency: 'CNY'
    }],
    paymentMappings: [{
      sourceType: 'alipay', paymentMethodKey,
      mappingAction: 'account', accountId: wrongCashAccountId,
      mappingScope: 'history'
    }],
    rows: [row({
      sourceType: 'alipay', transactionType: 'withdrawal', rawTransactionType: '账户存取',
      item: '提现-实时提现', counterparty: '浙江农商联合银行', paymentMethod: '余额',
      paymentMethodKey, mappingAction: 'account', mappedAccountId: wrongCashAccountId
    })]
  })

  assert.equal(plan.events[0].ledgerAccountId, null)
  assert.equal(plan.events[0].fieldSources.fundsProjection.from.label, '支付宝账户余额')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
  assert.equal(plan.issues[0].status, 'open')
})

test('有效历史映射也必须作为可修改账户项展示', () => {
  const walletAccountId = '51000000-0000-4000-8000-000000000034'
  const paymentMethodKey = buildPaymentMethodKey('wechat', '零钱')
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000034',
    idFactory: ids(),
    accounts: [{
      accountId: walletAccountId,
      name: '家庭零钱',
      type: 'wallet',
      nature: 'asset',
      currency: 'CNY'
    }],
    paymentMappings: [{
      sourceType: 'wechat', paymentMethodKey,
      mappingAction: 'account', accountId: walletAccountId,
      mappingScope: 'history'
    }],
    rows: [row({
      paymentMethod: '零钱', paymentMethodKey,
      mappingAction: 'account', mappedAccountId: walletAccountId
    })]
  })

  assert.equal(plan.events[0].ledgerAccountId, walletAccountId)
  assert.equal(plan.events[0].status, 'ready')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
  assert.equal(plan.issues[0].status, 'resolved')
  assert.equal(plan.issues[0].blocking, false)
})

test('同名账户不唯一时不得自动猜测', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000023',
    idFactory: ids(),
    accounts: [
      { accountId: '51000000-0000-4000-8000-000000000006', name: '支付宝花呗', currency: 'CNY' },
      { accountId: '51000000-0000-4000-8000-000000000007', name: '支付宝花呗', currency: 'CNY' }
    ],
    rows: [row({
      sourceType: 'alipay', paymentMethod: '花呗',
      paymentMethodKey: buildPaymentMethodKey('alipay', '花呗'), mappingAction: null, mappedAccountId: null
    })]
  })
  assert.equal(plan.events[0].ledgerAccountId, null)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
})

test('普通微信转账按外部收支处理，不制造第二个自有账户', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000020',
    idFactory: ids(),
    rows: [row({
      transactionType: 'transfer', rawTransactionType: '转账', item: '转给朋友',
      direction: 'expense', economicEffect: 'normal'
    })]
  })
  assert.equal(plan.events[0].economicNature, 'expense')
  assert.equal(plan.events[0].status, 'ready')
  assert.equal(plan.events[0].counterpartyLedgerAccountId, null)
  assert.equal(plan.issues.length, 0)
})

test('相同证据上下文的共同字段问题恢复为一张可批量处理卡片', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000015',
    idFactory: ids(),
    rows: [
      row({
        transactionType: 'unknown', sourceTransactionId: 'WX-SHARED-000015',
        amountMinor: '1234', item: '待分类记录'
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000015',
        identityId: '40000000-0000-4000-8000-000000000015',
        sourceTransactionId: 'WX-SHARED-000016', rowNumber: 2,
        localAt: '2026-08-02 12:00:00.000', utcAt: '2026-08-02 04:00:00.000',
        amountMinor: '5678', transactionType: 'unknown', item: '待分类记录'
      })
    ]
  })

  assert.equal(plan.events.length, 2)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'shared_fields')
  assert.equal(plan.issues[0].memberCount, 2)
})

test('不同支付账户的共同字段问题不得误批量', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000016',
    idFactory: ids(),
    rows: [
      row({ transactionType: 'unknown', sourceTransactionId: 'WX-SPLIT-000016', item: '待分类记录' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000016',
        identityId: '40000000-0000-4000-8000-000000000016',
        sourceTransactionId: 'WX-SPLIT-000017', rowNumber: 2,
        localAt: '2026-08-02 12:00:00.000', utcAt: '2026-08-02 04:00:00.000',
        amountMinor: '5678', transactionType: 'unknown', item: '待分类记录',
        paymentMethod: '支付宝账户余额', paymentMethodKey: 'd'.repeat(64)
      })
    ]
  })

  assert.equal(plan.issues.length, 2)
  assert.equal(plan.issues.every((issue) => issue.issueType === 'shared_fields'), true)
})

test('多笔退款仍保持逐笔问题，绝不批量套用同一原消费', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000017',
    idFactory: ids(),
    rows: [
      row({
        direction: 'income', economicEffect: 'refund', amountMinor: '100',
        sourceTransactionId: 'WX-REFUND-000017', item: '退款到账', counterparty: '商户甲'
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000017',
        identityId: '40000000-0000-4000-8000-000000000017',
        sourceTransactionId: 'WX-REFUND-000018', rowNumber: 2,
        localAt: '2026-08-02 12:00:00.000', utcAt: '2026-08-02 04:00:00.000',
        direction: 'income', economicEffect: 'refund', amountMinor: '200',
        item: '退款到账', counterparty: '商户乙'
      })
    ]
  })

  const refundIssues = plan.issues.filter((issue) => issue.issueType === 'refund_relation')
  assert.equal(refundIssues.length, 2)
  assert.equal(refundIssues.every((issue) => issue.memberCount === 1), true)
})

test('以后默认不计入仍生成可编辑账户问题而不是静默排除', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000014',
    idFactory: ids(),
    rows: [row({ mappingAction: 'ignore', mappedAccountId: null })]
  })

  assert.equal(plan.events[0].status, 'needs_action')
  assert.ok(plan.events[0].reasonCodes.includes('source_account_ignored_default'))
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
})

test('同一银行卡跨微信和支付宝只生成一个账户归属问题', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000008',
    idFactory: ids(),
    rows: [
      row({
        mappingAction: null,
        mappedAccountId: null,
        paymentMethod: '光大银行信用卡(2690)',
        paymentMethodKey: 'a'.repeat(64)
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000008',
        batchId: '20000000-0000-4000-8000-000000000008',
        importId: '30000000-0000-4000-8000-000000000008',
        sourceOrder: 1,
        sourceType: 'alipay',
        rowNumber: 2,
        identityId: '40000000-0000-4000-8000-000000000008',
        sourceTransactionId: 'ALI-CARD-000008',
        localAt: '2026-08-02 12:00:00.000',
        utcAt: '2026-08-02 04:00:00.000',
        amountMinor: '4321',
        paymentMethod: '光大银行信用卡(2690)',
        paymentMethodKey: 'b'.repeat(64),
        mappingAction: null,
        mappedAccountId: null
      })
    ]
  })

  assert.equal(plan.events.length, 2)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
  assert.equal(plan.issues[0].memberCount, 2)
})

test('同一银行卡跨三种账单已匹配时仍只显示一个已确认账户', () => {
  const accountId = '50000000-0000-4000-8000-000000000099'
  const makeCardRow = (sourceType, suffix, key) => row({
    rowId: `10000000-0000-4000-8000-${suffix}`,
    batchId: `20000000-0000-4000-8000-${suffix}`,
    importId: `30000000-0000-4000-8000-${suffix}`,
    identityId: `40000000-0000-4000-8000-${suffix}`,
    sourceType,
    sourceTransactionId: `${sourceType.toUpperCase()}-CARD-${suffix}`,
    localAt: `2026-08-${key === 'a' ? '01' : key === 'b' ? '02' : '03'} 12:00:00.000`,
    utcAt: `2026-08-${key === 'a' ? '01' : key === 'b' ? '02' : '03'} 04:00:00.000`,
    paymentMethod: '光大银行信用卡(2690)',
    paymentMethodKey: key.repeat(64),
    mappingAction: null,
    mappedAccountId: null
  })
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000099',
    idFactory: ids(),
    accounts: [{ accountId, name: '光大银行信用卡(2690)', type: 'credit', currency: 'CNY' }],
    rows: [
      makeCardRow('wechat', '000000000091', 'a'),
      makeCardRow('alipay', '000000000092', 'b'),
      makeCardRow('bank', '000000000093', 'c')
    ]
  })

  const accountIssues = plan.issues.filter((issue) => issue.issueType === 'account_mapping')
  assert.equal(accountIssues.length, 1)
  assert.equal(accountIssues[0].status, 'resolved')
  assert.equal(accountIssues[0].memberCount, 3)
})

test('映射优先级不受输入数组顺序影响，本批选择始终覆盖历史映射', () => {
  const historyId = '50000000-0000-4000-8000-000000000081'
  const batchId = '50000000-0000-4000-8000-000000000082'
  const paymentMethodKey = 'e'.repeat(64)
  const mappings = [
    {
      sourceType: 'wechat', paymentMethodKey, paymentMethodHint: '光大银行信用卡(2690)',
      mappingAction: 'account', accountId: historyId, accountType: 'credit', mappingScope: 'history'
    },
    {
      sourceType: 'wechat', paymentMethodKey, paymentMethodHint: '光大银行信用卡(2690)',
      mappingAction: 'account', accountId: batchId, accountType: 'credit', mappingScope: 'batch'
    }
  ]
  const build = (paymentMappings) => buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000081',
    idFactory: ids(), paymentMappings,
    rows: [row({ paymentMethod: '光大银行信用卡(2690)', paymentMethodKey, mappingAction: null, mappedAccountId: null })]
  })

  assert.equal(build(mappings).events[0].ledgerAccountId, batchId)
  assert.equal(build([...mappings].reverse()).events[0].ledgerAccountId, batchId)
})

test('同一物理账户的同级映射冲突必须回退为一个账户问题', () => {
  const rows = [
    row({
      paymentMethod: '光大银行信用卡(2690)', paymentMethodKey: 'f'.repeat(64),
      mappingAction: null, mappedAccountId: null
    }),
    row({
      rowId: '10000000-0000-4000-8000-000000000083',
      batchId: '20000000-0000-4000-8000-000000000083',
      importId: '30000000-0000-4000-8000-000000000083',
      identityId: '40000000-0000-4000-8000-000000000083',
      sourceType: 'alipay', sourceTransactionId: 'ALI-CONFLICT-000083',
      localAt: '2026-08-03 12:00:00.000', utcAt: '2026-08-03 04:00:00.000',
      paymentMethod: '光大银行信用卡(2690)', paymentMethodKey: '1'.repeat(64),
      mappingAction: null, mappedAccountId: null
    })
  ]
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000083',
    idFactory: ids(), rows,
    paymentMappings: [
      {
        sourceType: 'wechat', paymentMethodKey: 'f'.repeat(64), paymentMethodHint: '光大银行信用卡(2690)',
        mappingAction: 'account', accountId: '50000000-0000-4000-8000-000000000083',
        accountType: 'credit', mappingScope: 'history'
      },
      {
        sourceType: 'alipay', paymentMethodKey: '1'.repeat(64), paymentMethodHint: '光大银行信用卡(2690)',
        mappingAction: 'account', accountId: '50000000-0000-4000-8000-000000000084',
        accountType: 'credit', mappingScope: 'history'
      }
    ]
  })

  assert.deepEqual(plan.events.map((event) => event.ledgerAccountId), [null, null])
  const accountIssues = plan.issues.filter((issue) => issue.issueType === 'account_mapping')
  assert.equal(accountIssues.length, 1)
  assert.equal(accountIssues[0].status, 'open')
  assert.equal(accountIssues[0].memberCount, 2)
})

test('余额宝收益按收入处理，不生成资金流转问题', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000009',
    idFactory: ids(),
    rows: [row({
      sourceType: 'alipay',
      direction: 'neutral',
      transactionType: 'transfer',
      item: '余额宝-2026.07.02-收益发放',
      paymentMethod: '支付宝余额宝',
      paymentMethodKey: 'c'.repeat(64),
      mappingAction: null,
      mappedAccountId: null
    })]
  })

  assert.equal(plan.events[0].economicNature, 'income')
  assert.equal(plan.events[0].flowDirection, 'inflow')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'account_mapping')
})

test('失败来源记录保留为 excluded 事件而不是伪装成用户跳过', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000005',
    idFactory: ids(),
    rows: [row({ economicEffect: 'failed' })]
  })

  assert.equal(plan.events[0].status, 'excluded')
  assert.ok(plan.events[0].reasonCodes.includes('transaction_failed'))
  assert.equal(plan.issues.length, 0)
})

test('只有商户、账户与金额匹配的部分退款仍需人工确认', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000006',
    idFactory: ids(),
    rows: [
      row({ amountMinor: '1000', item: '原消费' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000006',
        identityId: '40000000-0000-4000-8000-000000000006',
        sourceTransactionId: 'WX-REFUND-000006',
        rowNumber: 2,
        localAt: '2026-08-03 12:00:00.000',
        utcAt: '2026-08-03 04:00:00.000',
        amountMinor: '300',
        direction: 'income',
        economicEffect: 'refund',
        item: '部分退款'
      })
    ]
  })

  assert.equal(plan.relations.length, 1)
  assert.equal(plan.relations[0].relationType, 'refund_of')
  assert.equal(plan.relations[0].status, 'proposed')
  assert.equal(plan.events.find((event) => event.economicNature === 'refund').status, 'needs_action')
  assert.equal(plan.issues.some((issue) => issue.issueType === 'refund_relation'), true)
})

test('唯一稳定订单号匹配压制同商户弱候选并自动确认', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000016',
    idFactory: ids(),
    rows: [
      row({ amountMinor: '1000', sourceTransactionId: 'WX-EXPENSE-000016', sourceMerchantOrderId: 'MERCHANT-ORDER-000016', counterparty: '重复商户' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000016',
        identityId: '40000000-0000-4000-8000-000000000016',
        sourceTransactionId: 'WX-EXPENSE-000017',
        sourceMerchantOrderId: 'MERCHANT-ORDER-000017',
        rowNumber: 2,
        localAt: '2026-08-02 12:00:00.000',
        utcAt: '2026-08-02 04:00:00.000',
        amountMinor: '900',
        counterparty: '重复商户'
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000017',
        identityId: '40000000-0000-4000-8000-000000000017',
        sourceTransactionId: 'WX-REFUND-000016',
        sourceMerchantOrderId: 'MERCHANT-ORDER-000016',
        rowNumber: 3,
        localAt: '2026-08-03 12:00:00.000',
        utcAt: '2026-08-03 04:00:00.000',
        amountMinor: '300',
        direction: 'income',
        economicEffect: 'refund',
        counterparty: '重复商户',
        item: '退款入账'
      })
    ]
  })

  assert.equal(plan.relations.length, 1)
  assert.equal(plan.relations[0].status, 'confirmed')
  assert.deepEqual(plan.relations[0].reasonCodes, ['auto_refund_exact_reference'])
  assert.equal(plan.issues.some((issue) => issue.issueType === 'refund_relation'), false)
})

test('原消费行标记已退款时仍保持支出，只把退款入账行识别为退款', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000010',
    idFactory: ids(),
    rows: [
      row({ amountMinor: '1000', economicEffect: 'refund', rawStatus: '已退款（¥3.00）', counterparty: '同一商户' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000010',
        identityId: '40000000-0000-4000-8000-000000000010',
        sourceTransactionId: 'WX-REFUND-000010',
        rowNumber: 2,
        localAt: '2026-08-03 12:00:00.000',
        utcAt: '2026-08-03 04:00:00.000',
        amountMinor: '300',
        direction: 'income',
        economicEffect: 'refund',
        counterparty: '同一商户',
        item: '退款入账'
      })
    ]
  })

  assert.deepEqual(plan.events.map((event) => event.economicNature).sort(), ['expense', 'refund'])
  assert.equal(plan.relations.length, 1)
  assert.equal(plan.relations[0].status, 'confirmed')
  assert.equal(plan.issues.length, 0)
})

test('支付宝明确退款记录即使原始收支为不计收支也投影为退款流入', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000018',
    idFactory: ids(),
    rows: [row({
      sourceType: 'alipay',
      sourceTransactionId: 'ALI-REFUND-000018',
      direction: 'neutral',
      transactionType: 'refund',
      economicEffect: 'refund',
      rawStatus: '退款成功',
      amountMinor: '300'
    })]
  })

  assert.equal(plan.events[0].economicNature, 'refund')
  assert.equal(plan.events[0].flowDirection, 'inflow')
})

test('只有金额和账户相同但商户不同，不再抓最近五笔支出充当退款候选', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000011',
    idFactory: ids(),
    rows: [
      row({ amountMinor: '1000', counterparty: '早餐店' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000011',
        identityId: '40000000-0000-4000-8000-000000000011',
        sourceTransactionId: 'WX-REFUND-000011',
        rowNumber: 2,
        localAt: '2026-08-03 12:00:00.000',
        utcAt: '2026-08-03 04:00:00.000',
        amountMinor: '300',
        direction: 'income',
        economicEffect: 'refund',
        counterparty: '服装店',
        item: '退款入账'
      })
    ]
  })

  assert.equal(plan.relations.length, 0)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].issueType, 'refund_relation')
  assert.equal(plan.issues[0].candidateCount, 0)
})

test('平台商户名不同但规范化商品标题相同的退款保留人工候选', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000019',
    idFactory: ids(),
    rows: [
      row({
        sourceType: 'alipay', sourceTransactionId: 'ALI-EXPENSE-000019',
        localDate: '2026-07-04', localAt: '2026-07-04 11:37:00.000', utcAt: '2026-07-04 03:37:00.000',
        amountMinor: '466', counterparty: '1688平台商家',
        item: '全款交易：手持小型缝纫机便携式迷你微型手持简易缝衣服神器'
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000019',
        identityId: '40000000-0000-4000-8000-000000000019',
        sourceType: 'alipay', sourceTransactionId: 'ALI-REFUND-000019', rowNumber: 2,
        localDate: '2026-07-04', localAt: '2026-07-04 15:02:00.000', utcAt: '2026-07-04 07:02:00.000',
        amountMinor: '466', direction: 'neutral', transactionType: 'refund', economicEffect: 'refund',
        counterparty: '义乌市千单日用品有限公司',
        item: '退款-手持小型缝纫机便携式迷你微型手持简易缝衣服神器'
      })
    ]
  })

  const refundIssue = plan.issues.find((issue) => issue.issueType === 'refund_relation')
  const refundRelation = plan.relations.find((relation) => relation.relationType === 'refund_of')
  assert.equal(refundIssue.candidateCount, 1)
  assert.equal(refundRelation.status, 'proposed')
  assert.deepEqual(refundRelation.reasonCodes, ['refund_item_evidence_candidate'])
})

test('退款存在多个同商户证据候选时保留人工选择并准确返回候选数', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000012',
    idFactory: ids(),
    rows: [
      row({ amountMinor: '1000', counterparty: '重复商户' }),
      row({
        rowId: '10000000-0000-4000-8000-000000000012',
        identityId: '40000000-0000-4000-8000-000000000012',
        sourceTransactionId: 'WX-EXPENSE-000012',
        rowNumber: 2,
        localAt: '2026-08-02 12:00:00.000',
        utcAt: '2026-08-02 04:00:00.000',
        amountMinor: '900',
        counterparty: '重复商户'
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000013',
        identityId: '40000000-0000-4000-8000-000000000013',
        sourceTransactionId: 'WX-REFUND-000012',
        rowNumber: 3,
        localAt: '2026-08-03 12:00:00.000',
        utcAt: '2026-08-03 04:00:00.000',
        amountMinor: '300',
        direction: 'income',
        economicEffect: 'refund',
        counterparty: '重复商户',
        item: '退款入账'
      })
    ]
  })

  const issue = plan.issues.find((item) => item.issueType === 'refund_relation')
  assert.equal(plan.relations.filter((relation) => relation.relationType === 'refund_of').length, 2)
  assert.equal(plan.relations.every((relation) => relation.status === 'proposed'), true)
  assert.equal(issue.candidateCount, 2)
})

test('同商户但相隔超过退款窗口时不得自动关联', () => {
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000014',
    idFactory: ids(),
    rows: [
      row({
        localDate: '2025-01-01', localAt: '2025-01-01 12:00:00.000', utcAt: '2025-01-01 04:00:00.000',
        amountMinor: '1000', counterparty: '长期商户'
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000014',
        identityId: '40000000-0000-4000-8000-000000000014',
        sourceTransactionId: 'WX-REFUND-000014', rowNumber: 2,
        localAt: '2026-08-03 12:00:00.000', utcAt: '2026-08-03 04:00:00.000',
        amountMinor: '300', direction: 'income', economicEffect: 'refund',
        counterparty: '长期商户', item: '退款入账'
      })
    ]
  })

  assert.equal(plan.relations.length, 0)
  assert.equal(plan.issues.some((issue) => issue.issueType === 'refund_relation'), true)
})

test('花呗信用购合并还款只保留两个真实负债账户并生成一个分配问题', () => {
  const bankId = '51000000-0000-4000-8000-000000000101'
  const huabeiId = '51000000-0000-4000-8000-000000000102'
  const creditId = '51000000-0000-4000-8000-000000000103'
  const mappings = [
    ['浙江农商联合银行储蓄卡(5564)', bankId],
    ['花呗', huabeiId],
    ['江苏银行信用购', creditId]
  ].map(([paymentMethod, accountId]) => ({
    sourceType: 'alipay', paymentMethodKey: buildPaymentMethodKey('alipay', paymentMethod),
    paymentMethodHint: paymentMethod, mappingAction: 'account', accountId
  }))
  const plan = buildOrganizePlan({
    updateId: '60000000-0000-4000-8000-000000000101',
    idFactory: ids(),
    paymentMappings: mappings,
    rows: [
      row({
        rowId: '10000000-0000-4000-8000-000000000101', identityId: '40000000-0000-4000-8000-000000000101',
        sourceTransactionId: 'ALI-HUABEI-000101', sourceType: 'alipay', rowNumber: 1,
        paymentMethod: '花呗', paymentMethodKey: buildPaymentMethodKey('alipay', '花呗'),
        localAt: '2026-07-01 12:00:00.000', utcAt: '2026-07-01 04:00:00.000',
        mappingAction: null, mappedAccountId: null
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000102', identityId: '40000000-0000-4000-8000-000000000102',
        sourceTransactionId: 'ALI-CREDIT-000102', sourceType: 'alipay', rowNumber: 2,
        paymentMethod: '江苏银行信用购', paymentMethodKey: buildPaymentMethodKey('alipay', '江苏银行信用购'),
        localAt: '2026-07-02 12:00:00.000', utcAt: '2026-07-02 04:00:00.000',
        amountMinor: '2345', mappingAction: null, mappedAccountId: null
      }),
      row({
        rowId: '10000000-0000-4000-8000-000000000103', identityId: '40000000-0000-4000-8000-000000000103',
        sourceTransactionId: 'ALI-REPAY-000103', sourceType: 'alipay', rowNumber: 3,
        transactionType: 'transfer', rawTransactionType: '信用借还', direction: 'neutral',
        counterparty: '花呗|信用购', item: '自动还款-花呗|信用购2026年07月账单', rawStatus: '还款成功',
        paymentMethod: '浙江农商联合银行储蓄卡(5564)',
        paymentMethodKey: buildPaymentMethodKey('alipay', '浙江农商联合银行储蓄卡(5564)'),
        localAt: '2026-08-08 12:00:00.000', utcAt: '2026-08-08 04:00:00.000',
        amountMinor: '1036610', mappingAction: null, mappedAccountId: null
      })
    ]
  })

  const repayment = plan.events.find((event) => event.amountMinor === '1036610')
  assert.equal(repayment.ledgerAccountId, bankId)
  assert.equal(repayment.counterpartyLedgerAccountId, null)
  assert.equal(repayment.fieldSources.fundsProjection.to.referenceKind, 'aggregate')
  assert.deepEqual(
    repayment.fieldSources.fundsProjection.to.candidates.map((candidate) => candidate.accountId).sort(),
    [creditId, huabeiId].sort()
  )
  assert.equal(plan.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'transfer_accounts').length, 1)
  assert.equal(plan.issues.some((issue) => issue.issueType === 'account_mapping' &&
    issue.primaryReasonCode === 'payment_reference_mapping_required' && issue.memberCount === 1 &&
    plan.members.some((member) => member.issueId === issue.issueId && member.objectId === repayment.eventId)), false)
})
