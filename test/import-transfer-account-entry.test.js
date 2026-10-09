const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture, runtime, flush } = require('./helpers/paged-workbench')
const tap = dataset => ({ currentTarget: { dataset } })
const input = value => ({ ...tap({}), detail: { value } })
const plain = value => JSON.parse(JSON.stringify(value))

async function setup(t, projection, issueType = 'transfer_accounts', configureAccounts) {
  const data = fixture(1, true), event = data.events[0]
  Object.assign(event, { economicNature: 'internal_transfer', ledgerAccountId: null, counterpartyLedgerAccountId: null })
  if (projection) Object.assign(event, projection)
  Object.assign(data.issues[0], { issueType, subject: event })
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  const accounts = Array.from({ length: 25 }, (_, i) => ({ accountId: 'account-' + i, name: '合成账户' + i, type: 'bank', currency: 'CNY' }))
  if (configureAccounts) configureAccounts(accounts)
  const drafts = [{ accountId: 'draft-1', name: '合成本批账户', type: 'wallet', currency: 'CNY' }]
  h.options = (query) => {
    let rows = query.kind === 'accounts' ? accounts : query.kind === 'accountDrafts' ? drafts : []
    if (query.ids) rows = rows.filter(row => query.ids.includes(row.accountId))
    if (query.query) rows = rows.filter(row => row.name.includes(query.query))
    const start = Number(query.cursor || 0), size = query.pageSize || 40
    return { protocolVersion: 2, viewVersion: 'v1', items: rows.slice(start, start + size), total: rows.length,
      nextCursor: start + size < rows.length ? String(start + size) : null }
  }
  h.intercept = (action, query) => action === 'financeUpdates.options' ? h.options(query) : undefined
  await flush()
  await page.openIssue(tap({ id: 'synthetic-issue' }))
  assert.equal(page.data.issueDetailsReady, true)
  return { h, page, accounts, drafts }
}

test('资金流转各端字段直接打开完整目录，原生片段 picker 和重复搜索文案移除', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/import-workbench/index.wxml'), 'utf8')
  const start = markup.indexOf('<view wx:elif="{{currentIssue.fundsRoute')
  const route = markup.slice(start, markup.indexOf('issueDetail.hasDestination}}'))
  assert.equal((route.match(/class="route-vertical-pick"/g) || []).length, 3)
  assert.doesNotMatch(route, /<picker[^>]+route-vertical-pick/)
  assert.doesNotMatch(markup, />搜索转入账户/)
  for (const target of ['account', 'counterparty']) assert.match(markup,
    new RegExp('class="transfer-account-control" data-target="' + target + '" bindtap="openDirectory"'))
  assert.doesNotMatch(markup, /搜索全部(?:负债)?账户/)
})

test('单一入口可翻页选择预载范围外账户，再搜索另一端，保留两端已选值且只改草稿', async t => {
  const { h, page, accounts } = await setup(t)
  assert.ok(!page.data.accountChoices.some(row => row.accountId === accounts[18].accountId))
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.title, '选择转出账户')
  assert.equal(page.data.directorySheet.page.count, 25)
  await page.changeDirectoryPage(tap({ direction: '1' }))
  page.selectDirectory(tap({ index: 6 }))
  assert.equal(page.data.directorySheet, null)
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, accounts[18].accountId)
  await page.openDirectory(tap({ target: 'counterparty' }))
  assert.equal(page.data.directorySheet.title, '选择转入账户')
  assert.equal(page.searchDirectory(input('合成账户24')), undefined)
  await flush()
  page.selectDirectory(tap({ index: 0 }))
  assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), { ledgerAccountId: accounts[18].accountId, counterpartyLedgerAccountId: accounts[24].accountId })
  await page.openDirectory(tap({ target: 'account' }))
  page.closeDirectory()
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, accounts[18].accountId)
  assert.ok(h.calls.every(call => !/resolve|organize|post|setReview/.test(call.action)))
})

test('已有一端的投影账户只选择缺少的一端，原已知账户保持', async t => {
  const { page } = await setup(t, { ledgerAccountId: 'account-0',
    fundsProjection: { from: { label: '已知转出' }, to: { label: '待确认转入' } } })
  assert.equal(page.data.currentIssue.missingFundsSide, 'to')
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.title, '选择转入账户')
  page.searchDirectory(input('合成账户24')); await flush()
  page.selectDirectory(tap({ index: 0 }))
  assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), { counterpartyLedgerAccountId: 'account-24' })
  assert.equal(page.data.currentIssue.subject.ledgerAccountId, 'account-0')
})

test('完整目录保留本批账户、新建和清除选择，远端选择不会丢失新建入口', async t => {
  const { page } = await setup(t)
  await page.openDirectory(tap({ target: 'account' }))
  await page.changeDirectoryKind(tap({ kind: 'accountDrafts' }))
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'draft-1')
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isDraft, true)
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.canCreate, true)
  assert.equal(page.data.directorySheet.canClear, true)
  page.selectDirectory(tap({ choice: 'create' }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isCreate, true)
  await page.openDirectory(tap({ target: 'account' }))
  page.selectDirectory(tap({ choice: 'clear' }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isPlaceholder, true)
  await page.openDirectory(tap({ target: 'counterparty' }))
  assert.equal(page.data.directorySheet.canCreate, false)
})

for (const issueType of ['transfer_accounts', 'shared_fields']) for (const mode of ['switch', 'close', 'hide', 'user', 'issue']) test(issueType + '账户目录迟到响应在 ' + mode + ' 后不回填或改写选择', async t => {
  const { h, page } = await setup(t, null, issueType)
  await page.openDirectory(tap({ target: 'account' }))
  let release
  h.intercept = (action, query) => action !== 'financeUpdates.options' ? undefined : query.query === '慢'
    ? new Promise(resolve => { release = resolve }) : h.options(query)
  page.searchDirectory(input('慢')); await flush()
  const draft = plain(page.data.issueDraft)
  page.selectDirectory(tap({ index: 0 }))
  assert.deepEqual(plain(page.data.issueDraft), draft, '搜索中不能选择旧结果')
  if (mode === 'switch') await page.openDirectory(tap({ target: 'counterparty' }))
  if (mode === 'close') page.closeDirectory()
  if (mode === 'hide') page.onHide()
  if (mode === 'user') { h.app.globalData.uid = 'other-user'; h.cache.reset() }
  if (mode === 'issue') page.setData({ currentIssue: { ...page.data.currentIssue, issueId: 'other-issue' } })
  const before = JSON.stringify(page.data)
  release({ protocolVersion: 2, viewVersion: 'v1', items: [{ accountId: 'late', name: '迟到账户' }], total: 1, nextCursor: null })
  await flush()
  assert.equal(JSON.stringify(page.data), before)
  if (['user', 'issue'].includes(mode)) {
    page.selectDirectory(tap({ choice: 'create' }))
    assert.deepEqual(plain(page.data.issueDraft), draft)
  }
})

test('交易类型弹层的账户行可搜索全目录，选择后仍能新建且保持当前性质草稿', async t => {
  const { h, page } = await setup(t, { economicNature: 'unknown', ledgerAccountId: 'account-0' }, 'shared_fields')
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.title, '选择账单所属账户')
  page.searchDirectory(input('合成账户24')); await flush()
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'account-24')
  assert.equal(page.data.issueDetail.natureLabel, '性质待确认')
  page.changeIssueNature(input(page.data.natureOptions.findIndex(option => option.value === 'income')))
  assert.equal(page.refreshIssueFieldsDraft().fields.ledgerAccountId, 'account-24')
  assert.equal(page.data.issueDetail.accountLabel, '收款账户')
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.canCreate, true)
  assert.equal(page.data.directorySheet.canClear, false, '没有空选项时不显示无效的清除操作')
  page.selectDirectory(tap({ choice: 'create' }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isCreate, true)
  assert.equal(page.data.issueDetail.natureLabel, '收入')
  assert.ok(h.calls.every(call => !/resolve|organize|post|setReview/.test(call.action)))
})

test('合并还款的单一补充入口兼有全目录与新建负债账户，不重复添加已有分配', async t => {
  const { h, page, accounts } = await setup(t, { economicNature: 'repayment', ledgerAccountId: 'account-0',
    fundsProjection: { from: { label: '合成付款账户' }, to: { referenceKind: 'aggregate', label: '合成合并还款', candidates: [] } } })
  accounts[24].type = 'credit'
  assert.equal(page.data.currentIssue.aggregateRepayment, true)
  await page.openDirectory(tap({ target: 'repayment' }))
  assert.equal(page.data.directorySheet.canCreate, true)
  page.selectDirectory(tap({ choice: 'create' }))
  assert.equal(page.data.repaymentAllocationChoices.filter(row => row.isNew).length, 1)
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.openDirectory(tap({ target: 'repayment' }))
    page.searchDirectory(input('合成账户24')); await flush()
    page.selectDirectory(tap({ index: 0 }))
  }
  assert.equal(page.data.repaymentAllocationChoices.filter(row => row.accountId === 'account-24').length, 1)
  assert.ok(h.calls.every(call => !/resolve|organize|post|setReview/.test(call.action)))
})

test('组合支付的还入账户直接从全目录选择，账户类型校验保留', async t => {
  const { page, accounts } = await setup(t, { economicNature: 'unknown', reasonCodes: ['payment_components_ambiguous'] }, 'shared_fields')
  accounts[24].type = 'credit'
  assert.equal(page.data.currentIssue.paymentNeedsReview, true)
  page.changePaymentNature(input(2))
  await page.openDirectory(tap({ target: 'paymentTarget' }))
  assert.equal(page.data.directorySheet.items[0].directoryDisabled, true)
  const initial = page.data.paymentTargetIndex
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(page.data.paymentTargetIndex, initial, '不适用账户在选择时即阻止，不返回表单留下错误选择')
  assert.ok(page.data.directorySheet)
  page.searchDirectory(input('合成账户24')); await flush()
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(page.data.paymentTargetChoices[page.data.paymentTargetIndex].accountId, 'account-24')
  assert.equal(page.data.directorySheet, null)
})

test('本人还款目录优先展示可用负债，禁选资金账户，重开仍标记当前选择', async t => {
  const { page, accounts } = await setup(t, { economicNature: 'repayment', repaymentOwnershipRequired: true,
    ledgerAccountId: 'synthetic-wallet', fundsProjection: { from: { label: '合成付款账户' }, to: { referenceKind: 'atomic', label: '合成信用卡' } } })
  accounts[2].type = 'credit'
  page.changeRepaymentOwner(tap({ owner: 'self' }))
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.liabilityOnly, true)
  assert.equal(page.data.directorySheet.items[0].accountId, accounts[2].accountId)
  const invalid = page.data.directorySheet.items.findIndex(row => row.type === 'bank')
  page.selectDirectory(tap({ index: invalid }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isPlaceholder, true)
  assert.ok(page.data.directorySheet)
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(page.data.directorySheet, null)
  assert.equal(page.data.issueFieldsCanSave, true)
  await page.openDirectory(tap({ target: 'account' }))
  const checked = page.data.directorySheet.items.filter(row => row.directorySelected)
  assert.deepEqual(checked.map(row => row.accountId), [accounts[2].accountId])
  page.closeDirectory()
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, accounts[2].accountId)
})

test('本人还款默认展开但不自动确认，归属往返保留输入且保存仅提交当前模式', async t => {
  for (const owner of ['self', 'other']) {
    const { h, page } = await setup(t, { economicNature: 'repayment', repaymentOwnershipRequired: true,
      ledgerAccountId: 'synthetic-wallet', fundsProjection: { kind: 'repayment', from: { label: '合成钱包' }, to: { referenceKind: 'atomic', label: '合成信用卡' } } },
      'transfer_accounts', accounts => { accounts[2].type = 'credit' })
    assert.equal(page.data.issueDraft.repaymentOwner, 'self')
    assert.equal(page.data.issueFieldsCanSave, false, '默认本人不替用户选择还入账户')
    assert.equal(page._draftSession.state.entries.length, 0)
    const legacy = plain(page.reviewDraftEntry(page.data.currentIssue, '', {}).form)
    legacy.issueDraft.repaymentOwner = ''
    page.restoreReviewDraft('synthetic-issue', legacy)
    assert.equal(page.data.issueDraft.repaymentOwner, 'self', '旧空白归属草稿也采用默认本人')

    page.changeIssueAccount(input(page.data.accountChoices.findIndex(account => account.accountId === 'account-2')))
    const selfFields = { counterpartyLedgerAccountId: 'account-2', repaymentOwnership: { owner: 'self' } }
    assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), selfFields)
    page.changeRepaymentOwner(tap({ owner: 'other' }))
    assert.equal(page.data.issueFieldsCanSave, false, '代还仍须明确处理方式')
    page.changeRepaymentOtherTreatment(tap({ treatment: 'expense' }))
    const otherFields = { repaymentOwnership: { owner: 'other', treatment: 'expense' } }
    assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), otherFields, '代还不提交暂留的本人账户')
    page.changeRepaymentOwner(tap({ owner: 'self' }))
    assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'account-2')
    assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), selfFields, '切回保留账户且不提交代还处理方式')
    if (owner === 'other') {
      page.changeRepaymentOwner(tap({ owner: 'other' }))
      assert.equal(page.data.issueDraft.repaymentOtherTreatment, 'expense')
    }
    assert.equal(page._draftSession.state.entries.length, 0, '展开和切换都不自动保存')
    await page.resolveWithFields()
    assert.deepEqual(plain(page._draftSession.state.entries[0].decision.fields), owner === 'self' ? selfFields : otherFields)
    assert.ok(h.calls.every(call => !/resolve|organize|post|setReview/.test(call.action)))
  }
})

test('明确的他人归属与恢复草稿不被默认本人覆盖，失效页面不能切换归属', async t => {
  const { page } = await setup(t, { economicNature: 'repayment', repaymentOwnershipRequired: true,
    repaymentOwnership: { owner: 'other', treatment: 'pending' }, ledgerAccountId: 'synthetic-wallet',
    fundsProjection: { kind: 'repayment', from: { label: '合成钱包' }, to: { referenceKind: 'atomic', label: '合成信用卡' } } })
  assert.equal(page.data.issueDraft.repaymentOwner, 'other')
  assert.equal(page.data.issueDraft.repaymentOtherTreatment, 'pending')
  const saved = plain(page.reviewDraftEntry(page.data.currentIssue, '', {}).form)
  page.changeRepaymentOwner(tap({ owner: 'self' }))
  page.restoreReviewDraft('synthetic-issue', saved)
  page.refreshIssueFieldsDraft()
  assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), { repaymentOwnership: { owner: 'other', treatment: 'pending' } })
  page.setData({ issueStale: true })
  page.changeRepaymentOwner(tap({ owner: 'self' }))
  page.changeRepaymentOtherTreatment(tap({ treatment: 'expense' }))
  assert.equal(page.data.issueDraft.repaymentOwner, 'other')
  assert.equal(page.data.issueDraft.repaymentOtherTreatment, 'pending')
  page.setData({ issueStale: false })
  page.onHide()
  page.changeRepaymentOwner(tap({ owner: 'self' }))
  assert.equal(page.data.issueDraft.repaymentOwner, 'other')
})

test('切换为他人还款会关闭本人账户目录，迟到目录不重新显示或改选', async t => {
  const { h, page } = await setup(t, { economicNature: 'repayment', repaymentOwnershipRequired: true,
    ledgerAccountId: 'synthetic-wallet', fundsProjection: { kind: 'repayment', from: { label: '合成钱包' }, to: { referenceKind: 'atomic', label: '合成信用卡' } } })
  let release
  h.intercept = (action, query) => action === 'financeUpdates.options' ? new Promise(resolve => { release = () => resolve(h.options(query)) }) : undefined
  const loading = page.openDirectory(tap({ target: 'account' }))
  await flush()
  assert.ok(release)
  page.changeRepaymentOwner(tap({ owner: 'other' }))
  release(); await loading
  assert.equal(page.data.directorySheet, null)
  assert.equal(page.data.issueDraft.repaymentOwner, 'other')
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isPlaceholder, true)
})

test('收款建议由点击采用，目录改选并清除后仍可使用，付款账户及原保存范围保持', async t => {
  const { h, page } = await setup(t, { economicNature: 'repayment', repaymentOwnershipRequired: true,
    ledgerAccountId: 'synthetic-wallet', fundsProjection: { from: { label: '合成钱包' }, to: { referenceKind: 'atomic', label: '示例银行信用卡' } } }, 'transfer_accounts', accounts => {
    Object.assign(accounts[2], { type: 'credit', name: '示例银行信用卡1234' })
    accounts[24].type = 'credit'
  })
  page.changeRepaymentOwner(tap({ owner: 'self' }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].isPlaceholder, true)
  assert.equal(page.data.bankSuggestion.side, 'to')
  assert.equal(page.data.bankSuggestion.candidates.length, 1)
  page.selectBankSuggestion(tap({ id: 'account-24' }))
  assert.equal(page.data.issueFieldsCanSave, false, '非建议账户不能通过建议入口选入')
  page.selectBankSuggestion(tap({ id: 'account-2' }))
  assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), { counterpartyLedgerAccountId: 'account-2', repaymentOwnership: { owner: 'self' } })
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.title, '选择还入账户')
  page.searchDirectory(input('合成账户24')); await flush()
  page.selectDirectory(tap({ index: 0 }))
  assert.equal(page.data.accountChoices.some(row => row.accountId === 'account-2'), false)
  await page.openDirectory(tap({ target: 'account' }))
  page.selectDirectory(tap({ choice: 'clear' }))
  page.selectBankSuggestion(tap({ id: 'account-2' }))
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, 'account-2')
  assert.equal(page.data.currentIssue.subject.ledgerAccountId, 'synthetic-wallet')
  assert.equal(page.data.issueFieldsCanSave, true)
  const selectedIndex = page.data.issueDraft.accountIndex
  page.changeRepaymentOwner(tap({ owner: 'other' }))
  page.selectBankSuggestion(tap({ id: 'account-2' }))
  assert.equal(page.data.issueDraft.accountIndex, selectedIndex, '替他人还款不改变暂留的本人账户选择')
  page.changeRepaymentOwner(tap({ owner: 'self' }))
  page.setData({ issueStale: true })
  page.selectBankSuggestion(tap({ id: 'account-2' }))
  assert.equal(page.data.issueDraft.accountIndex, selectedIndex, '过期表单不接受建议点击')
  assert.ok(h.calls.every(call => !/resolve|organize|post|setReview/.test(call.action)))
})

test('付款端建议写回付款账户，收款端已知值和资金方向不交换', async t => {
  const { page } = await setup(t, { ledgerAccountId: null, counterpartyLedgerAccountId: 'known-target',
    fundsProjection: { from: { referenceKind: 'atomic', label: '示例银行储蓄卡' }, to: { label: '合成收款钱包' } } }, 'transfer_accounts', accounts => {
    accounts[2].name = '示例银行储蓄卡1234'
  })
  assert.equal(page.data.bankSuggestion.side, 'from')
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet.title, '选择转出账户')
  page.closeDirectory()
  page.selectBankSuggestion(tap({ id: 'account-2' }))
  assert.deepEqual(plain(page.refreshIssueFieldsDraft().fields), { ledgerAccountId: 'account-2' })
  assert.equal(page.data.currentIssue.subject.counterpartyLedgerAccountId, 'known-target')
})

test('目录读取失败可原处重试，已选值保留；失效视图不能重新打开目录', async t => {
  const { h, page } = await setup(t)
  await page.openDirectory(tap({ target: 'account' }))
  page.selectDirectory(tap({ index: 2 }))
  const selected = page.data.accountChoices[page.data.issueDraft.accountIndex].accountId
  await page.openDirectory(tap({ target: 'account' }))
  let fail = true
  h.intercept = (action, query) => {
    if (action !== 'financeUpdates.options') return
    if (query.cursor && fail) throw new Error('合成目录读取失败')
    return h.options(query)
  }
  await page.changeDirectoryPage(tap({ direction: '1' }))
  assert.ok(page.data.directorySheet.error)
  assert.equal(page.data.accountChoices[page.data.issueDraft.accountIndex].accountId, selected)
  fail = false
  await page.changeDirectoryPage(tap({}))
  assert.equal(page.data.directorySheet.error, '')
  assert.equal(page.data.directorySheet.page.start, 13)
  page.closeDirectory()
  page.setData({ issueStale: true })
  await page.openDirectory(tap({ target: 'account' }))
  assert.equal(page.data.directorySheet, null)
})
