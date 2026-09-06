const { digestRequest } = require('./digest')
const { queryCashBalances } = require('./import-cash-guard')
const { accountImpacts, cashDeficits, MAINTENANCE_POLICY_VERSION } = require('./maintenance-policy')
const { isAggregateRepayment } = require('./repayment-allocation')

function correctionImpactResult(event, transactions) {
  const owned = transactions.filter((row) => row.role !== 'refund_original')
  const unchanged = owned.length > 0 && owned.every((row) => row.creationMethod === 'created' && row.deletedAt == null &&
    (row.origin == null || row.origin === 'import') && Number(row.version) === Number(row.linkedVersion))
  const supported = (owned.length === 1 && !(event.fieldSources && event.fieldSources.paymentResolution)) || isAggregateRepayment(event)
  const conflicts = []
  if (!['posted', 'corrected'].includes(event.status) || !unchanged) conflicts.push('TRANSACTION_SET_CHANGED')
  if (!supported) conflicts.push('WHOLE_UPDATE_UNDO_REQUIRED')
  return { updateId: event.updateId, eventId: event.eventId, eventStatus: event.status, eventVersion: event.version,
    transactionIds: owned.map((row) => row.transactionId),
    reusedTransactionIds: owned.filter((row) => row.creationMethod === 'reused').map((row) => row.transactionId),
    transactionSet: owned.map(({ transactionId, type, sourceAccountId, destinationAccountId, amountMinor, version }) =>
      ({ transactionId, type, sourceAccountId, destinationAccountId, amountMinor, version })),
    canCorrect: conflicts.length === 0, conflicts, policyVersion: MAINTENANCE_POLICY_VERSION }
}

async function accountState(connection, uid, before, after, { forUpdate = false, additionalAccountIds = [] } = {}) {
  const impacts = accountImpacts(before, after)
  const ids = [...new Set([...impacts.map((row) => row.accountId), ...additionalAccountIds])].sort()
  const [accounts] = ids.length ? await connection.execute(`SELECT account_id AS accountId, type, version, currency, archived_at AS archivedAt
    FROM catledger_accounts WHERE uid = ? AND account_id IN (${ids.map(() => '?').join(', ')})
    ORDER BY account_id${forUpdate ? ' FOR UPDATE' : ''}`, [uid, ...ids]) : [[]]
  const balances = await queryCashBalances(connection, uid, new Map(accounts.map((row) => [row.accountId, row])))
  const normalized = accounts.map((row) => ({ ...row, version: Number(row.version), balanceMinor: String(balances.get(row.accountId) || 0n) }))
  return { impacts, accounts: normalized, deficits: cashDeficits(impacts, normalized) }
}
function previewToken(uid, kind, state) {
  return digestRequest(kind, { uid, policyVersion: MAINTENANCE_POLICY_VERSION, ...state })
}
module.exports = { correctionImpactResult, accountState, previewToken }
