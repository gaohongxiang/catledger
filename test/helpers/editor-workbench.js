const { runtime, fixture, flush } = require('./paged-workbench')
const tap = dataset => ({ currentTarget: { dataset } })
const input = (field, value) => ({ ...tap({ field }), detail: { value } })
const plain = value => JSON.parse(JSON.stringify(value))
async function open(t, row = {}, options = {}) {
  const data = fixture(options.count || 1, true)
  Object.assign(data.events[0], { sourceDirection: 'expense', currency: 'CNY', categoryId: null,
    economicNature: 'internal_transfer', ledgerAccountId: null, counterpartyLedgerAccountId: null }, row)
  Object.assign(data.issues[0], { issueType: options.issueType || 'transfer_accounts', subject: data.events[0] })
  const h = runtime(data), page = h.page
  if (t) t.after(() => page.onUnload())
  h.accounts = options.accounts || Array.from({ length: 25 }, (_, index) => ({ accountId: 'account-' + index,
    name: '合成账户' + index, type: 'bank', currency: 'CNY' }))
  h.accountDrafts = options.accountDrafts || [{ accountId: 'draft-1', name: '合成本批账户', type: 'credit', currency: 'CNY' }]
  h.categories = options.categories || []
  if (options.intercept) h.intercept = options.intercept
  await flush()
  await page.openReviewEdit(tap({ id: data.events[0].eventId }))
  if (page.data.reviewEditSheet.error) throw Error(page.data.reviewEditSheet.error)
  return { h, page, row: data.events[0], accounts: h.accounts, drafts: h.accountDrafts }
}
function mode(page, field, value) { page.changeEditorMode(tap({ field, value })) }
function nature(page, value) { page.changeReviewedNature({ detail: { value: page.data.reviewEditSheet.editor.natureOptions.findIndex(item => item.value === value) } }) }
function select(page, target, item) { return page.selectEditorDirectory(item, target) }
function edit(page, field, value) { page.changeEditorText(input(field, value)) }
const view = page => page._reviewEditToken.view
const draft = page => page._reviewEditToken.draft
const writes = h => h.calls.filter(call => /resolve|organize|post|setReview/.test(call.action))
module.exports = { open, tap, input, plain, mode, nature, select, edit, view, draft, writes, flush }
