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
test('未改变身份的事项和已入账事件不迁移，保留原引用', () => {
  const input = fixture()
  assert.deepEqual(planAccountIssueUpgrade({ ...input, events: input.previousEvents }).accountIssueMappings, [])
  assert.deepEqual(planAccountIssueUpgrade({ ...input, events: input.events.map(event => ({ ...event, status: 'posted' })) }).accountIssueMappings, [])
})
