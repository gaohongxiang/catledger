const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const model = require('../miniprogram/pages/import-workbench/model')
const editor = require('./helpers/editor-workbench')

function pageFor(issue, accounts = [], importApi = {}) {
  const h = require('./helpers/paged-workbench').runtime()
  const page = h.page
  page._businessData = null
  page._draftSession = null
  page.request = (action, data) => importApi.callImport(action, data)
  Object.assign(page.data, { update: { updateId: 'synthetic-update' }, accountIssues: [issue], accounts })
  return page
}

function unknownIssue() {
  return { issueId: 'synthetic-issue', issueType: 'account_mapping', status: 'open',
    accountContext: { recognized: false, sourceType: 'wechat', label: '微信支付方式未标明' } }
}

test('未知账户默认待选择，不能提交为新建账户或排除决定', async () => {
  const page = pageFor(unknownIssue())
  const state = page.refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'pending')
  assert.equal(state.summary.invalid, 1)
  assert.equal(state.summary.create, 0)
  await page.completeAccountMapping()
  assert.match(page.data.accountStepError, /请选择账户归属/u)
  assert.equal(page.data.accountStepBusy, false)
})

test('明确选择新建后才进入表单，填写有效名称才能确认', () => {
  const page = pageFor(unknownIssue())
  page.refreshAccountMappings()
  page.openAccountChoice({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'create' } } })
  assert.equal(page.data.accountMappings[0].choiceValue, 'create')
  assert.equal(page.mappingState().summary.invalid, 1)
  page.bindAccountDraftName({ currentTarget: { dataset: { id: 'synthetic-issue' } }, detail: { value: '测试钱包' } })
  assert.equal(page.mappingState().summary.invalid, 0)
})

test('未知来源人工选择已有账户，目录页之外保留已选ID供服务端核对', () => {
  const page = pageFor(unknownIssue(), [{ accountId: 'wallet', name: '测试钱包', type: 'wallet', currency: 'CNY' }])
  page.refreshAccountMappings()
  page.openAccountChoice({ currentTarget: { dataset: { id: 'synthetic-issue' } } })
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'account:wallet' } } })
  assert.equal(page.mappingState().summary.ready, 1)
  page.data.accounts = []
  const state = page.refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'account:wallet')
  assert.equal(state.summary.invalid, 0)
})

test('刷新未知来源时保留服务端已经确认的人工归属', () => {
  const issue = unknownIssue()
  issue.status = 'resolved'
  issue.accountContext.accountId = 'wallet'
  const state = pageFor(issue, [{ accountId: 'wallet', name: '测试钱包' }]).refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'account:wallet')
  assert.equal(state.summary.confirmed, 1)
  assert.equal(state.summary.invalid, 0)
})

test('稳定识别的微信零钱仍可推荐唯一已有账户', () => {
  const issue = unknownIssue()
  issue.accountContext = { recognized: true, sourceType: 'wechat', label: '微信零钱', currency: 'CNY' }
  const state = pageFor(issue, [{ accountId: 'wallet', name: '微信零钱', currency: 'CNY' }]).refreshAccountMappings()
  assert.equal(state.mappings[0].choiceValue, 'account:wallet')
  assert.equal(state.mappings[0].suggestedExisting, true)
})

function syntheticIssueDetails(count = 1, issueType = 'category_assignment') {
  return { update: { status: 'review' }, issue: { issueId: 'synthetic-issue', issueType, status: 'open' },
    accounts: [], accountDrafts: [], categories: [], members: Array.from({ length: count }, (_, index) => ({ event: {
      eventId: 'event-' + index, amountMinor: '100', economicNature: 'expense', flowDirection: 'outflow',
      localAt: '2026-08-01 12:00:00', primaryEvidence: { item: '合成记录' }
    } })) }
}

function bankDetails(id, version = 1) {
  const event = { eventId: id + '-event', economicNature: 'repayment', amountMinor: '100',
    ledgerAccountId: 'wallet', primaryEvidence: { item: '/', counterparty: '平安银行信用卡还款' },
    fundsProjection: { from: { label: '微信零钱' }, to: { label: '平安银行信用卡', referenceKind: 'atomic' } } }
  return { update: { updateId: 'synthetic-update', version: 5, status: 'review' },
    issue: { issueId: id, version, issueType: 'transfer_accounts', status: 'open', subject: event },
    accounts: [{ accountId: 'card', name: '平安银行信用卡(1234)', type: 'credit' }], accountDrafts: [], categories: [],
    members: [{ event }] }
}

function bankPage(onCall) {
  const page = pageFor(bankDetails('one').issue, [], { createRequestId: () => 'synthetic-request', async callImport(action, payload) {
    if (onCall) { const result = await onCall(action, payload); if (result !== undefined) return result }
    if (action === 'reviewIssues.get') return bankDetails(payload.issueId)
    if (action === 'economicEvents.evidence') return { evidence: [{ evidenceId: payload.eventId, rawFields: { '交易对方': '平安银行信用卡还款' } }] }
    throw new Error('unexpected action')
  } })
  page.data.issues = ['one', 'two', 'three'].map(id => bankDetails(id).issue)
  page.loadUpdate = async function () { this.setData({ busy: false, currentIssue: null }) }
  return page
}

test('唯一候选与多候选都不自动确认，显式选择只改变本笔草稿', async t => {
  const { h, page, drafts } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  assert.equal(editor.draft(page).counterpartyLedgerAccountId, '')
  assert.ok(editor.view(page).missing.includes('还入账户'))
  editor.select(page, 'reviewCounterparty', drafts[0])
  assert.equal(editor.draft(page).counterpartyLedgerAccountId, drafts[0].accountId)
  assert.equal(editor.writes(h).length, 0)
})

test('整理阶段组合支付按金额与说明区分完整和待核对草稿', async t => {
  const { page, accounts } = await editor.open(t, { economicNature: 'expense', amountMinor: '1000' })
  editor.mode(page, 'composition', 'payment')
  assert.equal(editor.view(page).complete, false)
  for (const [index, amount] of [[0, '6.00'], [1, '4.00']]) {
    editor.select(page, 'editorPart' + index, accounts[index])
    page.changeEditorPart({ ...editor.tap({ index }), detail: { value: amount } })
  }
  assert.equal(editor.view(page).complete, false)
  assert.equal(editor.view(page).payload.composition.incomplete, true)
  editor.edit(page, 'evidenceNote', '已核对合成支付详情')
  assert.equal(editor.view(page).complete, true)
  assert.deepEqual(editor.plain(editor.view(page).payload.composition.parts.map(part => part.amountMinor)), ['600', '400'])
  for (const value of ['10.01', '1.001', '-1']) {
    page.changeEditorPart({ ...editor.tap({ index: 1 }), detail: { value } })
    assert.equal(editor.view(page).canSave, false)
  }
  page.changeEditorPart({ ...editor.tap({ index: 1 }), detail: { value: '' } })
  assert.equal(editor.view(page).complete, false)
  assert.equal(editor.view(page).payload.composition.parts[1].amountMinor, null)
})

test('组合支付预填唯一来源账户和明确还款性质，歧义与未知保持未选', () => {
  const accounts = [
    { accountId: 'bank', name: '测试银行储蓄卡(1234)', currency: 'CNY' },
    { accountId: 'wallet', name: '支付宝账户余额', currency: 'CNY' }
  ]
  const event = { currency: 'CNY', economicNature: 'unknown',
    primaryEvidence: { sourceType: 'alipay', item: '先采后付账单付款' },
    paymentComponents: [{ componentKind: 'financial', label: '测试银行储蓄卡(1234)' }, { componentKind: 'financial', label: '账户余额' }] }
  const initial = model.paymentResolutionDefaults(event, accounts)
  assert.equal(initial.natureIndex, 0)
  assert.equal(model.paymentResolutionDefaults({ ...event, economicNature: 'repayment' }, accounts).natureIndex, 2)
  assert.deepEqual(initial.rows.map(row => row.accountId), ['bank', 'wallet'])
  assert.ok(initial.rows.every(row => row.amountInput === ''))
  const ambiguous = model.paymentResolutionDefaults(event, accounts.concat([{ ...accounts[0], accountId: 'other' }]))
  assert.equal(ambiguous.rows[0].accountId, '')
  assert.equal(model.paymentResolutionDefaults({ ...event, primaryEvidence: { item: '普通商品' } }, accounts).natureIndex, 0)
  assert.equal(model.paymentResolutionDefaults({ ...event, primaryEvidence: { item: '信用卡还款' } }, accounts).natureIndex, 0)
})

test('账户阶段按来源成分只保存账户；统一编辑器沿用已保存付款账户', async t => {
  const issue = unknownIssue()
  issue.accountContext = { recognized: true, label: '测试银行', fundsSide: 'payment_component_0' }
  const page = pageFor(issue, [{ accountId: 'one', name: '测试银行', type: 'bank' }])
  page.refreshAccountMappings()
  page.openAccountChoice({ currentTarget: { dataset: { id: issue.issueId } } })
  page.selectAccountChoice({ currentTarget: { dataset: { value: 'account:one' } } })
  const decision = page.accountMappingDecision(issue)
  assert.equal(JSON.stringify(decision).includes('paymentResolution'), false)
  const { page: editorPage } = await editor.open(t, { economicNature: 'expense',
    paymentComponents: [{ componentKind: 'financial', label: '测试银行' }, { componentKind: 'financial', label: '测试余额' }],
    paymentAccounts: [{ componentIndex: 0, accountId: 'one' }, { componentIndex: 1, accountId: 'two' }],
    fieldSources: { paymentComponents: [{ componentKind: 'financial', label: '测试银行' }, { componentKind: 'financial', label: '测试余额' }] } })
  assert.deepEqual(editor.plain(editor.draft(editorPage).parts.map(part => part.accountId)), ['one', 'two'])
  assert.ok(editor.draft(editorPage).parts.every(part => part.amountInput === ''))
})

test('来源账户组不显示组合支付入口，普通选择器仍按账户归属；整理保留组合核对', () => {
  const issue = { issueType: 'account_mapping', status: 'open', reasonCodes: ['payment_components_ambiguous'],
    subject: { eventId: 'synthetic', economicNature: 'unknown' },
    accountContext: { label: '测试账户', fundsSide: 'payment_component_0', recognized: true } }
  const grouped = model.issueView(issue)
  assert.equal(grouped.label, '测试账户')
  assert.equal(grouped.paymentNeedsReview, false)
  assert.equal(model.issueView({ ...issue, accountContext: { ...issue.accountContext, fundsSide: 'payment_target' } }).paymentNeedsReview, false)
  assert.equal(model.issueView({ ...issue, issueType: 'shared_fields' }).paymentNeedsReview, true)
})

test('补充还入账户只改草稿，删除或清空分配重新计算缺口', async t => {
  const { h, page, drafts } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0', amountMinor: '10000' })
  editor.mode(page, 'composition', 'repayment'); editor.select(page, 'editorPart0', drafts[0])
  page.changeEditorPart({ ...editor.tap({ index: 0 }), detail: { value: '100.00' } })
  assert.equal(editor.view(page).complete, true)
  page.addEditorPart(); assert.equal(editor.view(page).complete, false)
  page.removeEditorPart(editor.tap({ index: 1 })); assert.equal(editor.view(page).complete, true)
  page.changeEditorPart({ ...editor.tap({ index: 0 }), detail: { value: '' } })
  assert.equal(editor.view(page).complete, false)
  assert.equal(editor.writes(h).length, 0)
})

test('分类保存只提交分类，隐藏的预选账户不覆盖原账户', () => {
  const page = pageFor(unknownIssue())
  page.data.currentIssue = { issueType: 'category_assignment' }
  page.data.accountChoices = [{ accountId: 'must-not-be-written' }]
  page.data.issueCategories = [{ categoryId: 'category-expense' }]
  let saved
  page.resolveIssue = (decision, extra) => { saved = { decision, extra } }
  page.resolveWithFields()
  assert.equal(saved.decision, 'apply_fields')
  assert.equal(JSON.stringify(saved.extra.fields), JSON.stringify({ categoryId: 'category-expense' }))
})

test('性质可先确认，分类留待后续而不擅自选首项', async t => {
  const { page } = await editor.open(t, { economicNature: 'unknown', ledgerAccountId: 'account-0', categoryId: null })
  editor.nature(page, 'expense')
  assert.equal(editor.view(page).payload.fields.economicNature, 'expense')
  assert.equal(Object.hasOwn(editor.view(page).payload.fields, 'categoryId'), false)
})

test('缺转入账户可保存待核对草稿，但不冒充完成或自动写入', async t => {
  const { h, page, accounts } = await editor.open(t, { economicNature: 'internal_transfer', ledgerAccountId: 'account-0' })
  assert.equal(editor.view(page).complete, false)
  editor.select(page, 'reviewCounterparty', accounts[1]); assert.equal(editor.view(page).complete, true)
  page.clearEditorChoice(editor.tap({ field: 'counterpartyLedgerAccountId' }))
  assert.equal(editor.view(page).complete, false)
  assert.ok(editor.view(page).missing.includes('转入账户'))
  assert.equal(editor.writes(h).length, 0)
})

test('两端不能为同一账户，不依赖问题分组或来源投影', async t => {
  const { page, accounts } = await editor.open(t, { ledgerAccountId: 'account-0' })
  editor.select(page, 'reviewCounterparty', accounts[0])
  assert.equal(editor.view(page).canSave, false)
  editor.select(page, 'reviewCounterparty', accounts[1])
  assert.equal(editor.view(page).canSave, true)
  assert.equal(editor.view(page).complete, true)
  editor.select(page, 'reviewAccount', accounts[1]); assert.equal(editor.view(page).canSave, false)
})

test('账户映射新建名称与类型实时校验，批量分类须选定分类', () => {
  const page = pageFor(unknownIssue())
  page.data.currentIssue = { issueType: 'account_mapping' }
  // 直接构造表单的测试须模拟详情已经核实；未就绪时不能切换性质。
  page.data.issueDetailsReady = true
  page.data.accountChoices = [{ isCreate: true }]
  for (const name of ['', '   ', '名'.repeat(33)]) {
    page.changeDraftAccountName({ detail: { value: name } })
    assert.equal(page.data.issueFieldsCanSave, false)
  }
  page.changeDraftAccountName({ detail: { value: '测试钱包' } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.changeDraftAccountType({ detail: { value: 999 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeDraftAccountType({ detail: { value: 2 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  assert.equal(Object.hasOwn(model.buildIssueFieldsDraft(page.data).fields, 'categoryId'), false)
  page.data.currentIssue = { issueType: 'category_assignment' }
  page.data.issueCategories = [{ categoryId: '', isPlaceholder: true }, { categoryId: 'category' }]
  page.changeIssueCategory({ detail: { value: 0 } })
  assert.equal(page.data.issueFieldsCanSave, false)
  page.changeIssueCategory({ detail: { value: 1 } })
  assert.equal(page.data.issueFieldsCanSave, true)
  page.changeIssueCategory({ detail: { value: 0 } })
  assert.equal(page.data.issueFieldsCanSave, false)
})

test('普通资金区域只渲染统一编辑字段并使用同一保存门禁', () => {
  const root = path.join(__dirname, '../miniprogram/pages/import-workbench')
  const markup = fs.readFileSync(path.join(root, 'review-editor-fields.wxml'), 'utf8')
  assert.match(markup, /editor.routeFields/)
  assert.match(markup, /changeEditorPart/)
  assert.match(markup, /editor.partFields/)
  const sheet = fs.readFileSync(path.join(root, 'review-edit.wxml'), 'utf8')
  assert.match(sheet, /reviewEditSheet.canSave/)
  assert.match(sheet, /saveReviewEdit/)
})

test('组合金额使用整数差额，多账户仅全部动作分配，空白不能冒充已确认零', () => {
  const rows = [{ componentIndex: 0, accountId: 'a', amountInput: '' }, { componentIndex: 1, accountId: 'b', amountInput: '' }]
  const updated = model.updatePaymentAmounts(rows, 0, '0.10', '30')
  assert.deepEqual(updated.map(row => row.amountInput), ['0.10', '0.20'])
  assert.equal(rows[0].amountInput, '')
  assert.equal(model.updatePaymentAmounts(rows, 1, '999999999999.98', '99999999999999')[0].amountInput, '0.01')
  assert.equal(model.buildPaymentResolutionDraft([{ ...rows[0], amountInput: '0' }, { ...rows[1], amountInput: '0.30' }], 'expense', null, '核对', '30').valid, true)
  assert.equal(model.buildPaymentResolutionDraft([rows[0], { ...rows[1], amountInput: '0.30' }], 'expense', null, '核对', '30').valid, false)
  const many = [...rows, { componentIndex: 2, accountId: 'c', amountInput: '' }]
  assert.deepEqual(model.updatePaymentAmounts(many, 1, '0.10', '30').map(row => row.amountInput), ['', '0.10', ''])
  const all = model.updatePaymentAmounts(many, 2, '', '30', true)
  assert.deepEqual(all.map(row => row.amountInput), ['0.00', '0.00', '0.30'])
  assert.equal(model.buildPaymentResolutionDraft(all, 'expense', null, '核对', '30').valid, true)
})

test('修改分配金额只更新对应叶字段，不把另一行输入重新下发', async t => {
  const { page, accounts } = await editor.open(t, { economicNature: 'expense', amountMinor: '10000' })
  editor.mode(page, 'composition', 'payment')
  editor.select(page, 'editorPart0', accounts[0]); editor.select(page, 'editorPart1', accounts[1])
  const patches = [], original = page.setData
  page.setData = function (patch) { patches.push(patch); original.call(this, patch) }
  page.changeEditorPart({ ...editor.tap({ index: 1 }), detail: { value: '50.' } })
  assert.equal(editor.draft(page).parts[1].amountInput, '50.')
  assert.ok(patches.some(patch => patch['reviewEditSheet.draft.parts[1].amountInput'] === '50.'))
  assert.ok(patches.every(patch => !Object.keys(patch).some(key => key === 'reviewEditSheet.draft.parts' || key.includes('parts[0]'))))
})
