const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { open, tap, input, plain, mode, nature, select, edit, view, draft, writes, flush } = require('./helpers/editor-workbench')

test('资金两端均由统一模板进入全目录，旧片段表单退出', () => {
  const root = path.join(__dirname, '../miniprogram/pages/import-workbench')
  const markup = fs.readFileSync(path.join(root, 'review-editor-fields.wxml'), 'utf8')
  assert.match(markup, /editor.routeFields/)
  assert.match(markup, /data-target="{{item.target}}" bindtap="openDirectory"/)
  const old = fs.readFileSync(path.join(root, 'index.wxml'), 'utf8')
  assert.doesNotMatch(old, /changeIssueNature|changePaymentRow|changeRepaymentAllocation|editLoanRepayment/)
})

test('完整目录翻页和搜索后，稳定ID定位两端且选择仅改本笔草稿', async t => {
  const { h, page, accounts } = await open(t)
  await page.openDirectory(tap({ target: 'reviewAccount' }))
  assert.equal(page.data.directorySheet.title, '选择转出账户')
  assert.equal(page.data.directorySheet.page.count, 25)
  await page.changeDirectoryPage(tap({ direction: '1' }))
  page.selectDirectory(tap({ index: 6 }))
  assert.equal(draft(page).ledgerAccountId, accounts[18].accountId)
  await page.openDirectory(tap({ target: 'reviewCounterparty' }))
  assert.equal(page.data.directorySheet.title, '选择转入账户')
  page.searchDirectory(input('', '合成账户24')); await flush()
  page.selectDirectory(tap({ index: 0 }))
  assert.deepEqual(plain(view(page).payload.fields), { ledgerAccountId: 'account-18', counterpartyLedgerAccountId: 'account-24' })
  await page.openDirectory(tap({ target: 'reviewAccount' }))
  assert.equal(page.data.directorySheet.selectedId, 'account-18')
  page.closeDirectory()
  assert.equal(draft(page).ledgerAccountId, 'account-18')
  assert.equal(writes(h).length, 0)
})

test('投影两端已有值仍可编辑，改变对端不交换原账单端', async t => {
  const { page, accounts } = await open(t, { ledgerAccountId: 'account-0', counterpartyLedgerAccountId: 'account-1', fundsProjection: { from: { label: '已知转出' }, to: { label: '已知转入' } } })
  assert.equal(view(page).routeFields.length, 2)
  assert.equal(select(page, 'reviewCounterparty', accounts[24]), true)
  assert.deepEqual(plain(view(page).payload.fields), { ledgerAccountId: 'account-0', counterpartyLedgerAccountId: 'account-24' })
  assert.equal(draft(page).ledgerAccountId, 'account-0')
})

test('目录支持本批账户与清空，清空保留缺口而不选择默认账户', async t => {
  const { page } = await open(t)
  await page.openDirectory(tap({ target: 'reviewAccount' }))
  await page.changeDirectoryKind(tap({ kind: 'accountDrafts' }))
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(draft(page).ledgerAccountId, 'draft-1')
  page.clearEditorChoice(tap({ field: 'ledgerAccountId' }))
  assert.equal(draft(page).ledgerAccountId, '')
  assert.ok(view(page).missing.includes('转出账户'))
})

for (const issueType of ['transfer_accounts', 'shared_fields']) for (const boundary of ['switch', 'close', 'hide', 'user', 'event', 'nature']) {
  test(issueType + '目录迟到结果在 ' + boundary + ' 后不能改草稿', async t => {
    const { h, page, accounts } = await open(t, {}, { issueType })
    await page.openDirectory(tap({ target: 'reviewAccount' }))
    let release
    h.intercept = (action, query) => action === 'financeUpdates.options' && query.query === '慢' ? new Promise(resolve => { release = resolve }) : undefined
    page.searchDirectory(input('', '慢')); await flush()
    const token = page._reviewEditToken
    const before = plain(draft(page))
    page.selectDirectory(tap({ index: 0 }))
    assert.deepEqual(plain(draft(page)), before)
    if (boundary === 'switch') await page.openDirectory(tap({ target: 'reviewCounterparty' }))
    if (boundary === 'close') page.closeDirectory()
    if (boundary === 'hide') page.onHide()
    if (boundary === 'user') { h.cache.reset(); h.app.globalData.uid = 'another-user' }
    if (boundary === 'event') { page.closeReviewEdit(); await page.openReviewEdit(tap({ id: 'synthetic-event-0' })) }
    if (boundary === 'nature') nature(page, 'income')
    const state = plain(page.data.directorySheet), after = plain(page._reviewEditToken ? draft(page) : token.draft)
    release({ viewVersion: h.summary.viewVersion, items: [accounts[24]], total: 1, nextCursor: null }); await flush(); await flush()
    assert.deepEqual(plain(page.data.directorySheet), state)
    assert.deepEqual(plain(page._reviewEditToken ? draft(page) : token.draft), after)
    assert.equal(writes(h).length, 0)
  })
}

test('合并还款使用本批负债账户，重复和付款端混入被拒绝', async t => {
  const { h, page, accounts, drafts } = await open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  mode(page, 'composition', 'repayment')
  assert.equal(select(page, 'editorPart0', drafts[0]), true)
  assert.equal(select(page, 'editorPart0', accounts[0]), false)
  page.changeEditorPart({ ...tap({ index: 0 }), detail: { value: '1.00' } })
  assert.equal(view(page).complete, true)
  page.addEditorPart(); select(page, 'editorPart1', drafts[0])
  page.changeEditorPart({ ...tap({ index: 1 }), detail: { value: '0.50' } })
  assert.ok(view(page).errors.some(message => message.includes('重复')))
  page.removeEditorPart(tap({ index: 1 }))
  assert.equal(view(page).errors.length, 0)
  assert.equal(writes(h).length, 0)
})

test('组合支付还款的付款端限资金账户，还入端限负债，均可全目录选择', async t => {
  const { page, accounts, drafts } = await open(t, { economicNature: 'repayment' })
  mode(page, 'composition', 'payment')
  assert.equal(select(page, 'reviewCounterparty', accounts[0]), false)
  assert.equal(select(page, 'reviewCounterparty', drafts[0]), true)
  assert.equal(select(page, 'editorPart0', drafts[0]), false)
  assert.equal(select(page, 'editorPart0', accounts[24]), true)
  assert.equal(draft(page).parts[0].accountId, 'account-24')
  assert.equal(draft(page).counterpartyLedgerAccountId, 'draft-1')
})

test('默认本人、归属往返和隐藏字段隔离；普通贷款无强制关联', async t => {
  const { h, page, drafts } = await open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  assert.equal(draft(page).owner, 'self')
  assert.equal(draft(page).repaymentMode, 'ordinary')
  select(page, 'reviewCounterparty', drafts[0])
  mode(page, 'owner', 'other')
  assert.equal(view(page).other, true)
  assert.ok(view(page).missing.includes('代还处理方式'))
  mode(page, 'otherTreatment', 'expense')
  assert.equal(view(page).payload.fields.economicNature, 'expense')
  assert.equal(view(page).payload.decisions.ownership.owner, 'other')
  assert.equal(view(page).payload.decisions.repayment, undefined)
  assert.equal(draft(page).counterpartyLedgerAccountId, '')
  mode(page, 'owner', 'self')
  assert.equal(draft(page).counterpartyLedgerAccountId, 'draft-1')
  assert.equal(view(page).payload.decisions.ownership.owner, 'self')
  assert.equal(writes(h).length, 0)
})

test('明确的他人归属不会被默认本人覆盖，隐藏页面不能改草稿', async t => {
  const { page } = await open(t, { economicNature: 'expense', ledgerAccountId: 'account-0', repaymentOwnership: { owner: 'other', treatment: 'expense' } })
  assert.equal(draft(page).owner, 'other')
  const token = page._reviewEditToken, before = plain(draft(page)); page.onHide()
  mode(page, 'owner', 'self'); edit(page, 'note', '迟到')
  assert.equal(page._reviewEditToken, null)
  assert.deepEqual(plain(token.draft), before)
})

test('本人改代还关闭目录，迟到选择不再次打开或替换当前模式', async t => {
  const { h, page } = await open(t, { economicNature: 'repayment', ledgerAccountId: 'account-0' })
  let release
  h.intercept = (action, query) => action === 'financeUpdates.options' && query.kind === 'accounts' ? new Promise(resolve => { release = resolve }) : undefined
  const loading = page.openDirectory(tap({ target: 'reviewCounterparty' })); await flush()
  mode(page, 'owner', 'other')
  release({ viewVersion: h.summary.viewVersion, items: [], total: 0, nextCursor: null }); await loading
  assert.equal(page.data.directorySheet, null)
  assert.equal(draft(page).owner, 'other')
})

test('目录失败可原处重试且选择不丢，失效版本拒绝重新打开', async t => {
  const { h, page, accounts } = await open(t)
  select(page, 'reviewAccount', accounts[18])
  h.intercept = action => { if (action === 'financeUpdates.options') throw Error('合成读取失败') }
  await page.openDirectory(tap({ target: 'reviewAccount' }))
  assert.match(page.data.directorySheet.error, /失败/)
  assert.equal(draft(page).ledgerAccountId, 'account-18')
  h.intercept = null; await page.changeDirectoryPage(tap({}))
  assert.equal(page.data.directorySheet.error, '')
  page.closeDirectory(); page._viewSession.close()
  await page.openDirectory(tap({ target: 'reviewAccount' }))
  assert.equal(page.data.directorySheet, null)
})
