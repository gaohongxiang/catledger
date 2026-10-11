const { digestParts } = require('../digest')
const { VERSION, bankChannelEdges, pairKey } = require('../bank-channel-matching')
const { chunks, insertMany } = require('../sql-batch')
const { getRowSemantic } = require('../row-semantic-resolver')

function sourceIdentity(event) {
  const rows = event.relationEvidence.rows
  // 同一可靠身份可以有多份原文；物理行身份不推广为跨文件规则。
  if (!rows.length || rows.some(row => !row.identityId || row.identityState === 'identity_conflict' ||
    !['source_transaction_id', 'order_combination'].includes(row.identityKind))) return null
  const ids = new Set(rows.map(row => row.identityId))
  return ids.size === 1 ? [...ids][0] : null
}
function eventBasis(event) {
  const rows = event.relationEvidence.rows.map(row => JSON.stringify([row.identityId, row.sourceType,
    row.amountMinor, row.currency, row.direction, row.utcAt, row.rawTransactionTime,
    row.rawTransactionType, row.rawStatus, row.paymentMethodKey, row.counterparty, row.item,
    getRowSemantic(row)])).sort()
  return [event.ledgerAccountId, event.economicNature, event.flowDirection, event.amountMinor,
    event.currency, event.utcAt, event.manualFieldMask & 128 ? event.categoryId : null, ...new Set(rows)]
}
function decisionIdentity(pair) {
  const bankIdentityId = sourceIdentity(pair.bank), platformIdentityId = sourceIdentity(pair.platform)
  if (!bankIdentityId || !platformIdentityId) return null
  const basisDigest = pair.pairKind === 'repayment'
    ? digestParts('repayment-channel-basis-v1', JSON.stringify(eventBasis(pair.bank)), JSON.stringify(eventBasis(pair.platform)),
      JSON.stringify([pair.bank.counterpartyLedgerAccountId, pair.platform.counterpartyLedgerAccountId,
        pair.bank.fieldSources.repaymentOwnership, pair.platform.fieldSources.repaymentOwnership, pair.repayment,
        pair.bank.ledgerAccountFacts?.type, pair.platform.ledgerAccountFacts?.type]))
    : digestParts('bank-channel-basis-v1', JSON.stringify(eventBasis(pair.bank)), JSON.stringify(eventBasis(pair.platform)))
  return { bankIdentityId, platformIdentityId, basisDigest,
    pairDigest: digestParts(VERSION, bankIdentityId, platformIdentityId, basisDigest) }
}
async function remember(connection, uid, pairs, actionId) {
  // 手续费和目标账户必须逐对明确确认；首版仅记住还款候选的“不同笔”，不自动重放费用授权。
  const rows = pairs.filter(pair => pair.pairKind !== 'repayment' || pair.decision === 'distinct')
    .map(pair => ({ pair, identity: decisionIdentity(pair) })).filter(item => item.identity)
  await insertMany(connection, `INSERT INTO catledger_bank_channel_decisions
    (uid, pair_digest, bank_identity_id, platform_identity_id, basis_digest, decision, rule_version, action_id) VALUES`,
  rows.map(({ pair, identity }) => [uid, identity.pairDigest, identity.bankIdentityId, identity.platformIdentityId,
    identity.basisDigest, pair.decision, VERSION, actionId]),
  ' ON DUPLICATE KEY UPDATE decision = VALUES(decision), action_id = VALUES(action_id), updated_at = CURRENT_TIMESTAMP(3)')
}
async function remembered(connection, uid, events) {
  const pairs = bankChannelEdges(events).map(pair => ({ ...pair, identity: decisionIdentity(pair) })).filter(pair => pair.identity)
  const saved = new Map()
  for (const part of chunks(pairs.map(pair => [pair.identity.pairDigest]))) {
    const [rows] = await connection.execute(`SELECT pair_digest AS pairDigest, decision FROM catledger_bank_channel_decisions
      WHERE uid = ? AND pair_digest IN (${part.map(() => '?').join(',')}) AND rule_version = ?`, [uid, ...part.flat(), VERSION])
    rows.forEach(row => saved.set(row.pairDigest, row.decision))
  }
  return pairs.filter(pair => saved.has(pair.identity.pairDigest) &&
    (pair.pairKind !== 'repayment' || saved.get(pair.identity.pairDigest) === 'distinct'))
    .map(pair => ({ ...pair, decision: saved.get(pair.identity.pairDigest) }))
}
function markDistinct(pair) {
  for (const event of [pair.bank, pair.platform]) event.fieldSources = { ...event.fieldSources,
    bankChannelDistinctPairs: [...new Set([...(event.fieldSources.bankChannelDistinctPairs || []), pairKey(pair.bank, pair.platform)])] }
}
module.exports = { decisionIdentity, remember, remembered, markDistinct }
