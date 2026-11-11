// 新负债模型：建计划只按「已还期数/账单锚点」切分历史，不再补记历史费用、不再"选已记"认领已有支出。
// 原来针对修正表单页 coverage 交互的用例随该功能作废，这里改为验收新契约：创建页无 coverage 入口，
// 已还期数一次带出并随建计划提交，不产生第二次确认或额外认领命令。
const test = require('node:test'), assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

test('新建分期页不再有补记历史费用/选已记认领入口，计划只按已还期数一次建立', async () => {
  const h = runtime(), page = h.page('loan-form')
  h.accounts = [{ accountId: 'credit-a', name: '信用卡', type: 'credit', archived: false }]
  const created = { loanId: 'new-loan', version: 1 }
  h.respond = (action, data) => {
    if (action === 'loans.previewPlan') return { ok: true, data: { periods: [{ periodNumber: 1, dueDate: '2026-02-28', principalMinor: '50000', interestMinor: '2000', feeMinor: '0' }], summary: { remainingPrincipalMinor: '50000', totalPaymentMinor: '52000', totalInterestMinor: '2000', totalFeeMinor: '0', totalTerms: 1 } } }
    if (action === 'loans.create') return { ok: true, data: created }
    return undefined
  }
  page.onLoad({ accountId: 'credit-a' }); await page.load()

  // 旧 coverage 交互已从创建页移除。
  assert.equal(typeof page.openHistoricalCoverage, 'undefined')
  assert.equal(typeof page.chooseHistoricalCandidate, 'undefined')
  assert.equal(page.data.historyCoverageByPeriod, undefined)

  page.setData({ name: '合成分期', principalYuan: '500', paidTerms: '1', schedule: { ...page.data.schedule, terms: '1', methodIndex: 0, measurementIndex: 1, repaymentYuan: '520', firstPaymentDate: '2026-02-28' } })
  await page.preview(); await page.save()

  const saved = h.calls.find(c => c.action === 'loans.create')
  // 不再传 coverage / oneOffCharges；已还期数写进 setup。
  assert.equal(saved.data.coverage, undefined)
  assert.equal(saved.data.oneOffCharges, undefined)
  assert.equal(saved.data.installmentSetup.historicalPaidTerms, 1)
  assert.equal(h.modals.length, 0)
})
