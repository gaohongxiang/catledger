const { writePayment } = require('./loan-payment-write')
const { loadSource, sourceSelection } = require('./loan-source')
const { paymentLinks, inspectPayment, reversePayment } = require('./loan-payment-maintenance')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { transactionToPublic } = require('./transaction-domain')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { lockAccounts, selectTransaction } = require('./transaction-command-service')
const { decodeCursor, encodeCursor } = require('./cursor')
const { assertPrincipalTimeline, lockLoanVersions, advanceLoans, PAYMENT_SELECT, publicPayment, selectPayment, selectAllocations } = require('./loan-payment-repository')
function createLoanPaymentService({ getPool, selectLoan }) {
  const write = (context, action, operation) => executeIdempotentMutation({ getPool, ...context, currentReads: true, action, operation })
  const read = (context, operation) => executeLedgerRead({ getPool, ...context, consistentSnapshot: true, operation })
  async function record(context) {
    return write(context, 'loans.record', (connection, uid, data) => writePayment(connection, uid, data, context.subjectHash, selectLoan))
  }
  async function correct(context) {
    return write(context, 'loans.correct', (connection, uid, data) => writePayment(connection, uid, data, context.subjectHash, selectLoan, { correct: true }))
  }
  async function source(context) {
    return read(context, async (connection, uid) => {
      const selected = await loadSource(connection, uid, context.data.transactionIds)
      return { source: sourceSelection(uid, context.subjectHash, selected), transactions: selected.transactions.map(transactionToPublic) }
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
      const inspection = await inspectPayment(connection, uid, data.paymentId, data.version), current = inspection.payment
      const loans = await lockLoanVersions(connection, uid, data.loans, selectLoan)
      if (inspection.allocations.length !== loans.size || inspection.allocations.some(a => !loans.has(a.loanId))) throw ledgerError('VALIDATION_ERROR')
      const changes = inspection.transactions.filter(t => t.createdByPayment).map(transaction => ({ transaction, multiplier: -1n }))
        .concat(inspection.originals.map(transaction => ({ transaction })))
      const accounts = await lockAccounts(connection, uid, changes.flatMap(c => [c.transaction.sourceAccountId, c.transaction.destinationAccountId]))
      await assertCashBalanceChanges(connection, uid, accounts, changes)
      await reversePayment(connection, uid, inspection)
      await assertPrincipalTimeline(connection, uid, loans)
      return { paymentId: current.paymentId, version: current.version + 1, reversed: true, loans: await advanceLoans(connection, uid, loans) }
    })
  }
  return { record, correct, source, reverse, payment, payments }
}
module.exports = { createLoanPaymentService, paymentLinks }
