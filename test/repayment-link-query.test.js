const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { candidate, candidateFilters } = require('../cloudfunctions/catledger-api/src/repayment-query-service')
const { evidenceView } = require('../cloudfunctions/catledger-api/src/repayment-evidence')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, syntheticBill } = require('./helpers/local-services')

test('信用账户整单还款不成为贷款候选，即使备注包含分期；其他借款仍按方向核对', () => {
  const accounts = [{ accountId: 'asset', type: 'wallet' }, { accountId: 'debt', type: 'other_liability', name: '合成借款账户' }]
  const row = { type: 'transfer', sourceAccountId: 'asset', destinationAccountId: 'debt', note: '分期 第3期 本金未知' }
  for (const type of ['cash', 'bank', 'wallet', 'other_asset']) {
    assert.equal(candidate(row, [{ ...accounts[0], type }, { ...accounts[1], type: 'credit' }]), null)
  }
  assert.equal(candidate(row, accounts).type, 'other_liability')
  assert.equal(candidate({ ...row, type: 'expense' }, accounts), null)
  assert.equal(candidate({ ...row, sourceAccountId: 'debt', destinationAccountId: 'asset' }, accounts), null)
  assert.equal(candidate(row, [{ ...accounts[0], type: 'credit' }, accounts[1]]), null)
  assert.equal(candidate(row, [accounts[0], { ...accounts[1], archivedAt: '2026-09-02' }]).inactive, true)
  assert.equal(Object.hasOwn(candidate(row, accounts), 'periodNumber'), false)
})
test('候选过滤拒绝无效月份/账户/页长，允许明确全部月份', () => {
  assert.equal(candidateFilters().month, null)
  assert.equal(candidateFilters({ month: '2026-08' }).range.startDate, '2026-08-01')
  for (const month of [false, 0, '2026-13', [], '2026-08-02']) assert.throws(() => candidateFilters({ month }))
  for (const pageSize of [0, 41, 1.5, '20']) assert.throws(() => candidateFilters({ pageSize }))
  assert.throws(() => candidateFilters({ accountId: 'x'.repeat(65) }))
})
test('原始分期字段仅展示证据：零不丢失，未知不变零，不暴露卡号列，不推算说明', () => {
  const rawFields = [{ name: '期次', value: '3/12' }, { name: '本金（元）', value: '0' },
    { name: '利息', value: '未知' }, { name: '完整卡号', value: 'SYNTHETIC-PRIVATE' }]
  const snapshot = JSON.stringify(rawFields)
  const value = evidenceView({ rawFields, item: '合成商品（分期）', note: '本金请核对，不推测' })
  assert.equal(JSON.stringify(rawFields), snapshot)
  assert.deepEqual(value.fields.map(f => f.value), ['3/12', '0', '未知'])
  assert.equal(JSON.stringify(value).includes('SYNTHETIC-PRIVATE'), false)
  assert.equal(Object.hasOwn(value, 'principalMinor'), false)
  const long = evidenceView({ rawFields: JSON.stringify(Array.from({ length: 10 }, () => ({ name: '本金', value: '合成'.repeat(100) }))), item: '字'.repeat(200) })
  assert.equal(long.fields.length, 8); assert.equal(long.fields[0].value.length, 100); assert.equal(long.description.length, 160); assert.equal(long.truncated, true)
})

test('还款衔接只读查询：真实MySQL权限、候选分页、整组更正、期次与隔离', { skip: !process.env.CATLEDGER_TEST_DB_HOST }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-repayment-link' })
    const api = (a, d) => call(services.api, a, d), imp = (a, d) => call(services.import, a, d)
    const user = await api('bootstrap'), categoryId = user.categories.find(c => c.kind === 'expense').id
    const account = async (type, name) => (await api('accounts.create', { requestId: randomUUID(), type, name, currency: 'CNY',
      openingDisplayBalanceMinor: '10000000', occurredLocalAt: '2026-07-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const asset = await account('wallet', '合成余额'), debt = await account('credit', '合成信用账户'), otherDebt = await account('other_liability', '合成另一负债')
    const createLoan = async (accountId = debt, known = true) => api('loans.create', { requestId: randomUUID(), name: '合成分期资料', kind: 'installment', accountId,
      baselinePrincipalMinor: known ? '1000000' : null, baselineDate: known ? '2026-07-01' : null })
    const transfer = async (amountMinor = '1000', date = '2026-08-02T18:15:15', target = debt, source = asset) => api('transactions.create', {
      requestId: randomUUID(), type: 'transfer', sourceAccountId: source, destinationAccountId: target, amountMinor,
      occurredLocalAt: date, timezoneOffsetMinutes: -480, note: '合成普通信用卡还款，非自动分期' })
    const read = id => api('loans.transaction', { transactionId: id })
    const balances = async () => (await api('accounts.list')).accounts.map(a => [a.accountId, a.bookBalanceMinor])
    const currentLoan = async loanId => (await api('loans.get', { loanId })).loan
    const expense = async month => BigInt((await api('statistics.get', { month })).summary.expenseMinor)
    const debtDelta = (rows, delta) => rows.map(([id, balance]) => [id, id === debt ? String(BigInt(balance) + delta) : balance])
    const share = (loanId, version = 1, principalMinor = '1000', interestMinor = '0') => ({ loanId, version, principalMinor, interestMinor, feeMinor: '0',
      interestTreatment: 'expense', feeTreatment: 'expense', interestCategoryId: interestMinor === '0' ? null : categoryId })
    const payment = async (id, allocations, mode = 'associate') => {
      const selected = await api('loans.source', { transactionIds: [id] }), first = selected.transactions[0]
      return api('loans.record', { requestId: randomUUID(), mode, kind: 'repayment', assetAccountId: asset,
        totalMinor: selected.transactions.reduce((v, r) => String(BigInt(v) + BigInt(r.amountMinor)), '0'),
        occurredLocalAt: first.occurredLocalAt, timezoneOffsetMinutes: first.timezoneOffsetMinutes, confirmed: true, source: selected.source, allocations })
    }
    const original = await transfer(), second = await transfer(), september = await transfer('1000', '2026-09-03T12:00:00', otherDebt)
    const candidateOne = await transfer('1000', '2026-08-02T18:15:15', otherDebt), candidateTwo = await transfer('1000', '2026-08-02T18:15:15', otherDebt)
    await transfer('1000', '2026-10-01T12:00:00') // 最新的信用卡还款也不能占用候选分页
    await transfer('1000', '2026-08-04T12:00:00', asset, debt) // 放款方向不是还款候选
    await t.test('信用卡总额转账无贷款提示；在分页前排除，其他借款同额同秒保持独立', async () => {
      const before = await balances(), beforeExpense = await expense('2026-08')
      const ordinary = await read(original.transactionId)
      assert.equal(ordinary.state, 'none'); assert.equal(ordinary.targetAccount, null); assert.equal(ordinary.payment, null)
      assert.deepEqual(ordinary.allocations, []); assert.deepEqual(ordinary.evidence, { items: [], hasMore: false })
      assert.equal((await read(second.transactionId)).state, 'none')
      const all = await api('loans.unassigned', { pageSize: 40 })
      assert.equal(all.items.length, 3)
      assert.ok(all.items.every(item => item.targetType === 'other_liability'))
      const recent = await api('loans.unassigned', { pageSize: 1 })
      assert.equal(recent.items[0].transactionId, september.transactionId); assert.ok(recent.nextCursor)
      const legacyFilter = await api('loans.unassigned', { accountId: debt, pageSize: 1 })
      assert.deepEqual(legacyFilter.items, []); assert.equal(legacyFilter.nextCursor, null)
      const first = await api('loans.unassigned', { month: '2026-08', accountId: otherDebt, pageSize: 1 })
      const next = await api('loans.unassigned', { month: '2026-08', accountId: otherDebt, pageSize: 1, cursor: first.nextCursor })
      assert.ok(first.nextCursor); assert.equal(next.nextCursor, null)
      assert.deepEqual(new Set([first.items[0].transactionId, next.items[0].transactionId]), new Set([candidateOne.transactionId, candidateTwo.transactionId]))
      await assert.rejects(api('loans.unassigned', { month: '2026-09', accountId: otherDebt, cursor: first.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(api('loans.unassigned', { month: '2026-08', accountId: debt, cursor: first.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
      assert.equal((await api('loans.list')).items.length, 0)
      assert.deepEqual(await balances(), before)
      assert.equal(await expense('2026-08'), beforeExpense)
    })
    const loan = await createLoan(), sibling = await createLoan()
    await t.test('贷款选择按目标账户在服务端过滤并绑定游标，未知本金保持未知', async () => {
      const unknown = await createLoan(otherDebt, false)
      for (let i = 0; i < 21; i++) await createLoan(otherDebt)
      const filtered = await api('loans.list', { accountId: debt, pageSize: 1 })
      assert.equal(filtered.items[0].accountId, debt); assert.ok(filtered.nextCursor)
      const next = await api('loans.list', { accountId: debt, pageSize: 1, cursor: filtered.nextCursor })
      assert.equal(next.items[0].accountId, debt); assert.equal(next.nextCursor, null)
      await assert.rejects(api('loans.list', { accountId: otherDebt, cursor: filtered.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
      assert.equal((await currentLoan(unknown.loanId)).remainingPrincipalMinor, null)
    })
    let linked
    await t.test('已有信用账户贷款关联继续返回整组付款，不再扣款也不进入候选', async () => {
      const before = await balances()
      linked = await payment(original.transactionId, [share(loan.loanId, 1, '700'), share(sibling.loanId, 1, '300')])
      const context = await read(original.transactionId)
      assert.equal(context.state, 'linked'); assert.equal(context.payment.totalMinor, '1000')
      assert.equal(context.allocations.length, 2)
      assert.equal(context.allocations.find(a => a.loanId === loan.loanId).unallocated.principalMinor, '700')
      assert.equal((await api('loans.unassigned', { month: '2026-08', accountId: debt })).items.length, 0)
      assert.deepEqual(await balances(), before)
      await assert.rejects(payment(original.transactionId, [share(loan.loanId, 2)]), { publicCode: 'LOAN_TRANSACTION_LOCKED' })
    })
    await t.test('详情只返回已分配期次并明确截断/未分配；计划与查询不生成付款', async () => {
      const before = await balances(), periods = []
      for (let n = 1; n <= 4; n++) periods.push(await api('loans.savePeriod', { requestId: randomUUID(), loanId: loan.loanId,
        loanVersion: (await currentLoan(loan.loanId)).version, periodNumber: n, dueDate: '2026-08-0' + (n + 2), principalMinor: '100', interestMinor: '0', feeMinor: '0' }))
      await api('loans.allocatePeriods', { requestId: randomUUID(), loanId: loan.loanId, loanVersion: (await currentLoan(loan.loanId)).version,
        paymentId: linked.paymentId, version: 1, confirmed: true, items: periods.map(p => ({ periodId: p.periodId, version: 1, principalMinor: '100', interestMinor: '0', feeMinor: '0' })) })
      const view = await read(original.transactionId), allocated = view.allocations.find(a => a.loanId === loan.loanId)
      assert.equal(allocated.periodCount, 4); assert.equal(allocated.periods.length, 3); assert.equal(allocated.periods[0].periodNumber, 1)
      assert.equal(allocated.unallocated.principalMinor, '300')
      assert.equal(view.allocations.find(a => a.loanId === sibling.loanId).periodCount, 0)
      assert.deepEqual(await balances(), before)
    })
    await t.test('撤销信用账户贷款关联后回到普通转账，不再出现贷款候选', async () => {
      const before = await balances(), p = (await api('loans.payment', { paymentId: linked.paymentId })).payment
      await api('loans.reverse', { requestId: randomUUID(), paymentId: linked.paymentId, version: p.version, confirmed: true,
        loans: await Promise.all([loan, sibling].map(async l => ({ loanId: l.loanId, version: (await currentLoan(l.loanId)).version }))) })
      assert.equal((await read(original.transactionId)).state, 'none')
      assert.equal((await api('loans.unassigned', { month: '2026-08', accountId: debt })).items.length, 0)
      assert.deepEqual(await balances(), before)
    })
    await t.test('整组更正原交易定位活动付款，再次更正不悬空；撤销恢复原账', async () => {
      const before = await balances(), beforeExpense = await expense('2026-08'), l = await createLoan()
      const result = await payment(second.transactionId, [share(l.loanId, 1, '800', '200')], 'correctExisting')
      assert.equal((await read(second.transactionId)).state, 'replaced')
      assert.deepEqual(await balances(), debtDelta(before, -200n), '资金账户不再扣款，原全本金转账中的200分改记利息')
      assert.equal(await expense('2026-08'), beforeExpense + 200n)
      const next = await api('loans.correct', { requestId: randomUUID(), paymentId: result.paymentId, version: 1, loans: result.loans,
        kind: 'repayment', assetAccountId: asset, totalMinor: '1000', occurredLocalAt: '2026-08-02T18:15:15', timezoneOffsetMinutes: -480,
        confirmed: true, allocations: [share(l.loanId, 2, '700', '300')] })
      assert.equal((await read(second.transactionId)).payment.paymentId, next.paymentId)
      assert.deepEqual(await balances(), debtDelta(before, -300n), '再次更正只调整负债与费用，不二次扣资金')
      assert.equal(await expense('2026-08'), beforeExpense + 300n)
      await api('loans.reverse', { requestId: randomUUID(), paymentId: next.paymentId, version: 1, confirmed: true, loans: next.loans })
      assert.equal((await read(second.transactionId)).state, 'none')
      assert.deepEqual(await balances(), before)
      assert.equal(await expense('2026-08'), beforeExpense)
    })
    await t.test('其他借款关联后退出候选，撤销后恢复候选，全程不二次扣款', async () => {
      const l = await createLoan(otherDebt), before = await balances()
      assert.equal((await read(candidateOne.transactionId)).state, 'candidate')
      const result = await payment(candidateOne.transactionId, [share(l.loanId)])
      assert.equal((await read(candidateOne.transactionId)).state, 'linked')
      const candidates = await api('loans.unassigned', { month: '2026-08', accountId: otherDebt })
      assert.deepEqual(candidates.items.map(item => item.transactionId), [candidateTwo.transactionId])
      await api('loans.reverse', { requestId: randomUUID(), paymentId: result.paymentId, version: 1, confirmed: true, loans: result.loans })
      assert.equal((await read(candidateOne.transactionId)).state, 'candidate')
      assert.equal((await api('loans.unassigned', { month: '2026-08', accountId: otherDebt })).items.length, 2)
      assert.deepEqual(await balances(), before)
    })
    await t.test('来源显式字段跨整组更正保留，权限角色能读取而不复制原始卡号列', async () => {
      const lines = syntheticBill(1, 'SYNTHETIC-LINK-EVIDENCE').toString().split('\n')
      lines[1] += ',期次,本金（元）,利息（元）,完整卡号'
      lines[2] += ',2/12,0.80,0.20,SYNTHETIC-PRIVATE'
      const content = Buffer.from(lines.join('\n'))
      const prepared = await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成来源.csv', size: content.length }] })
      const file = prepared.files[0]; services.objects.set(file.cloudPath, content)
      const parsed = await imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
      let update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
      const issues = await imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })
      const decisions = issues.items.filter(i => i.status === 'open').map(i => ({ issueId: i.issueId, issueVersion: i.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: asset } }))
      if (decisions.length) update = await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion, decisions })
      await imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
      const [[ref]] = await lab.owner.execute('SELECT transaction_id AS id FROM catledger_economic_event_transactions WHERE uid=? AND update_id=? AND superseded_at IS NULL', [user.uid, update.updateId])
      const source = await api('loans.source', { transactionIds: [ref.id] })
      assert.equal(source.evidence.items[0].fields[0].value, '2/12')
      assert.equal(JSON.stringify(source.evidence).includes('SYNTHETIC-PRIVATE'), false)
      const l = await createLoan(), before = await balances(), beforeExpense = await expense('2026-09')
      const result = await payment(ref.id, [share(l.loanId, 1, '80', '20')], 'correctExisting')
      const context = await read(ref.id)
      assert.equal(context.payment.paymentId, result.paymentId); assert.equal(context.evidence.items[0].fields[1].value, '0.80')
      assert.equal(context.allocations[0].periodCount, 0, '来源2/12不能自动写成已对账期次')
      assert.deepEqual(await balances(), debtDelta(before, 80n), '原100分支出更正为80分清偿与20分利息，资金不再扣款')
      assert.equal(await expense('2026-09'), beforeExpense - 80n)
    })
    await t.test('跨用户/非法标识拒绝、普通支出不误判，账户停用仍可看到候选但不可继续', async () => {
      const stranger = localServices({ apiPool, importPool, subject: 'synthetic-link-other' }); await call(stranger.api, 'bootstrap')
      await assert.rejects(call(stranger.api, 'loans.transaction', { transactionId: original.transactionId }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(call(stranger.api, 'loans.unassigned', { accountId: debt }), { publicCode: 'NOT_FOUND' })
      assert.equal((await call(stranger.api, 'loans.unassigned')).items.length, 0)
      const expense = await api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: asset, categoryId, amountMinor: '100', occurredLocalAt: '2026-08-02T12:00:00', timezoneOffsetMinutes: -480 })
      assert.equal((await read(expense.transactionId)).state, 'none')
      await api('accounts.archive', { requestId: randomUUID(), accountId: otherDebt, version: 1 })
      assert.equal((await read(september.transactionId)).targetAccount.inactive, true)
      assert.equal((await api('loans.unassigned', { accountId: otherDebt })).items[0].inactive, true)
    })
  } finally { await lab.close() }
})
