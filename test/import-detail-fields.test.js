const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const detail = require('../miniprogram/packages/finance/pages/import-workbench/detail-fields')
const editor = require('./helpers/editor-workbench')
const editorModel = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
const policy = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const { readDetail } = require('../miniprogram/packages/finance/pages/import-workbench/detail-reader')
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
  assert.equal(value.nature.value, '分期出账')
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

test('未知改还款只收集两端；空端待核对，同账户与停用端不能当有效资金', async t => {
  const { page } = await editor.open(t, { ...row('unknown'), categoryId: null }, { accounts: [bank, credit] })
  editor.nature(page, 'repayment')
  assert.ok(editor.view(page).missing.includes('付款账户'))
  assert.equal(editor.select(page, 'reviewCounterparty', credit), false, '资金端不能使用负债')
  assert.equal(editor.select(page, 'reviewCounterparty', { ...bank, archivedAt: '2026-01-01' }), false)
  assert.equal(editor.select(page, 'reviewCounterparty', bank), true)
  assert.equal(editor.view(page).errors.length, 0)
  const posted = transactionDrafts({ ...row('repayment'), ...editor.view(page).payload.fields })[0]
  assert.equal(posted.sourceAccountId, bank.accountId); assert.equal(posted.destinationAccountId, credit.accountId)
})

test('分类保持选填，切换异类不会提交旧分类，停用或跨种类不能选择', async t => {
  const expense = { categoryId: 'category-expense', name: '合成支出分类', kind: 'expense' }
  const income = { categoryId: 'category-income', name: '合成收入分类', kind: 'income' }
  const { page } = await editor.open(t, { economicNature: 'expense', ledgerAccountId: bank.accountId, categoryId: expense.categoryId }, { accounts: [bank], categories: [expense, income] })
  editor.nature(page, 'income')
  assert.equal(editor.draft(page).categoryId, '')
  assert.equal(editor.view(page).payload.fields.categoryId, null)
  assert.equal(editor.select(page, 'editorCategory', expense), false)
  assert.equal(editor.select(page, 'editorCategory', { ...income, archivedAt: '2026-01-01' }), false)
  assert.equal(editor.select(page, 'editorCategory', income), true)
  editor.nature(page, 'expense')
  assert.equal(editor.draft(page).categoryId, expense.categoryId)
})

for (const sourceDirection of ['income', 'expense']) for (const nature of ['repayment', 'borrow', 'internal_transfer']) {
  test('真实 Page 从完整详情读取来源方向，显示及保存端点一致：' + sourceDirection + '/' + nature, async t => {
    const from = nature === 'repayment' ? bank : credit, to = nature === 'repayment' ? credit : bank
    const anchor = sourceDirection === 'income' ? to : from, other = sourceDirection === 'income' ? from : to
    const { page, row: original } = await editor.open(t, { ...row('unknown'), sourceDirection, ledgerAccountId: anchor.accountId,
      categoryId: null }, { accounts: [credit, bank], issueType: 'shared_fields' })
    const before = JSON.stringify(original)
    editor.nature(page, nature)
    assert.deepEqual(editor.plain(editor.view(page).routeFields.map(item => item.label)), {
      repayment: ['付款账户','还入账户'], borrow: ['借款负债账户','到账账户'], internal_transfer: ['转出账户','转入账户']
    }[nature])
    assert.equal(editor.select(page, 'reviewCounterparty', other), true)
    const posted = transactionDrafts({ ...original, ...editor.view(page).payload.fields })[0]
    assert.equal(posted.sourceAccountId, from.accountId); assert.equal(posted.destinationAccountId, to.accountId)
    assert.equal(JSON.stringify(original), before)
    editor.nature(page, 'unknown'); editor.nature(page, nature)
    assert.equal(editor.draft(page).ledgerAccountId, anchor.accountId)
    assert.equal(editor.draft(page).counterpartyLedgerAccountId, other.accountId)
  })
}

for (const boundary of ['close', 'hide', 'new-event']) test('完整详情尚未核验不能编辑，迟到响应在 ' + boundary + ' 后不回填', async t => {
  const data = fixture(2, true), h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  let release
  h.intercept = (action, input) => action === 'economicEvents.detail' && !input.evidenceId && input.eventId === data.events[0].eventId ? new Promise(resolve => { release = resolve }) : undefined
  const opening = page.openReviewEdit(tap(data.events[0].eventId)); await flush()
  editor.edit(page, 'note', '不应写入')
  assert.equal(page._reviewEditToken.draft, undefined)
  assert.equal(page.data.reviewEditSheet.canSave, false)
  if (boundary === 'close') page.closeReviewEdit()
  if (boundary === 'hide') page.onHide()
  if (boundary === 'new-event') { await page.openReviewEdit(tap(data.events[1].eventId)); editor.edit(page, 'note', '新会话输入') }
  if (page._reviewEditToken && page._reviewEditToken.evidenceRead) await page._reviewEditToken.evidenceRead
  const before = JSON.stringify(page.data.reviewEditSheet)
  release({ protocolVersion: 2, viewVersion: h.summary.viewVersion, part: JSON.stringify({ ...data.events[0], sourceDirection: 'income', editorFacts: policy.capability(data.events[0]) }), nextCursor: null })
  await opening
  assert.equal(JSON.stringify(page.data.reviewEditSheet), before)
})

test('待核对与已核对使用同一字段模板，性质及输入置于原文之前', () => {
  const dir = path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench')
  for (const file of ['review-detail.wxml', 'review-edit.wxml']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    assert.ok(source.indexOf('is="review-editor-fields"') > 0)
    assert.ok(source.indexOf('is="review-editor-fields"') < source.indexOf('class="evidence-card"'))
  }
  const fields = fs.readFileSync(path.join(dir, 'review-editor-fields.wxml'), 'utf8')
  // 性质是模式行：和账单摘要同一张卡，但先于摘要出现，并且必须先于被它重建的资金账户区。
  assert.ok(fields.indexOf('class="editor-nature-bar') > 0)
  assert.ok(fields.includes('class="editor-nature-label">性质'))
  assert.ok(fields.indexOf('openNatureSheet') > 0)
  assert.ok(fields.indexOf('class="editor-summary-block"') < fields.indexOf('class="editor-nature-bar'))
  assert.ok(fields.indexOf('class="editor-nature-bar') < fields.indexOf('class="editor-summary-facts"'))
  assert.ok(fields.indexOf('class="editor-nature-bar') < fields.indexOf('editor.fundsEndpoints'))
  assert.equal(fields.includes('issue-summary-nature'), false)
  // 账单事实全部只读：金额、日期、时间和对方都不能在核对页改写。
  assert.equal(fields.includes('data-field="amountInput"'), false)
  assert.equal(fields.includes('data-field="date"'), false)
  assert.equal(fields.includes('data-field="time"'), false)
  assert.equal(fields.includes('data-field="counterparty"'), false)
  assert.equal(fields.includes('toggleEditorDetails'), false)
  // 顺序固定：摘要 → 账户 → 该性质适用的业务判断 → 期次 → 分类 → 备注；
  // 具体出现哪些区域仍由性质决定，不强行给每种性质凑满。
  const summary = fields.indexOf('class="editor-summary-block"')
  const account = fields.indexOf('editor.fundsEndpoints')
  const channel = fields.indexOf('wx:if="{{editor.repaymentChannel}}"')
  const principalAttribution = fields.indexOf('attribution-block-pinned')
  const feeAttribution = fields.indexOf('wx:if="{{editor.source && !editor.principal && editor.attribution}}"')
  const period = fields.indexOf('class="editor-row-label">期次')
  const category = fields.indexOf('class="editor-row-label">分类')
  const note = fields.indexOf('class="editor-row-label">备注')
  assert.ok(summary >= 0 && summary < account)
  assert.ok(account < channel && account < principalAttribution && account < feeAttribution)
  assert.ok(channel < period && principalAttribution < period && feeAttribution < period)
  assert.ok(period < category && category < note)
  // 期次和备注始终直接编辑，不再先点“修改／添加备注”。
  assert.equal(fields.includes('editEditorPeriod'), false)
  assert.equal(fields.includes('openEditorNote'), false)
  assert.equal(fields.includes('添加备注'), false)
  assert.ok(fields.includes('data-field="periodInput"'))
  assert.ok(fields.includes('data-field="totalTermsInput"'))
  assert.ok(fields.includes('data-field="note"'))
  // 账户任何性质都单独成组，不并进摘要行，也不提供卡片尾部的清除选择动作。
  assert.ok(fields.includes('wx:if="{{editor.fundsEndpoints.length}}"'))
  assert.equal(fields.includes('editor.fundsEndpoints.length &&'), false)
  assert.equal(fields.includes('editor-summary-account'), false)
  assert.equal(fields.includes('清除{{endpoint.label}}选择'), false)
  // 分类只对有独立分类的性质出现；分期本金的“随原消费”不再渲染成不可选的死行。
  assert.ok(fields.indexOf('wx:if="{{editor.categoryKind}}"') > 0)
  assert.equal(fields.includes('!editor.categoryKind'), false)
  assert.equal(fields.includes('分期本金不重复入账'), false)
  // 选了分类后不再提供行尾清除按钮；改选直接点分类行。
  assert.equal(fields.includes('data-field="categoryId"'), false)
  // 性质行常驻主题浅底色；未确定时换成待核对提醒底色。
  assert.ok(fields.includes("editor.naturePending ? 'is-pending'"))
  const editorStyle = fs.readFileSync(path.join(dir, 'review-editor.wxss'), 'utf8')
  assert.match(editorStyle, /\.editor-nature-bar \{[^}]*background: var\(--ui-accent-soft\)/)
  // 期次、分类、备注共用一个收尾组：组首只有一条分隔线，行间只画行底边。
  assert.equal((fields.match(/class="editor-rows"/g) || []).length, 1)
  assert.equal(fields.includes('editor-rows-tail'), false)
  assert.match(editorStyle,
    /\.editor-nature-bar\.is-pending \{[^}]*background: var\(--theme-warning-soft/)
  // 备注行不单独顶对齐：名目和输入框随行高居中。
  assert.doesNotMatch(editorStyle, /\.editor-row-note \{[^}]*align-items: flex-start/)
  assert.doesNotMatch(editorStyle, /\.editor-row-note \.editor-row-label \{[^}]*padding-top/)
  assert.match(editorStyle, /\.editor-row-textarea \{[^}]*padding: 0;/)
  // 单账户整行做成按钮：点击名称、箭头或左侧留白都打开账户目录。
  assert.match(editorStyle, /\.funds-account-row\.is-action \{[^}]*width: 100%/)
})

test('真实 Page 保留空与明确零的区别，原始凭据不被空备注编辑修改', async t => {
  for (const amount of ['0', null]) {
    const { page, row: original } = await editor.open(t, { economicNature: 'unknown', amountMinor: amount, localAt: amount == null ? null : '2026-09-01 12:00:00',
      primaryEvidence: { sourceType: 'wechat', note: '原始备注', counterparty: '原始对方' } })
    assert.equal(editor.draft(page).amountInput, amount == null ? '' : '0.00')
    assert.equal(editor.view(page).missing.includes('记账金额'), amount == null)
    editor.edit(page, 'note', '')
    assert.equal(editor.view(page).payload.fields.note, '')
    // 账单事实不随备注变化：对方仍取原值，原凭据文本也不被空备注覆盖。
    assert.equal(editor.view(page).payload.fields.counterparty, undefined)
    assert.equal(editor.view(page).summaryTitle, '原始对方')
    assert.equal(original.primaryEvidence.note, '原始备注')
    assert.equal(editor.view(page).complete, false)
  }
})

test('代还待处理显示同一缺口；返回本人恢复账户并重验类型', async t => {
  const { page } = await editor.open(t, { economicNature: 'repayment', ledgerAccountId: bank.accountId }, { accounts: [bank, credit] })
  assert.equal(editor.draft(page).owner, 'self')
  editor.mode(page, 'owner', 'other')
  assert.ok(editor.view(page).missing.includes('代还处理方式'))
  editor.mode(page, 'otherTreatment', 'pending')
  assert.equal(editor.view(page).payload.decisions.ownership.treatment, 'pending')
  assert.equal(editor.view(page).complete, false)
  editor.mode(page, 'owner', 'self')
  assert.equal(editor.select(page, 'reviewCounterparty', bank), false)
  assert.equal(editor.select(page, 'reviewCounterparty', credit), true)
})

test('退款分类继承原消费；组合还款隐藏消费分类，返回支出恢复', async t => {
  const { page } = await editor.open(t, { economicNature: 'refund', detailFacts: { refund: { status: 'confirmed', originals: [{ categoryName: '合成原分类', amountMinor: '100' }] } } })
  assert.equal(editor.view(page).categoryKind, '')
  assert.equal(editor.view(page).refundCategory, '合成原分类')
  editor.nature(page, 'expense'); page.addFundsAccount(editor.tap({ endpoint: 'payer' })); editor.nature(page, 'repayment')
  assert.equal(editor.view(page).categoryKind, '')
  editor.nature(page, 'expense'); assert.equal(editor.view(page).categoryKind, 'expense')
})
