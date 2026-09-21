const { importError } = require('./errors')
const { eventAllocation, allocationTransactionDrafts } = require('./funds-allocation')
const booking = require('./repayment-booking').createRepaymentBooking(importError)
function inputForEvent(event) {
  const decision = event.fieldSources && event.fieldSources.loanRepayment
  if (!decision) return null
  const input = booking.normalize(decision, event.amountMinor)
  if (!['repayment','internal_transfer'].includes(event.economicNature) || event.flowDirection !== 'neutral' || event.currency !== 'CNY') throw importError('UNRESOLVED_IMPORT')
  const plan = eventAllocation(event)
  if (!plan.valid) throw importError('UNRESOLVED_IMPORT')
  const sources = plan.kind !== 'none' ? allocationTransactionDrafts(event, plan) : [{ type:'transfer',
    sourceAccountId:event.sourceDirection === 'income' ? event.counterpartyLedgerAccountId : event.ledgerAccountId,
    destinationAccountId:event.sourceDirection === 'income' ? event.ledgerAccountId : event.counterpartyLedgerAccountId }]
  if (sources.length !== 1 || sources[0].type !== 'transfer' || sources[0].sourceAccountId !== input.assetAccountId ||
    sources[0].destinationAccountId !== input.liabilityAccountId) throw importError('UNRESOLVED_IMPORT')
  return input
}
module.exports = { booking,inputForEvent }
