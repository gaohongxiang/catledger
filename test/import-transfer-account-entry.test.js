const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture, runtime, flush } = require('./helpers/paged-workbench')
const tap = dataset => ({ currentTarget: { dataset } })
const input = value => ({ ...tap({}), detail: { value } })
const plain = value => JSON.parse(JSON.stringify(value))

async function setup(t, projection) {
  const data = fixture(1, true), event = data.events[0]
  Object.assign(event, { economicNature: 'internal_transfer', ledgerAccountId: null, counterpartyLedgerAccountId: null })
  if (projection) Object.assign(event, projection)
  Object.assign(data.issues[0], { issueType: 'transfer_accounts', subject: event })
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  const accounts = Array.from({ length: 25 }, (_, i) => ({ accountId: 'account-' + i, name: '合成账户' + i, type: 'bank', currency: 'CNY' }))
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
  const route = markup.slice(markup.indexOf('<view wx:elif="{{currentIssue.fundsRoute'), markup.indexOf('<text wx:if="{{bankSuggestion'))
  assert.equal((route.match(/class="funds-route-picker funds-account-control"/g) || []).length, 3)
  assert.doesNotMatch(route, /<picker[^>]+funds-route-picker/)
  assert.doesNotMatch(markup, />搜索转入账户/)
  for (const target of ['account', 'counterparty']) assert.match(markup,
    new RegExp('class="transfer-account-control" data-target="' + target + '" bindtap="openDirectory"'))
  const searchLines = markup.split('\n').filter(line => line.includes('>搜索全部账户'))
  assert.equal(searchLines.length, 1)
  assert.ok(searchLines[0].includes("currentIssue.issueType !== 'transfer_accounts'"))
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

for (const mode of ['switch', 'close', 'hide', 'user', 'issue']) test('账户目录迟到响应在 ' + mode + ' 后不回填或改写选择', async t => {
  const { h, page } = await setup(t)
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
