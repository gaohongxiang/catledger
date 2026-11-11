const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')

test('rebuildPlan: 改已还期数后按新参数重新生成整份期次（无已取消窟窿、不产交易）', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async () => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const first = localServices({ apiPool, importPool, subject: 'rebuild-a' })
    const other = localServices({ apiPool, importPool, subject: 'rebuild-b' })
    const api = (a, d) => call(first.api, a, d)
    const identity = await api('bootstrap'); await call(other.api, 'bootstrap')
    const debt = (await api('accounts.create', { requestId: randomUUID(), type: 'other_liability', name: '负债', currency: 'CNY', openingDisplayBalanceMinor: '3000000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const schedule = { scheduleMethod:'flat', scheduleTerms:12, measurementKind:'rate', quoteType:'annual', ratePpm:'100000', feePerTermMinor:'0', feeUpfrontMinor:'0', firstPaymentDate:'2026-10-01' }
    const base = { name:'重算分期', kind:'installment', accountId:debt, baselinePrincipalMinor:'1200000', baselineDate:'2026-09-01' }
    const loanId = (await api('loans.create', { requestId: randomUUID(), ...base, ...schedule })).loanId
    assert.equal((await api('loans.generatePlan', { requestId: randomUUID(), loanId, version: 1, confirmed: true })).generatedPeriods, 12)
    const [[beforeTx]] = await lab.owner.execute('SELECT COUNT(*) AS c FROM catledger_transactions WHERE uid=?', [identity.uid])
    const loan = (await api('loans.get', { loanId })).loan
    const setup = { schema:1, originalPrincipalMinor:'1200000', historicalPaidTerms:5, recordType:'credit_card', customRecordType:'', discountKind:null, discountValue:null }
    const rb = await api('loans.rebuildPlan', { requestId: randomUUID(), loanId, version: loan.version, confirmed: true,
      ...schedule, installmentSetup: setup })
    assert.equal(rb.generatedPeriods, 12) // 全期重新生成 1..12
    const view = await api('loans.periods', { loanId, pageSize: 40 })
    // 不再有「已取消」窟窿：全期 12 条都是正常期次，已还由锚点驱动。
    assert.equal(view.items.length, 12)
    assert.equal(view.items.filter(i => i.cancelled).length, 0)
    // 以详情口径（buildView → installmentSummary）为准：锚点 5 期已还，未还本金 7×100000。
    const tracked = (await api('loans.get', { loanId })).loan.installmentSummary
    assert.equal(tracked.historicalPaidTerms ?? tracked.manualThrough, 5)
    assert.equal(tracked.paidPeriods, 5)
    assert.equal(tracked.unpaidPrincipalMinor, '700000')
    const [[afterTx]] = await lab.owner.execute('SELECT COUNT(*) AS c FROM catledger_transactions WHERE uid=?', [identity.uid])
    assert.equal(Number(afterTx.c), Number(beforeTx.c))
    assert.equal((await api('loans.get', { loanId })).loan.version, 3)
    // 版本冲突拒绝
    await assert.rejects(api('loans.rebuildPlan', { requestId: randomUUID(), loanId, version: 1, confirmed: true, ...schedule }), { publicCode: 'CONFLICT' })
    // 跨用户拒绝
    await assert.rejects(call(other.api, 'loans.rebuildPlan', { requestId: randomUUID(), loanId, version: 3, confirmed: true, ...schedule }), { publicCode: 'NOT_FOUND' })
    // 已还期数 = 总期数（全部已还）不再报错，仍生成全期、无已取消。
    const l2 = (await api('loans.get', { loanId })).loan
    const full = await api('loans.rebuildPlan', { requestId: randomUUID(), loanId, version: l2.version, confirmed: true, ...schedule,
      installmentSetup: { ...setup, historicalPaidTerms: 12 } })
    assert.equal(full.generatedPeriods, 12)
    const view2 = await api('loans.periods', { loanId, pageSize: 40 })
    assert.equal(view2.items.filter(i => i.cancelled).length, 0)
    assert.equal((await api('loans.get', { loanId })).loan.installmentSummary.unpaidPrincipalMinor, '0')
    console.log('PASS rebuild: rows', view.items.length, 'cancelled 0, unpaid', tracked.unpaidPrincipalMinor, 'version 3')
  } finally { await lab.close() }
})
