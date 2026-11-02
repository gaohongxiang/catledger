const assert = require('node:assert/strict')
const test = require('node:test')
const model = require('../miniprogram/packages/finance/pages/import-workbench/model')
const { project } = require('../miniprogram/services/import-draft-session')

function state() {
  const event = { eventId: 'e', economicNature: 'repayment', ledgerAccountId: 'wallet', counterpartyLedgerAccountId: null,
    accountOwnershipRequired: true, fundsProjection: { kind: 'repayment', from: { label: '支付宝账户余额' },
      to: { referenceKind: 'atomic', label: '合成银行信用卡' } } }
  return { currentIssue: model.issueView({ issueId: 'i', issueType: 'transfer_accounts', subject: event }), issueEvents: [event],
    accountChoices: [{ isPlaceholder: true }, { accountId: 'credit', type: 'credit' }, { isCreate: true }, { accountId: 'wallet-2', type: 'wallet' }],
    accountTypeOptions: [{ value: 'credit' }, { value: 'wallet' }],
    issueDraft: { accountIndex: 0, accountTypeIndex: 0, newAccountName: '' } }
}

test('旧片段表单不能用单一目录选择完成资金两端确认', () => {
  const data = state(); data.issueDraft.accountIndex = 1
  assert.equal(data.currentIssue.label, '资金两端归属待确认')
  assert.equal(model.buildIssueFieldsDraft(data).valid, false)
})

test('账本还入端只能选择负债账户，本批新建也使用稳定账户 ID', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page, accounts, drafts } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  assert.equal(editor.select(page, 'reviewCounterparty', accounts[1]), false)
  assert.equal(editor.select(page, 'reviewCounterparty', drafts[0]), true)
  assert.deepEqual(editor.plain(editor.view(page).payload.decisions.accountOwnership),
    { source: { kind: 'ledger', accountId: 'account-0' }, destination: { kind: 'ledger', accountId: drafts[0].accountId } })
  assert.equal(editor.view(page).payload.fields.counterpartyLedgerAccountId, undefined)
  assert.equal(editor.view(page).complete, true)
})

test('外部还入端直接按支出核对，未知端保留缺口，均不提交隐藏账户或贷款信息', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page, drafts } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  editor.select(page, 'reviewCounterparty', drafts[0])
  for (const kind of ['external', 'unknown']) {
    editor.mode(page, 'destinationKind', kind)
    const payload = editor.view(page).payload
    assert.deepEqual(editor.plain(payload.decisions.accountOwnership.destination), { kind })
    assert.equal(payload.decisions.ownership, undefined)
    assert.equal(payload.decisions.repayment, undefined)
    assert.equal(payload.fields.counterpartyLedgerAccountId, undefined)
    assert.equal(payload.fields.ledgerAccountDraft, undefined)
    assert.equal(payload.fields.economicNature, undefined)
    assert.equal(editor.view(page).complete, kind === 'external')
    assert.equal(editor.view(page).missing.includes('还入账户'), kind === 'unknown')
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
  const data = state(); data.currentIssue.subject.accountOwnershipRequired = false
  assert.equal(model.issueView(data.currentIssue).accountOwnershipRequired, false)
})
