const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

const account = (id, nature = 'liability') => ({ accountId: id, name: '合成账户', type: nature === 'asset' ? 'bank' : 'credit', nature,
  version: 1, archived: false, currency: 'CNY', bookBalanceMinor: nature === 'asset' ? '1000' : '-1000',
  displayBalanceMinor: '1000', balanceDirection: nature === 'asset' ? 'asset' : 'liability', statementDay: 25,
  repaymentDay: 10, creditLimitMinor: '200000' })
const day = (field, value) => ({ currentTarget: { dataset: { field } }, detail: { value: String(value) } })
const input = value => ({ detail: { value } })

test('新建负债三个字段均可选；切换资产后不带账单资料；旧服务阻止资料被忽略', async () => {
  const h = runtime(), page = h.page('accounts')
  h.respond = (action, data) => action === 'accounts.list' ? { ok: true, data: { accounts: [], liabilitySettingsVersion: 1 } } :
    action === 'accounts.create' ? { ok: true, data: { ...data, accountId: 'new' } } : undefined
  await page.loadAccounts()
  page.openCreate(); page.changeType({ detail: { value: 3 } })
  page.bindName(input('合成信用卡')); page.changeBillingDay(day('statementDay', 31)); page.changeBillingDay(day('repaymentDay', 5)); page.bindCreditLimit(input('2000.00'))
  await page.saveForm()
  const first = h.calls.find(c => c.action === 'accounts.create')
  assert.equal(first.data.statementDay, 31); assert.equal(first.data.repaymentDay, 5); assert.equal(first.data.creditLimitMinor, '200000')
  page.openCreate(); page.changeType({ detail: { value: 3 } }); page.bindCreditLimit(input('20'))
  page.changeType({ detail: { value: 1 } }); page.bindName(input('合成银行'))
  await page.saveForm()
  const second = h.calls.filter(c => c.action === 'accounts.create')[1]
  assert.equal(Object.hasOwn(second.data, 'creditLimitMinor'), false)
  const legacy = runtime(), old = legacy.page('accounts')
  await old.loadAccounts(); old.openCreate(); old.changeType({ detail: { value: 3 } }); old.bindName(input('合成旧服务'))
  old.bindCreditLimit(input('100'))
  await old.saveForm()
  assert.match(old.data.errorMessage, /暂不可用/)
  assert.equal(legacy.calls.some(c => c.action === 'accounts.create'), false)
})

test('负债详情可清空资料且不触发余额校正；资产仍保留校正入口', async () => {
  const h = runtime(), page = h.page('account-detail')
  h.accounts = [account('debt')]
  h.respond = (action, data) => {
    if (action === 'accounts.list') return { ok: true, data: { accounts: h.accounts, liabilitySettingsVersion: 1 } }
    if (action === 'accounts.update') {
      Object.assign(h.accounts[0], { ...data, version: 2 })
      return { ok: true, data: h.accounts[0] }
    }
    return undefined
  }
  page.onLoad({ accountId: 'debt' }); await page.loadAccount()
  page.openCorrection(); assert.equal(page.data.formOpen, false)
  for (const field of ['statementDay', 'repaymentDay', 'creditLimit']) {
    page.startEditBilling(day(field, 0)); assert.equal(page.data.editingBilling, field)
    page.bindBillingField(input(''))
    await page.saveBillingField()
    assert.equal(page.data.editingBilling, '')
  }
  const writes = h.calls.filter(c => c.action.startsWith('accounts.') && !['accounts.list'].includes(c.action))
  assert.equal(writes.length, 3); assert.ok(writes.every(c => c.action === 'accounts.update'))
  assert.equal(writes[2].data.statementDay, null); assert.equal(writes[2].data.repaymentDay, null); assert.equal(writes[2].data.creditLimitMinor, null)
  h.accounts = [account('asset', 'asset')]
  page.setData({ accountId: 'asset' }); await page.loadAccount({ force: true })
  page.startEditBilling(day('statementDay', 0)); assert.equal(page.data.editingBilling, '')
  page.openCorrection(); assert.equal(page.data.formOpen, true)
})

test('服务端未确认账单资料时，不向用户报保存成功', async () => {
  const h = runtime(), page = h.page('account-detail')
  h.accounts = [account('debt')]
  h.respond = action => action === 'accounts.list' ? { ok: true, data: { accounts: h.accounts, liabilitySettingsVersion: 1 } } :
    action === 'accounts.update' ? { ok: true, data: { accountId: 'debt', version: 2 } } : undefined
  page.onLoad({ accountId: 'debt' }); await page.loadAccount()
  page.startEditBilling(day('statementDay', 0))
  await page.saveBillingField()
  assert.match(page.data.billingFieldError, /未确认保存/)
  assert.equal(page.data.editingBilling, 'statementDay')
  assert.equal(h.toasts.includes('已保存'), false)
})
