const test = require('node:test')
const assert = require('node:assert/strict')
const { selectedAccountProblems } = require('../cloudfunctions/catledger-import/src/local-review-submit')
const identity = require('../cloudfunctions/catledger-import/src/local-review-identity')

function fixture() {
  const reference = { sourceType: 'wechat', label: '微信零钱', expectedAccountType: 'wallet', memberRole: 'subject' }
  const facts = {
    events: ['selected', 'unrelated'].map(eventId => ({ eventId, currency: 'CNY', economicNature: 'expense',
      fieldSources: { paymentAccountReferences: [reference] } })),
    issues: [{ issueId: 'issue', issueType: 'account_mapping', primaryReasonCode: 'ledger_account_required', subjectEventIds: ['selected'] }],
    members: [{ issueId: 'issue', objectType: 'event', objectId: 'selected', memberRole: 'subject' }]
  }
  const state = { snapshotId: 'snapshot', decisions: { accounts: [{ issueId: 'issue', eventIds: ['selected'],
    reasonCode: 'ledger_account_required', decision: 'apply_fields', fields: { mappingAccountId: 'wallet' } }], events: [] } }
  const accounts = new Map([['wallet', { accountId: 'wallet', type: 'wallet', currency: 'CNY' }]])
  return { state, facts, accounts }
}

test('本机选择在重放前失效：按本用户目录、原引用类型和币种精确退回对应事件', () => {
  for (const patch of [{ archivedAt: '2026-11-01' }, { supersededAt: '2026-11-01' }, { disabledAt: '2026-11-01' },
    { type: 'bank' }, { currency: 'USD' }, { type: undefined }, { currency: undefined }, null]) {
    const { state, facts, accounts } = fixture()
    if (patch) accounts.set('wallet', { ...accounts.get('wallet'), ...patch })
    else accounts.delete('wallet')
    assert.deepEqual(selectedAccountProblems(state, facts, accounts), [
      { eventIds: ['selected'], reason: 'account_unavailable', issueType: 'server_recheck' }
    ])
  }
  const { state, facts, accounts } = fixture()
  assert.deepEqual(selectedAccountProblems(state, facts, accounts), [])
  state.decisions.accounts[0].fields = { mappingAccountId: 'outside-user', type: 'wallet', currency: 'CNY' }
  assert.equal(selectedAccountProblems(state, facts, accounts)[0].reason, 'account_unavailable', '客户端属性不能证明账户属于当前用户')
})

test('失效诊断覆盖单笔字段、组成与归属选择；待创建和外部份额不误报', () => {
  const { state, facts, accounts } = fixture()
  state.decisions.accounts = []
  for (const editor of [{ fields: { ledgerAccountId: 'missing' } },
    { composition: { kind: 'payment', parts: [{ accountId: 'missing' }, { kind: 'external', accountId: null }] } },
    { decisions: { accountOwnership: { destination: { kind: 'ledger', accountId: 'missing' } } } }]) {
    state.decisions.events = [{ eventId: 'selected', editor }]
    assert.deepEqual(selectedAccountProblems(state, facts, accounts).map(problem => problem.eventIds), [['selected']])
  }
  const draft = { name: '合成待创建钱包', type: 'wallet', currency: 'CNY', creationKey: 'a'.repeat(64) }
  const accountId = identity.accountId(state.snapshotId, draft.name, draft.type, draft.creationKey)
  state.decisions.accounts = [{ eventIds: ['selected'], decision: 'apply_fields', fields: { mappingAccountDraft: draft } },
    { eventIds: ['unrelated'], decision: 'apply_fields', fields: { mappingAccountId: accountId } }]
  state.decisions.events = [{ eventId: 'selected', editor: { fields: { ledgerAccountId: accountId },
    composition: { parts: [{ kind: 'external', accountId: null }] } } }]
  assert.deepEqual(selectedAccountProblems(state, facts, accounts), [])
  state.decisions.events[0].editor.composition.parts = {}
  assert.deepEqual(selectedAccountProblems(state, facts, accounts), [], '无效组成仍由原校验拒绝，诊断不得覆盖成内部错误')
})
