const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { runtime } = require('./helpers/read-runtime')

const account = (extra = {}) => ({ accountId: 'archived-bank', name: '合成恢复账户', type: 'bank', nature: 'asset',
  version: 2, archived: true, currency: 'CNY', bookBalanceMinor: '123400', displayBalanceMinor: '123400', balanceDirection: 'asset', ...extra })
const tick = () => new Promise(resolve => setImmediate(resolve))

async function detail(h) {
  const page = h.page('account-detail')
  page.onLoad({ accountId: h.accounts[0].accountId })
  await page.loadAccount()
  return page
}

test('停用列表进入原账户详情后可以恢复，原 ID、版本和余额保留且目录缓存失效', async () => {
  const h = runtime()
  h.accounts = [account()]
  h.respond = (action, data) => {
    if (action === 'accounts.restore') {
      h.accounts[0] = { ...h.accounts[0], archived: false, version: 3 }
      return { ok: true, data: h.accounts[0] }
    }
    return undefined
  }
  const list = h.page('accounts')
  await list.loadAccounts(); list.toggleArchived()
  list.openAccountDetail({ currentTarget: { dataset: { id: 'archived-bank' } } })
  assert.equal(h.navigation[0], '/pages/account-detail/index?accountId=archived-bank')
  await h.api.callApi('catalog.get')
  const page = await detail(h)
  await page.restore()
  const write = h.calls.find(c => c.action === 'accounts.restore')
  assert.equal(write.data.accountId, 'archived-bank')
  assert.equal(write.data.version, 2)
  assert.equal(page.data.account.archived, false)
  assert.equal(page.data.account.bookBalanceMinor, '123400')
  assert.equal(h.api.isFresh('catalog.get'), false)
  assert.equal(h.calls.some(c => ['accounts.create', 'accounts.correctBalance', 'loans.syncCharges', 'loans.configureCharges'].includes(c.action)), false)
  const template = readFileSync(path.join(__dirname, '../miniprogram/pages/account-detail/index.wxml'), 'utf8')
  assert.match(template, /bindtap="restore"[^>]*>恢复使用<\/button>/)
})

test('停用前说明余额保留、转账与贷款还款限制和恢复入口；取消不写入', async () => {
  const h = runtime()
  h.accounts = [account({ archived: false, nature: 'liability', type: 'other_liability', bookBalanceMinor: '-123400', balanceDirection: 'liability', debtMinor: '123400' })]
  h.respond = action => action === 'loans.list' ? { ok: true, data: { items: [], nextCursor: null } } : undefined
  const page = await detail(h), work = page.archive()
  assert.match(h.modals[0].content, /1,234\.00/)
  assert.match(h.modals[0].content, /转账/)
  assert.match(h.modals[0].content, /还款/)
  assert.match(h.modals[0].content, /恢复使用/)
  h.modals[0].success({ confirm: false }); await work
  assert.equal(h.calls.some(c => c.action === 'accounts.archive'), false)
})

test('恢复请求发送前可靠保存；失败重试原载荷，重复点击不新建请求', async () => {
  const h = runtime()
  h.accounts = [account()]
  let lost = true, release
  h.respond = async action => {
    if (action === 'accounts.restore') {
      await new Promise(resolve => { release = resolve })
      if (lost) throw new Error('合成断网')
      h.accounts[0] = { ...h.accounts[0], archived: false, version: 3 }
      return { ok: true, data: h.accounts[0] }
    }
    return undefined
  }
  const page = await detail(h), saving = page.restore()
  await tick()
  assert.equal(h.calls.filter(c => c.action === 'accounts.restore').length, 1)
  const first = h.calls.find(c => c.action === 'accounts.restore')
  const stored = Array.from(h.storage.values()).find(value => value && value.action === 'accounts.restore')
  assert.equal(stored.payload.requestId, first.data.requestId)
  await page.restore()
  assert.equal(h.calls.filter(c => c.action === 'accounts.restore').length, 1)
  release(); await saving
  assert.equal(page.data.pendingAccountAction, 'accounts.restore')
  page.data.account.version = 99
  lost = false
  const retry = page.retryAccountStatus(); await tick(); release(); await retry
  const writes = h.calls.filter(c => c.action === 'accounts.restore')
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1].data, first.data)
  assert.equal(page.data.account.archived, false)
  assert.equal(page.data.pendingAccountAction, '')
})

test('停用确认弹窗在隐藏或换用户后不提交；恢复迟到响应不覆盖新会话与编辑草稿', async () => {
  for (const leave of ['hide', 'session']) {
    const h = runtime()
    h.accounts = [account({ archived: false })]
    const page = await detail(h)
    const confirmation = page.archive()
    if (leave === 'hide') page.onHide()
    else { h.cache.reset(); h.uid = h.app.globalData.uid = '9876543210' }
    h.modals[0].success({ confirm: true }); await confirmation
    assert.equal(h.calls.some(c => c.action === 'accounts.archive'), false)
  }
  const h = runtime()
  h.accounts = [account()]
  let release
  h.respond = async action => {
    if (action === 'accounts.restore') {
      await new Promise(resolve => { release = resolve })
      return { ok: true, data: account({ archived: false, version: 3 }) }
    }
    return undefined
  }
  const page = await detail(h), saving = page.restore()
  await tick(); page.onHide(); h.cache.reset(); h.uid = h.app.globalData.uid = '9876543210'
  h.accounts = [account({ name: '另一个合成账户', archived: false, version: 1 })]
  await page.loadAccount()
  page.startEditName(); page.bindNameDraft({ detail: { value: '新用户未保存的名称' } })
  release(); await saving
  assert.equal(page.data.account.name, '另一个合成账户')
  assert.equal(page.data.editingName, true)
  assert.equal(page.data.nameDraft, '新用户未保存的名称')
  assert.equal(page.data.accountStatusMessage, '')
  assert.equal(h.toasts.length, 0)
})

test('存储失败不发送恢复请求；重名冲突不留下待核实操作', async () => {
  const h = runtime()
  h.accounts = [account()]
  const page = await detail(h), write = h.wx.setStorageSync
  h.wx.setStorageSync = () => { throw new Error('合成本机存储失败') }
  await page.restore()
  assert.equal(h.calls.some(c => c.action === 'accounts.restore'), false)
  assert.match(page.data.errorMessage, /本机未能保存请求/)
  h.wx.setStorageSync = write
  h.respond = action => action === 'accounts.restore' ? { ok: false, error: { code: 'ACCOUNT_NAME_CONFLICT', message: '已有同名活动账户，请先修改名称' } } : undefined
  await page.restore()
  assert.equal(page.data.pendingAccountAction, '')
  assert.match(page.data.errorMessage, /同名活动账户/)
})

test('继续核实期间离开页面，未知回执不再触发后台补发恢复命令', async () => {
  const h = runtime()
  h.accounts = [account()]
  h.respond = action => {
    if (action === 'accounts.restore') throw new Error('合成发送失败')
    return undefined
  }
  const page = await detail(h)
  await page.restore()
  let release
  h.respond = async action => {
    if (action === 'transactions.commandResult') await new Promise(resolve => { release = resolve })
    return undefined
  }
  const retry = page.retryAccountStatus()
  await tick(); page.onHide(); release(); await retry
  assert.equal(h.calls.filter(c => c.action === 'accounts.restore').length, 1)
  assert.ok(Array.from(h.storage.values()).some(value => value && value.action === 'accounts.restore'))
  assert.equal(h.toasts.length, 0)
})

test('彻底删除无流水账户成功后退回列表；有记录时提示并可跳转到该账户流水去删除', async () => {
  const h = runtime()
  h.accounts = [account({ bookBalanceMinor: '0', displayBalanceMinor: '0' })]
  let blocked = true
  h.respond = action => {
    if (action === 'accounts.remove') {
      if (blocked) return { ok: false, error: { code: 'ACCOUNT_HAS_RECORDS', message: '该账户已有流水或关联记录，不能删除；请改用停用（归档）' } }
      h.accounts = []
      return { ok: true, data: account({ archived: true }) }
    }
    return undefined
  }
  const page = await detail(h)
  // 第一次：确认删除 -> 被流水挡住，显示引导、不跳转、不误报通用错误
  const first = page.removeAccount()
  h.modals[0].success({ confirm: true })
  await first
  assert.equal(page.data.removeBlockedByRecords, true)
  assert.equal(h.calls.filter(c => c.action === 'accounts.remove').length, 1)
  assert.equal(h.navigation.includes('back'), false)
  assert.equal(page.data.errorMessage, '')
  // 内联展示该账户流水（不跳转）；模板里有勾选与删除按钮
  assert.equal(h.navigation.some(url => String(url).indexOf('/pages/account-transactions') >= 0), false)
  const template = readFileSync(path.join(__dirname, '../miniprogram/pages/account-detail/index.wxml'), 'utf8')
  assert.match(template, /bindtap="removeAccount"[^>]*>彻底删除<\/button>/)
  assert.match(template, /bindtap="deleteRemoveRecords"/)
  // 第二次：用户清完流水回来再删 -> 成功退回列表
  blocked = false
  page.setData({ removeBlockedByRecords: false })
  const second = page.removeAccount()
  h.modals[h.modals.length - 1].success({ confirm: true })
  await second
  assert.equal(h.navigation.includes('back'), true)
})

test('被流水挡住时内联列出流水，删除后自动重试彻底删除账户', async () => {
  const h = runtime()
  h.accounts = [account({ bookBalanceMinor: '0', displayBalanceMinor: '0' })]
  let blocked = true
  h.respond = (action, data) => {
    if (action === 'transactions.list') {
      // 按月查询：只有 2026-01 有这笔期初调整，其余月份为空，避免重复计入。
      const txs = data.month === '2026-01' ? [{ transactionId: 't1', version: 1, type: 'balance_adjustment', amountMinor: '10834', occurredLocalAt: '2026-01-01T00:00:00', origin: 'manual', note: '期初' }] : []
      return { ok: true, data: { source: 'manual', transactions: txs, nextCursor: null, summary: { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' } } }
    }
    if (action === 'transactions.deleteMany') return { ok: true, data: { deletedCount: 1 } }
    if (action === 'accounts.remove') {
      if (blocked) return { ok: false, error: { code: 'ACCOUNT_HAS_RECORDS', message: '有流水' } }
      h.accounts = []
      return { ok: true, data: account({ archived: true }) }
    }
    return undefined
  }
  const page = await detail(h)
  const first = page.removeAccount()
  h.modals[0].success({ confirm: true })
  await first
  await tick(); await tick(); await tick()
  assert.equal(page.data.removeBlockedByRecords, true)
  // 自动拉取了该账户流水
  assert.equal(page.data.removeRecords.length, 1)
  // 余额调整类不可选（selectable=false）
  assert.equal(page.data.removeRecords[0].selectable, false)
  // 模板含内联删除入口
  const template = readFileSync(path.join(__dirname, '../miniprogram/pages/account-detail/index.wxml'), 'utf8')
  assert.match(template, /bindtap="deleteRemoveRecords"/)
})

test('彻底删除成功后标记账户列表刷新，返回列表按最新数据强制重读', async () => {
  const h = runtime()
  h.accounts = [account({ bookBalanceMinor: '0', displayBalanceMinor: '0' })]
  h.respond = action => {
    if (action === 'accounts.remove') { h.accounts = []; return { ok: true, data: account({ archived: true }) } }
    return undefined
  }
  const page = await detail(h)
  const task = page.removeAccount()
  h.modals[0].success({ confirm: true })
  await task
  // 成功：退回列表 + 标记 accountsDirty
  assert.equal(h.navigation.includes('back'), true)
  assert.equal(h.app.globalData.accountsDirty, true)
  // 列表页 onShow：见到 dirty 标记则强制重读，并清标记
  const list = h.page('accounts')
  const forced = []
  const original = list.loadAccounts
  list.loadAccounts = opts => { forced.push(!!(opts && opts.force)); return Promise.resolve() }
  list.onShow()
  assert.deepEqual(forced, [true])
  assert.equal(h.app.globalData.accountsDirty, false)
  list.loadAccounts = original
})
