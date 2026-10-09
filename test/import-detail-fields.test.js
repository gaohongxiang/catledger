const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const detail = require('../miniprogram/pages/import-workbench/detail-fields')
const form = require('../miniprogram/pages/import-workbench/detail-form')
const { readDetail } = require('../miniprogram/pages/import-workbench/detail-reader')
const { NATURE_OPTIONS } = require('../miniprogram/pages/import-workbench/transaction-review')
const { transactionDrafts } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
const { eventDetailFacts } = require('../cloudfunctions/catledger-import/src/event-detail-facts')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const tap = id => ({ currentTarget: { dataset: { id } } })
const credit = { accountId: '10000000-0000-4000-8000-000000000001', name: '合成信用卡', type: 'credit' }
const bank = { accountId: '10000000-0000-4000-8000-000000000002', name: '合成储蓄卡', type: 'bank' }
const row = nature => ({ eventId: 'synthetic-event-0', version: 1, economicNature: nature, sourceDirection: 'income',
  flowDirection: 'inflow', amountMinor: '12345', localAt: '2026-09-01 12:00:00', currency: 'CNY',
  ledgerAccountId: credit.accountId, fieldSources: {}, primaryEvidence: { note: '合成备注', counterparty: '合成对方' } })
const fields = input => Object.fromEntries(detail.fieldsFor(input, { accounts: [credit, bank] }).map(item => [item.key, item]))
for (const nature of ['income', 'expense', 'refund', 'internal_transfer', 'repayment', 'borrow', 'fee', 'balance_adjustment', 'unknown']) {
  test('性质始终首项且不改原记录：' + nature, () => {
    const input = row(nature), before = JSON.stringify(input), result = detail.fieldsFor(input)
    assert.equal(result[0].key, 'nature')
    assert.equal(result[0].value, detail.natureLabel(input))
    assert.equal(fields(input).note.value, '合成备注')
    assert.equal(JSON.stringify(input), before)
  })
}
test('入账端点与可见账户角色一致，不通过显示层再次交换内部 ID', () => {
  for (const sourceDirection of ['income', 'expense', null]) {
    for (const nature of ['repayment', 'borrow', 'internal_transfer']) {
      const input = { ...row(nature), sourceDirection, counterpartyLedgerAccountId: bank.accountId }
      const labels = detail.accountLabels(input), draft = transactionDrafts(input)[0]
      const reverse = draft.destinationAccountId === input.ledgerAccountId
      assert.equal(labels.reverse, reverse)
      if (nature === 'repayment') assert.equal(labels.from, reverse ? '还入账户' : '付款账户')
      if (nature === 'borrow') assert.equal(labels.from, reverse ? '到账账户' : '借款负债账户')
      const ordered = detail.fieldsFor(input, { accounts: [credit, bank] }).filter(field => ['account', 'counterparty'].includes(field.key))
      assert.deepEqual(ordered.map(field => field.label), {
        repayment: ['付款账户', '还入账户'], borrow: ['借款负债账户', '到账账户'], internal_transfer: ['转出账户', '转入账户']
      }[nature])
      assert.equal(ordered[0].value, draft.sourceAccountId === credit.accountId ? credit.name : bank.name)
      assert.equal(ordered[1].value, draft.destinationAccountId === credit.accountId ? credit.name : bank.name)
    }
  }
})
test('单端账户随性质命名，组合支付及合并还款保留分配并先付后收', () => {
  for (const [nature, label] of Object.entries({ income: '收款账户', refund: '收款账户', expense: '付款账户', fee: '付款账户',
    balance_adjustment: '调整账户', unknown: '账单所属账户' })) assert.equal(fields(row(nature)).account.label, label)
  for (const allocation of [
    { paymentResolution: { allocations: [{ accountId: bank.accountId, amountMinor: '12345' }] }, counterpartyLedgerAccountId: credit.accountId },
    { ledgerAccountId: bank.accountId, repaymentAllocations: [{ accountId: credit.accountId, amountMinor: '12345' }] }
  ]) {
    const result = detail.fieldsFor({ ...row('repayment'), ...allocation }, { accounts: [bank, credit] })
      .filter(field => /^(account|counterparty|payment-|repayment-)/.test(field.key))
    assert.match(result[0].label, /^付款账户/)
    assert.match(result[0].value, /合成储蓄卡/)
    assert.match(result[1].label, /^还入账户/)
    assert.match(result[1].value, /合成信用卡/)
  }
})
test('分期本金只显示来源字段，不误呈现为已发生的还款；零金额不当作缺失', () => {
  const value = fields({ ...row('repayment'), installment: { creditStatement: true, component: 'principal', periodNumber: 3, totalTerms: 12 }, amountMinor: '0' })
  assert.equal(value.nature.value, '分期本金出账')
  assert.equal(value.account.label, '所属信用卡')
  assert.equal(value.counterparty, undefined)
  assert.equal(value.amount.value, '¥0.00')
  assert.match(value.effect.value, /不记实际还款/)
  assert.equal(fields({ ...row('expense'), amountMinor: null }).amount.missing, true)
})
test('退款、费用分项和计划来自已读取事实，不用缺 DTO 推断未关联', () => {
  assert.equal(fields(row('refund')).refund.value, '关联信息待读取')
  const original = { localAt: '2026-08-01 12:00:00', amountMinor: '15000', categoryName: '餐饮 / 美食' }
  const refund = fields({ ...row('refund'), detailFacts: { refund: { status: 'confirmed', originals: [original] } } })
  assert.match(refund.refund.value, /150.00/)
  assert.equal(refund.category.value, '餐饮 / 美食')
  const repayment = fields({ ...row('repayment'), loanRepayment: { mode: 'associate', loanId: 'synthetic-loan', principalMinor: '12000',
    interestMinor: '345', feeMinor: '0', interestTreatment: 'accrued', feeTreatment: 'expense' }, detailFacts: { loan: { name: '合成贷款' } } })
  assert.equal(repayment.principal.value, '¥120.00')
  assert.equal(repayment.fee.value, '¥0.00')
  assert.match(repayment['interest-treatment'].value, /不重复支出/)
  assert.equal(repayment.plan.value, '合成贷款')
})
function draft(nature = 'repayment') {
  return { currentIssue: { issueId: 'synthetic-issue', issueType: 'shared_fields', subject: row('unknown') },
    issueDraft: { natureIndex: NATURE_OPTIONS.findIndex(item => item.value === nature), accountIndex: 0, counterpartyAccountIndex: 0, categoryIndex: 0 },
    accountChoices: [credit], counterpartyAccountChoices: [{ isPlaceholder: true }, bank], natureOptions: NATURE_OPTIONS,
    issueCategories: [{ isPlaceholder: true }], categories: [] }
}
test('未知性质改还款一次收集两端，缺失/同账户/停用对端均不能保存', () => {
  const data = draft()
  assert.equal(form.validateDraft(data).valid, false)
  data.issueDraft.counterpartyAccountIndex = 1
  const result = form.validateDraft(data)
  assert.equal(result.valid, true)
  assert.equal(result.fields.ledgerAccountId, credit.accountId)
  assert.equal(result.fields.counterpartyLedgerAccountId, bank.accountId)
  const posting = transactionDrafts({ ...row('repayment'), ...result.fields })[0]
  assert.equal(posting.sourceAccountId, bank.accountId)
  assert.equal(posting.destinationAccountId, credit.accountId)
  for (const target of [credit, { ...bank, archivedAt: '2026-01-01' }, { ...bank, unavailable: true }]) {
    data.counterpartyAccountChoices[1] = target
    assert.equal(form.validateDraft(data).valid, false)
  }
})
test('分类选填且不把首笔分类静默覆盖同组；本金、未知状态保留原保护', () => {
  const data = draft('expense')
  data.issueCategories.push({ categoryId: bank.accountId, kind: 'expense', name: '合成分类' })
  data.issueDraft.categoryIndex = 1
  assert.equal(form.validateDraft(data).fields.categoryId, undefined)
  data.issueDraft.categoryChanged = true
  assert.equal(form.validateDraft(data).fields.categoryId, bank.accountId)
  data.currentIssue.evidenceReviewOnly = true
  assert.equal(form.validateDraft(data).valid, false)
  data.currentIssue.evidenceReviewOnly = false
  data.currentIssue.installmentPrincipal = true
  data.issueDraft.natureIndex = NATURE_OPTIONS.findIndex(item => item.value === 'repayment')
  const principal = form.validateDraft(data)
  assert.equal(principal.valid, true)
  assert.equal(principal.fields.counterpartyLedgerAccountId, null)
})
test('完整详情分段读取校验对象身份；迟到结果、残缺 JSON 和过长内容不冒充完成', async () => {
  const text = JSON.stringify(row('income')), calls = []
  const session = { read: async (_, input) => { calls.push(input); const offset = Number(input.cursor || 0); return { part: text.slice(offset, offset + 40), nextCursor: offset + 40 < text.length ? String(offset + 40) : null } } }
  assert.equal((await readDetail(session, 'synthetic-event-0', () => true)).economicNature, 'income')
  assert.ok(calls.length > 1)
  await assert.rejects(readDetail(session, 'wrong-id', () => true), /不匹配/)
  let active = true
  assert.equal(await readDetail({ read: async () => { active = false; return { part: text } } }, 'synthetic-event-0', () => active), null)
  await assert.rejects(readDetail({ read: async () => ({ part: '{broken', nextCursor: null }) }, 'synthetic-event-0', () => true), /完整读取/)
})
test('详情补充 SQL 只有受用户/批次约束的读取，保留真实关联和零金额', async () => {
  const calls = []
  const connection = { execute: async (sql, values) => {
    calls.push({ sql, values }); assert.match(sql.trim(), /^SELECT/); assert.equal(values[0], 'synthetic-user')
    if (/UNION ALL/.test(sql)) return [[credit]]
    if (/FROM catledger_economic_event_relations/.test(sql)) return [[{ eventId: 'original', amountMinor: '0', categoryName: '美食', parentCategoryName: '餐饮' }]]
    if (/FROM catledger_economic_event_transactions/.test(sql)) return [[]]
    throw Error('unexpected SQL')
  } }
  const value = await eventDetailFacts(connection, 'synthetic-user', 'synthetic-update', row('refund'))
  assert.equal(value.accounts[0].accountId, credit.accountId)
  assert.equal(value.refund.status, 'confirmed')
  assert.equal(value.refund.originals[0].amountMinor, '0')
  assert.equal(value.refund.originals[0].categoryName, '餐饮 / 美食')
  assert.equal(calls.length, 3)
  calls.slice(1).forEach(call => assert.deepEqual(call.values, ['synthetic-user', 'synthetic-update', 'synthetic-event-0']))
})
test('真实 Page：性质切换后账户角色立即更新，完整详情晚到不覆盖输入', async () => {
  const data = fixture(1, true)
  Object.assign(data.events[0], row('unknown'), { ledgerAccountId: 'synthetic-account' })
  Object.assign(data.issues[0], { issueType: 'shared_fields', primaryReasonCode: 'economic_nature_required' })
  const h = runtime(data), page = h.page
  let release
  h.intercept = (action, input) => action === 'economicEvents.detail' && !input.evidenceId ? new Promise(resolve => { release = resolve }) : undefined
  await page.openIssue(tap('synthetic-issue'))
  page.changeIssueNature({ detail: { value: NATURE_OPTIONS.findIndex(item => item.value === 'repayment') } })
  assert.equal(page.data.issueDetail.accountLabel, '还入账户')
  assert.equal(page.data.issueDetail.destinationLabel, '付款账户')
  assert.equal(page.data.issueFieldsCanSave, false)
  const saved = JSON.stringify(page.data.issueDraft)
  release({ viewVersion: h.summary.viewVersion, part: JSON.stringify({ ...data.events[0], detailFacts: { accounts: [bank] } }), nextCursor: null })
  await flush(); await flush()
  assert.equal(JSON.stringify(page.data.issueDraft), saved)
  assert.equal(page.data.issueDetail.natureLabel, '还款')
  page.onUnload()
})
test('真实 Page：轻量问题摘要不遮住来源方向，三种双端性质的显示、草稿和入账端点一致', async () => {
  for (const sourceDirection of ['income', 'expense']) for (const nature of ['repayment', 'borrow', 'internal_transfer']) {
    const data = fixture(1, true)
    Object.assign(data.events[0], row('unknown'), { sourceDirection, flowDirection: sourceDirection === 'income' ? 'inflow' : 'outflow' })
    const { sourceDirection: omitted, ...summary } = data.events[0]
    Object.assign(data.issues[0], { issueType: 'shared_fields', primaryReasonCode: 'economic_nature_required', subject: summary })
    const h = runtime(data), page = h.page
    let release
    h.intercept = (action, input) => {
      if (action === 'economicEvents.detail' && !input.evidenceId) return new Promise(resolve => { release = resolve })
      if (action === 'financeUpdates.options' && input.kind === 'accounts') return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [credit, bank], total: 2, nextCursor: null }
    }
    try {
      await page.openIssue(tap('synthetic-issue'))
      assert.equal(page.data.currentIssue.subject.sourceDirection, sourceDirection)
      page.changeIssueNature({ detail: { value: NATURE_OPTIONS.findIndex(item => item.value === nature) } })
      const labels = sourceDirection === 'income'
        ? { repayment: ['还入账户', '付款账户'], borrow: ['到账账户', '借款负债账户'], internal_transfer: ['转入账户', '转出账户'] }
        : { repayment: ['付款账户', '还入账户'], borrow: ['借款负债账户', '到账账户'], internal_transfer: ['转出账户', '转入账户'] }
      assert.equal(page.data.issueDetail.accountLabel, labels[nature][0])
      assert.equal(page.data.issueDetail.destinationLabel, labels[nature][1])
      assert.equal(page.data.issueDetail.destinationFirst, sourceDirection === 'income')
      const firstTarget = page.data.issueDetail.destinationFirst ? 'counterparty' : 'account'
      await page.openDirectory({ currentTarget: { dataset: { target: firstTarget } } })
      assert.equal(page.data.directorySheet.title, '选择' + { repayment: '付款账户', borrow: '借款负债账户', internal_transfer: '转出账户' }[nature])
      page.closeDirectory()
      await page.openDirectory({ currentTarget: { dataset: { target: 'counterparty' } } })
      page.selectDirectory({ currentTarget: { dataset: { index: page.data.directorySheet.items.findIndex(account => account.accountId === bank.accountId) } } })
      const saved = JSON.stringify(page.data.issueDraft)
      release({ viewVersion: h.summary.viewVersion, part: JSON.stringify({ ...data.events[0], ledgerAccountId: 'stale-account', detailFacts: {} }), nextCursor: null })
      await flush(); await flush()
      assert.equal(JSON.stringify(page.data.issueDraft), saved, '详情迟到不覆盖人工账户选择')
      assert.equal(page.data.issueCanSubmit, true)
      await page.resolveWithFields()
      const entry = page._draftSession.state.entries[0]
      assert.equal(entry.decision.fields.ledgerAccountId, credit.accountId)
      assert.equal(entry.decision.fields.counterpartyLedgerAccountId, bank.accountId)
      const posting = transactionDrafts({ ...data.events[0], ...entry.decision.fields })[0]
      assert.equal(posting.sourceAccountId, sourceDirection === 'income' ? bank.accountId : credit.accountId)
      assert.equal(posting.destinationAccountId, sourceDirection === 'income' ? credit.accountId : bank.accountId)
      assert.equal(data.events[0].sourceDirection, sourceDirection)
    } finally { page.onUnload() }
  }
})
test('真实 Page：裁切详情补回方向但保留草稿，关闭后迟到的方向不得回填', async () => {
  for (const closeBeforeDetail of [false, true]) {
    const data = fixture(1, true)
    Object.assign(data.events[0], row('unknown'), { ledgerAccountId: 'synthetic-account' })
    delete data.events[0].sourceDirection
    Object.assign(data.issues[0], { issueType: 'shared_fields', primaryReasonCode: 'economic_nature_required' })
    const h = runtime(data), page = h.page
    let release
    h.intercept = (action, input) => action === 'economicEvents.detail' && !input.evidenceId ? new Promise(resolve => { release = resolve }) : undefined
    try {
      await page.openIssue(tap('synthetic-issue'))
      page.changeIssueNature({ detail: { value: NATURE_OPTIONS.findIndex(item => item.value === 'repayment') } })
      const saved = JSON.stringify(page.data.issueDraft)
      if (closeBeforeDetail) page.closeIssue()
      release({ viewVersion: h.summary.viewVersion, part: JSON.stringify({ ...data.events[0], sourceDirection: 'income', detailFacts: {} }), nextCursor: null })
      await flush(); await flush()
      if (closeBeforeDetail) {
        assert.equal(page.data.currentIssue, null)
        assert.equal(page.data.issueFacts, null)
      } else {
        assert.equal(page.data.issueDetail.accountLabel, '还入账户')
        assert.equal(page.data.issueDetail.destinationLabel, '付款账户')
        assert.equal(page.data.issueDetail.destinationFirst, true)
        assert.equal(JSON.stringify(page.data.issueDraft), saved)
      }
    } finally { page.onUnload() }
  }
})
test('待核对/已核对/编辑模板均把性质与字段放在原文之前', () => {
  const dir = path.join(__dirname, '../miniprogram/pages/import-workbench')
  const pending = fs.readFileSync(path.join(dir, 'index.wxml'), 'utf8')
  const start = pending.indexOf('class="detail-nature-first')
  assert.ok(start > 0)
  assert.ok(start < pending.indexOf('class="payment-resolution-form"'))
  assert.ok(start < pending.indexOf('data-target="account" bindtap="openDirectory"'))
  assert.equal((pending.match(/bindchange="changeIssueNature"/g) || []).length, 1)
  for (const file of ['review-detail.wxml', 'review-edit.wxml']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.ok(source.indexOf('transaction-detail-fields') < source.indexOf('detail-original-title'))
  }
})

test('真实 Page：紧凑摘要保留零金额和缺失提示，省去空白对方备注与独立账单状态', async () => {
  for (const amount of ['0', null]) {
    const data = fixture(1, true)
    Object.assign(data.events[0], { economicNature: 'unknown', amountMinor: amount, localAt: amount === null ? null : '2026-09-01 12:00:00',
      primaryEvidence: { sourceType: 'wechat', counterparty: '', status: '', note: '' } })
    Object.assign(data.issues[0], { issueType: 'shared_fields', primaryReasonCode: 'economic_nature_required' })
    const source = JSON.stringify(data.events[0]), h = runtime(data), page = h.page
    try {
      await page.openIssue(tap('synthetic-issue'))
      assert.equal(page.data.issueDetail.summary.amount, amount === null ? '金额待补充' : '¥0.00')
      assert.equal(page.data.issueDetail.summary.time, amount === null ? '时间待补充' : '2026-09-01 12:00:00')
      assert.equal(page.data.issueDetail.summary.party, '')
      assert.ok(page.data.issueDetail.fields.every(field => !['status', 'note'].includes(field.key)))
      assert.equal(page.data.issueFieldsCanSave, false, '提示合并不解除未知性质的保存门禁')
      assert.equal(page.data.issueDetail.hideValidationHint, true)
      assert.equal(JSON.stringify(data.events[0]), source)
    } finally { page.onUnload() }
  }
  const data = draft('expense'), patches = {}
  data.currentIssue.subject.primaryEvidence.status = '支付成功'
  form.refreshIssueFieldsDraft.call({ data, setData: patch => Object.assign(patches, patch) })
  assert.equal(patches.issueDetail.fields.some(field => field.key === 'status'), false)
  assert.equal(data.currentIssue.subject.primaryEvidence.status, '支付成功', '省去重复展示，不修改原始账单字段')
  assert.equal(patches.issueDetail.fields.find(field => field.key === 'note').value, '合成备注')
})


test('真实 Page：默认本人还款和代还方式只提示一次，缺账户或处理方式仍禁存', async () => {
  const data = fixture(1, true)
  Object.assign(data.events[0], { economicNature: 'repayment', repaymentOwnershipRequired: true,
    fundsProjection: { kind: 'repayment', from: { label: '合成钱包' }, to: { referenceKind: 'atomic', label: '合成信用卡' } } })
  Object.assign(data.issues[0], { issueType: 'transfer_accounts', subject: data.events[0] })
  const h = runtime(data), page = h.page
  try {
    await page.openIssue(tap('synthetic-issue'))
    assert.equal(page.data.issueDraft.repaymentOwner, 'self')
    assert.equal(page.data.issueDetail.hideValidationHint, true)
    assert.equal(page.data.issueFieldsCanSave, false)
    page.changeRepaymentOwner({ currentTarget: { dataset: { owner: 'other' } } })
    assert.equal(page.data.issueDetail.hideValidationHint, true)
    assert.equal(page.data.issueFieldsCanSave, false)
    page.changeRepaymentOtherTreatment({ currentTarget: { dataset: { treatment: 'pending' } } })
    assert.equal(page.data.issueFieldsCanSave, true)
    page.changeRepaymentOwner({ currentTarget: { dataset: { owner: 'self' } } })
    page.data.accountChoices = [{ accountId: 'synthetic-other-wallet', type: 'wallet', name: '合成其他钱包' }]
    page.refreshIssueFieldsDraft()
    assert.equal(page.data.issueFieldsCanSave, false)
    assert.equal(page.data.issueDetail.hideValidationHint, false)
    assert.equal(page.data.issueFieldsReason, '请选择自己的信用卡或其他负债账户')
  } finally { page.onUnload() }
})

test('性质切换只展示适用字段：退款保留随原消费分类，组合支付还款不显示消费分类', () => {
  const data = draft('refund')
  data.currentIssue.subject.detailFacts = { refund: { status: 'confirmed', originals: [{ categoryName: '合成原分类', amountMinor: '100' }] } }
  const page = { data, setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let parent = this.data
      for (const part of parts.slice(0, -1)) parent = parent[part]
      parent[parts[parts.length - 1]] = value
    }
  } }
  form.refreshIssueFieldsDraft.call(page)
  assert.equal(page.data.issueDetail.categoryEditable, false)
  assert.equal(page.data.issueDetail.fields.find(field => field.key === 'category').value, '合成原分类')
  data.currentIssue.paymentNeedsReview = true
  data.currentIssue.subject.economicNature = 'expense'
  data.paymentNatureIndex = 2
  form.refreshIssueFieldsDraft.call(page)
  assert.equal(page.data.issueDetail.natureLabel, '还款')
  assert.equal(page.data.issueDetail.fields.some(field => field.key === 'category'), false)
  data.paymentNatureIndex = 1
  form.refreshIssueFieldsDraft.call(page)
  assert.equal(page.data.issueDetail.natureLabel, '支出')
  assert.equal(page.data.issueDetail.fields.some(field => field.key === 'category'), true)
})
