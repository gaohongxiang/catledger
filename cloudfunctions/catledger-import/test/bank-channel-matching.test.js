const assert = require('node:assert/strict')
const test = require('node:test')

const { buildOrganizePlan } = require('../src/organizer-planner')
const { buildPaymentMethodKey } = require('../src/identity')
const { getRowSemantic } = require('../src/row-semantic-resolver')
const { VERSION, bankChannelPair, semanticRowsAfterConfirmation } = require('../src/bank-channel-matching')
const { applyFields } = require('../src/review/policy')
const { bankTime } = require('../src/parsers/bank')
const { parseLocalDateTime } = require('../src/parsers/normalize')

const ACCOUNT = '50000000-0000-4000-8000-000000000001'
const OTHER_ACCOUNT = '50000000-0000-4000-8000-000000000002'
const CATEGORY = '70000000-0000-4000-8000-000000000001'
const CANDIDATE_REASON = 'bank_channel_same_event_candidate'
const accounts = [ACCOUNT, OTHER_ACCOUNT].map((accountId, index) => ({
  accountId, name: `合成记账账户${index + 1}`, type: 'credit', currency: 'CNY'
}))

function ids() {
  let next = 1
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`
}

// 全部为合成 planning rows；真实来源规则负责生成语义，不伪造已解析动作。
function row(sourceType, suffix = '1', overrides = {}) {
  const bank = sourceType === 'bank'
  const result = {
    rowId: `${sourceType}-row-${suffix}`,
    batchId: `${sourceType}-batch`,
    importId: `${sourceType}-import`,
    sourceType,
    sourceFormat: bank ? 'bank_xls' : sourceType === 'wechat' ? 'wechat_xlsx' : 'alipay_app_csv',
    sourceProfileId: `${sourceType}-synthetic-profile`,
    sourceOrder: bank ? 0 : 1,
    rowNumber: Number(suffix),
    parseState: 'valid',
    identityId: `${sourceType}-identity-${suffix}`,
    identityState: 'new',
    sourceTransactionId: `SYNTHETIC-${sourceType}-${suffix}`,
    sourceOrderId: null,
    sourceMerchantOrderId: null,
    rawTransactionTime: bank ? '2026-09-01 12:34' : '2026-09-01 12:34:45',
    localDate: '2026-09-01',
    localAt: bank ? '2026-09-01 12:34:00.000' : '2026-09-01 12:34:45.000',
    utcAt: bank ? '2026-09-01 04:34:00.000' : '2026-09-01 04:34:45.000',
    timezoneOffsetMinutes: -480,
    amountMinor: '1234',
    currency: 'CNY',
    direction: 'expense',
    rawTransactionType: bank ? '' : sourceType === 'wechat' ? '商户消费' : '购物',
    transactionType: bank ? 'unknown' : 'payment',
    rawStatus: bank ? '' : '支付成功',
    economicEffect: 'normal',
    bankStatementKind: bank ? 'credit' : null,
    // 银行本地账户引用与平台卡引用保持独立，唯有已确认映射连接到账本账户。
    paymentMethod: bank ? '****1234' : '合成银行信用卡(1234)',
    mappingAction: 'account',
    mappedAccountId: ACCOUNT,
    suggestedCategoryId: CATEGORY,
    counterparty: bank ? '合成银行交易' : '合成平台商户',
    item: bank ? '财付通-合成收单商户' : '合成商品明细',
    sourceNote: bank ? '合成银行账单附记' : '合成平台附记',
    existingTransactionId: null,
    ...overrides
  }
  result.paymentMethodKey = buildPaymentMethodKey(sourceType, result.paymentMethod)
  result.semantic = getRowSemantic(result)
  result.transactionType = result.semantic.legacy.transactionType
  result.economicEffect = result.semantic.legacy.economicEffect
  return result
}

function plan(rows) {
  return buildOrganizePlan({ updateId: 'synthetic-bank-channel-update', rows, accounts, idFactory: ids() })
}

function channelIssues(result) {
  return result.issues.filter(issue => issue.issueType === 'same_event' && issue.reasonCodes.includes(CANDIDATE_REASON))
}

function memberRows(result, issue) {
  const byId = new Map(result.events.map(event => [event.eventId, event]))
  return result.members.filter(member => member.issueId === issue.issueId && member.objectType === 'event')
    .flatMap(member => byId.get(member.objectId).fieldSources.rowIds).sort()
}

function assertManualGroup(result, rows) {
  const issues = channelIssues(result)
  assert.equal(issues.length, 1, '渠道证据应产生一个完整的待确认同笔组')
  assert.deepEqual(memberRows(result, issues[0]), rows.map(item => item.rowId).sort())
  assert.equal(issues[0].memberCount, rows.length)
  assert.equal(issues[0].candidateCount, rows.length - 1)
  assert.equal(issues[0].blocking, true)
  assert.equal(result.events.length, rows.length, '候选不得减少事件数')
  assert.equal(result.evidence.length, rows.length)
  assert.equal(new Set(result.evidence.map(evidence => evidence.eventId)).size, rows.length)
  assert.equal(result.counts.duplicateEvidenceCount, 0, '候选不能计作已合并重复证据')
  assert.ok(result.events.every(event => event.status === 'needs_action' && event.reasonCodes.includes(CANDIDATE_REASON)))
}

function assertNoChannelCandidate(rows) {
  const result = plan(rows)
  assert.equal(channelIssues(result).length, 0)
  assert.ok(result.events.every(event => !event.reasonCodes.includes(CANDIDATE_REASON)))
  assert.equal(result.events.length, rows.length)
  assert.equal(result.evidence.length, rows.length)
}

for (const [prefix, platform] of [
  ['财付通-', 'wechat'], ['财付通--', 'wechat'], ['财付通快捷-', 'wechat'],
  ['微信支付-', 'wechat'], ['支付宝-', 'alipay'], ['支付宝快捷-', 'alipay']
]) {
  test(`${prefix}渠道与同一已确认账户生成同笔候选，无须完整商户文本互含`, () => {
    const rows = [row('bank', '1', { item: `${prefix}合成收单商户` }), row(platform)]
    assert.equal(rows[0].semantic.sourceAction, null)
    assert.equal(rows[0].semantic.moneyEffect, 'financial')
    assert.deepEqual(rows[0].semantic.issues.map(issue => issue.code), ['row_transaction_type_unknown'])
    assert.equal(rows[1].semantic.sourceAction, 'purchase')
    assertManualGroup(plan(rows), rows)
  })
}

test('已知银行消费同样仅为人工候选，不利用银行流水号自动合并', () => {
  const bank = row('bank', '1', { rawTransactionType: '消费' })
  const platform = row('wechat', '1', { sourceTransactionId: bank.sourceTransactionId })
  assert.equal(bank.semantic.sourceAction, 'purchase')
  assertManualGroup(plan([bank, platform]), [bank, platform])
})

for (const bankType of ['', '退款']) {
  test(`银行${bankType || '缺类型'}入流与平台退款保留完整同笔组，随后再核对退款关系`, () => {
    const rows = [
      row('bank', '1', { direction: 'income', rawTransactionType: bankType }),
      row('wechat', '1', { direction: 'income', rawTransactionType: '退款', rawStatus: '退款成功' })
    ]
    assert.equal(rows[1].semantic.sourceAction, 'refund_credit')
    const result = plan(rows)
    assertManualGroup(result, rows)
    assert.ok(!result.issues.some(issue => issue.status === 'open' && issue.issueType === 'refund_relation'))
    assert.equal(result.events.find(event => event.sourceType === 'wechat').economicNature, 'refund')
    assert.equal(result.relations.length, 0, '同笔候选不伪造原消费或退款关系')
  })
}

test('银行渠道前缀必须明确指向该平台，商户中间或近似字样不算渠道', async t => {
  const cases = [
    ['渠道指向支付宝而证据来自微信', '支付宝-合成收单商户', 'wechat'],
    ['渠道指向微信而证据来自支付宝', '财付通-合成收单商户', 'alipay'],
    ['商户中间出现微信支付', '合成门店微信支付用品', 'wechat'],
    ['商户后缀出现财付通', '合成商户-财付通', 'wechat'],
    ['商户中间出现支付宝', '合成支付宝用品商店', 'alipay'],
    ['财付通近似商户名', '财付通合成商店', 'wechat'],
    ['财付通还款不是快捷支付渠道', '财付通还款-合成业务', 'wechat'],
    ['支付宝还款不是快捷支付渠道', '支付宝还款-合成业务', 'alipay'],
    ['没有明确渠道', '合成收单商户', 'wechat']
  ]
  for (const [name, item, platform] of cases) await t.test(name, () => {
    assertNoChannelCandidate([row('bank', '1', { item }), row(platform)])
  })
  await t.test('两个平台来源没有银行证据', () => {
    assertNoChannelCandidate([row('wechat'), row('alipay')])
  })
})

test('同卡尾号不能替代两边已确认相同账户，账户不符与缺失都不产生渠道候选', async t => {
  const missing = { mappingAction: null, mappedAccountId: null }
  const cases = [
    ['银行账户未确认', row('bank', '1', missing), row('wechat')],
    ['平台账户未确认', row('bank'), row('wechat', '1', missing)],
    ['两边账户均未确认', row('bank', '1', missing), row('wechat', '1', missing)],
    ['同尾号已明确属于不同账户', row('bank'), row('wechat', '1', { mappedAccountId: OTHER_ACCOUNT })]
  ]
  for (const [name, bank, platform] of cases) await t.test(name, () => assertNoChannelCandidate([bank, platform]))
})

test('交易时间必须有原始时分并落在同一分钟，不能使用日期补零或滚动60秒窗口', async t => {
  const midnight = {
    rawTransactionTime: '2026-09-01 00:00:00', localAt: '2026-09-01 00:00:00.000', utcAt: '2026-08-31 16:00:00.000'
  }
  for (const rawTransactionTime of ['', '2026-09-01', '20260901']) await t.test(`银行原始时间没有时分：${rawTransactionTime || '缺失'}`, () => {
    assertNoChannelCandidate([row('bank', '1', { ...midnight, rawTransactionTime }), row('wechat', '1', midnight)])
  })
  await t.test('平台原始时间没有时分', () => {
    assertNoChannelCandidate([row('bank', '1', midnight), row('wechat', '1', { ...midnight, rawTransactionTime: '2026-09-01' })])
  })
  await t.test('相差五秒但跨分钟', () => {
    assertNoChannelCandidate([
      row('bank', '1', { rawTransactionTime: '2026-09-01 12:34:55', localAt: '2026-09-01 12:34:55.000', utcAt: '2026-09-01 04:34:55.000' }),
      row('wechat', '1', { rawTransactionTime: '2026-09-01 12:35:00', localAt: '2026-09-01 12:35:00.000', utcAt: '2026-09-01 04:35:00.000' })
    ])
  })
  await t.test('相同时分但日期不同', () => {
    assertNoChannelCandidate([row('bank'), row('wechat', '1', {
      rawTransactionTime: '2026-09-02 12:34:00', localDate: '2026-09-02', localAt: '2026-09-02 12:34:00.000', utcAt: '2026-09-02 04:34:00.000'
    })])
  })
})

test('同一分钟和同账户不能覆盖金额、币种或原始方向差异', async t => {
  for (const [name, overrides] of [
    ['金额不同', { amountMinor: '1235' }],
    ['币种不同', { currency: 'USD' }],
    ['方向相反', { direction: 'income', rawTransactionType: '退款', rawStatus: '退款成功' }]
  ]) await t.test(name, () => assertNoChannelCandidate([row('bank'), row('wechat', '1', overrides)]))
})

test('未知状态、失败和关闭不能借另一来源的成功状态生成候选', async t => {
  for (const sourceType of ['bank', 'wechat']) {
    for (const [rawStatus, moneyEffect] of [['待核实', 'unknown'], ['交易失败', 'failed'], ['交易关闭', 'closed']]) {
      await t.test(`${sourceType} ${rawStatus}`, () => {
        const changed = row(sourceType, '1', { rawStatus })
        assert.equal(changed.semantic.moneyEffect, moneyEffect)
        assertNoChannelCandidate(sourceType === 'bank' ? [changed, row('wechat')] : [row('bank'), changed])
      })
    }
  }
  await t.test('支付宝非资金生命周期', () => {
    const nonFinancial = row('alipay', '1', { rawTransactionType: '信用借还', rawStatus: '芝麻免押下单成功', direction: 'neutral', amountMinor: '0' })
    assert.equal(nonFinancial.semantic.moneyEffect, 'non_financial')
    assertNoChannelCandidate([row('bank', '1', { item: '支付宝-合成收单商户', direction: 'neutral', amountMinor: '0' }), nonFinancial])
  })
})

test('组合支付、贷款分期及其他动作不混入银行消费退款同笔候选', async t => {
  await t.test('平台组合支付', () => {
    const platform = row('wechat', '1', { paymentMethod: '合成银行信用卡(1234)&零钱' })
    assert.ok(platform.semantic.issues.some(issue => issue.code === 'payment_components_ambiguous'))
    assertNoChannelCandidate([row('bank'), platform])
  })
  await t.test('银行有多个资金账户', () => {
    const bank = row('bank', '1', { paymentMethod: '****1234&****5678' })
    assert.ok(bank.semantic.issues.some(issue => issue.code === 'payment_components_ambiguous'))
    assertNoChannelCandidate([bank, row('wechat')])
  })
  await t.test('平台信用卡还款', () => {
    const platform = row('wechat', '1', { rawTransactionType: '信用卡还款', rawStatus: '还款成功', counterparty: '合成另一银行信用卡(5678)' })
    assert.equal(platform.semantic.sourceAction, 'repayment')
    assertNoChannelCandidate([row('bank'), platform])
  })
  await t.test('平台借款到账', () => {
    const platform = row('alipay', '1', { rawTransactionType: '借款', direction: 'income' })
    assert.equal(platform.semantic.sourceAction, 'borrow')
    assertNoChannelCandidate([row('bank', '1', { item: '支付宝-合成收单商户', direction: 'income' }), platform])
  })
  for (const [component, sourceAction] of [['principal', 'installment_principal'], ['fee', 'fee']]) {
    await t.test(`银行分期${component}`, () => {
      const bank = row('bank', '1', { installmentFields: { reference: 'SYNTHETIC-CONTRACT', period: '1', terms: '3', component } })
      assert.equal(bank.semantic.sourceAction, sourceAction)
      assert.equal(bank.semantic.relationHints.installment.creditStatement, true)
      assertNoChannelCandidate([bank, row('wechat')])
    })
  }
  await t.test('银行明确手续费与平台消费不相容', () => {
    const bank = row('bank', '1', { rawTransactionType: '手续费' })
    assert.equal(bank.semantic.sourceAction, 'fee')
    assertNoChannelCandidate([bank, row('wechat')])
  })
  await t.test('银行有无法识别的类型并非缺交易类型', () => {
    const bank = row('bank', '1', { rawTransactionType: '合成未知银行业务' })
    assert.equal(bank.semantic.sourceAction, null)
    assertNoChannelCandidate([bank, row('wechat')])
  })
  await t.test('平台普通收款不能当退款', () => {
    const platform = row('wechat', '1', { direction: 'income', rawTransactionType: '二维码收款', rawStatus: '收款成功' })
    assert.equal(platform.semantic.sourceAction, 'receipt')
    assertNoChannelCandidate([row('bank', '1', { direction: 'income' }), platform])
  })
})

function permutations(items) {
  return items.length < 2 ? [items] : items.flatMap((item, index) =>
    permutations(items.filter((_, candidate) => candidate !== index)).map(rest => [item, ...rest]))
}

test('一条银行流水对应同分钟两条独立平台记录时全部留待确认，文件和行序不改变成员集合', () => {
  const rows = [row('bank'), row('wechat', '1'), row('wechat', '2')]
  for (const order of permutations(rows)) {
    const reordered = order.map((item, index) => ({ ...item, sourceOrder: index, rowNumber: 10 - index }))
    assertManualGroup(plan(reordered), rows)
  }
})

test('两边各有多笔同额记录时不得贪心选择首条、丢候选或自动合并', () => {
  const rows = [row('bank', '1'), row('bank', '2'), row('wechat', '1'), row('wechat', '2')]
  for (const order of permutations(rows)) {
    const reordered = order.map((item, index) => ({ ...item, sourceOrder: index, rowNumber: index + 1 }))
    assertManualGroup(plan(reordered), rows)
  }
})

test('银行规则拒绝的证据不能经旧文本相似规则重新成为同笔候选', async t => {
  const sameText = { counterparty: '合成同名商户', item: '财付通-合成同名商品', sourceNote: '' }
  const midnight = { localAt: '2026-09-01 00:00:00.000', utcAt: '2026-08-31 16:00:00.000' }
  const cases = [
    ['账户已确认不同', {}, { mappedAccountId: OTHER_ACCOUNT }],
    ['同名文本缺少渠道', { item: '合成同名商品' }, { item: '合成同名商品' }],
    ['渠道明确指向其他平台', { item: '支付宝-合成同名商品' }, { item: '支付宝-合成同名商品' }],
    ['日期补零不能成为精确时间', { ...midnight, rawTransactionTime: '2026-09-01' }, { ...midnight, rawTransactionTime: '2026-09-01 00:00:00' }],
    ['银行有无法识别的业务类型', { rawTransactionType: '合成未知银行业务' }, {}]
  ]
  for (const [name, bankOverrides, platformOverrides] of cases) await t.test(name, () => {
    const result = plan([row('bank', '1', { ...sameText, ...bankOverrides }), row('wechat', '1', { ...sameText, ...platformOverrides })])
    assert.equal(result.issues.filter(issue => issue.issueType === 'same_event').length, 0,
      '被渠道契约拒绝的银行证据不能改走缺少校验的旧同笔路径')
    assert.ok(result.events.every(event => !event.reasonCodes.includes('same_event_candidate')))
  })
})

test('同一银行证据给出互相矛盾的平台渠道时不能仅采用先出现的渠道', () => {
  const bank = row('bank', '1', { item: '财付通-合成收单商户', counterparty: '支付宝-合成收单商户' })
  assertNoChannelCandidate([bank, row('wechat')])
})

test('原始时间已被银行解析器确认到分钟时，等价文本形式不应丢失精度', async t => {
  for (const rawTransactionTime of ['20260901 12:34', '２０２６/０９/０１ １２：３４', "'20260901123400"]) {
    await t.test(rawTransactionTime, () => {
      const normalized = parseLocalDateTime(bankTime(rawTransactionTime, ''), -480)
      assert.ok(normalized, '必须是现有银行解析器支持的时间，不扩展解析范围')
      assert.equal(normalized.utcAt, '2026-09-01 04:34:00.000')
      const rows = [row('bank', '1', { ...normalized, rawTransactionTime }), row('wechat')]
      assertManualGroup(plan(rows), rows)
    })
  }
})

test('Excel 序列时间必须包含实际日内小数，整数日期不能推定为零点交易', async t => {
  const rawTransactionTime = String(Date.UTC(2026, 8, 1, 12, 34, 45) / 86400000 + 25569)
  const normalized = parseLocalDateTime(rawTransactionTime, -480)
  assert.ok(normalized)
  assert.equal(normalized.utcAt, '2026-09-01 04:34:45.000')
  await t.test('微信 XLSX 小数时间保留原始交易分钟', () => {
    const rows = [row('bank', '1', { item: '财付通快捷-合成收单商户' }), row('wechat', '1', { ...normalized, rawTransactionTime })]
    assertManualGroup(plan(rows), rows)
  })
  await t.test('银行 XLS 小数时间同样具有日内时间证据', () => {
    const rows = [row('bank', '1', { ...normalized, rawTransactionTime }), row('wechat')]
    assertManualGroup(plan(rows), rows)
  })
  const date = Math.floor(Number(rawTransactionTime))
  for (const dateOnly of [String(date), `${date}.0000`]) await t.test(`Excel 只有日期：${dateOnly}`, () => {
    const midnight = parseLocalDateTime(dateOnly, -480)
    assert.ok(midnight)
    const bank = row('bank', '1', { ...midnight, rawTransactionTime: '2026-09-01 00:00:00' })
    const platform = row('wechat', '1', { ...midnight, rawTransactionTime: dateOnly })
    assertNoChannelCandidate([bank, platform])
  })
  await t.test('普通 CSV 数字不能直接套用 Excel 时间语义', () => {
    assertNoChannelCandidate([row('bank'), row('wechat', '1', { ...normalized, rawTransactionTime, sourceFormat: 'wechat_csv' })])
  })
})

function separateEvents(rows) {
  const idFactory = ids()
  return rows.map(item => buildOrganizePlan({ updateId: 'synthetic-bank-channel-update', rows: [item], accounts, idFactory }).events[0])
}

test('人工改值后按原始证据重验，不以双方改成相同金额或同一分钟掩盖冲突', async t => {
  const rows = [row('bank'), row('wechat')]
  const [bank, platform] = separateEvents(rows)
  assert.equal(bankChannelPair(bank, platform), true)
  await t.test('双方金额改成相同新值仍与来源不符', () => {
    assert.equal(bankChannelPair(applyFields(bank, { amountMinor: '1235' }), applyFields(platform, { amountMinor: '1235' })), false)
  })
  await t.test('平台时间改到下一分钟', () => {
    const changed = applyFields(platform, { occurredLocalAt: '2026-09-01 12:35:45', timezoneOffsetMinutes: -480 })
    assert.equal(bankChannelPair(bank, changed), false)
  })
  await t.test('平台来源精确到秒，人工改秒数仍属来源冲突', () => {
    const changed = applyFields(platform, { occurredLocalAt: '2026-09-01 12:34:59', timezoneOffsetMinutes: -480 })
    assert.equal(bankChannelPair(bank, changed), false)
  })
  await t.test('银行来源也精确到秒时不允许手工改秒数后合并', () => {
    const preciseBank = separateEvents([row('bank', '1', {
      rawTransactionTime: '2026-09-01 12:34:10', localAt: '2026-09-01 12:34:10.000', utcAt: '2026-09-01 04:34:10.000'
    })])[0]
    assert.equal(bankChannelPair(preciseBank, platform), true)
    const changed = applyFields(preciseBank, { occurredLocalAt: '2026-09-01 12:34:20', timezoneOffsetMinutes: -480 })
    assert.equal(bankChannelPair(changed, platform), false)
  })
  await t.test('重存相同时间没有来源冲突', () => {
    const unchanged = applyFields(platform, { occurredLocalAt: '2026-09-01 12:34:45', timezoneOffsetMinutes: -480 })
    assert.equal(bankChannelPair(bank, unchanged), true)
  })
})

test('退款已自动关联原消费仍可确认银行同笔，不能因新增解释性原因变成不可操作', async t => {
  const sourceOrderId = 'SYNTHETIC-REFUND-ORIGINAL-ORDER'
  const original = row('wechat', '9', {
    sourceOrderId, rawTransactionTime: '2026-08-31 12:34:45', localDate: '2026-08-31',
    localAt: '2026-08-31 12:34:45.000', utcAt: '2026-08-31 04:34:45.000'
  })
  const bank = row('bank', '1', { direction: 'income' })
  const platform = row('wechat', '1', { sourceOrderId, direction: 'income', rawTransactionType: '退款', rawStatus: '退款成功' })
  const result = plan([original, bank, platform])
  const issues = channelIssues(result)
  assert.equal(issues.length, 1)
  const bankEvent = result.events.find(event => event.fieldSources.rowIds.includes(bank.rowId))
  const platformEvent = result.events.find(event => event.fieldSources.rowIds.includes(platform.rowId))
  assert.ok(result.relations.some(relation => relation.sourceEventId === platformEvent.eventId && relation.status === 'confirmed'))
  await t.test('自动退款关联不能拆掉同笔事件成员', () => {
    assert.deepEqual(memberRows(result, issues[0]), [bank.rowId, platform.rowId].sort())
    assert.equal(issues[0].memberCount, 2)
    assert.equal(issues[0].candidateCount, 1)
  })
  await t.test('自动退款解释性原因不能使同笔确认失效', () => {
    assert.equal(bankChannelPair(bankEvent, platformEvent), true, '初始完整候选必须通过确认入口的同一校验')
  })
})

test('银行退款已有弱原消费线索时同笔问题仍只包含两条来源记录', () => {
  const original = row('bank', '9', {
    rawTransactionType: '消费', rawTransactionTime: '2026-08-31 12:34', localDate: '2026-08-31',
    localAt: '2026-08-31 12:34:00.000', utcAt: '2026-08-31 04:34:00.000'
  })
  const bank = row('bank', '1', { direction: 'income', rawTransactionType: '退款' })
  const platform = row('wechat', '1', { direction: 'income', rawTransactionType: '退款', rawStatus: '退款成功' })
  const result = plan([original, bank, platform])
  const issues = channelIssues(result)
  assert.equal(issues.length, 1)
  assert.deepEqual(memberRows(result, issues[0]), [bank.rowId, platform.rowId].sort())
  assert.equal(issues[0].memberCount, 2, '原消费关联应留给同笔确认后的退款问题，不能混进同笔成员')
  assert.equal(issues[0].candidateCount, 1)
})

test('语义版本升级后必须重验被解释的银行证据，旧缓存不能隐藏新状态阻断', () => {
  const bank = row('bank'), platform = row('wechat')
  const platformEvent = separateEvents([platform])[0]
  const confirmed = { ...platformEvent, fieldSources: { ...platformEvent.fieldSources,
    bankChannelResolution: { version: VERSION, ledgerAccountId: ACCOUNT, primaryRowId: platform.rowId, explainedBankRowIds: [bank.rowId] }
  } }
  assert.deepEqual(semanticRowsAfterConfirmation(confirmed, [platform, bank]).map(item => item.rowId), [platform.rowId])
  const outdatedBank = { ...bank, rawStatus: '待核实',
    semantic: { ...bank.semantic, profileVersion: 'synthetic-old-bank-profile' } }
  assert.equal(getRowSemantic(outdatedBank).moneyEffect, 'unknown')
  assert.deepEqual(semanticRowsAfterConfirmation(confirmed, [platform, outdatedBank]).map(item => item.rowId),
    [platform.rowId, bank.rowId], '现行规则已未知的银行状态必须回到语义重算，不能被旧缓存继续解释掉')
})
