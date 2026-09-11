const assert = require('node:assert/strict')
const test = require('node:test')
const model = require('../miniprogram/pages/import-workbench/model')
const { project } = require('../miniprogram/services/import-draft-session')

function state() {
  const event = { eventId: 'e', economicNature: 'repayment', ledgerAccountId: 'wallet', counterpartyLedgerAccountId: null,
    repaymentOwnershipRequired: true, fundsProjection: { kind: 'repayment', from: { label: '支付宝账户余额' },
      to: { referenceKind: 'atomic', label: '合成银行信用卡' } } }
  return { currentIssue: model.issueView({ issueId: 'i', issueType: 'transfer_accounts', subject: event }), issueEvents: [event],
    accountChoices: [{ isPlaceholder: true }, { accountId: 'credit', type: 'credit' }, { isCreate: true }, { accountId: 'wallet-2', type: 'wallet' }],
    accountTypeOptions: [{ value: 'credit' }, { value: 'wallet' }],
    issueDraft: { accountIndex: 0, accountTypeIndex: 0, newAccountName: '', repaymentOwner: '', repaymentOtherTreatment: '' } }
}

test('无归属选择时即使已有账户选择也不能保存', () => {
  const data = state(); data.issueDraft.accountIndex = 1
  assert.equal(data.currentIssue.label, '还款账户归属待确认')
  assert.equal(model.buildIssueFieldsDraft(data).valid, false)
})

test('本人账户确认选择已有负债或完整新建账户', () => {
  const data = state(); data.issueDraft.repaymentOwner = 'self'; data.issueDraft.accountIndex = 1
  assert.deepEqual(model.buildIssueFieldsDraft(data).fields, { counterpartyLedgerAccountId: 'credit', repaymentOwnership: { owner: 'self' } })
  data.issueDraft.accountIndex = 2
  assert.equal(model.buildIssueFieldsDraft(data).valid, false)
  data.issueDraft.newAccountName = '我的合成信用卡'
  assert.deepEqual(model.buildIssueFieldsDraft(data).fields.counterpartyLedgerAccountDraft, { name: '我的合成信用卡', type: 'credit', currency: 'CNY' })
  data.issueDraft.accountTypeIndex = 1
  assert.equal(model.buildIssueFieldsDraft(data).valid, false)
  data.issueDraft.accountIndex = 3
  assert.equal(model.buildIssueFieldsDraft(data).valid, false)
})

test('他人还款必须明确处理方式且不提交残留账户新建信息', () => {
  const data = state(); data.issueDraft.repaymentOwner = 'other'; data.issueDraft.accountIndex = 2
  data.issueDraft.newAccountName = '不应创建的信用卡'
  assert.equal(model.buildIssueFieldsDraft(data).valid, false)
  for (const treatment of ['expense', 'pending']) {
    data.issueDraft.repaymentOtherTreatment = treatment
    assert.deepEqual(model.buildIssueFieldsDraft(data), { valid: true, fields: { repaymentOwnership: { owner: 'other', treatment } } })
  }
})

test('暂存他人归属的乐观投影不减少待核对数量', () => {
  const data = state()
  const view = { issues: [{ issueId: 'i', status: 'open', blocking: true }], events: data.issueEvents }
  const projected = project(view, [{ kind: 'review', issueId: 'i', subjectIds: ['e'],
    decision: { fields: { repaymentOwnership: { owner: 'other', treatment: 'pending' } } } }])
  assert.equal(projected.issues[0].status, 'open')
  assert.equal(projected.events[0].localReviewConfirmed, undefined)
})

test('已经明确归属的普通还款不重复插入归属问题', () => {
  const data = state(); data.currentIssue.subject.repaymentOwnershipRequired = false
  assert.equal(model.issueView(data.currentIssue).repaymentOwnershipRequired, false)
})
