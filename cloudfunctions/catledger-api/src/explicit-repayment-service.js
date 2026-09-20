const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { buildManualTransaction, parseVersion } = require('./transaction-domain')
const { lockAccounts, insertManualTransaction } = require('./transaction-command-service')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { selectPayment } = require('./loan-payment-repository')
const { inspectPayment, deactivatePayment } = require('./loan-payment-maintenance')
const booking = require('./repayment-booking').createRepaymentBooking(ledgerError)
function createExplicitRepaymentService({ getPool }) {
  const write = (context, action, operation) => executeIdempotentMutation({ getPool,...context,currentReads:true,action,operation })
  async function bookRepayment(context) {
    return write(context, 'loans.bookRepayment', async (connection, uid, data) => {
      const input = booking.normalize(data.repayment, data.totalMinor)
      const drafts = booking.drafts(input).map(d => buildManualTransaction({ ...d,occurredLocalAt:data.occurredLocalAt,
        timezoneOffsetMinutes:data.timezoneOffsetMinutes,note:data.note || '借款还款' }))
      const accounts = await lockAccounts(connection, uid, [input.assetAccountId,input.liabilityAccountId])
      await booking.validateRelations(connection, uid, input)
      await assertCashBalanceChanges(connection, uid, accounts, drafts.map(transaction => ({ transaction })))
      const transactions = []
      for (const draft of drafts) {
        const transactionId = randomUUID()
        await insertManualTransaction(connection, uid, transactionId, draft)
        transactions.push({ transactionId,version:1 })
      }
      return booking.persist(connection, uid, input, { totalMinor:data.totalMinor,localAt:drafts[0].localAt,
        utcAt:drafts[0].occurredAtUtc,timezoneOffsetMinutes:drafts[0].timezoneOffsetMinutes,transactions })
    })
  }
  async function pendingPayment(connection, uid, data) {
    const payment = await selectPayment(connection, uid, data.paymentId, true)
    if (payment.version !== parseVersion(data.version) || payment.status !== 'active' || data.confirmed !== true) throw ledgerError('CONFLICT')
    const detail = await booking.detail(connection, uid, payment.paymentId)
    const inspection = await inspectPayment(connection, uid, payment.paymentId, data.version)
    if (!detail || inspection.allocations.length) throw ledgerError('CONFLICT')
    return { payment,detail }
  }
  async function assignRepayment(context) {
    return write(context, 'loans.assignRepayment', async (connection, uid, data) => {
      const { payment,detail } = await pendingPayment(connection, uid, data)
      const input = booking.normalize({ ...detail,confirmed:true,mode:'associate',assetAccountId:payment.assetAccountId,
        loanId:data.loanId,loanVersion:data.loanVersion }, payment.totalMinor)
      const loan = await booking.assign(connection, uid, payment, input)
      return { paymentId:payment.paymentId,version:payment.version + 1,pending:false,loans:[loan] }
    })
  }
  async function releaseRepayment(context) {
    return write(context, 'loans.releaseRepayment', async (connection, uid, data) => {
      const { payment } = await pendingPayment(connection, uid, data)
      await deactivatePayment(connection, uid, payment.paymentId)
      return { paymentId:payment.paymentId,version:payment.version + 1,released:true }
    })
  }
  return { bookRepayment,assignRepayment,releaseRepayment }
}
module.exports = { createExplicitRepaymentService }
