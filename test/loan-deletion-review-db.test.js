const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { chargeLab, prepareBank, postBank } = require('./helpers/loan-charges')
const { localServices, call } = require('./helpers/local-services')
const balances = async h => Object.fromEntries((await h.api('accounts.list')).accounts.map(a => [a.accountId, a.bookBalanceMinor]))
async function snapshot(h) {
  const value = {}
  for (const name of ['users', 'transactions', 'loans', 'loan_payments', 'loan_charges', 'loan_charge_audit', 'loan_charge_contracts', 'loan_period_allocations', 'mutation_receipts']) value[name] = (await h.owner.query('SELECT * FROM catledger_' + name + ' WHERE uid=?', [h.uid]))[0]
  return value
}
async function legacy(h, beforeArchive, referenceLabel) {
  const initial = await balances(h), loan = await h.create()
  if (referenceLabel) await h.configure(loan, { referenceLabel, mode: 'once' })
  const view = await h.api('loans.installment', { loanId: loan.loanId, periodNumber: 1 })
  await h.api('loans.record', { requestId: randomUUID(), simplePeriod: true, mode: 'new', kind: 'repayment', assetAccountId: h.assetAccountId,
    totalMinor: '52000', occurredLocalAt: '2026-01-31T12:00:00', timezoneOffsetMinutes: -480, confirmed: true,
    allocations: [{ loanId: loan.loanId, version: view.loanVersion, principalMinor: '50000', interestMinor: '2000', feeMinor: '0', interestTreatment: 'accrued', feeTreatment: 'accrued', period: { periodNumber: 1, version: view.period.version } }] })
  const fee = (await h.state(loan)).items.find(f => f.chargeKey === 'period:1:interest')
  await h.owner.execute('UPDATE catledger_transactions SET creation_provenance_json=NULL WHERE uid=? AND transaction_id=?', [h.uid, fee.transactionId])
  if (beforeArchive) await beforeArchive(loan, fee)
  const version = (await h.api('loans.get', { loanId: loan.loanId })).loan.version
  const archived = await h.api('loans.archiveInstallment', { requestId: randomUUID(), loanId: loan.loanId, version, archived: true })
  const [[transaction]] = await h.owner.execute('SELECT version FROM catledger_transactions WHERE uid=? AND transaction_id=?', [h.uid, fee.transactionId])
  return { initial, loan, fee, data: { loanId: loan.loanId, version: archived.version, reviewedCreations: [{ transactionId: fee.transactionId, version: Number(transaction.version), createdByThisPlan: true }] } }
}
async function preview(h, data) {
  const impact = await h.api('loans.deleteImpact', data)
  return { impact, input: { ...data, requestId: randomUUID(), confirmed: true, previewToken: impact.previewToken } }
}
test('旧归档费用的明确创建确认与整组撤销共用原事务', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  async function scenario(name, run) { await t.test(name, async () => { const h = await chargeLab(); try { await run(h) } finally { await h.close() } }) }
  await scenario('未确认仍阻塞；确认预览不写账，同一事务记录证据并撤销；并发和旧回执不重复影响', async h => {
    const { initial, loan, fee, data } = await legacy(h), old = await preview(h, { loanId: data.loanId, version: data.version })
    assert.equal(old.impact.canDelete, false); assert(old.impact.blockers.some(b => b.code === 'OWNERSHIP_REVIEW'))
    const before = await snapshot(h), { impact, input } = await preview(h, data)
    assert.equal(impact.canDelete, true); assert.equal(impact.counts.fees, 1); assert.equal(impact.counts.repayments, 1)
    assert.deepEqual(await snapshot(h), before)
    await assert.rejects(h.api('loans.delete', { ...input, previewToken: old.input.previewToken }), { publicCode: 'CONFLICT' })
    const result = await Promise.all([h.api('loans.delete', input), h.api('loans.delete', input)])
    assert.deepEqual(result[0], result[1]); assert.deepEqual(await balances(h), initial)
    const [[row]] = await h.owner.execute('SELECT creation_provenance_json AS provenance,deleted_at FROM catledger_transactions WHERE uid=? AND transaction_id=?', [h.uid, fee.transactionId])
    const provenance = typeof row.provenance === 'string' ? JSON.parse(row.provenance) : row.provenance
    assert.equal(provenance.evidence, 'user_confirmed_legacy_creation'); assert.deepEqual(provenance.loanIds, [loan.loanId]); assert(row.deleted_at)
    const [[audit]] = await h.owner.execute("SELECT COUNT(*) AS count FROM catledger_loan_charge_audit WHERE uid=? AND action='confirm_creation'", [h.uid]); assert.equal(Number(audit.count), 1)
    const next = await h.create(), independent = await h.expense('2026-02-01'), after = await snapshot(h)
    assert.deepEqual(await h.api('loans.delete', input), result[0]); assert.deepEqual(await snapshot(h), after)
    assert.notEqual(next.loanId, loan.loanId); assert(independent.transactionId)
    assert.deepEqual((await h.api('transactions.commandResult', { requestId: input.requestId, commandAction: 'loans.delete' })).result, result[0])
  })
  await scenario('事务末尾失败同时回滚归属确认、审计、账务和回执，原请求重试成功', async h => {
    const { data } = await legacy(h), { input } = await preview(h, data), before = await snapshot(h)
    await h.owner.query("CREATE TRIGGER fail_review_delete BEFORE UPDATE ON catledger_loans FOR EACH ROW BEGIN IF NEW.deleted_at IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic review rollback'; END IF; END")
    try { await assert.rejects(h.api('loans.delete', input), { publicCode: 'INTERNAL_ERROR' }) } finally { await h.owner.query('DROP TRIGGER fail_review_delete') }
    assert.deepEqual(await snapshot(h), before)
    assert.equal((await h.api('loans.delete', input)).deleted, true)
  })
  await scenario('跨用户、非本计划记录、陈旧版本和未逐笔明确确认均拒绝', async h => {
    const { data } = await legacy(h), { input } = await preview(h, data), before = await snapshot(h)
    const other = localServices({ apiPool: h.apiPool, importPool: h.importPool, subject: 'synthetic-review-other-' + randomUUID() }); await call(other.api, 'bootstrap')
    await assert.rejects(call(other.api, 'loans.delete', input), { publicCode: 'NOT_FOUND' })
    await assert.rejects(h.api('loans.deleteImpact', { ...data, reviewedCreations: [{ ...data.reviewedCreations[0], transactionId: randomUUID() }] }), { publicCode: 'NOT_FOUND' })
    await assert.rejects(h.api('loans.deleteImpact', { ...data, reviewedCreations: [{ ...data.reviewedCreations[0], version: 99 }] }), { publicCode: 'CONFLICT' })
    await assert.rejects(h.api('loans.deleteImpact', { ...data, reviewedCreations: [{ ...data.reviewedCreations[0], createdByThisPlan: false }] }), { publicCode: 'VALIDATION_ERROR' })
    await assert.rejects(h.api('loans.deleteImpact', { ...data, reviewedCreations: [...data.reviewedCreations, ...data.reviewedCreations] }), { publicCode: 'VALIDATION_ERROR' })
    assert.deepEqual(await snapshot(h), before)
  })
  await scenario('有持久创建归属或缺少逐期审计时不能用确认覆盖', async h => {
    const { fee, data } = await legacy(h)
    await h.owner.execute('UPDATE catledger_transactions SET creation_provenance_json=? WHERE uid=? AND transaction_id=?', [JSON.stringify({ kind: 'independent' }), h.uid, fee.transactionId])
    await assert.rejects(h.api('loans.deleteImpact', data), { publicCode: 'LOAN_DELETE_BLOCKED' })
    await h.owner.execute('UPDATE catledger_transactions SET creation_provenance_json=NULL WHERE uid=? AND transaction_id=?', [h.uid, fee.transactionId])
    await h.owner.execute("DELETE FROM catledger_loan_charge_audit WHERE uid=? AND charge_id=? AND action='record_period_fee'", [h.uid, fee.chargeId])
    await assert.rejects(h.api('loans.deleteImpact', data), { publicCode: 'LOAN_DELETE_BLOCKED' })
  })
  await scenario('外部退款仍阻塞整次操作，不落下已确认一半的记录', async h => {
    const { data } = await legacy(h, async (loan, fee) => {
      const d = { loanId: loan.loanId, chargeId: fee.chargeId, operation: 'refund', amountMinor: '100', destinationAccountId: h.assetAccountId, occurredLocalAt: '2026-02-01T12:00:00', timezoneOffsetMinutes: -480 }
      const p = await h.api('loans.chargeImpact', d); await h.api('loans.changeCharge', { ...d, requestId: randomUUID(), confirmed: true, previewToken: p.previewToken })
    })
    const { impact, input } = await preview(h, data), before = await snapshot(h)
    assert.equal(impact.canDelete, false); assert(impact.blockers.some(b => b.code === 'EXTERNAL_REFUND'))
    await assert.rejects(h.api('loans.delete', input), { publicCode: 'LOAN_DELETE_BLOCKED' }); assert.deepEqual(await snapshot(h), before)
  })
  await scenario('银行认领记录不接受人工确认覆盖；无确认时仍按保留规则处理', async h => {
    const { data } = await legacy(h, async () => {
      await postBank(h, await prepareBank(h, { period: 1, date: '2026-01-31', reference: 'SYNTHETIC-REVIEW-CLAIM' }))
    }, 'SYNTHETIC-REVIEW-CLAIM')
    await assert.rejects(h.api('loans.deleteImpact', data), { publicCode: 'LOAN_DELETE_BLOCKED' })
    const ordinary = await preview(h, { loanId: data.loanId, version: data.version })
    assert.equal(ordinary.impact.counts.retained, 1)
  })
  await scenario('明确确认费用归属也不能绕过共享付款，阻塞时确认和审计均不写入', async h => {
    const { data } = await legacy(h, async loan => {
      const other = await h.create(), current = (await h.api('loans.get', { loanId: loan.loanId })).loan
      await h.api('loans.record', { requestId: randomUUID(), kind: 'repayment', mode: 'new', confirmed: true,
        assetAccountId: h.assetAccountId, totalMinor: '20000', occurredLocalAt: '2026-02-01T12:00:00', timezoneOffsetMinutes: -480,
        allocations: [current, other].map(l => ({ loanId: l.loanId, version: l.version, principalMinor: '10000', interestMinor: '0', feeMinor: '0', interestTreatment: 'expense', feeTreatment: 'expense' })) })
    })
    const { impact, input } = await preview(h, data), before = await snapshot(h)
    assert.equal(impact.canDelete, false); assert(impact.blockers.some(b => b.code === 'SHARED_PAYMENT'))
    await assert.rejects(h.api('loans.delete', input), { publicCode: 'LOAN_DELETE_BLOCKED' }); assert.deepEqual(await snapshot(h), before)
  })
})
