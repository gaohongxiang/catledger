const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

const liability = (extra = {}) => ({ accountId: 'card-1', name: '合成信用卡', type: 'credit', nature: 'liability', version: 2,
  archived: false, currency: 'CNY', bookBalanceMinor: '-100', displayBalanceMinor: '100', balanceDirection: 'liability',
  debtMinor: '0', debtDirection: 'paid', ...extra })

const SOURCE_ITEMS = [
  { itemId: 'i8p', accountId: 'card-1', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'principal', amountMinor: '50000', occurredDate: '2026-08-13' },
  { itemId: 'i8i', accountId: 'card-1', planLabel: '电销现分', totalTerms: 12, periodNumber: 8, component: 'interest', amountMinor: '3000', occurredDate: '2026-08-13' },
  { itemId: 'i9p', accountId: 'card-1', planLabel: '电销现分', totalTerms: 12, periodNumber: 9, component: 'principal', amountMinor: '50000', occurredDate: '2026-09-13' }
]

async function detail(h) {
  const page = h.page('account-detail')
  page.onLoad({ accountId: 'card-1' })
  await page.loadAccount()
  return page
}

test('账户详情页展示账单里的分期（按期次各一条，全部展示），并能新建/归入', async () => {
  const h = runtime()
  h.accounts = [liability()]
  h.respond = (action, data) => {
    if (action === 'loans.installmentSources') return { ok: true, data: { items: SOURCE_ITEMS, nextCursor: null } }
    if (action === 'loans.list') return { ok: true, data: { items: [{ loanId: 'loan-1', accountId: 'card-1', name: '电销现分', kind: 'installment', scheduleTerms: 12, version: 1, remainingPrincipalMinor: '500000', status: 'active' }], nextCursor: null } }
    return undefined
  }
  const page = await detail(h)
  // 按期次各一条：第 8 期(本金+利息一行)、第 9 期各一条，全部展示不遗漏。
  assert.equal(page.data.accountSources.length, 2)
  const p8 = page.data.accountSources.find(g => g.latestPeriod === 8), p9 = page.data.accountSources.find(g => g.latestPeriod === 9)
  assert.match(p8.periodText, /第 8 \/ 12 期/)
  assert.match(p8.amountText, /本金.*利息/)
  assert.equal(p8.sourceItemId, 'i8p')
  assert.equal(p9.sourceItemId, 'i9p')

  // 新建分期 → 跳 loan-form?sourceItemId
  page.createLoanFromSource({ currentTarget: { dataset: { id: 'i9p' } } })
  assert.match(h.navigation[h.navigation.length - 1], /loan-form\/index\?sourceItemId=i9p/)

  // 归入已有 → 弹候选
  await page.chooseLoanForSource({ currentTarget: { dataset: { id: 'i9p' } } })
  assert.ok(page.data.sourceChoosing)
  assert.equal(page.data.sourceChoosing.loans.length, 1)

  // 确认归入 → 调 linkInstallmentSource
  await page.confirmSourceLink({ currentTarget: { dataset: { id: 'loan-1' } } })
  const link = h.calls.find(c => c.action === 'loans.linkInstallmentSource')
  assert.ok(link)
  assert.equal(link.data.loanId, 'loan-1')
  assert.equal(link.data.itemId, 'i9p')
})

test('没有账单分期时不显示该区块', async () => {
  const h = runtime()
  h.accounts = [liability()]
  h.respond = (action) => action === 'loans.installmentSources' ? { ok: true, data: { items: [], nextCursor: null } } : undefined
  const page = await detail(h)
  assert.equal(page.data.accountSources.length, 0)
  assert.equal(page.data.accountSourcesError, '')
})
