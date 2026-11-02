const test = require('node:test')
const assert = require('node:assert/strict')
const { planAccountIssueUpgrade } = require('../src/account-plan-upgrade')
const oldKeys = ['account-identity-v2:alipay:花呗', 'account-identity-v2:alipay:江苏银行信用购']
const unified = 'account-identity-v2:alipay:alipay_huabei_credit'
function fixture(accounts = ['account-a', 'account-a'], statuses = ['resolved', 'resolved']) {
  const previousEvents = oldKeys.map((key, i) => ({ eventId: 'event-' + i, currency: 'CNY', version: 7,
    status: 'ready', reasonCodes: [], ledgerAccountId: accounts[i], amountMinor: String(100 + i),
    fieldSources: { ledgerAccountReference: { sourceType: 'alipay', paymentMethodKey: 'old-key-' + i, accountIdentityKey: key } } }))
  const events = previousEvents.map(event => ({ ...event, version: 8,
    fieldSources: { ledgerAccountReference: { ...event.fieldSources.ledgerAccountReference, accountIdentityKey: unified } } }))
  const issues = previousEvents.map((_, i) => ({ issueId: 'issue-' + i, issueType: 'account_mapping', status: statuses[i] }))
  const members = previousEvents.map((event, i) => ({ issueId: issues[i].issueId, objectType: 'event', objectId: event.eventId, memberRole: 'subject' }))
  let id = 0
  return { updateId: 'update', previousEvents, events, issues, members, idFactory: () => 'id-' + ++id }
}
test('账户族统一仅合并事项，一致旧决定直接继承且两个事件仍独立', () => {
  const input = fixture(), before = JSON.stringify(input)
  const plan = planAccountIssueUpgrade(input)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].status, 'resolved')
  assert.equal(plan.issues[0].blocking, false)
  assert.deepEqual(plan.members.map(member => member.objectId), ['event-0', 'event-1'])
  assert.deepEqual(plan.members.map(member => member.objectVersion), [8, 8])
  assert.deepEqual(plan.supersededIssueIds, ['issue-0', 'issue-1'])
  assert.deepEqual(plan.accountIssueMappings, [{ fromIssueId: 'issue-0', toIssueId: plan.issues[0].issueId },
    { fromIssueId: 'issue-1', toIssueId: plan.issues[0].issueId }])
  assert.equal(JSON.stringify(input), before, '计划不改写事件、金额、账户或旧决定')
})

test('升级后的成员数按交易计数，同一目标的全部资金角色和旧选择关系保留', () => {
  const reference = { sourceType: 'alipay', paymentMethodKey: 'target-key', accountIdentityKey: 'target-identity' }
  const event = { eventId: 'event', currency: 'CNY', version: 7, status: 'ready', reasonCodes: [],
    counterpartyLedgerAccountId: 'credit', fieldSources: { fundsProjection: { to: reference },
      paymentAccountReferences: [{ ...reference, memberRole: 'payment_target' }] } }
  const issues = ['projection', 'payment'].map(issueId => ({ issueId, issueType: 'account_mapping', status: 'resolved' }))
  const members = ['mapping_to', 'payment_target'].map((memberRole, index) => ({
    issueId: issues[index].issueId, objectType: 'event', objectId: event.eventId, memberRole }))
  const input = { updateId: 'update', previousEvents: [event], events: [event], issues, members }, before = JSON.stringify(input)
  const plan = planAccountIssueUpgrade(input)
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].memberCount, 1)
  assert.equal(plan.issues[0].status, 'resolved')
  assert.deepEqual(plan.members.map(member => member.memberRole).sort(), ['mapping_to', 'payment_target'])
  assert.deepEqual(plan.accountIssueMappings.map(mapping => mapping.fromIssueId).sort(), ['payment', 'projection'])
  assert.equal(JSON.stringify(input), before)
})

test('同规则反复升级回同一账户组时不复用旧事项键，前代事项保持可追溯', () => {
  let input = fixture(), firstKey
  const keys = new Set(), retained = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = JSON.stringify(input), plan = planAccountIssueUpgrade(input)
    assert.equal(plan.issues.length, 1)
    const issue = plan.issues[0]
    assert.equal(keys.has(issue.issueKey), false)
    if (attempt === 0) firstKey = issue.issueKey
    keys.add(issue.issueKey)
    assert.deepEqual(plan.supersededIssueIds, input.issues.map(prior => prior.issueId).sort())
    assert.deepEqual(plan.accountIssueMappings.map(mapping => mapping.fromIssueId).sort(), input.issues.map(prior => prior.issueId).sort())
    assert.equal(JSON.stringify(input), before)
    retained.push(...input.issues.map(prior => ({ ...prior, status: 'superseded' })))
    input = { ...input, previousEvents: input.events,
      events: input.events.map(event => ({ ...event, version: event.version + 1, fieldSources: {
        ledgerAccountReference: { ...event.fieldSources.ledgerAccountReference,
          accountIdentityKey: attempt === 0 ? 'intermediate-family' : unified } } })),
      issues: plan.issues, members: plan.members }
  }
  assert.ok(retained.some(issue => issue.issueKey === firstKey))
  assert.equal(new Set(retained.map(issue => issue.issueId)).size, retained.length)
})
test('冲突或不完整的旧决定保留为一个待核对事项，不按成员顺序覆盖', () => {
  for (const input of [fixture(['account-a', 'account-b']), fixture(['account-a', null], ['resolved', 'open']), fixture([null, null], ['open', 'open'])]) {
    for (const reverse of [false, true]) {
      const plan = planAccountIssueUpgrade({ ...input, members: reverse ? [...input.members].reverse() : input.members })
      assert.equal(plan.issues.length, 1)
      assert.equal(plan.issues[0].status, 'open')
      assert.equal(plan.issues[0].blocking, true)
      assert.equal(plan.members.length, 2)
    }
  }
})
test('旧版永久忽略恢复待确认后，账户事项也跟着回到待核对', () => {
  const reference = { sourceType: 'alipay', paymentMethodKey: 'wallet-key', accountIdentityKey: 'wallet-identity' }
  const previousEvents = ['event-0', 'event-1'].map(eventId => ({ eventId, currency: 'CNY', version: 7,
    status: 'excluded', reasonCodes: ['source_account_ignored_default'], ledgerAccountId: null,
    amountMinor: '100', fieldSources: { ledgerAccountReference: { ...reference } } }))
  const events = previousEvents.map(event => ({ ...event, version: 8, status: 'needs_action', reasonCodes: [] }))
  const issues = [{ issueId: 'issue-0', issueType: 'account_mapping', status: 'resolved' }]
  const members = previousEvents.map(event => ({ issueId: 'issue-0', objectType: 'event',
    objectId: event.eventId, memberRole: 'subject' }))
  const plan = planAccountIssueUpgrade({ updateId: 'update', previousEvents, events, issues, members,
    idFactory: () => 'id-1' })
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.issues[0].status, 'open')
  assert.equal(plan.issues[0].blocking, true)
  assert.equal(plan.issues[0].primaryReasonCode, 'payment_reference_mapping_required')
  assert.deepEqual(plan.members.map(member => member.objectId), ['event-0', 'event-1'])
  assert.deepEqual(plan.supersededIssueIds, ['issue-0'])
  // 历史自动排除没有本机决定；迁移关系仍须承接本批用户明确保存的选择。
  assert.deepEqual(plan.accountIssueMappings, [{ fromIssueId: 'issue-0', toIssueId: 'id-1' }])
})

test('未改变身份的事项和已入账事件不迁移，保留原引用', () => {
  const input = fixture()
  assert.deepEqual(planAccountIssueUpgrade({ ...input, events: input.previousEvents }).accountIssueMappings, [])
  assert.deepEqual(planAccountIssueUpgrade({ ...input, events: input.events.map(event => ({ ...event, status: 'posted' })) }).accountIssueMappings, [])
})

test('v40 已解决却缺还款目标账户的事项重新确认，明确排除和已有账户保持', () => {
  const reference = { sourceType: 'alipay', paymentMethodKey: 'target-key', accountIdentityKey: 'target-identity', memberRole: 'payment_target' }
  for (const state of ['missing', 'confirmed', 'excluded', 'posted', 'manual-nature', 'manual-account', 'expense']) {
    const event = { eventId: 'event-target', currency: 'CNY', version: 3,
      economicNature: state === 'expense' ? 'expense' : 'repayment',
      manualFieldMask: state === 'manual-nature' ? 8 : state === 'manual-account' ? 2 : 0,
      status: state === 'excluded' || state === 'posted' ? state : 'needs_action',
      counterpartyLedgerAccountId: state === 'confirmed' ? 'target-account' : null,
      reasonCodes: state === 'excluded' ? ['manual_exclusion', 'account_mapping_excluded'] : [],
      fieldSources: { paymentAccountReferences: [reference] } }
    const input = { updateId: 'update', previousEvents: [event], events: [event],
      issues: [{ issueId: 'broken-target', issueType: 'account_mapping', status: 'resolved' }],
      members: [{ issueId: 'broken-target', objectType: 'event', objectId: event.eventId, memberRole: 'payment_target' }],
      idFactory: () => 'reopened-target' }
    const before = JSON.stringify(input), plan = planAccountIssueUpgrade(input)
    if (state === 'missing') {
      assert.equal(plan.issues.length, 1)
      assert.equal(plan.issues[0].status, 'open')
      assert.equal(plan.issues[0].blocking, true)
      assert.deepEqual(plan.supersededIssueIds, ['broken-target'])
      assert.deepEqual(plan.accountIssueMappings, [{ fromIssueId: 'broken-target', toIssueId: 'reopened-target' }])
    } else assert.equal(plan.issues.length, 0)
    assert.equal(JSON.stringify(input), before)
  }
})

test('旧计划同账户的普通付款与组合付款事项合为一组，完整一致决定保留、冲突重问', () => {
  const reference = { sourceType: 'alipay', paymentMethodKey: 'wallet-key', accountIdentityKey: 'wallet-identity' }
  for (const mode of ['pending', 'confirmed', 'conflict', 'excluded']) {
    const events = [{ eventId: 'combined', version: 4, currency: 'CNY', status: 'needs_action', reasonCodes: [],
      fieldSources: { paymentAccountReferences: [{ ...reference, memberRole: 'payment_component_1', componentIndex: 1 }],
        paymentAccounts: mode === 'pending' ? [] : [{ componentIndex: 1, accountId: 'wallet' }] } },
    { eventId: 'single', version: 3, currency: 'CNY', status: mode === 'excluded' ? 'excluded' : 'needs_action',
      reasonCodes: mode === 'excluded' ? ['manual_exclusion', 'account_mapping_excluded'] : [],
      ledgerAccountId: mode === 'pending' ? null : mode === 'conflict' ? 'other-wallet' : 'wallet',
      fieldSources: { ledgerAccountReference: reference } }]
    const issues = ['combined-group', 'single-group'].map(issueId => ({ issueId, issueType: 'account_mapping', status: mode === 'pending' ? 'open' : 'resolved' }))
    const members = events.map((event, index) => ({ issueId: issues[index].issueId, objectType: 'event', objectId: event.eventId,
      memberRole: index === 0 ? 'payment_component_1' : 'subject' }))
    const input = { updateId: 'update', events, previousEvents: events, issues, members }, before = JSON.stringify(input)
    const plan = planAccountIssueUpgrade(input)
    if (mode === 'excluded') {
      assert.equal(plan.issues.length, 0, '不把明确排除范围并进计入组')
      continue
    }
    assert.equal(plan.issues.length, 1)
    assert.equal(plan.issues[0].status, mode === 'confirmed' ? 'resolved' : 'open')
    if (mode === 'conflict') assert.equal(plan.issues[0].primaryReasonCode, 'account_mapping_conflict')
    assert.equal(plan.members.length, 2)
    assert.deepEqual(plan.members.map(member => member.memberRole).sort(), ['payment_component_1', 'subject'])
    assert.equal(plan.accountIssueMappings.length, 2)
    assert.equal(JSON.stringify(input), before)
  }
})

test('已确认同笔的银行引用随新账户事项迁移，不退回平台别名且旧键保留', () => {
  const { accountReference } = require('../src/account-reference')
  const { memberReference, referenceGroup } = require('../src/account-issue-grouping')
  const { publicIssue } = require('../src/review-presentation')
  const bank = { ...accountReference('bank', '测试银行储蓄卡(1234)', 'ledger_account'), fundsSide: 'ordinary' }
  const component = { ...accountReference('alipay', '测试银行储蓄卡(1234)', 'payment_method'), memberRole: 'payment_component_0', componentIndex: 0 }
  const events = [{ eventId: 'merged', version: 2, currency: 'CNY', status: 'ready', reasonCodes: [], ledgerAccountId: 'bank-account',
    fieldSources: { ledgerAccountReference: accountReference('alipay', '测试银行(1234)', 'ledger_account'),
      bankChannelAccountContexts: { 'old-bank-issue': bank } } },
  { eventId: 'composite', version: 2, currency: 'CNY', status: 'needs_action', reasonCodes: [],
    fieldSources: { paymentAccountReferences: [component], paymentAccounts: [{ componentIndex: 0, accountId: 'bank-account' }] } }]
  const issues = ['old-bank-issue', 'old-component-issue'].map(issueId => ({ issueId, issueType: 'account_mapping', status: 'resolved' }))
  const members = events.map((event, index) => ({ issueId: issues[index].issueId, objectType: 'event', objectId: event.eventId,
    memberRole: index ? 'payment_component_0' : 'subject' }))
  const input = { updateId: 'update', previousEvents: events, events, issues, members }, before = JSON.stringify(input)
  const plan = planAccountIssueUpgrade(input), moved = plan.members.find(member => member.objectId === 'merged')
  assert.equal(plan.issues.length, 1)
  assert.equal(plan.contextUpdates.length, 1)
  assert.equal(moved.objectVersion, 3)
  assert.equal(plan.members.find(member => member.objectId === 'composite').objectVersion, 2)
  const updated = { ...events[0], version: 3, fieldSources: { ...events[0].fieldSources, bankChannelAccountContexts: plan.contextUpdates[0].contexts } }
  assert.deepEqual(updated.fieldSources.bankChannelAccountContexts['old-bank-issue'], bank)
  assert.deepEqual(memberReference(updated, moved), bank)
  assert.equal(referenceGroup(updated, moved), referenceGroup(events[0], members[0]))
  const shown = publicIssue({ ...plan.issues[0], subjectEventId: 'merged', subjectMemberRole: moved.memberRole,
    subjectFieldSources: updated.fieldSources, subjectLedgerAccountId: 'bank-account' }).accountContext
  assert.equal(shown.sourceType, 'bank')
  assert.equal(shown.paymentMethodKey, bank.paymentMethodKey)
  assert.equal(shown.label, bank.label)
  assert.equal(JSON.stringify(input), before)
})
