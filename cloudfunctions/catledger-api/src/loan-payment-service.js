const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { parseVersion, transactionToPublic } = require('./transaction-domain')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { lockAccounts, validateCategory, insertManualTransaction, selectTransaction, protectRefundedExpense } = require('./transaction-command-service')
const { decodeCursor, encodeCursor } = require('./cursor')
const { paymentInput, paymentDrafts } = require('./loan-payment-domain')
const { assertPrincipalTimeline, lockLoanVersions, advanceLoans, PAYMENT_SELECT, publicPayment, selectPayment, selectAllocations } = require('./loan-payment-repository')
async function paymentLinks(connection, uid, paymentId) {
  const [rows] = await connection.execute(`SELECT transaction_id AS transactionId,transaction_version AS transactionVersion,
    created_by_payment AS createdByPayment,active FROM catledger_loan_payment_transactions WHERE uid=? AND payment_id=? ORDER BY transaction_id LIMIT 61`, [uid,paymentId])
  if (rows.length > 60) throw ledgerError('CONFLICT')
  return rows
}
function createLoanPaymentService({ getPool, selectLoan }) {
  const write = (context, action, operation) => executeIdempotentMutation({ getPool, ...context, currentReads: true, action, operation })
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  async function record(context) {
    return write(context, 'loans.record', async (connection, uid, data) => {
      const input = paymentInput(data), loans = await lockLoanVersions(connection, uid, input.allocations, selectLoan)
      const accounts = await lockAccounts(connection, uid, [input.assetAccountId,...[...loans.values()].map(l => l.accountId)])
      if (!['cash','bank','wallet','other_asset'].includes(accounts.get(input.assetAccountId).type)) throw ledgerError('VALIDATION_ERROR')
      for (const loan of loans.values()) {
        if (!['credit','other_liability'].includes(accounts.get(loan.accountId).type)) throw ledgerError('VALIDATION_ERROR')
        if (loan.baselinePrincipalMinor == null) throw ledgerError('LOAN_PRINCIPAL_UNCONFIRMED')
        if (input.localDate < loan.baselineDate) throw ledgerError('VALIDATION_ERROR')
      }
      const drafts = paymentDrafts(input, loans)
      for (const id of new Set(drafts.map(d => d.categoryId).filter(Boolean))) await validateCategory(connection, uid, id, 'expense')
      await assertCashBalanceChanges(connection, uid, accounts, drafts.map(transaction => ({ transaction })))
      const paymentId = randomUUID()
      await connection.execute(`INSERT INTO catledger_loan_payments
        (uid,payment_id,kind,origin_mode,asset_account_id,total_minor,occurred_local_at,occurred_at_utc,timezone_offset_minutes)
        VALUES (?,?,?,?,?,?,?,?,?)`, [uid,paymentId,input.kind,input.mode,input.assetAccountId,input.totalMinor,input.localAt,input.occurredAtUtc,input.timezoneOffsetMinutes])
      for (const a of input.allocations) await connection.execute(`INSERT INTO catledger_loan_payment_allocations
        (uid,payment_id,loan_id,principal_minor,interest_minor,fee_minor,interest_treatment,fee_treatment,interest_category_id,fee_category_id,confirmed_loan_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [uid,paymentId,a.loanId,a.principalMinor,a.interestMinor,a.feeMinor,a.interestTreatment,a.feeTreatment,a.interestCategoryId,a.feeCategoryId,a.version])
      await assertPrincipalTimeline(connection, uid, loans)
      for (const draft of drafts) {
        const transactionId = randomUUID()
        await insertManualTransaction(connection, uid, transactionId, draft)
        await connection.execute(`INSERT INTO catledger_loan_payment_transactions
          (uid,payment_id,transaction_id,transaction_version,created_by_payment) VALUES (?,?,?,1,1)`, [uid,paymentId,transactionId])
      }
      return { paymentId, version: 1, transactionCount: drafts.length, loans: await advanceLoans(connection, uid, loans) }
    })
  }
  async function payment(context) {
    return read(context, async (connection, uid) => {
      const value = await selectPayment(connection, uid, context.data.paymentId)
      const links = await paymentLinks(connection, uid, value.paymentId), transactions = []
      for (const link of links) transactions.push(transactionToPublic(await selectTransaction(connection, uid, link.transactionId)))
      return { payment: value, allocations: await selectAllocations(connection, uid, value.paymentId), transactions }
    })
  }
  async function payments(context) {
    return read(context, async (connection, uid) => {
      const data = context.data, loan = await selectLoan(connection, uid, data.loanId), pageSize = data.pageSize == null ? 20 : data.pageSize
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 40) throw ledgerError('VALIDATION_ERROR')
      let cursor = null
      if (data.cursor) {
        cursor = decodeCursor(context.subjectHash, data.cursor)
        if (cursor.action !== 'loans.payments' || cursor.uid !== uid || cursor.loanId !== loan.loanId || typeof cursor.at !== 'string' || typeof cursor.id !== 'string') throw ledgerError('VALIDATION_ERROR')
      }
      const [rows] = await connection.execute(PAYMENT_SELECT + ` WHERE uid=? AND payment_id IN
        (SELECT payment_id FROM catledger_loan_payment_allocations WHERE uid=? AND loan_id=?)
        ${cursor ? 'AND (occurred_local_at < ? OR (occurred_local_at=? AND payment_id < ?))' : ''}
        ORDER BY occurred_local_at DESC,payment_id DESC LIMIT ?`, [uid,uid,loan.loanId,...(cursor ? [cursor.at,cursor.at,cursor.id] : []),pageSize+1])
      const items = rows.slice(0,pageSize), last = items.at(-1)
      return { items: items.map(publicPayment), nextCursor: rows.length > pageSize ? encodeCursor(context.subjectHash,
        { action: 'loans.payments', uid, loanId: loan.loanId, at: last.occurredLocalAt, id: last.paymentId }) : null }
    })
  }
  async function reverse(context) {
    return write(context, 'loans.reverse', async (connection, uid, data) => {
      if (data.confirmed !== true) throw ledgerError('VALIDATION_ERROR')
      const current = await selectPayment(connection, uid, data.paymentId, true)
      if (current.status !== 'active' || current.version !== parseVersion(data.version)) throw ledgerError('CONFLICT')
      const allocations = await selectAllocations(connection, uid, current.paymentId)
      const loans = await lockLoanVersions(connection, uid, data.loans, selectLoan)
      if (allocations.length !== loans.size || allocations.some(a => !loans.has(a.loanId))) throw ledgerError('VALIDATION_ERROR')
      const links = await paymentLinks(connection, uid, current.paymentId), transactions = []
      for (const link of links) {
        const transaction = await selectTransaction(connection, uid, link.transactionId, { forUpdate: true })
        if (!link.active || transaction.deletedAt || Number(transaction.version) !== Number(link.transactionVersion)) throw ledgerError('CONFLICT')
        await protectRefundedExpense(connection, uid, transaction, null)
        if (link.createdByPayment) {
          const [[external]] = await connection.execute(`SELECT link_id FROM catledger_economic_event_transactions
            WHERE uid=? AND transaction_id=? AND superseded_at IS NULL LIMIT 1`, [uid,transaction.transactionId])
          if (external) throw ledgerError('LOAN_TRANSACTION_LOCKED')
          transactions.push(transaction)
        }
      }
      const accounts = await lockAccounts(connection, uid, transactions.flatMap(t => [t.sourceAccountId,t.destinationAccountId]))
      await assertCashBalanceChanges(connection, uid, accounts, transactions.map(transaction => ({ transaction, multiplier: -1n })))
      await connection.execute("UPDATE catledger_loan_payments SET status='reversed',version=version+1 WHERE uid=? AND payment_id=?", [uid,current.paymentId])
      await assertPrincipalTimeline(connection, uid, loans)
      for (const transaction of transactions) await connection.execute(`UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1
        WHERE uid=? AND transaction_id=?`, [uid,transaction.transactionId])
      await connection.execute('UPDATE catledger_loan_payment_transactions SET active=0 WHERE uid=? AND payment_id=?', [uid,current.paymentId])
      return { paymentId: current.paymentId, version: current.version + 1, reversed: true, loans: await advanceLoans(connection, uid, loans) }
    })
  }
  return { record, reverse, payment, payments }
}
module.exports = { createLoanPaymentService, paymentLinks }
