const test = require('node:test')
const assert = require('node:assert/strict')
const { open, tap, mode, nature, edit, view, draft, writes, plain } = require('./helpers/editor-workbench')

const wallet = { accountId: 'synthetic-wallet', name: '合成钱包', type: 'wallet', currency: 'CNY' }
const credit = { accountId: 'synthetic-credit', name: '中信银行信用卡0022（合成）', type: 'credit', currency: 'CNY' }
const row = direction => ({ economicNature: 'repayment', sourceDirection: direction,
  ledgerAccountId: direction === 'income' ? null : wallet.accountId,
  counterpartyLedgerAccountId: direction === 'income' ? wallet.accountId : null,
  fundsProjection: { from: { referenceKind: 'atomic', label: '合成钱包' }, to: { referenceKind: 'atomic', label: '中信银行' } },
  detailFacts: { accounts: [wallet] } })
const choices = h => h.calls.filter(call => call.action === 'financeUpdates.options' && call.input.query === '中信银行')

for (const direction of ['expense', 'income']) test('建议账户按真实还入端选择，读取与选择不提前写入：' + direction, async t => {
  const unrelated = Array.from({ length: 55 }, (_, i) => ({ accountId: 'synthetic-' + i, name: '无关银行' + i, type: 'credit' }))
  const { page, h } = await open(t, row(direction), { accounts: [...unrelated, credit,
    { ...credit, accountId: 'archived', archivedAt: '2026-01-01' },
    { ...credit, accountId: 'wrong-type', type: 'bank' }, { ...credit, accountId: 'foreign-currency', currency: 'USD' }] })
  await page._reviewEditToken.suggestionRead
  assert.equal(page.data.reviewEditSheet.detailsExpanded, false)
  assert.deepEqual(plain(view(page).bankSuggestion.candidates.map(item => item.accountId)), [credit.accountId])
  assert.equal(choices(h).length, 1, '应按银行查完整目录，不能仅用预载账户')
  assert.equal(choices(h)[0].input.pageSize, 12)
  assert.equal(view(page).routeFields[1].accountId, '', '读取不能自动选择')
  edit(page, 'note', '保留正在编辑的备注')
  page.toggleEditorDetails(); page.toggleEditorDetails()
  assert.equal(choices(h).length, 1, '普通输入与展开不重复查询')
  page.selectEditorSuggestion(tap({ id: 'wrong-type' }))
  assert.equal(view(page).routeFields[1].accountId, '')
  page.selectEditorSuggestion(tap({ id: credit.accountId }))
  assert.equal(view(page).routeFields[0].accountId, wallet.accountId)
  assert.equal(view(page).routeFields[1].accountId, credit.accountId)
  assert.equal(draft(page).note, '保留正在编辑的备注')
  assert.equal(draft(page)[direction === 'income' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId'], credit.accountId)
  assert.equal(writes(h).length, 0)
})

for (const transition of ['close', 'hide', 'nature', 'owner', 'manual']) test('建议读取迟到不能改动新页面或新选择：' + transition, async t => {
  let release
  const { h, page } = await open(t, row('expense'), { accounts: [credit], intercept: (action, input) =>
    action === 'financeUpdates.options' && input.query === '中信银行' ? new Promise(resolve => { release = resolve }) : undefined })
  const token = page._reviewEditToken
  assert.equal(typeof release, 'function')
  await token.evidenceRead
  if (transition === 'close') page.closeReviewEdit()
  if (transition === 'hide') page.onHide()
  if (transition === 'nature') nature(page, 'expense')
  if (transition === 'owner') mode(page, 'owner', 'other')
  if (transition === 'manual') page.selectEditorDirectory({ ...credit, accountId: 'manual-choice' }, 'reviewCounterparty')
  const before = JSON.stringify(page.data.reviewEditSheet)
  release({ protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [credit], nextCursor: null, total: 1 })
  await token.suggestionRead
  assert.equal(token.accounts.has(credit.accountId), false)
  assert.equal(JSON.stringify(page.data.reviewEditSheet), before)
  assert.equal(writes(h).length, 0)
})

test('建议读取失败可重试，且贷款负债模式不推荐信用卡', async t => {
  let fail = true
  const { page, h } = await open(t, row('expense'), { accounts: [credit], intercept: (action, input) => {
    if (action === 'financeUpdates.options' && input.query === '中信银行' && fail) throw new Error('synthetic read failure')
  } })
  await page._reviewEditToken.suggestionRead
  assert.match(page.data.reviewEditSheet.suggestionError, /未能读取/)
  fail = false
  await page.loadEditorSuggestions(tap({ retry: true }))
  assert.equal(page.data.reviewEditSheet.suggestionError, '')
  assert.equal(view(page).bankSuggestion.candidates.length, 1)
  mode(page, 'repaymentMode', 'loan')
  assert.ok(!view(page).bankSuggestion)
  assert.equal(writes(h).length, 0)
})
