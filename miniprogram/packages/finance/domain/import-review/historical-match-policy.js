const { digestParts } = require('./portable-digest')
const REASON = 'historical_duplicate_candidate'
const VERSION = 'historical-review-v1'
const time = value => Date.parse(String(value || '').replace(' ', 'T').slice(0,19) + 'Z')
function matches(event, transaction) {
  if (!['ready','needs_action'].includes(event.status) || !event.ledgerAccountId || event.currency !== 'CNY' ||
    transaction.deletedAt || transaction.type === 'balance_adjustment' || String(event.amountMinor) !== String(transaction.amountMinor)) return false
  if (Math.abs(time(event.utcAt)-time(transaction.utcAt)) > 48*3600000 ||
    !Number.isFinite(time(event.utcAt)) || !Number.isFinite(time(transaction.utcAt))) return false
  const eventDate=String(event.localDate || event.localAt || '').slice(0,10),date=String(transaction.localDate || transaction.localAt || '').slice(0,10)
  if (Math.abs(Date.parse(eventDate+'T00:00:00Z')-Date.parse(date+'T00:00:00Z')) > 3*86400000) return false
  return event.flowDirection === 'outflow' ? transaction.sourceAccountId === event.ledgerAccountId
    : event.flowDirection === 'inflow' ? transaction.destinationAccountId === event.ledgerAccountId
      : event.flowDirection === 'neutral' && transaction.sourceAccountId === event.ledgerAccountId && transaction.destinationAccountId === event.counterpartyLedgerAccountId
}
function groupKey(group) {
  return digestParts(VERSION,group.eventId,group.accountId,group.otherAccountId||'',group.flowDirection,String(group.amountMinor),group.utcAt,
    ...group.candidates.map(row=>`${row.transactionId}:${row.version}`))
}
module.exports={REASON,VERSION,matches,groupKey}
