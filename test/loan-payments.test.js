const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const hasDatabase = Boolean(process.env.CATLEDGER_TEST_DB_HOST)

test('实际借还复用总账：守恒、防重、版本、整组撤销与关联保护', { skip: !hasDatabase }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-loan-payments' })
    const api = (action, data) => call(services.api, action, data)
    const identity = await api('bootstrap'), categoryId = identity.categories.find(c => c.kind === 'expense').id
    async function account(type, balance, name) {
      return (await api('accounts.create', { requestId: randomUUID(), type, name, currency: 'CNY', openingDisplayBalanceMinor: balance,
        occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    }
    const assetAccountId = await account('bank', '1000000', '合成付款账户'), debt = await account('other_liability', '160000', '合成贷款账户')
    const metadata = { name: '合成贷款', kind: 'borrowing', accountId: debt, baselinePrincipalMinor: '80000', baselineDate: '2026-09-01' }
    const loan = await api('loans.create', { ...metadata, requestId: randomUUID() })
    const second = await api('loans.create', { ...metadata, name: '同账户合成贷款', requestId: randomUUID() })
    const allocation = (loanId = loan.loanId, version = 1, principalMinor = '80000', interestMinor = '18000', feeMinor = '2000') => ({
      loanId, version, principalMinor, interestMinor, feeMinor, interestTreatment: 'expense', feeTreatment: 'expense', interestCategoryId: categoryId, feeCategoryId: categoryId
    })
    const request = (allocations = [allocation()]) => ({ requestId: randomUUID(), mode: 'new', kind: 'repayment', assetAccountId,
      occurredLocalAt: '2026-09-02T10:00:00', timezoneOffsetMinutes: -480, totalMinor: '100000', confirmed: true, allocations })
    async function totals() {
      const [[row]] = await lab.owner.execute(`SELECT COALESCE(SUM(IF(source_account_id=?, -CAST(amount_minor AS SIGNED),0)+IF(destination_account_id=?,amount_minor,0)),0) AS asset,
        COALESCE(SUM(IF(type='expense',amount_minor,0)),0) AS expense FROM catledger_transactions WHERE uid=? AND deleted_at IS NULL`, [assetAccountId,assetAccountId,identity.uid])
      return { asset: String(row.asset), expense: String(row.expense) }
    }
    let payment
    await t.test('100000=80000+18000+2000；同键重放和只读核实不重复扣款，结清只影响明确分配的贷款', async () => {
      const payload = request(), before = await totals()
      payment = await api('loans.record', payload)
      assert.deepEqual(await api('loans.record', payload), payment)
      assert.deepEqual((await api('transactions.commandResult', { requestId: payload.requestId, commandAction: 'loans.record' })).result, payment)
      assert.deepEqual(await totals(), { asset: String(BigInt(before.asset) - 100000n), expense: '20000' })
      assert.equal((await api('loans.get', { loanId: loan.loanId })).loan.status, 'settled')
      assert.equal((await api('loans.get', { loanId: second.loanId })).loan.remainingPrincipalMinor, '80000')
      const view = await api('loans.payment', { paymentId: payment.paymentId })
      assert.equal(view.transactions.length, 3)
      assert.equal(view.allocations[0].version, 2)
      assert.ok(Buffer.byteLength(JSON.stringify(view)) < 32768)
    })
    await t.test('普通编辑、删除、分类与退款不能绕开贷款整组；活动记录锁定本金基准', async () => {
      const view = await api('loans.payment', { paymentId: payment.paymentId }), expense = view.transactions.find(x => x.type === 'expense')
      for (const [action, data] of [
        ['transactions.delete', { transactionId: expense.transactionId, version: expense.version }],
        ['categories.assignTransactions', { categoryId, items: [{ transactionId: expense.transactionId, version: expense.version }] }],
        ['transactions.setCategory', { transactionId: expense.transactionId, version: expense.version, categoryId: null }],
        ['transactions.update', { transactionId: expense.transactionId, version: expense.version, type: 'expense', amountMinor: '100', sourceAccountId: assetAccountId, categoryId,
          occurredLocalAt: '2026-09-02T10:00:00', timezoneOffsetMinutes: -480 }],
        ['transactions.create', { type: 'refund', originalTransactionId: expense.transactionId, amountMinor: '1', destinationAccountId: assetAccountId,
          occurredLocalAt: '2026-09-03T10:00:00', timezoneOffsetMinutes: -480 }]
      ]) await assert.rejects(api(action, { requestId: randomUUID(), ...data }), { publicCode: 'LOAN_TRANSACTION_LOCKED' })
      await assert.rejects(api('loans.update', { ...metadata, requestId: randomUUID(), loanId: loan.loanId, version: 2, baselinePrincipalMinor: '90000' }), { publicCode: 'LOAN_BASELINE_LOCKED' })
    })
    await t.test('整组撤销恢复余额、本金及结清状态；相同撤销重放只执行一次', async () => {
      const payload = { requestId: randomUUID(), paymentId: payment.paymentId, version: 1, loans: [{ loanId: loan.loanId, version: 2 }], confirmed: true }
      const result = await api('loans.reverse', payload)
      assert.deepEqual(await api('loans.reverse', payload), result)
      assert.deepEqual(await totals(), { asset: '1000000', expense: '0' })
      assert.equal((await api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '80000')
      assert.equal((await api('loans.payment', { paymentId: payment.paymentId })).payment.status, 'reversed')
    })
    await t.test('已计费用只清偿负债；多贷款分配和竞争提交保持整数守恒', async () => {
      const payload = request([allocation(loan.loanId, 3, '40000', '18000', '2000'), allocation(second.loanId, 1, '40000', '0', '0')])
      payload.allocations[0].interestTreatment = 'accrued'; payload.allocations[0].feeTreatment = 'accrued'
      payload.allocations[0].interestCategoryId = null; payload.allocations[0].feeCategoryId = null
      const results = await Promise.allSettled([api('loans.record', payload), api('loans.record', { ...payload, requestId: randomUUID() })])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.find(r => r.status === 'rejected').reason.publicCode, 'CONFLICT')
      assert.deepEqual(await totals(), { asset: '900000', expense: '0' })
      for (const row of [loan, second]) assert.equal((await api('loans.get', { loanId: row.loanId })).loan.remainingPrincipalMinor, '40000')
    })
    await t.test('未知、超分配、重复贷款、跨用户和负本金均拒绝且整批回滚', async () => {
      const unknown = await api('loans.create', { ...metadata, requestId: randomUUID(), baselinePrincipalMinor: null, baselineDate: null })
      for (const payload of [request([allocation(unknown.loanId)]), request([allocation(loan.loanId, 4)]),
        { ...request([allocation(loan.loanId, 4)]), confirmed: false },
        request([allocation(loan.loanId, 4), allocation(loan.loanId, 4)]),
        request([{ ...allocation(loan.loanId, 4), principalMinor: null }])]) {
        await assert.rejects(api('loans.record', payload), error => ['VALIDATION_ERROR','LOAN_PRINCIPAL_UNCONFIRMED','LOAN_PRINCIPAL_EXCEEDED'].includes(error.publicCode))
      }
      const other = localServices({ apiPool, importPool, subject: 'synthetic-loan-payment-other' }); await call(other.api, 'bootstrap')
      await assert.rejects(call(other.api, 'loans.payment', { paymentId: payment.paymentId }), { publicCode: 'NOT_FOUND' })
      await assert.rejects(call(other.api, 'loans.record', request([allocation(loan.loanId, 4)])), { publicCode: 'NOT_FOUND' })
      assert.deepEqual(await totals(), { asset: '900000', expense: '0' })
    })
    await t.test('第二笔正式交易失败和现金不足均不留下部分付款，分页不串贷款', async () => {
      let inserts = 0
      const faultPool = { async getConnection() {
        const connection = await apiPool.getConnection()
        return new Proxy(connection, { get(target, key) {
          if (key === 'execute') return async (sql, values) => {
            if (/INSERT INTO catledger_transactions/.test(sql) && ++inserts === 2) throw new Error('synthetic loan second transaction failure')
            return target.execute(sql, values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      const faulty = localServices({ apiPool: faultPool, importPool, subject: 'synthetic-loan-payments' })
      const payload = { ...request([allocation(loan.loanId, 4, '8000', '1800', '200')]), totalMinor: '10000' }
      await assert.rejects(call(faulty.api, 'loans.record', payload), { publicCode: 'INTERNAL_ERROR' })
      assert.equal(inserts, 2)
      assert.equal((await api('loans.get', { loanId: loan.loanId })).loan.version, 4)
      assert.deepEqual(await totals(), { asset: '900000', expense: '0' })
      await assert.rejects(api('transactions.commandResult', { requestId: payload.requestId, commandAction: 'loans.record' }), { publicCode: 'OPERATION_UNCONFIRMED' })
      const cash = await account('cash', '9999', '合成现金不足')
      await assert.rejects(api('loans.record', { ...payload, requestId: randomUUID(), assetAccountId: cash }), { publicCode: 'INSUFFICIENT_CASH_BALANCE' })
      assert.equal((await api('loans.get', { loanId: loan.loanId })).loan.version, 4)
      const firstPage = await api('loans.payments', { loanId: loan.loanId, pageSize: 1 })
      assert.equal(firstPage.items.length, 1); assert.ok(firstPage.nextCursor)
      const next = await api('loans.payments', { loanId: loan.loanId, pageSize: 1, cursor: firstPage.nextCursor })
      assert.notEqual(next.items[0].paymentId, firstPage.items[0].paymentId)
      await assert.rejects(api('loans.payments', { loanId: second.loanId, cursor: firstPage.nextCursor }), { publicCode: 'VALIDATION_ERROR' })
    })
    await t.test('新放款增加资产和本金而非收入；不能撤销已被后续还款消耗的本金', async () => {
      const zero = await api('loans.create', { ...metadata, requestId: randomUUID(), baselinePrincipalMinor: '0' })
      const draw = await api('loans.record', { ...request([allocation(zero.loanId, 1, '100000', '0', '0')]), kind: 'drawdown' })
      assert.equal((await api('loans.get', { loanId: zero.loanId })).loan.remainingPrincipalMinor, '100000')
      await api('loans.record', { ...request([allocation(zero.loanId, 2, '100000', '0', '0')]), occurredLocalAt: '2026-09-03T10:00:00' })
      await assert.rejects(api('loans.reverse', { requestId: randomUUID(), paymentId: draw.paymentId, version: 1, loans: [{ loanId: zero.loanId, version: 3 }], confirmed: true }), { publicCode: 'LOAN_PRINCIPAL_EXCEEDED' })
      assert.deepEqual(await totals(), { asset: '900000', expense: '0' })
    })
  } finally { await lab.close() }
})
