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

test('本人账户确认选择负债账户，本批新建也使用稳定账户 ID', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page, accounts, drafts } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  assert.equal(editor.select(page, 'reviewCounterparty', accounts[1]), false)
  assert.equal(editor.select(page, 'reviewCounterparty', drafts[0]), true)
  assert.equal(editor.view(page).payload.fields.counterpartyLedgerAccountId, drafts[0].accountId)
  assert.equal(editor.view(page).payload.decisions.ownership.owner, 'self')
})

test('代还需明确处理方式且不提交隐藏的本人账户或贷款信息', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page, drafts } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  editor.select(page, 'reviewCounterparty', drafts[0]); editor.mode(page, 'owner', 'other')
  assert.ok(editor.view(page).missing.includes('代还处理方式'))
  for (const treatment of ['expense', 'pending']) {
    editor.mode(page, 'otherTreatment', treatment)
    const payload = editor.view(page).payload
    assert.deepEqual(editor.plain(payload.decisions.ownership), { owner: 'other', treatment })
    assert.equal(payload.decisions.repayment, undefined)
    assert.equal(payload.fields.counterpartyLedgerAccountId, undefined)
    assert.equal(payload.fields.ledgerAccountDraft, undefined)
    assert.equal(payload.fields.economicNature, treatment === 'expense' ? 'expense' : 'unknown')
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
