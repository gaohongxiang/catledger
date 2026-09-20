const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { createObserver } = require('../scripts/performance-observer')
const { localServices, call } = require('./helpers/local-services')
const { runtime } = require('./helpers/read-runtime')
const { bytes } = require('../miniprogram/services/read-observer')
const flush = () => new Promise(resolve => setImmediate(resolve))

test('流水后续页不汇总，版本变化拒绝旧游标；退款口径、身份与组合筛选不变', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const db = await isolatedMysql()
  try {
    const observer = createObserver(db.owner), services = localServices({ apiPool: observer.pool, importPool: db.owner })
    const api = (action, data) => call(services.api, action, data)
    const user = await api('bootstrap'), categoryId = user.categories.find(c => c.kind === 'expense').id
    const account = await api('accounts.create', { requestId: randomUUID(), type: 'wallet', name: '合成分页账户', openingDisplayBalanceMinor: '10000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    let original
    for (let i = 0; i < 8; i++) original = await api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: account.accountId, categoryId,
      amountMinor: '100', occurredLocalAt: '2026-09-02T12:00:00', timezoneOffsetMinutes: -480, note: i % 2 ? '合成甲' : '合成乙' })
    await api('transactions.create', { requestId: randomUUID(), type: 'refund', destinationAccountId: account.accountId, originalTransactionId: original.transactionId,
      amountMinor: '50', occurredLocalAt: '2026-09-03T12:00:00', timezoneOffsetMinutes: -480 })
    const query = { month: '2026-09', source: 'manual', accountId: account.accountId, search: '合成甲', pageSize: 2 }
    observer.reset(); const first = await api('transactions.list', query)
    assert.equal(first.summary.expenseMinor, '750'); assert.equal(observer.snapshot().summaryCount, 1)
    observer.reset(); const second = await api('transactions.list', { ...query, cursor: first.nextCursor })
    assert.equal(Object.hasOwn(second, 'summary'), false); assert.equal(observer.snapshot().summaryCount, 0)
    assert.equal(second.dataRevision, first.dataRevision); assert.equal(second.nextCursor, null)
    assert.equal(new Set([...first.transactions, ...second.transactions].map(t => t.transactionId)).size, 4)
    const other = localServices({ apiPool: db.owner, importPool: db.owner, subject: 'synthetic-pagination-other' }); await call(other.api, 'bootstrap')
    await assert.rejects(call(other.api, 'transactions.list', { ...query, cursor: first.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
    await api('transactions.delete', { requestId: randomUUID(), transactionId: first.transactions[0].transactionId, version: first.transactions[0].version })
    observer.reset()
    await assert.rejects(api('transactions.list', { ...query, cursor: first.nextCursor }), { publicCode: 'READ_SNAPSHOT_CHANGED' })
    assert.equal(observer.snapshot().summaryCount, 0)
    assert.equal((await api('transactions.list', query)).summary.expenseMinor, '650')
  } finally { await db.close() }
})

function pagedRuntime() {
  const h = runtime(), page = h.page('transactions'), patches = [], setData = page.setData
  page.setData = function(patch, callback) { patches.push(patch); return setData.call(this, patch, callback) }
  h.respond = (action, data) => action === 'transactions.list' ? { ok: true, data: {
    source: data.source || null, ...(data.cursor ? {} : { summary: { incomeMinor: '0', expenseMinor: '900', netIncomeMinor: '-900' } }),
    transactions: Array.from({ length: 30 }, (_, i) => ({ transactionId: 'synthetic-' + (Number(data.cursor || 0) + i), version: 1, type: 'expense', origin: 'manual', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', sourceAccount: { accountId: 'account-a', name: '合成账户' } })),
    nextCursor: String(Number(data.cursor || 0) + 30)
  } } : undefined
  return { h, page, patches }
}

test('长列表只追加30行，选择态走路径补丁，前台未变恢复分页与滚动内容', async () => {
  const { h, page, patches } = pagedRuntime(); await page.prepareAndLoad()
  const summary = page.data.expenseText
  for (let i = 2; i <= 10; i++) {
    patches.length = 0; await page.loadTransactions(true)
    const append = patches.filter(p => Object.keys(p).some(k => /^transactions\[\d+\]$/.test(k)))
    assert.equal(append.length, 1); assert.equal(Object.keys(append[0]).filter(k => k.startsWith('transactions[')).length, 30)
    assert.ok(bytes(append[0]) < 24 * 1024); assert.ok(patches.every(p => !Object.hasOwn(p, 'transactions')))
    assert.equal(page.data.expenseText, summary); assert.equal(page.data.transactions.length, i * 30)
  }
  patches.length = 0; page.toggleSelection(); await page.selectAll(); assert.equal(page.data.selectedCount, 100)
  page.resetSelection(); assert.equal(page.data.transactions.filter(t => t.selected).length, 0)
  assert.ok(patches.every(p => !Object.hasOwn(p, 'transactions')))
  const before = h.calls.length, rows = page.data.transactions
  const validation = h.api.revalidateForeground(); page.onShow(); await page.prepareAndLoad(); await validation
  assert.equal(h.calls.length, before + 1); assert.equal(page.data.transactions, rows); assert.equal(page.data.transactions.length, 300)
})

test('跨页版本变化自动重读首屏，不拼接、不沿用选择；刷新失败保留已确认删除', async () => {
  const { h, page } = pagedRuntime(); await page.prepareAndLoad()
  const respond = h.respond
  h.respond = (action, data) => {
    if (action === 'transactions.list' && data.cursor) { h.revision = '2'; return { ok: false, error: { code: 'READ_SNAPSHOT_CHANGED', message: 'changed' } } }
    return respond(action, data)
  }
  page.toggleSelection(); page.selectTransaction(0)
  await page.loadTransactions(true)
  assert.equal(page.data.transactions.length, 30); assert.equal(page._listRevision, '2'); assert.equal(page.data.selectedCount, 0)
  h.respond = (action, data) => {
    if (action === 'transactions.deleteMany') return { ok: true, data: { deletedCount: data.items.length } }
    if (action === 'transactions.list') return { ok: false, error: { code: 'FORBIDDEN', message: '合成读取失败' } }
    return respond(action, data)
  }
  page.selectTransaction(0)
  const deleting = page.deleteSelected(); await flush(); h.modals.at(-1).success({ confirm: true }); await deleting
  assert.match(page.data.errorMessage, /已删除，列表待刷新/); assert.equal(page.data.deleteRetryCount, 0)
  await page.deleteSelected()
  assert.equal(h.calls.filter(c => c.action === 'transactions.deleteMany').length, 1)
  assert.equal([...h.storage.keys()].some(k => k.startsWith('catledger_pending_ledger_v1:')), false)
})
