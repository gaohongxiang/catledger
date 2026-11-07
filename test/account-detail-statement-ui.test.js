const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

const liability = (extra = {}) => ({ accountId: 'card-1', name: '合成信用卡', type: 'credit', nature: 'liability', version: 2,
  archived: false, currency: 'CNY', bookBalanceMinor: '-100', displayBalanceMinor: '100', balanceDirection: 'liability',
  debtMinor: '0', debtDirection: 'paid', statementDueMinor: null, statementMinimumMinor: null, statementDueDate: null,
  statementCycle: null, hasStatementData: false, ...extra })

async function detail(h) {
  const page = h.page('account-detail')
  page.onLoad({ accountId: 'card-1' })
  await page.loadAccount()
  return page
}

test('本期账单可补录：编辑本期应还后调 accounts.update 带上金额', async () => {
  const h = runtime()
  h.accounts = [liability()]
  h.respond = (action, data) => {
    if (action === 'accounts.list') return { ok: true, data: { accounts: h.accounts, liabilitySettingsVersion: 1 } }
    if (action === 'accounts.update') return { ok: true, data: Object.assign({}, h.accounts[0], data, { version: 3, statementDueMinor: '813739' }) }
    return undefined
  }
  const page = await detail(h)
  page.startEditBilling({ currentTarget: { dataset: { field: 'statementDue' } } })
  assert.equal(page.data.editingBilling, 'statementDue')
  page.bindBillingField({ detail: { value: '8137.39' } })
  await page.saveBillingField()
  const update = h.calls.find(c => c.action === 'accounts.update')
  assert.ok(update)
  assert.equal(update.data.statementDueMinor, '813739')
})

test('非法到期日格式被前端拒绝，不发请求', async () => {
  const h = runtime()
  h.accounts = [liability()]
  h.respond = (action) => action === 'accounts.list' ? { ok: true, data: { accounts: h.accounts, liabilitySettingsVersion: 1 } } : undefined
  const page = await detail(h)
  page.startEditBilling({ currentTarget: { dataset: { field: 'statementDueDate' } } })
  page.bindBillingField({ detail: { value: 'abc' } })
  await page.saveBillingField()
  assert.equal(h.calls.some(c => c.action === 'accounts.update'), false)
  assert.ok(page.data.billingFieldError)
})
