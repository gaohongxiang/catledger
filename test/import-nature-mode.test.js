const test = require('node:test')
const assert = require('node:assert/strict')
const editor = require('./helpers/editor-workbench')

const installment = { creditStatement: true, factKind: 'billing', periodNumber: 3, totalTerms: 6, originKind: 'unconfirmed' }

test('性质是独立模式行：切换后重建表单，不混进摘要卡', async t => {
  const { page } = await editor.open(t, { economicNature: 'expense', counterparty: '',
    primaryEvidence: { sourceType: 'wechat', item: '合成商品说明', counterparty: '', note: '' } })
  const view = editor.view(page)
  assert.equal(view.natureEditable, true)
  assert.equal(view.natureLabel, '支出')
  assert.equal(view.natureFixedHint, '')
  assert.equal(view.summaryTitle, '合成商品说明')
  assert.equal(view.summaryTitlePlaceholder, false)
  page.openNatureSheet()
  assert.equal(page.data.reviewEditSheet.natureOpen, true)
  const index = view.natureOptions.findIndex(item => item.value === 'income')
  page.selectEditorNature({ currentTarget: { dataset: { index } } })
  assert.equal(editor.draft(page).economicNature, 'income')
  assert.equal(editor.view(page).natureLabel, '收入')
  assert.equal(page.data.reviewEditSheet.natureOpen, false)
})

test('性质未确定时性质行用强调底色提示，选定后恢复', async t => {
  const { page } = await editor.open(t, { economicNature: 'unknown' })
  assert.equal(editor.view(page).naturePending, true)
  editor.nature(page, 'expense')
  assert.equal(editor.view(page).naturePending, false)
})

test('摘要标题优先交易对方，再回退账单条目，最后才是占位', async t => {
  const withParty = await editor.open(t, { economicNature: 'expense', counterparty: '合成商户' })
  assert.equal(editor.view(withParty.page).summaryTitle, '合成商户')
  assert.equal(editor.view(withParty.page).summaryTitlePlaceholder, false)

  const noTitle = await editor.open(t, { economicNature: 'expense', counterparty: '',
    primaryEvidence: { sourceType: 'bank', item: '', counterparty: '', note: '' } })
  assert.equal(editor.view(noTitle.page).summaryTitle, '未提供交易对方')
  assert.equal(editor.view(noTitle.page).summaryTitlePlaceholder, true)
})

test('分期本金默认显示“分期出账”，可改判为实际收支且选项不越界', async t => {
  const { page } = await editor.open(t, { economicNature: 'repayment', installment: { ...installment, component: 'principal' } })
  let view = editor.view(page)
  assert.equal(view.natureLabel, '分期出账')
  assert.equal(view.natureEditable, true)
  assert.equal(view.natureFixedHint, '')
  assert.deepEqual(Array.from(view.natureOptions, item => item.value), ['expense', 'income', 'repayment', 'fee', 'unknown'])
  assert.equal(view.natureOptions.find(item => item.value === 'repayment').label, '分期出账')
  page.openNatureSheet()
  assert.equal(page.data.reviewEditSheet.natureOpen, true)
  assert.match(page.data.reviewEditSheet.natureHint, /按实际流水入账/)
  page.closeNatureSheet()
  editor.nature(page, 'expense')
  assert.equal(editor.draft(page).economicNature, 'expense')
  view = editor.view(page)
  assert.equal(view.natureLabel, '支出')
  assert.equal(view.categoryKind, 'expense')
  assert.equal(view.natureFixedHint, '')
  editor.nature(page, 'unknown')
  assert.equal(editor.view(page).natureLabel, '性质待确认')
  editor.nature(page, 'refund')
  assert.equal(editor.draft(page).economicNature, 'unknown')
  editor.nature(page, 'internal_transfer')
  assert.equal(editor.draft(page).economicNature, 'unknown')
})

test('分期利息和手续费仍由来源确定，性质只读', async t => {
  for (const [component, label] of [['interest', '分期利息'], ['fee', '分期手续费']]) {
    const { page } = await editor.open(t, { economicNature: 'fee', installment: { ...installment, component } })
    const view = editor.view(page)
    assert.equal(view.natureLabel, label)
    assert.equal(view.natureEditable, false)
    assert.equal(view.natureFixedHint, '由分期来源确定')
    page.openNatureSheet()
    assert.equal(page.data.reviewEditSheet.natureOpen, false)
    editor.nature(page, 'expense')
    assert.equal(editor.draft(page).economicNature, 'fee')
  }
})

test('切换性质前提示会清空的已选内容，不静默丢弃', async t => {
  const { page } = await editor.open(t, { economicNature: 'expense' })
  page._reviewEditToken.draft = { ...page._reviewEditToken.draft, refund: { mode: 'link', kind: 'event', id: 'synthetic-refund' } }
  page.openNatureSheet()
  assert.match(page.data.reviewEditSheet.natureHint, /退款原消费/)
  page.closeNatureSheet()
  assert.equal(page.data.reviewEditSheet.natureOpen, false)
  assert.equal(page.data.reviewEditSheet.natureHint, '')
})

test('性质切换列表只列经济性质，并带各自模式说明', async t => {
  const { page } = await editor.open(t, { economicNature: 'expense' })
  const options = editor.view(page).natureOptions
  assert.deepEqual(Array.from(options, item => item.value), ['expense', 'income', 'refund', 'internal_transfer', 'repayment', 'borrow', 'fee', 'unknown'])
  assert.ok(options.every(item => item.label && item.hint))
  assert.equal(options.find(item => item.value === 'fee').label, '利息／手续费')
})

test('账单事实只读：旧控件事件不改金额、日期、时间和对方，备注仍可编辑', async t => {
  const { page } = await editor.open(t, { economicNature: 'expense', amountMinor: '1234',
    localAt: '2026-08-01 12:41:17', counterparty: '合成商户' })
  const before = JSON.stringify(editor.draft(page))
  for (const [field, value] of [['amountInput', '9.99'], ['date', '2026-09-01'], ['time', '08:00:00'], ['counterparty', '改过的对方']]) {
    editor.edit(page, field, value)
  }
  assert.equal(JSON.stringify(editor.draft(page)), before)
  assert.equal(editor.view(page).summaryTitle, '合成商户')
  editor.edit(page, 'note', '只改备注')
  assert.equal(editor.draft(page).note, '只改备注')
  assert.equal(editor.view(page).payload.fields.note, '只改备注')
  assert.equal(editor.view(page).payload.fields.counterparty, undefined)
})

test('期次和备注打开即直接编辑，不再经过“修改／添加备注”动作', async t => {
  const { page } = await editor.open(t, { economicNature: 'repayment', installment: { ...installment, component: 'principal' } })
  assert.equal('periodEditing' in page.data.reviewEditSheet, false)
  assert.equal('noteOpen' in page.data.reviewEditSheet, false)
  assert.equal(typeof page.editEditorPeriod, 'undefined')
  assert.equal(typeof page.openEditorNote, 'undefined')
  editor.edit(page, 'periodInput', '4')
  editor.edit(page, 'totalTermsInput', '8')
  editor.edit(page, 'note', '直接写的备注')
  const sourceCorrection = editor.view(page).payload.sourceCorrection
  assert.equal(sourceCorrection.periodNumber, 4)
  assert.equal(sourceCorrection.totalTerms, 8)
  assert.equal(editor.view(page).payload.fields.note, '直接写的备注')
})

test('性质弹层：整行可点并铺满列表，选项不再用窄按钮', () => {
  const fs = require('node:fs'), path = require('node:path')
  const root = path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench')
  const sheet = fs.readFileSync(path.join(root, 'review-edit.wxml'), 'utf8')
  const options = sheet.slice(sheet.indexOf('class="nature-options"'), sheet.indexOf('nature-sheet-hint'))
  assert.match(options, /<view wx:for="\{\{reviewEditSheet\.editor\.natureOptions\}\}"/)
  assert.match(options, /bindtap="selectEditorNature"/)
  assert.match(options, /aria-role="radio"/)
  assert.doesNotMatch(options, /<button/)
  // 勾选使用项目内对勾图标，不再用 CSS 手画对号。
  assert.match(options, /assets\/icons\/check\.svg/)
  const wxss = fs.readFileSync(path.join(root, 'review-editor.wxss'), 'utf8')
  assert.match(wxss, /\.nature-option \{[^}]*width: 100%/)
  assert.match(wxss, /\.nature-option\.is-selected \{[^}]*background: var\(--ui-accent-soft\)/)
  assert.match(wxss, /\.nature-option-check-icon \{[^}]*width: 24rpx/)
  assert.doesNotMatch(wxss, /\.nature-option\.is-selected \.nature-option-check::after/)
  assert.match(wxss, /\.nature-sheet-hint \{[^}]*background: var\(--theme-warning-soft/)
  // 表头两端对齐铺满整行，关闭键图标右缘与列表卡片右边线同一条竖线。
  assert.match(sheet, /class="review-sheet-close nature-sheet-close"/)
  assert.match(wxss, /\.nature-sheet-head \{[^}]*justify-content: space-between/)
  assert.doesNotMatch(wxss, /\.nature-sheet-head \{[^}]*padding-right: 88rpx/)
  assert.match(wxss, /\.nature-sheet \.nature-sheet-close \{[^}]*margin: 0 -28rpx 0 0/)
  assert.match(wxss, /\.nature-sheet \.nature-sheet-close \{[^}]*padding: 28rpx/)
})
