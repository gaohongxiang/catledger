const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const editor = require('./helpers/editor-workbench')
const model = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
const details = require('../miniprogram/packages/finance/pages/import-workbench/detail-fields')
const presentation = require('../miniprogram/packages/finance/pages/import-workbench/presentation')

const ACCOUNTS = [
  { accountId: 'synthetic-credit', name: '合成信用卡', type: 'credit', currency: 'CNY' },
  { accountId: 'synthetic-bank', name: '合成收款账户', type: 'bank', currency: 'CNY' }
]
function row(role = 'registration', changes = {}) {
  const disbursement = { role, planLabel: '合成现金分期', totalTerms: 12 }
  return { eventId: 'synthetic-registration', version: 1, status: 'needs_action', currency: 'CNY',
    economicNature: role === 'registration' ? 'unknown' : 'borrow', flowDirection: 'neutral', sourceDirection: 'expense',
    amountMinor: '120000', localAt: '2026-08-25 12:00:00', ledgerAccountId: ACCOUNTS[0].accountId,
    counterpartyLedgerAccountId: role === 'registration' ? null : ACCOUNTS[1].accountId,
    categoryId: null, reasonCodes: [], disbursement, fieldSources: { disbursement },
    primaryEvidence: { sourceType: 'bank', item: '合成现金分期12期 转分期付款', counterparty: '' },
    editorFacts: { version: 1, readonly: false, recordRole: role === 'registration' ? 'installment_registration' : 'transaction',
      natures: role === 'registration' ? ['unknown'] : ['borrow'], composition: 'single', timezoneOffsetMinutes: -480 }, ...changes }
}
const derive = (item, draft, extra = {}) => model.derive(item, draft, { accounts: ACCOUNTS, ...extra })
function draftForCreate(item, fields = {}) {
  let draft = model.create(item)
  for (const [key, value] of Object.entries({ planAction: 'create', planStartMonth: '2026-03',
    planRatePercent: '0.65', planFirstPaymentDate: '2026-04-10', ...fields })) draft = model.change(item, draft, key, value)
  return draft
}
function fillCreate(page, fields = {}) {
  page.selectEditorPlanAction(editor.tap({ value: 'create' }))
  for (const [field, value] of Object.entries({ planStartMonth: '2026-03', planRatePercent: '0.65',
    planFirstPaymentDate: '2026-04-10', ...fields })) editor.edit(page, field, value)
}
function apiFor(h) {
  return h.load(path.resolve(__dirname, '../miniprogram/services/catledger-api.js'))
}
function acceptReview(h, status = 'ready') {
  h.intercept = action => {
    if (action !== 'financeUpdates.setReview') return
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', action, update: h.summary.update, event: { status } }
  }
}

test('分期登记只给信用卡与计划，unknown 不提示修改性质，也不出现资金两端或分类', () => {
  const item = row(), draft = model.create(item), view = derive(item, draft)
  assert.equal(presentation.record(item).displayTitle, '分期登记')
  assert.equal(details.natureLabel(item), '分期登记')
  assert.equal(view.title, '分期登记')
  assert.equal(view.natureLabel, '分期登记')
  assert.equal(view.natureEditable, false)
  assert.equal(view.naturePending, false)
  assert.equal(view.directionClass, '')
  assert.deepEqual(view.natureOptions.map(item => item.value), ['unknown'])
  assert.deepEqual(view.accountFields.map(field => [field.label, field.allowedTypes]), [['所属信用卡', ['credit']]])
  assert.equal(view.fundsEndpoints.length, 1)
  assert.equal(view.fundsEndpoints[0].addable, false)
  assert.equal(view.categoryKind, '')
  assert.equal(view.showLoan, false)
  assert.equal(view.showOwnership, false)
  assert.equal(view.complete, false)
  assert.deepEqual(view.missing, ['分期计划'])
  assert.match(view.disbursementPlan.effectText, /不生成资金流水/)
  for (const [key, value] of Object.entries({ economicNature: 'income', counterpartyLedgerAccountId: 'other', categoryId: 'category',
    amountInput: '1', composition: 'payment', owner: 'other', note: '不应写入' })) {
    assert.equal(model.change(item, draft, key, value), draft, key)
  }
})

test('分期登记先不关联保留待核对；选计划后只输出既有 installmentPlan 决定', () => {
  const item = row()
  let draft = model.change(item, model.create(item), 'planAction', 'skip')
  let view = derive(item, draft)
  assert.equal(view.canSave, true)
  assert.equal(view.complete, false)
  assert.match(view.disbursementPlan.skipText, /保留待核对/)
  assert.deepEqual(Object.keys(view.payload.fields), ['installmentPlan'])
  assert.equal(view.payload.fields.installmentPlan.startMonth, null)
  const saved = row('registration', { installmentPlanDecision: view.payload.fields.installmentPlan })
  assert.match(derive(saved, model.create(saved)).disbursementPlan.savedText, /仍待核对/)
  assert.doesNotMatch(derive(saved, model.create(saved)).disbursementPlan.savedText, /已归入|已关联|可入账/)
  draft = model.change(item, draft, 'planAction', 'link')
  draft = model.change(item, draft, 'planLoanId', 'synthetic-plan')
  view = derive(item, draft, { planCandidates: [{ loanId: 'synthetic-plan', name: '已有合成分期', scheduleTerms: 12, startMonth: '2026-02' }] })
  assert.equal(view.canSave, true)
  assert.equal(view.complete, true)
  assert.deepEqual(view.payload.fields.installmentPlan, { action: 'link', loanId: 'synthetic-plan',
    planLabel: '已有合成分期', totalTerms: 12, principalMinor: '120000', startMonth: '2026-02', accountId: ACCOUNTS[0].accountId })
  assert.equal(view.payload.decisions, undefined)
})

test('现金分期借款保留一张借款卡，计划未关联时不承诺尚不存在的后续入口', () => {
  const item = row('disbursement'), draft = model.change(item, model.create(item), 'planAction', 'skip'), view = derive(item, draft)
  assert.equal(presentation.record(item).displayTitle, '现金分期借款')
  assert.equal(view.title, '现金分期借款')
  assert.deepEqual(view.accountFields.map(field => field.label), ['借款负债账户', '到账账户'])
  assert.equal(view.complete, true)
  assert.match(view.disbursementPlan.skipText, /只记录借款，暂不关联分期计划/)
  assert.doesNotMatch(view.disbursementPlan.effectText, /已按借款入账/)
  const fields = details.fieldsFor({ ...item, installmentPlanDecision: view.payload.fields.installmentPlan })
  assert.match(fields.find(field => field.key === 'plan').value, /当前尚无入账后补关联入口/)
  const reclassified = derive(item, model.change(item, draft, 'economicNature', 'expense'))
  assert.equal(reclassified.natureLabel, '支出')
  assert.equal(reclassified.title, '核对交易')
  assert.doesNotMatch(reclassified.disbursementPlan.effectText, /这笔借款/)
  assert.notEqual(presentation.record({ ...item, economicNature: 'expense' }).displayTitle, '现金分期借款')
})

test('新建计划不把账单日期当起始月或首期还款日，必须明确填写利率且允许真实零利率', () => {
  const item = row(), blank = model.create(item)
  assert.equal(blank.planStartMonth, '')
  assert.equal(blank.planRatePercent, '')
  assert.equal(blank.planFirstPaymentDate, '')
  const missing = derive(item, model.change(item, blank, 'planAction', 'create'))
  assert.equal(missing.canSave, false)
  assert.match(missing.fieldErrors.plan, /起始月/)
  assert.match(missing.fieldErrors.plan, /利率/)
  for (const fields of [{ planRatePercent: '' }, { planRatePercent: '-1' }, { planFirstPaymentDate: '' },
    { planFirstPaymentDate: '2026-02-30' }, { planStartMonth: '' }]) {
    const view = derive(item, draftForCreate(item, fields))
    assert.equal(view.canSave, false, JSON.stringify(fields))
  }
  const view = derive(item, draftForCreate(item, { planRatePercent: '0', planFirstPaymentDate: '2028-02-29' }))
  assert.equal(view.canSave, true)
  assert.equal(view.planRequest.schedule.ratePpm, '0')
  assert.equal(view.planRequest.schedule.firstPaymentDate, '2028-02-29')
  assert.equal(view.planRequest.startMonth, '2026-03')
  assert.equal(view.payload.fields.installmentPlan, undefined, '未建立计划前不能伪造计划 ID')
})

test('创建计划采用现有还款参数口径，额外创建字段不进入导入决定，已建计划恢复后不重建', () => {
  const item = row(), draft = draftForCreate(item, { planQuoteIndex: 3 }), view = derive(item, draft)
  assert.deepEqual(view.planRequest.schedule, { scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'installment',
    ratePpm: '6500', repaymentMinor: null, feePerTermMinor: null, feeUpfrontMinor: null, firstPaymentDate: '2026-04-10' })
  const created = model.change(item, draft, 'planLoanId', 'synthetic-new-plan')
  const decision = derive(item, created).payload
  assert.deepEqual(Object.keys(decision.fields.installmentPlan).sort(), ['accountId', 'action', 'loanId', 'planLabel', 'principalMinor', 'startMonth', 'totalTerms'].sort())
  const restored = model.restore(item, decision), restoredView = derive(item, restored)
  assert.equal(restoredView.planRequest, null)
  assert.equal(restoredView.canSave, true)
  assert.equal(restoredView.disbursementPlan.formLocked, true)
  assert.equal(model.change(item, restored, 'planRatePercent', '2'), restored)
  assert.deepEqual(restoredView.payload.fields.installmentPlan, decision.fields.installmentPlan)
})

test('真实 Page 的分期登记拦住旧性质、资金两端、分类和备注入口，只接受所属信用卡', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  assert.equal(editor.view(page).registration, true)
  page.openNatureSheet()
  assert.equal(page.data.reviewEditSheet.natureOpen, false)
  editor.nature(page, 'income')
  editor.mode(page, 'owner', 'other')
  editor.edit(page, 'note', '不应写入')
  assert.equal(editor.draft(page).economicNature, 'unknown')
  assert.equal(editor.draft(page).owner, 'self')
  assert.equal(editor.draft(page).note, '')
  assert.equal(page.reviewEditorDirectory('editorCategory'), null)
  assert.equal(page.reviewEditorDirectory('reviewCounterparty'), null)
  assert.equal(editor.select(page, 'reviewAccount', ACCOUNTS[1]), false)
  assert.equal(editor.select(page, 'reviewAccount', ACCOUNTS[0]), true)
  page.selectEditorPlanAction(editor.tap({ value: 'skip' }))
  acceptReview(h, 'needs_action')
  await page.saveReviewEdit()
  const entry = h.calls.find(call => call.action === 'financeUpdates.setReview').input
  assert.equal(entry.fields.installmentPlan.action, 'skip')
  assert.equal(entry.fields.economicNature, undefined)
  assert.equal(entry.fields.counterpartyLedgerAccountId, undefined)
})

test('真实 Page 新建计划先校验，利率口径互锁，并将用户填写的日期利率只送给 loans.create', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  const requests = []
  apiFor(h).callApi = async (action, data) => {
    requests.push({ action, data: editor.plain(data) })
    return { loanId: 'synthetic-created-plan' }
  }
  page.selectEditorPlanAction(editor.tap({ value: 'create' }))
  assert.equal(await page.createEditorPlan(page._reviewEditToken), false)
  assert.equal(requests.length, 0)
  fillCreate(page)
  page.selectEditorPlanSchedule(editor.input('planMethodIndex', 1))
  assert.equal(editor.draft(page).planMethodIndex, 1)
  page.selectEditorPlanSchedule(editor.input('planQuoteIndex', 3))
  assert.equal(editor.draft(page).planMethodIndex, 0)
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].action, 'loans.create')
  const payload = requests[0].data
  assert.equal(payload.ratePpm, '6500')
  assert.equal(payload.quoteType, 'installment')
  assert.equal(payload.firstPaymentDate, '2026-04-10')
  assert.equal(payload.startDate, '2026-03-01')
  assert.equal(payload.baselinePrincipalMinor, '120000')
  assert.equal(payload.originKind, undefined)
  assert.equal(payload.importAccountDraft, undefined, '已有账户不附带本批账户创建信息')
  const entry = h.calls.find(call => call.action === 'financeUpdates.setReview').input
  assert.equal(entry.fields.installmentPlan.loanId, 'synthetic-created-plan')
  assert.equal(entry.fields.installmentPlan.ratePpm, undefined)
  assert.equal(entry.fields.installmentPlan.firstPaymentDate, undefined)
})

test('创建回执未知时重试冻结请求；同一次保存连点不会创建第二个计划', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  const creates = []
  let finish, failed = false
  apiFor(h).callApi = async (action, data) => {
    if (action === 'transactions.commandResult') return null
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    if (!failed) { failed = true; throw Object.assign(Error('模拟断网'), { code: 'NETWORK_ERROR' }) }
    return new Promise(resolve => { finish = () => resolve({ loanId: 'synthetic-recovered-plan' }) })
  }
  fillCreate(page, { planRatePercent: '0' })
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(creates.length, 1)
  assert.equal(editor.draft(page).planLoanId, '')
  assert.equal(editor.draft(page).planRatePercent, '0')
  const retry = page.saveReviewEdit()
  await editor.flush()
  assert.equal(page.data.reviewEditSheet.saving, true)
  await page.saveReviewEdit()
  assert.equal(creates.length, 2)
  assert.deepEqual(creates[1], creates[0], '重试沿用原 requestId 和全部用户参数')
  finish()
  await retry
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.loanId, 'synthetic-recovered-plan')
  assert.equal(creates.length, 2)
})

test('登记来源未写总期数仍读取同卡计划；换卡后迟到候选不能回填', async t => {
  const item = row(), otherCard = { ...ACCOUNTS[0], accountId: 'synthetic-other-credit', name: '合成另一信用卡' }
  item.disbursement.totalTerms = null
  const { page, h } = await editor.open(t, item, { accounts: ACCOUNTS.concat(otherCard) })
  let finish, request
  apiFor(h).callApi = (action, data) => {
    assert.equal(action, 'loans.planCandidates')
    request = editor.plain(data)
    return new Promise(resolve => { finish = () => resolve({ items: [{ loanId: 'old-card-plan', name: '旧卡计划',
      scheduleTerms: 12, startMonth: '2026-01', originalPrincipalMinor: '120000', matched: true }] }) })
  }
  page.selectEditorPlanAction(editor.tap({ value: 'link' }))
  await editor.flush()
  assert.equal(request.totalTerms, null)
  assert.equal(request.startMonth, null)
  assert.equal(editor.select(page, 'reviewAccount', otherCard), true)
  finish()
  await editor.flush()
  assert.equal(editor.draft(page).planLoanId, '')
  assert.deepEqual(editor.plain(editor.view(page).disbursementPlan.candidates), [])
})

test('计划已建但事件保存回执未知时，重开编辑恢复同一计划 ID，不重复 loans.create', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  let created = 0, offline = true
  apiFor(h).callApi = async action => {
    assert.equal(action, 'loans.create')
    created += 1
    return { loanId: 'synthetic-reopen-plan' }
  }
  h.intercept = action => {
    if (action === 'imports.commandResult') throw Object.assign(Error('模拟回执未确认'), { code: 'OPERATION_UNCONFIRMED' })
    if (action !== 'financeUpdates.setReview') return
    if (offline) throw Object.assign(Error('模拟保存中断'), { code: 'NETWORK_ERROR' })
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', action, update: h.summary.update, event: { status: 'ready' } }
  }
  fillCreate(page)
  await page.saveReviewEdit()
  const first = h.calls.find(call => call.action === 'financeUpdates.setReview').input
  assert.equal(created, 1)
  assert.equal(page.data.reviewEditSheet.pending, true)
  page.closeReviewEdit()
  await page.openReviewEdit(editor.tap({ id: 'synthetic-registration' }))
  assert.equal(page.data.reviewEditSheet.pending, true)
  assert.equal(editor.draft(page).planLoanId, 'synthetic-reopen-plan')
  assert.equal(editor.view(page).planRequest, null)
  editor.edit(page, 'planRatePercent', '8')
  assert.equal(editor.draft(page).planRatePercent, '')
  offline = false
  await page.saveReviewEdit()
  assert.equal(created, 1)
  assert.deepEqual(h.calls.filter(call => call.action === 'financeUpdates.setReview').map(call => call.input), [first, first])
})

for (const receiptKnown of [false, true]) test('创建结果未知后重开完整恢复表单与请求键：' + (receiptKnown ? '核实已有回执' : '重发原请求'), async t => {
  const { page, h } = await editor.open(t, row('disbursement', { counterpartyLedgerAccountId: null }), { accounts: ACCOUNTS })
  const creates = [], checks = []
  let offline = true
  apiFor(h).callApi = async (action, data) => {
    if (action === 'transactions.commandResult') {
      checks.push(editor.plain(data))
      return receiptKnown ? { action: 'loans.create', result: { loanId: 'synthetic-resumed-plan' } } : null
    }
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    if (offline) throw Object.assign(Error('模拟响应丢失'), { code: 'NETWORK_ERROR' })
    return { loanId: 'synthetic-resumed-plan' }
  }
  editor.select(page, 'reviewCounterparty', ACCOUNTS[1])
  editor.edit(page, 'note', '合成恢复备注')
  fillCreate(page, { planRatePercent: '1.25', planStartMonth: '2026-02', planFirstPaymentDate: '2026-03-09' })
  page.selectEditorPlanSchedule(editor.input('planQuoteIndex', 3))
  await page.saveReviewEdit()
  const original = creates[0]
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  const stored = [...h.storage.entries()].find(([key]) => key.startsWith('catledger_import_plan_create_v1:'))[1]
  assert.equal(stored.requestId, original.requestId)
  page.closeReviewEdit()
  if (receiptKnown) await page.postUpdate()
  else await page.openReviewEdit(editor.tap({ id: 'synthetic-registration' }))
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.post'), false, '创建未确认时先恢复原记录')
  const restored = editor.draft(page)
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  assert.equal(page.data.reviewEditSheet.canSave, true)
  assert.equal(restored.planAction, 'create')
  assert.equal(restored.planRatePercent, '1.25')
  assert.equal(restored.planStartMonth, '2026-02')
  assert.equal(restored.planFirstPaymentDate, '2026-03-09')
  assert.equal(restored.planQuoteIndex, 3)
  assert.equal(restored.counterpartyLedgerAccountId, ACCOUNTS[1].accountId)
  assert.equal(restored.note, '合成恢复备注')
  editor.edit(page, 'planRatePercent', '8')
  page.selectEditorPlanAction(editor.tap({ value: 'skip' }))
  assert.equal(editor.draft(page).planRatePercent, '1.25')
  assert.equal(editor.draft(page).planAction, 'create')
  offline = false
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(creates.length, receiptKnown ? 1 : 2)
  assert.equal(checks[0].requestId, original.requestId)
  if (!receiptKnown) assert.deepEqual(creates[1], original)
  const saved = h.calls.find(call => call.action === 'financeUpdates.setReview').input
  assert.equal(saved.fields.installmentPlan.loanId, 'synthetic-resumed-plan')
  assert.equal(saved.fields.counterpartyLedgerAccountId, ACCOUNTS[1].accountId)
  assert.equal([...h.storage.keys()].some(key => key.startsWith('catledger_import_plan_create_v1:')), false)
})

test('另一条记录不能接管未知的计划创建；原在途槽清除后仍沿用已保存的请求键', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS, count: 2 })
  Object.assign(h.events[1], row('registration', { eventId: 'synthetic-another-registration' }))
  const creates = []
  let offline = true
  apiFor(h).callApi = async (action, data) => {
    if (action === 'transactions.commandResult') return null
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    if (offline) throw Object.assign(Error('模拟请求结果未知'), { code: 'NETWORK_ERROR' })
    return { loanId: 'synthetic-owned-plan' }
  }
  fillCreate(page)
  await page.saveReviewEdit()
  const first = creates[0]
  page.closeReviewEdit()
  await page.openReviewEdit(editor.tap({ id: 'synthetic-another-registration' }))
  assert.equal(page.data.reviewEditSheet.planCreatePending, false)
  fillCreate(page)
  await page.saveReviewEdit()
  assert.equal(creates.length, 1)
  assert.match(page.data.reviewEditSheet.error, /另一次操作/)
  page.closeReviewEdit()
  for (const key of h.storage.keys()) if (key.startsWith('catledger_pending_ledger_v1:')) h.storage.delete(key)
  await page.openReviewEdit(editor.tap({ id: 'synthetic-registration' }))
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  offline = false
  acceptReview(h)
  await page.saveReviewEdit()
  assert.deepEqual(creates, [first, first], '即使通用槽已不存在，也不能换新 requestId 创建另一份计划')
})

test('恢复指针写入失败不发送创建；已成功回执保存失败时保留原请求待恢复', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  const write = h.wx.setStorageSync
  let fail = 'before', created = 0
  h.wx.setStorageSync = (key, value) => {
    if (key.startsWith('catledger_import_plan_create_v1:') && (fail === 'before' || fail === 'receipt' && value.loanId)) throw Error('模拟存储不可用')
    return write(key, value)
  }
  apiFor(h).callApi = async action => {
    if (action === 'transactions.commandResult') return { action: 'loans.create', result: { loanId: 'synthetic-persisted-plan' } }
    assert.equal(action, 'loans.create')
    created += 1
    return { loanId: 'synthetic-persisted-plan' }
  }
  fillCreate(page)
  await page.saveReviewEdit()
  assert.equal(created, 0)
  assert.match(page.data.reviewEditSheet.error, /本机未能保存/)
  fail = 'receipt'
  await page.saveReviewEdit()
  assert.equal(created, 1)
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  assert.ok([...h.storage.keys()].some(key => key.startsWith('catledger_pending_ledger_v1:')))
  page.closeReviewEdit()
  await page.openReviewEdit(editor.tap({ id: 'synthetic-registration' }))
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  fail = ''
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(created, 1)
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.loanId, 'synthetic-persisted-plan')
})

test('别页核实并清掉通用创建槽后，未保存的计划归属仍拦住整批入账', async t => {
  const { page, h } = await editor.open(t, row('disbursement', { status: 'ready' }), { accounts: ACCOUNTS })
  const creates = []
  apiFor(h).callApi = async (action, data) => {
    if (action === 'transactions.commandResult') return { action: 'loans.create', result: { loanId: 'synthetic-verified-elsewhere' } }
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    if (creates.length > 1) return { loanId: 'synthetic-verified-elsewhere' }
    throw Object.assign(Error('模拟已创建但响应丢失'), { code: 'NETWORK_ERROR' })
  }
  fillCreate(page)
  await page.saveReviewEdit()
  const requestId = creates[0].requestId
  assert.deepEqual(creates[0].importOrigin, { updateId: page.data.update.updateId, eventId: 'synthetic-registration' })
  page.closeReviewEdit()
  const genericPending = h.load(path.resolve(__dirname, '../miniprogram/services/pending-ledger-write.js'))
  await genericPending.verify()
  assert.equal(genericPending.pending(), null)
  assert.equal(page.pendingReviewEdit().payload.requestId, requestId)
  await page.postUpdate()
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.post'), false)
  assert.equal(page.data.reviewEditSheet.eventId, 'synthetic-registration')
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  acceptReview(h)
  await page.saveReviewEdit()
  assert.deepEqual(creates, [creates[0], creates[0]], '没有通用槽时仍以原参数和原请求键重放已创建计划')
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.loanId, 'synthetic-verified-elsewhere')
  assert.equal(page.pendingReviewEdit(), null)
})

test('账单已明确总期数时，旧输入事件不能改成另一期数后创建计划', async t => {
  const item = row(), initial = model.create(item)
  assert.equal(model.change(item, initial, 'planTerms', '24'), initial)
  const { page, h } = await editor.open(t, item, { accounts: ACCOUNTS })
  const creates = []
  apiFor(h).callApi = async (action, data) => {
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    return { loanId: 'synthetic-correct-terms' }
  }
  fillCreate(page, { planTerms: '24' })
  assert.equal(editor.view(page).disbursementPlan.termsReadonly, true)
  assert.equal(editor.draft(page).planTerms, '12')
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(creates.length, 1)
  assert.equal(creates[0].scheduleTerms, 12)
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.totalTerms, 12)
})

test('旧草稿和创建恢复值的期数与账单不符时，不能创建或保存计划归属', () => {
  const item = row(), stale = { ...draftForCreate(item), planTerms: '24' }
  let view = derive(item, stale)
  assert.equal(view.canSave, false)
  assert.match(view.fieldErrors.plan, /账单为 12 期/)
  for (const action of ['create', 'link']) {
    const restored = model.restore(item, { fields: { installmentPlan: { action, loanId: 'synthetic-wrong-terms',
      planLabel: '合成现金分期', totalTerms: 24, principalMinor: '120000', startMonth: '2026-03', accountId: ACCOUNTS[0].accountId } } })
    view = derive(item, restored)
    assert.equal(view.canSave, false, action)
    assert.match(view.fieldErrors.plan, /账单为 12 期/, action)
    assert.equal(view.disbursementPlan.formLocked, action === 'create')
  }
})

test('期数不符的候选显示理由并禁止旧点击和自动预选，匹配期数仍可保存', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  const candidates = [
    { loanId: 'synthetic-wrong-terms', name: '合成24期计划', scheduleTerms: 24, startMonth: '2026-03', matched: true },
    { loanId: 'synthetic-right-terms', name: '合成12期计划', scheduleTerms: 12, startMonth: '2026-03' }
  ]
  apiFor(h).callApi = async action => {
    assert.equal(action, 'loans.planCandidates')
    return { items: candidates }
  }
  page.selectEditorPlanAction(editor.tap({ value: 'link' }))
  await editor.flush()
  const view = editor.view(page).disbursementPlan
  assert.equal(view.candidates[0].disabled, true)
  assert.match(view.candidates[0].disabledReason, /账单为 12 期/)
  assert.equal(view.candidates[0].matched, false)
  assert.equal(view.matchedCount, 0)
  assert.equal(editor.draft(page).planLoanId, '')
  page.selectEditorPlanCandidate(editor.tap({ id: candidates[0].loanId }))
  assert.equal(editor.draft(page).planLoanId, '')
  const stale = model.change(row(), editor.draft(page), 'planLoanId', candidates[0].loanId)
  assert.equal(derive(row(), stale, { planCandidates: candidates }).canSave, false)
  page.selectEditorPlanCandidate(editor.tap({ id: candidates[1].loanId }))
  assert.equal(editor.draft(page).planLoanId, candidates[1].loanId)
  assert.equal(editor.view(page).canSave, true)
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.loanId, candidates[1].loanId)
})

test('账单未写总期数时仍允许填写期数和选择不同期数的已有计划', async t => {
  const item = row()
  item.disbursement.totalTerms = null
  const { page, h } = await editor.open(t, item, { accounts: ACCOUNTS })
  fillCreate(page, { planTerms: '24' })
  assert.equal(editor.view(page).disbursementPlan.termsReadonly, false)
  assert.equal(editor.draft(page).planTerms, '24')
  assert.equal(editor.view(page).canSave, true)
  assert.equal(editor.view(page).planRequest.terms, 24)
  apiFor(h).callApi = async action => {
    assert.equal(action, 'loans.planCandidates')
    return { items: [{ loanId: 'synthetic-flexible-terms', name: '合成36期计划', scheduleTerms: 36, startMonth: '2026-03' }] }
  }
  page.selectEditorPlanAction(editor.tap({ value: 'link' }))
  await editor.flush()
  assert.equal(editor.view(page).disbursementPlan.candidates[0].disabled, false)
  page.selectEditorPlanCandidate(editor.tap({ id: 'synthetic-flexible-terms' }))
  assert.equal(editor.view(page).canSave, true)
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.totalTerms, 36)
})

test('本批草稿信用卡新建计划时附原账户ID和快照，说明放弃导入仍保留信用卡', async t => {
  const { page, h } = await editor.open(t, row(), { accounts: ACCOUNTS })
  const snapshotId = '40000000-0000-4000-8000-000000000001'
  const credit = { ...ACCOUNTS[0] }
  page._draftSession.model = { drafts: new Map([[credit.accountId, credit]]), facts: { snapshotId } }
  const creates = []
  apiFor(h).callApi = async (action, data) => {
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    return { loanId: 'synthetic-plan-with-credit' }
  }
  fillCreate(page)
  assert.equal(editor.view(page).disbursementPlan.accountCreationText, '会同时创建这张信用卡；放弃导入时信用卡保留。')
  acceptReview(h)
  await page.saveReviewEdit()
  assert.equal(creates.length, 1)
  assert.equal(creates[0].accountId, credit.accountId)
  assert.deepEqual(creates[0].importAccountDraft, { snapshotId, name: credit.name, type: 'credit', currency: 'CNY' })
  const decision = h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan
  assert.equal(decision.accountId, credit.accountId)
  assert.equal(decision.loanId, 'synthetic-plan-with-credit')
  assert.equal(decision.importAccountDraft, undefined)
})

test('仅isDraft标记也识别本批信用卡，缺快照时明确拦截且不发送创建', async t => {
  const credit = { ...ACCOUNTS[0], isDraft: true }
  const { page, h } = await editor.open(t, row(), { accounts: [credit, ACCOUNTS[1]] })
  page._draftSession.model = { drafts: new Map(), facts: {} }
  assert.equal(editor.select(page, 'reviewAccount', credit), true)
  const creates = []
  apiFor(h).callApi = async (action, data) => {
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    return { loanId: 'synthetic-flagged-credit-plan' }
  }
  fillCreate(page)
  assert.equal(editor.view(page).canSave, false)
  assert.equal(editor.view(page).planRequest, null)
  assert.match(editor.view(page).fieldErrors.plan, /尚未读取本批账户资料/)
  await page.saveReviewEdit()
  assert.equal(await page.createEditorPlan(page._reviewEditToken), false)
  assert.match(page.data.reviewEditSheet.error, /重新打开本次导入/)
  assert.equal(creates.length, 0)
  const snapshotId = '40000000-0000-4000-8000-000000000002'
  page._draftSession.model.facts.snapshotId = snapshotId
  editor.edit(page, 'planRatePercent', '0.65')
  assert.equal(editor.view(page).canSave, true)
  acceptReview(h)
  await page.saveReviewEdit()
  assert.deepEqual(creates[0].importAccountDraft, { snapshotId, name: credit.name, type: 'credit', currency: 'CNY' })
})

test('草稿信用卡与计划创建中断后重开仍使用原快照和全部参数', async t => {
  const { page, h } = await editor.open(t, row('disbursement'), { accounts: ACCOUNTS })
  const snapshotId = '40000000-0000-4000-8000-000000000003'
  const credit = { ...ACCOUNTS[0] }
  page._draftSession.model = { drafts: new Map([[credit.accountId, credit]]), facts: { snapshotId } }
  const creates = []
  let offline = true
  apiFor(h).callApi = async (action, data) => {
    if (action === 'transactions.commandResult') return null
    assert.equal(action, 'loans.create')
    creates.push(editor.plain(data))
    if (offline) throw Object.assign(Error('模拟创建响应丢失'), { code: 'NETWORK_ERROR' })
    return { loanId: 'synthetic-recovered-credit-plan' }
  }
  fillCreate(page, { planRatePercent: '0' })
  await page.saveReviewEdit()
  assert.equal(page.data.reviewEditSheet.planCreatePending, true)
  const first = creates[0]
  assert.deepEqual(first.importAccountDraft, { snapshotId, name: credit.name, type: 'credit', currency: 'CNY' })
  page.closeReviewEdit()
  page._draftSession.model.facts.snapshotId = '40000000-0000-4000-8000-000000000004'
  page._draftSession.model.drafts.set(credit.accountId, { ...credit, name: '后来显示的账户名' })
  await page.openReviewEdit(editor.tap({ id: 'synthetic-registration' }))
  assert.deepEqual(editor.plain(editor.view(page).planRequest.importAccountDraft), first.importAccountDraft)
  assert.equal(editor.draft(page).planRatePercent, '0')
  offline = false
  acceptReview(h)
  await page.saveReviewEdit()
  assert.deepEqual(creates, [first, first], '账户资料、快照和requestId都沿用原请求')
  assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields.installmentPlan.accountId, credit.accountId)
})
