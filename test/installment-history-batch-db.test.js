const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { chargeLab } = require('./helpers/loan-charges')

test('新增历史费用批量执行与既有计划逐项执行保持相同记账、审计和撤回事实',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async () => {
    const h = await chargeLab()
    try {
      const bulk = await h.create({ feePerTermMinor: '1000' })
      const planned = await h.create({ feePerTermMinor: '1000' })
      const [categories] = await h.owner.execute('SELECT category_id AS id,system_key AS systemKey FROM catledger_categories WHERE uid=?', [h.uid])
      await h.configure(planned, {
        firstChargeDate: '2026-01-31',
        interestCategoryId: categories.find(c => c.systemKey === 'finance__interest').id,
        feeCategoryId: categories.find(c => c.systemKey === 'finance__service').id
      })
      const before = (await h.api('accounts.list')).accounts
      const repayments = [{ periodNumber: 1, paid: true }, { periodNumber: 2, paid: false }, { periodNumber: 3, paid: true }, { periodNumber: 6, paid: true }]
      async function confirm(loan, selections) {
        const { loan: current } = await h.api('loans.get', { loanId: loan.loanId })
        const input = { requestId: randomUUID(), loanId: loan.loanId, version: current.version, repayments: selections }
        const saved = await h.api('loans.confirmInstallments', input)
        assert.deepEqual(await h.api('loans.confirmInstallments', input), saved)
      }
      async function facts(loan) {
        const state = await h.state(loan)
        const [rows] = await h.owner.execute(`SELECT f.charge_key AS chargeKey,f.amount_minor AS amountMinor,f.charge_date AS chargeDate,
          f.category_id AS categoryId,f.state,f.basis,f.version,f.historical_settled_minor AS historicalSettledMinor,
          t.type,t.source_account_id AS accountId,t.amount_minor AS expenseMinor,t.occurred_local_at AS occurredLocalAt,t.origin,t.note,t.deleted_at AS expenseDeletedAt,
          b.type AS adjustmentType,b.destination_account_id AS adjustmentAccountId,b.amount_minor AS adjustmentMinor,b.deleted_at AS adjustmentDeletedAt
          FROM catledger_loan_charges f JOIN catledger_loan_charge_contracts c ON c.uid=f.uid AND c.contract_id=f.contract_id
          LEFT JOIN catledger_transactions t ON t.uid=f.uid AND t.transaction_id=f.transaction_id
          LEFT JOIN catledger_transactions b ON b.uid=f.uid AND b.transaction_id=f.balance_adjustment_id
          WHERE f.uid=? AND c.loan_id=? AND f.state='recorded' ORDER BY f.charge_key`, [h.uid, loan.loanId])
        const [audit] = await h.owner.execute(`SELECT a.action,a.snapshot_json AS snapshot FROM catledger_loan_charge_audit a
          JOIN catledger_loan_charge_contracts c ON c.uid=a.uid AND c.contract_id=a.contract_id
          WHERE a.uid=? AND c.loan_id=? AND a.action IN ('confirm_historical_paid','confirm_settlement')`, [h.uid, loan.loanId])
        const snapshots = audit.map(row => {
          const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot
          if (snapshot.transactionId) snapshot.transactionId = '<expense>'
          if (snapshot.balanceAdjustmentId) snapshot.balanceAdjustmentId = '<adjustment>'
          return JSON.stringify({ action: row.action, snapshot })
        }).sort()
        return { rows, snapshots, authorization: state.contract.authorization }
      }
      await confirm(bulk, repayments)
      await confirm(planned, repayments)
      assert.deepEqual((await h.api('accounts.list')).accounts, before)
      const added = await facts(bulk), existing = await facts(planned)
      assert.equal(added.rows.length, 6)
      assert.deepEqual(added.rows, existing.rows)
      assert.deepEqual(added.snapshots, existing.snapshots)
      assert.equal(added.snapshots.length, 12)
      assert.ok(added.rows.every(row => Number(row.version) === 3 && String(row.historicalSettledMinor) === String(row.amountMinor)))
      assert.equal(added.authorization.mode, 'paused')
      assert.equal(existing.authorization.mode, 'paused')
      for (const loan of [bulk, planned]) assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '450000')
      for (const loan of [bulk, planned]) await confirm(loan, [{ periodNumber: 3, paid: false }])
      assert.deepEqual((await facts(bulk)).rows, (await facts(planned)).rows)
      assert.equal((await facts(bulk)).rows.length, 4)
      assert.deepEqual((await h.api('accounts.list')).accounts, before)
      for (const loan of [bulk, planned]) assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '500000')
      const [removed] = await h.owner.execute(`SELECT type,COUNT(*) AS count FROM catledger_transactions
        WHERE uid=? AND deleted_at IS NOT NULL AND creation_provenance_json->>'$.loanIds[0]' IN (?,?) GROUP BY type`, [h.uid, bulk.loanId, planned.loanId])
      assert.deepEqual(Object.fromEntries(removed.map(row => [row.type, Number(row.count)])), { balance_adjustment: 4, expense: 4 })
    } finally { await h.close() }
  })

test('600期同时补息费仍在同一原子保存内有界写入1200组费用',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
    const h = await chargeLab()
    try {
      const loan = await h.create({ scheduleTerms: 600, baselinePrincipalMinor: '0', feePerTermMinor: '1000',
        installmentSetup: { ...h.plan.installmentSetup, originalPrincipalMinor: '30000000', historicalPaidTerms: 600 } })
      const before = (await h.api('accounts.list')).accounts
      const input = { requestId: randomUUID(), loanId: loan.loanId, version: 1,
        repayments: Array.from({ length: 600 }, (_, index) => ({ periodNumber: index + 1, paid: true })) }
      const start = h.metrics()
      const result = await h.api('loans.confirmInstallments', input)
      const sql = h.metrics().sql - start.sql
      t.diagnostic(JSON.stringify({ name: 'save-600-interest-and-fee', sql, charges: 1200 }))
      assert.ok(sql <= 100, '息费双项的600期保存也必须有界批量写入')
      assert.deepEqual(await h.api('loans.confirmInstallments', input), result)
      assert.deepEqual((await h.api('accounts.list')).accounts, before)
      const state = await h.state(loan)
      assert.equal(state.totalCharges, 1200)
      assert.equal(state.recordedMinor, '1800000')
      const [[rows]] = await h.owner.execute(`SELECT COUNT(*) AS count,SUM(f.historical_settled_minor) AS settled
        FROM catledger_loan_charges f JOIN catledger_loan_charge_contracts c ON c.uid=f.uid AND c.contract_id=f.contract_id
        WHERE f.uid=? AND c.loan_id=? AND f.state='recorded' AND f.version=3 AND f.balance_adjustment_id IS NOT NULL`, [h.uid, loan.loanId])
      assert.equal(Number(rows.count), 1200)
      assert.equal(String(rows.settled), '1800000')
    } finally { await h.close() }
  })
