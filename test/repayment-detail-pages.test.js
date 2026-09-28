const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const paymentModel = require('../miniprogram/pages/loan-payment/model')
const transaction = { transactionId: 'synthetic-transfer', version: 1, type: 'transfer', origin: 'manual',
  amountMinor: '12000', occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480,
  sourceAccount: { accountId: 'account-a', name: '合成付款账户' }, destinationAccount: { accountId: 'credit', name: '合成信用账户' } }
const allocation = { loanId: 'synthetic-loan', loanName: '合成分期', kind: 'installment', version: 2,
  principalMinor: '10000', interestMinor: '2000', feeMinor: '0', interestTreatment: 'accrued', feeTreatment: 'accrued',
  period: { periodNumber: 2, version: 1 }, periodCount: 1, periods: [{ periodNumber: 2, dueDate: '2026-09-01' }],
  unallocated: { principalMinor: '0', interestMinor: '0', feeMinor: '0' } }
const payment = { paymentId: 'synthetic-payment', version: 3, kind: 'repayment', status: 'active', mode: 'new',
  assetAccountId: 'account-a', totalMinor: '12000', occurredLocalAt: transaction.occurredLocalAt, timezoneOffsetMinutes: -480 }
function setup() {
  const h = runtime()
  h.context = { state: 'linked', transaction, payment, allocations: [allocation] }
  h.group = { payment, allocations: [allocation], transactions: [transaction], unallocatedMinor: '0' }
  h.titles = []; h.wx.setNavigationBarTitle = ({ title }) => h.titles.push(title)
  h.respond = action => {
    const data = action === 'loans.transaction' ? h.context : action === 'loans.payment' ? h.group
      : action === 'loans.get' ? { loan: { ...allocation, name: allocation.loanName } } : undefined
    return data ? { ok: true, data } : undefined
  }
  return h
}
const event = id => ({ currentTarget: { dataset: { id } } })
const writes = h => h.calls.filter(c => /\.(record|correct|reverse|allocatePeriods|savePeriod|delete)$/.test(c.action))

test('真实账单入口：已关联手工还款显示只读结果，唯一操作到还款详情；解除关联后恢复普通编辑', async () => {
  const h = setup(), page = h.page('transaction-editor')
  h.app.globalData.editingTransaction = transaction
  page.onLoad({ mode: 'edit' }); await page.prepareForm()
  assert.equal(page.data.loanManaged, true)
  assert.equal(page.data.readonlyDetail, false) // 页面按保护状态展示详情，不篡改原入口模式。
  assert.equal(page.data.detail.amountText, '¥120.00')
  assert.equal(page.data.detail.canEditCategory, false)
  assert.equal(page.data.loanContext.showPaymentTotal, false)
  assert.equal(h.titles.at(-1), '账单详情')
  page.openLinkedPayment(); assert.equal(h.navigation.at(-1), '/pages/loan-payment/index?paymentId=synthetic-payment')
  page.setData({ saving: true }); page.openLinkedPayment(); assert.equal(h.navigation.length, 1)
  page.setData({ saving: false })
  h.context = { state: 'none', transaction, allocations: [] }
  await page.loadLoanContext()
  assert.equal(page.data.loanManaged, false); assert.equal(h.titles.at(-1), '编辑账单')
  page.openLinkedPayment(); assert.equal(h.navigation.length, 1)
  assert.equal(writes(h).length, 0)
})

test('还款详情真实入口：默认收起维护，展开不请求或写账；修改取消后回到同一还款', async () => {
  const h = setup(), page = h.page('loan-payment')
  page.onLoad({ paymentId: payment.paymentId }); await page.load()
  assert.equal(page.data.pageTitle, '还款详情'); assert.equal(page.data.managementOpen, false)
  assert.equal(page.data.allocations[0].periodText, '第 2 期'); assert.equal(page.data.hasUnallocated, false)
  const reads = h.calls.length
  page.toggleManagement(); assert.equal(page.data.managementOpen, true); assert.equal(h.calls.length, reads)
  page.openLoan(event('foreign-loan')); page.allocatePlan(event('foreign-loan')); assert.equal(h.navigation.length, 0)
  page.openLoan(event(allocation.loanId)); page.allocatePlan(event(allocation.loanId))
  assert.deepEqual(h.navigation, ['/pages/loan-detail/index?loanId=synthetic-loan', '/pages/loan-plan/index?loanId=synthetic-loan&paymentId=synthetic-payment'])
  await page.editPayment()
  assert.equal(page.data.pageTitle, '修改这次还款'); assert.equal(page.data.managementOpen, false)
  assert.equal(page.data.editingPayment.paymentId, payment.paymentId)
  await page.cancelEdit()
  assert.equal(page.data.payment.paymentId, payment.paymentId); assert.equal(page.data.pageTitle, '还款详情')
  assert.equal(writes(h).length, 0)
})

test('维护操作保留待确认、撤销和会话隔离；多贷款合计及未分配金额不被隐藏', async () => {
  const h = setup(), page = h.page('loan-payment')
  page.onLoad({ paymentId: payment.paymentId }); await page.load()
  page.setData({ hasPending: true })
  page.toggleManagement(); page.openLoan(event(allocation.loanId)); page.allocatePlan(event(allocation.loanId)); page.reverse(); await page.editPayment()
  assert.equal(page.data.managementOpen, false); assert.equal(h.modals.length, 0); assert.equal(h.navigation.length, 0)
  page.setData({ hasPending: false })
  page.reverse(); assert.equal(h.modals[0].title, '撤销这次还款'); assert.match(h.modals[0].content, /全部账目.*本金同步恢复/)
  h.modals[0].success({ confirm: false }); assert.equal(writes(h).length, 0)
  h.cache.reset()
  page.toggleManagement(); page.reverse(); page.openLoan(event(allocation.loanId)); await page.editPayment()
  assert.equal(h.modals.length, 1); assert.equal(h.navigation.length, 0); assert.equal(page.data.payment.paymentId, payment.paymentId)
  const view = paymentModel.paymentView({ ...h.group, unallocatedMinor: '500', allocations: [allocation, { ...allocation, loanId: 'loan-two', period: undefined }] })
  assert.equal(view.hasUnallocated, true); assert.equal(view.unallocatedText, '¥5.00')
  assert.equal(view.allocations.length, 2); assert.equal(view.allocations[1].periodText, '')
  assert.equal(paymentModel.pageTitle({ payment: { ...payment, kind: 'drawdown' } }), '放款详情')
})

test('期次入口展开只影响展示，选择金额草稿保持，关闭会话后不能展开', async () => {
  const h = setup(), page = h.page('loan-plan')
  page.onLoad({ loanId: allocation.loanId }); await page.load()
  page.setData({ items: [{ periodId: 'period-a', periodNumber: 1, dueDate: '2026-08-01', version: 1 }],
    allocationItems: [{ periodId: 'period-a', principalYuan: '100', interestYuan: '20', feeYuan: '0' }] })
  const before = JSON.stringify(page.data.allocationItems), reads = h.calls.length
  page.review(); page.togglePeriod(event('period-a')); page.togglePlanDetails()
  assert.equal(page.data.expandedPeriodId, 'period-a'); assert.equal(page.data.showPlanDetails, true)
  assert.equal(page.data.selectedPeriods['period-a'], true)
  assert.equal(JSON.stringify(page.data.allocationItems), before); assert.equal(h.calls.length, reads)
  page.togglePeriod(event('period-a')); assert.equal(page.data.expandedPeriodId, '')
  page.onUnload(); page.togglePeriod(event('period-a')); assert.equal(page.data.expandedPeriodId, '')
  assert.equal(writes(h).length, 0)
})
