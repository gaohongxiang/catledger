const test = require('node:test')
const assert = require('node:assert/strict')
const { referencesForRows } = require('../src/payment-account-groups')
const { confirmedBatchMappings } = require('../../../test/helpers/account-bindings')
const base = { sourceType: 'alipay', sourceFormat: 'alipay_app_csv', rawStatus: '交易成功', amountMinor: '1000', direction: 'expense', rawTransactionType: '信用借还', counterparty: '1688先采后付', item: '先采后付账单付款', paymentMethod: '测试银行储蓄卡(1234)&账户余额' }
test('账户引用独立于组合金额，目标只按明确平台产品及信用借还识别', () => {
  assert.deepEqual(referencesForRows([base]).map(x => x.label), ['测试银行储蓄卡(1234)', '支付宝账户余额', '1688先采后付'])
  assert.equal(referencesForRows([{ ...base, rawTransactionType: '购物' }]).length, 2)
  assert.equal(referencesForRows([{ ...base, counterparty: '某商家' }]).length, 2)
  assert.equal(referencesForRows([base, { ...base, paymentMethod: '账户余额' }]).length, 0)
  assert.equal(referencesForRows([{ ...base, paymentMethod: '账户余额' }])[0].memberRole, 'payment_target')
  assert.deepEqual(referencesForRows([{ ...base, paymentMethod: '优惠券&账户余额&测试银行储蓄卡(1234)' }]).slice(0, 2).map(x => x.componentIndex), [1, 2])
})

// 组合付款的账户步骤单元是“每个账户”，不是“这笔事件”：整理出来就是每个成分
// 各自一条待确认，同一笔交易同时是它们的成员，不再先合成一条“组合支付”。
function planningRow(paymentMethod, { transactionType = '信用借还', counterparty = '1688先采后付' } = {}) {
  const { normalizeRow } = require('../src/parsers/normalize')
  const normalized = normalizeRow('alipay', {
    transactionTime: '2026-08-08 15:51:47', amount: '1512.17', direction: '支出', status: '交易成功',
    transactionType, counterparty, item: '先采后付账单付款', paymentMethod, note: ''
  }, -480)
  return { ...normalized.normalized, rowId: 'row-1', batchId: 'batch-1', importId: 'import-1', sourceOrder: 0, rowNumber: 1,
    parseState: normalized.parseState, identityId: 'identity-1', identityState: 'new', sourceType: 'alipay',
    sourceFormat: 'alipay_app_csv', paymentMethod, rawStatus: '交易成功', rawTransactionType: transactionType,
    semantic: normalized.semantic, sourceTransactionId: '', sourceOrderId: '', sourceMerchantOrderId: '' }
}
const COMPOSITE_ACCOUNTS = [
  { accountId: 'acct-wallet', name: '支付宝账户余额', type: 'wallet', currency: 'CNY', version: 1 },
  { accountId: 'acct-card', name: '测试银行储蓄卡(1234)', type: 'bank', currency: 'CNY', version: 1 }
]
function organizeComposite(rows, paymentMappings = [], accounts = COMPOSITE_ACCOUNTS) {
  const { buildOrganizePlan } = require('../src/organizer-planner')
  let id = 0
  return buildOrganizePlan({ updateId: 'update-1', rows, accounts, paymentMappings,
    idFactory: () => 'id-' + (++id) })
}
function componentKey(label) {
  const { referencesForRows } = require('../src/payment-account-groups')
  return referencesForRows([planningRow('账户余额&测试银行储蓄卡(1234)')])
    .find(reference => reference.label === label).paymentMethodKey
}

test('组合付款整理后按账户各成一组，同一笔交易同时是它们的成员', () => {
  const plan = organizeComposite([planningRow('账户余额&测试银行储蓄卡(1234)')])
  const accountIssues = plan.issues.filter(issue => issue.issueType === 'account_mapping')
  assert.equal(accountIssues.length, 3)
  assert.deepEqual(accountIssues.map(issue => issue.primaryReasonCode), Array(3).fill('payment_reference_mapping_required'))
  assert.deepEqual(accountIssues.map(issue => issue.status), Array(3).fill('open'))
  assert.deepEqual(accountIssues.map(issue => issue.blocking), Array(3).fill(true))
  assert.deepEqual(plan.members.filter(member => member.objectType === 'event').map(member => member.memberRole).sort(),
    ['payment_component_0', 'payment_component_1', 'payment_target', 'subject'])
  // 账户归属有了各自的组，这笔事件只剩“每个账户实际付了多少”。
  const shared = plan.issues.filter(issue => issue.issueType !== 'account_mapping')
  assert.deepEqual(shared.map(issue => [issue.issueType, issue.primaryReasonCode]),
    [['shared_fields', 'payment_components_ambiguous']])
  // 引用与版本固化成来源事实，重新整理和读取都按同一份走，不再需要事后补一次分组。
  const { VERSION, needsExpansion } = require('../src/payment-account-groups')
  assert.equal(plan.events[0].fieldSources.paymentAccountGroupsVersion, VERSION)
  assert.deepEqual(plan.events[0].fieldSources.paymentAccountReferences.map(reference => reference.memberRole),
    ['payment_component_0', 'payment_component_1', 'payment_target'])
  assert.equal(needsExpansion(plan.events, [planningRow('账户余额&测试银行储蓄卡(1234)')],
    [{ eventId: plan.events[0].eventId, rowId: 'row-1', evidenceRole: 'primary' }]), false)
})

test('普通付款与组合付款共用账户时只确认一次，每组保留完整交易和资金角色', () => {
  const rows = ['测试银行储蓄卡(1234)&账户余额', '账户余额'].map((paymentMethod, index) => ({
    ...planningRow(paymentMethod, { transactionType: '餐饮美食', counterparty: '合成商户' }),
    rowId: 'row-' + index, identityId: 'identity-' + index, sourceTransactionId: 'SYNTHETIC-MIXED-' + index,
    amountMinor: index === 0 ? '1000' : '200'
  }))
  for (const accounts of [[], COMPOSITE_ACCOUNTS]) for (const reversed of [false, true]) {
    const input = reversed ? [...rows].reverse() : rows, before = JSON.stringify(input)
    const plan = organizeComposite(input, [], accounts)
    assert.equal(plan.events.length, 2, '归组不能合并独立交易')
    const issues = plan.issues.filter(issue => issue.issueType === 'account_mapping')
    assert.equal(issues.length, 2)
    const combined = plan.events.find(event => event.fieldSources.paymentAccountReferences)
    const single = plan.events.find(event => !event.fieldSources.paymentAccountReferences)
    const wallet = issues.find(issue => plan.members.some(member => member.issueId === issue.issueId && member.objectId === single.eventId))
    const bank = issues.find(issue => issue !== wallet)
    assert.equal(wallet.memberCount, 2)
    assert.deepEqual(plan.members.filter(member => member.issueId === wallet.issueId).map(member => member.objectId).sort(),
      [combined.eventId, single.eventId].sort())
    assert.deepEqual(plan.members.filter(member => member.issueId === wallet.issueId).map(member => member.memberRole).sort(),
      ['payment_component_1', 'subject'])
    assert.equal(bank.memberCount, 1)
    assert.equal(plan.members.find(member => member.issueId === bank.issueId).memberRole, 'payment_component_0')
    assert.equal(wallet.status, 'open', '账本名称相同仅提供候选，未确认前不自动沿用')
    assert.deepEqual(plan.events.map(event => event.amountMinor).sort(), ['1000', '200'])
    assert.equal(JSON.stringify(input), before)
  }
})

test('同一还款目标的多种资金角色只计一笔交易，独立还款仍逐笔计数', () => {
  for (const count of [1, 2]) {
    const rows = Array.from({ length: count }, (_, index) => ({
      ...planningRow('账户余额', { counterparty: '合成银行信用卡(1234)' }),
      rowId: 'row-' + index, identityId: 'identity-' + index, sourceTransactionId: 'SYNTHETIC-REPAYMENT-' + index
    }))
    const plan = organizeComposite(rows, [], [])
    const targetMember = plan.members.find(member => member.memberRole === 'payment_target')
    const target = plan.issues.find(issue => issue.issueId === targetMember.issueId)
    const members = plan.members.filter(member => member.issueId === target.issueId)
    assert.equal(target.memberCount, count)
    assert.equal(new Set(members.map(member => member.objectId)).size, count)
    for (const eventId of new Set(members.map(member => member.objectId))) {
      assert.deepEqual(members.filter(member => member.objectId === eventId).map(member => member.memberRole).sort(),
        ['mapping_to', 'payment_target'], '归组不删除后续写入所需的任一资金角色')
    }
  }
})

test('组合付款按成分沿用本批已确认账户决定，只问还没定过的成分', () => {
  const rows = [planningRow('账户余额&测试银行储蓄卡(1234)')]
  const plan = organizeComposite(rows, confirmedBatchMappings(rows, [{
    sourceType: 'alipay', paymentMethodKey: componentKey('支付宝账户余额'), paymentMethodHint: '账户余额',
    mappingAction: 'account', accountId: 'acct-wallet', mappingScope: 'batch'
  }]))
  const issues = plan.issues.filter(issue => issue.issueType === 'account_mapping')
  assert.deepEqual(issues.map(issue => issue.primaryReasonCode).sort(),
    ['payment_reference_mapping_confirmed', 'payment_reference_mapping_required', 'payment_reference_mapping_required'])
  assert.deepEqual(plan.events[0].fieldSources.paymentAccounts, [{ componentIndex: 0, accountId: 'acct-wallet' }])
})

test('新导入的组合还款目标沿用账户时写入事件，不能出现已确认却没有账户的事项', () => {
  const { publicIssue } = require('../src/review-presentation')
  const row = { ...planningRow('测试银行储蓄卡(1234)&账户余额'), sourceProfileKey: 'b'.repeat(64) }
  const reference = referencesForRows([row]).find(item => item.memberRole === 'payment_target')
  for (const { scope, confirmed } of [
    { scope: 'history', confirmed: false }, { scope: 'history', confirmed: true }, { scope: 'batch', confirmed: true }
  ]) for (const action of ['account', 'ignore']) {
    const mapping = { sourceType: reference.sourceType, paymentMethodKey: reference.paymentMethodKey,
      paymentMethodHint: reference.label, mappingScope: scope, mappingAction: action,
      accountId: action === 'account' ? 'acct-target' : null }
    const mappings = confirmed ? confirmedBatchMappings([row], [mapping]).map(item => ({ ...item, mappingScope: scope })) : [mapping]
    const plan = organizeComposite([row], mappings, COMPOSITE_ACCOUNTS.concat({
      accountId: 'acct-target', name: '合成还款目标', type: 'credit', currency: 'CNY' }))
    const event = plan.events[0], member = plan.members.find(item => item.memberRole === 'payment_target')
    const issue = plan.issues.find(item => item.issueId === member.issueId)
    const shown = publicIssue({ ...issue, subjectEventId: event.eventId, subjectMemberRole: member.memberRole,
      subjectFieldSources: event.fieldSources, subjectLedgerAccountId: event.ledgerAccountId,
      subjectCounterpartyLedgerAccountId: event.counterpartyLedgerAccountId,
      subjectSourceType: row.sourceType, subjectPaymentMethod: row.paymentMethod })
    assert.notEqual(event.status, 'excluded')
    assert.equal(issue.status, confirmed && action === 'account' ? 'resolved' : 'open')
    assert.equal(event.counterpartyLedgerAccountId, confirmed && action === 'account' ? 'acct-target' : null)
    assert.equal(shown.accountContext.accountId, event.counterpartyLedgerAccountId)
    assert.equal(shown.accountContext.defaultIgnored, false)
  }
})

test('已排除的事件不因为付款成分再立待确认账户项', () => {
  const { buildAccountIssues } = require('../src/organizer-planner')
  const events = [{ eventId: 'event-1', version: 1, status: 'excluded', reasonCodes: ['source_non_financial'],
    sourceType: 'alipay', fieldSources: {} }]
  const result = buildAccountIssues('update-1', events,
    new Map([['event-1', [planningRow('账户余额&测试银行储蓄卡(1234)')]]]), [], () => 'id')
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.members, [])
})

test('还款目标只在明确的信用借还里单独成组，购物行只有付款成分', () => {
  const single = organizeComposite([planningRow('账户余额')])
  assert.ok(single.members.some(member => member.memberRole === 'payment_target'))
  const shopping = organizeComposite([planningRow('账户余额&测试银行储蓄卡(1234)', { transactionType: '购物', counterparty: '某商家' })])
  assert.deepEqual(shopping.members.filter(member => member.objectType === 'event').map(member => member.memberRole).sort(),
    ['payment_component_0', 'payment_component_1', 'subject'])
})

test('归组新鲜判定与实际刷新候选一致，忽略已处理和舍弃证据', () => {
  const { needsExpansion, VERSION } = require('../src/payment-account-groups')
  const event = { eventId: 'event', status: 'needs_action', fieldSources: {} }
  const rows = [{ ...base, rowId: 'row' }], evidence = [{ eventId: 'event', rowId: 'row', evidenceRole: 'primary' }]
  assert.equal(needsExpansion([event], rows, evidence), true)
  assert.equal(needsExpansion([{ ...event, fieldSources: { paymentAccountGroupsVersion: VERSION } }], rows, evidence), false)
  assert.equal(needsExpansion([{ ...event, fieldSources: { paymentResolution: {} } }], rows, evidence), false)
  assert.equal(needsExpansion([{ ...event, status: 'excluded' }], rows, evidence), false)
  assert.equal(needsExpansion([event], rows, [{ ...evidence[0], evidenceRole: 'discarded' }]), false)
  assert.equal(needsExpansion([event], [{ ...rows[0], rawTransactionType: '购物', paymentMethod: '账户余额' }], evidence), false)
})
