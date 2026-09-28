const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

const flush = () => new Promise(resolve => setImmediate(resolve))
const clone = value => JSON.parse(JSON.stringify(value))
const confirmation = '永久删除所选账目，不可恢复。余额和统计将更新。'
const refreshMessage = '已删除，列表待刷新'
const rows = () => [{ transactionId: 'synthetic-delete', version: 2, origin: 'manual', editable: true,
  type: 'expense', amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480,
  sourceAccount: { accountId: 'account-a', name: '合成账户' }, category: { categoryId: 'category-a' } }]
const listResult = transactions => ({ ok: true, data: { transactions, nextCursor: null,
  summary: { incomeMinor: '0', expenseMinor: transactions.length ? '100' : '0', netIncomeMinor: transactions.length ? '-100' : '0' } } })
const failed = code => ({ ok: false, error: { code, message: '合成后端错误' } })
async function listPage(h, account = false) {
  const page = h.page(account ? 'account-transactions' : 'transactions')
  page.onLoad(account ? { accountId: 'account-a' } : {})
  page.onShow()
  await page.prepareAndLoad()
  await flush()
  return page
}
async function editorPage(h, origin = 'manual', type = 'expense') {
  const page = h.page('transaction-editor'), transaction = { ...rows()[0], origin, type }
  h.app.globalData.editingTransaction = transaction
  const previous = h.respond
  h.respond = (action, data) => action === 'loans.transaction'
    ? { ok: true, data: { state: 'none', transaction, allocations: [] } } : previous && previous(action, data)
  page.onLoad({ mode: origin === 'import' ? 'import' : 'edit' })
  await page.prepareForm()
  await flush()
  return page
}
async function deleteSelection(h, page) {
  page.toggleSelection()
  page.selectTransaction(0)
  const deleting = page.deleteSelected()
  await flush()
  assert.equal(h.modals.at(-1).content, confirmation)
  h.modals.at(-1).success({ confirm: true })
  await deleting
}

test('真实单笔入口：手工与导入仅确认一次，冻结身份，成功后不能重复提交', async t => {
  for (const origin of ['manual', 'import']) await t.test(origin, async () => {
    const h = runtime(), page = await editorPage(h, origin)
    assert.equal(page.data.canDelete, true)
    page.remove(); page.remove()
    assert.equal(h.modals.length, 1)
    assert.equal(h.modals[0].content, confirmation)
    page.setData({ transactionId: 'synthetic-later-edit', version: 3 })
    await h.modals[0].success({ confirm: true })
    const writes = h.calls.filter(call => call.action === 'transactions.delete')
    assert.equal(writes.length, 1)
    assert.equal(writes[0].data.transactionId, 'synthetic-delete')
    assert.equal(writes[0].data.version, 2)
    assert.deepEqual(h.navigation, ['back'])
    page.remove()
    assert.equal(h.modals.length, 1)
    assert.equal(h.load('services/pending-ledger-write').pending(), null)
  })
})

test('单笔删除取消与会话退出不写入；贷款维护账目给出明确入口', async () => {
  const h = runtime(), page = await editorPage(h)
  page.remove(); await h.modals[0].success({ confirm: false })
  assert.equal(h.calls.some(call => call.action === 'transactions.delete'), false)
  page.setData({ loanManaged: true }); await page.remove()
  assert.match(page.data.errorMessage, /全部贷款与还款.*详情/)
  assert.equal(h.modals.length, 1)
  page.setData({ loanManaged: false }); page.remove()
  h.cache.reset()
  await h.modals[1].success({ confirm: true })
  assert.equal(h.calls.some(call => call.action === 'transactions.delete'), false)
})

test('真实单笔入口响应丢失后继续原删除，核实未提交时沿用请求且不再次弹确认', async () => {
  const h = runtime()
  let lost = true
  h.respond = action => action === 'transactions.delete' && lost ? failed('CLOUD_CALL_FAILED') : undefined
  const page = await editorPage(h)
  page.remove(); await h.modals[0].success({ confirm: true })
  const pending = clone(h.load('services/pending-ledger-write').pending())
  lost = false
  await page.remove()
  const writes = h.calls.filter(call => call.action === 'transactions.delete')
  assert.equal(writes.length, 2)
  assert.deepEqual(clone(writes[0].data), clone(writes[1].data))
  assert.equal(writes[1].data.requestId, pending.payload.requestId)
  assert.equal(h.modals.length, 1)
  assert.equal(h.load('services/pending-ledger-write').pending(), null)
  assert.deepEqual(h.navigation, ['back'])
})

test('导入单笔的全部普通类型重启后恢复原删除回执，不因只读详情跳过恢复', async t => {
  for (const type of ['income', 'expense', 'transfer', 'refund']) await t.test(type, async () => {
    const first = runtime()
    first.respond = action => action === 'transactions.delete' ? failed('CLOUD_CALL_FAILED') : undefined
    const original = await editorPage(first, 'import', type)
    original.remove(); await first.modals[0].success({ confirm: true })
    const requestId = first.load('services/pending-ledger-write').pending().payload.requestId
    original.onUnload()
    const h = runtime(first.storage)
    h.app.globalData.uid = ''
    h.respond = action => action === 'transactions.commandResult'
      ? { ok: true, data: { action: 'transactions.delete', result: { deleted: true } } } : undefined
    const page = await editorPage(h, 'import', type)
    assert.equal(page.data.canDelete, true)
    assert.equal(h.calls.some(call => call.action === 'transactions.delete'), false)
    assert.equal(h.calls.find(call => call.action === 'transactions.commandResult').data.requestId, requestId)
    assert.equal(h.load('services/pending-ledger-write').pending(), null)
    assert.deepEqual(h.navigation, ['back'])
    assert.equal(h.modals.length, 0)
  })
})

test('单笔删除返回明细后刷新失败只显示已删除，并在新读取成功后清除状态', async t => {
  for (const account of [false, true]) await t.test(account ? '账户明细' : '全部明细', async () => {
    const h = runtime()
    let removed = false, offline = false
    h.respond = action => {
      if (action === 'transactions.delete') { removed = true; return { ok: true, data: { deleted: true } } }
      if (action === 'transactions.list') return offline ? failed('CLOUD_CALL_FAILED') : listResult(removed ? [] : rows())
    }
    const list = await listPage(h, account), editor = await editorPage(h)
    list.onHide()
    editor.remove(); await h.modals[0].success({ confirm: true })
    offline = true
    list.onShow(); await list.prepareAndLoad()
    assert.equal(list.data.errorMessage, refreshMessage)
    assert.equal(h.calls.filter(call => call.action === 'transactions.delete').length, 1)
    offline = false
    await list.prepareAndLoad({ force: true })
    assert.equal(list.data.errorMessage, '')
    assert.equal(list.data.transactions.length, 0)
    assert.equal(list.data.expenseText, '¥0.00')
    h.cache.reset()
    offline = true
    list.onShow(); await list.prepareAndLoad()
    assert.notEqual(list.data.errorMessage, refreshMessage, '删除状态不能串入新会话')
  })
})

test('真实批量入口删除成功后读取失败或抛错，不生成删除重试、不换请求号', async t => {
  for (const throws of [false, true]) await t.test(throws ? '读取抛错' : '读取返回失败', async () => {
    const h = runtime()
    let removed = false
    h.respond = (action, data) => {
      if (action === 'transactions.deleteMany') { removed = true; return { ok: true, data: { deletedCount: data.items.length } } }
      if (action === 'transactions.list') return removed ? failed('CLOUD_CALL_FAILED') : listResult(rows())
    }
    const page = await listPage(h)
    if (throws) page.loadTransactions = async () => { throw new Error('合成渲染异常') }
    await deleteSelection(h, page)
    assert.equal(page.data.errorMessage, refreshMessage)
    assert.equal(page.data.deleteRetryCount, 0)
    assert.equal(page.data.selectedCount, 0)
    assert.equal(h.load('services/pending-ledger-write').pending(), null)
    await page.deleteSelected()
    assert.equal(h.calls.filter(call => call.action === 'transactions.deleteMany').length, 1)
    assert.equal(h.modals.length, 1)
  })
})

test('批量响应丢失后重进真实页面只查原回执；刷新失败仍确认已删', async () => {
  const first = runtime()
  let stored
  first.respond = (action, data) => {
    if (action === 'transactions.list') return listResult(rows())
    if (action === 'transactions.deleteMany') { stored = clone(data); return failed('CLOUD_CALL_FAILED') }
  }
  const original = await listPage(first)
  await deleteSelection(first, original)
  assert.equal(original.data.deleteRetryCount, 1)
  original.onUnload()
  const h = runtime(first.storage)
  h.respond = action => action === 'transactions.commandResult'
    ? { ok: true, data: { action: 'transactions.deleteMany', result: { deletedCount: 1 } } }
    : action === 'transactions.list' ? failed('CLOUD_CALL_FAILED') : undefined
  const recovered = await listPage(h)
  await flush()
  assert.equal(recovered.data.errorMessage, refreshMessage)
  assert.equal(recovered.data.deleteRetryCount, 0)
  assert.equal(h.calls.some(call => call.action === 'transactions.deleteMany'), false)
  assert.equal(h.calls.find(call => call.action === 'transactions.commandResult').data.requestId, stored.requestId)
  assert.equal(h.load('services/pending-ledger-write').pending(), null)
})

test('批量继续删除沿用已确认范围和原请求，不能静默发送后来选择', async () => {
  const h = runtime()
  let lost = true
  h.respond = (action, data) => {
    if (action === 'transactions.list') return listResult(rows())
    if (action === 'transactions.deleteMany') return lost ? failed('CLOUD_CALL_FAILED') : { ok: true, data: { deletedCount: data.items.length } }
  }
  const page = await listPage(h)
  await deleteSelection(h, page)
  lost = false
  page.data.transactions = [{ ...rows()[0], transactionId: 'synthetic-later-added', selected: true }]
  await page.deleteSelected()
  const writes = h.calls.filter(call => call.action === 'transactions.deleteMany')
  assert.equal(writes.length, 2)
  assert.deepEqual(clone(writes[1].data), clone(writes[0].data))
  assert.equal(writes[1].data.items[0].transactionId, 'synthetic-delete')
  assert.equal(h.modals.length, 1)
})

test('真实删除入口受保护时指出退款、贷款或现金处理入口，清除确定失败的原请求', async t => {
  for (const [code, message] of [
    ['REFUNDED_TRANSACTION_LOCKED', /明细.*原消费.*退款/],
    ['TRANSACTION_GROUP_LOCKED', /同一来源.*明细.*完整分配组/],
    ['LOAN_TRANSACTION_LOCKED', /贷款.*分期.*费用.*全部贷款与还款/],
    ['INSUFFICIENT_CASH_BALANCE', /现金余额.*账户明细/]
  ]) for (const batch of [false, true]) await t.test(code + (batch ? ' 批量' : ' 单笔'), async () => {
    const h = runtime()
    h.respond = action => action === 'transactions.list' ? listResult(rows())
      : action === (batch ? 'transactions.deleteMany' : 'transactions.delete') ? failed(code) : undefined
    const page = batch ? await listPage(h) : await editorPage(h)
    if (batch) await deleteSelection(h, page)
    else { page.remove(); await h.modals[0].success({ confirm: true }) }
    assert.match(page.data.errorMessage, message)
    assert.equal(h.load('services/pending-ledger-write').pending(), null)
    assert.deepEqual(h.navigation, [])
    if (batch) { assert.equal(page.data.transactions.length, 1); assert.equal(page.data.deleteRetryCount, 0) }
  })
})
