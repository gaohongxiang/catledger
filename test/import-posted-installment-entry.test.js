const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')

// 已入账页的待补分期：只按本批来源计数并点名计划，入口带 updateId 直达。
function posted(h) {
  return { ...JSON.parse(JSON.stringify(h.summary)), viewVersion: 'v-posted',
    sources: [{ sourceId: 'source', sourceType: 'bank', fileName: '合成账单.csv', summary: {} }],
    update: { ...h.summary.update, status: 'posted', version: 5 }, posting: { createdTransactionCount: 3, reusedTransactionCount: 0 } }
}
// 已入账页走 catledger-api 读取（不经过导入会话），这里只接住这一条读取。
function ledger(items, seen) {
  return { callFunction: async ({ name, data }) => {
    assert.equal(name, 'catledger-api')
    if (data.action === 'loans.installmentSources') {
      seen.push(data.data)
      return { result: { ok: true, data: { readVersion: 1, uid: '1234567890', dataRevision: '1', unchanged: false,
        items, nextCursor: null } } }
    }
    return { result: { ok: false, error: { code: 'NOT_FOUND', message: '合成测试未覆盖 ' + data.action } } }
  } }
}
const settle = async () => { for (let i = 0; i < 8; i++) await flush() }

test('已入账卡按本批读取待补分期，显示条数与计划名，入口带本批标识', async () => {
  const navigation = [], seen = []
  const h = runtime(fixture(3), { wx: { cloud: ledger([
    { itemId: 'a', planLabel: '电销总账分月12期' }, { itemId: 'b', planLabel: '电销总账分月12期' },
    { itemId: 'c', planLabel: '电销现分按月收12期' }, { itemId: 'd', planLabel: null }], seen),
    navigateTo: options => navigation.push(options.url) } })
  const page = h.page
  page.applyUpdateView(posted(h)); await settle()
  assert.equal(page.data.currentStep, 4)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].updateId, 'synthetic-update')
  assert.equal(page.data.pendingInstallments, 4)
  assert.equal(page.data.pendingInstallmentNames, '电销总账分月12期、电销现分按月收12期')
  page.openInstallmentSources()
  assert.deepEqual(navigation, ['/packages/finance/pages/installment-sources/index?updateId=synthetic-update'])
})

test('本批没有待补来源时不显示条数，也不残留上一批的提示', async () => {
  const h = runtime(fixture(3), { wx: { cloud: ledger([], []), navigateTo() {} } })
  const page = h.page
  page.applyUpdateView(posted(h)); await settle()
  assert.equal(page.data.pendingInstallments, 0)
  assert.equal(page.data.pendingInstallmentNames, '')
  page.applyUpdateView(h.summary); await settle()
  assert.equal(page.data.pendingInstallments, 0)
  assert.equal(page.data.pendingInstallmentNames, '')
})
