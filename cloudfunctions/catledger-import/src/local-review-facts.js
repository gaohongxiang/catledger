// All reads use the caller's consistent snapshot / user transaction. No writes.
const repository = require('./finance-update-repository')
const { selectDomainEvents } = require('./review/event-store')
const { chunks } = require('./sql-batch')
const { PLAN_VERSION } = require('./domain-versions')
const { LIMITS } = require('./local-review-protocol')
const { importError } = require('./errors')

async function historyReferences(connection, uid, ids) {
  const result = []
  for (const part of chunks([...new Set(ids)].filter(Boolean).sort().map(id => [id]))) {
    const [rows] = await connection.execute(`SELECT t.transaction_id AS transactionId,t.version,t.type,
      t.source_account_id AS sourceAccountId,t.destination_account_id AS destinationAccountId,
      t.category_id AS categoryId,t.original_transaction_id AS originalTransactionId,t.amount_minor AS amountMinor,
      t.occurred_local_date AS localDate,t.occurred_local_at AS localAt,t.occurred_at_utc AS utcAt,t.note,t.deleted_at AS deletedAt,
      COALESCE((SELECT SUM(r.amount_minor) FROM catledger_transactions r WHERE r.uid=t.uid AND r.original_transaction_id=t.transaction_id
        AND r.type='refund' AND r.deleted_at IS NULL),0) AS refundedMinor
      FROM catledger_transactions t WHERE t.uid=? AND t.transaction_id IN (${part.map(() => '?').join(',')})`, [uid, ...part.flat()])
    result.push(...rows.map(row => ({ ...row, version: Number(row.version), amountMinor: String(row.amountMinor), refundedMinor: String(row.refundedMinor) })))
  }
  return result
}

async function refundReferences(connection, uid, updateId, events) {
  const coverage = [], references = new Map()
  // Download bounded relevant references, never an entire historical ledger. The
  // coverage declaration makes truncation and field changes explicit to the phone.
  for (const event of events.filter(event => event.economicNature === 'refund' && ['ready','needs_action'].includes(event.status))) {
    let found = { total: null, items: [] }
    if (event.utcAt && event.amountMinor != null && references.size < LIMITS.candidatePairs) {
      found = await require('./review/editor-refund').candidates(connection, uid, { ...event, updateId }, 'transaction',
        { limit: Math.min(201, LIMITS.candidatePairs - references.size) })
    }
    for (const candidate of found.items) references.set(candidate.id, candidate)
    coverage.push({ eventId: event.eventId, amountMinor: event.amountMinor, utcAt: event.utcAt,
      ledgerAccountId: event.ledgerAccountId, total: found.total, complete: found.total != null && found.total === found.items.length,
      candidates: found.items.map(row => row.id) })
  }
  return { coverage, candidates: [...references.values()] }
}

async function loadFacts(connection, uid, updateId) {
  const update = repository.publicUpdate(await repository.selectUpdate(connection, uid, updateId))
  if (update.status !== 'review' || update.planVersion !== PLAN_VERSION) throw importError('CONFLICT')
  const sources = await repository.selectSources(connection, uid, updateId)
  const { rows } = await repository.selectCoverageEvidence(connection, uid, updateId, { pairing: true })
  if (rows.length > LIMITS.sourceRows) throw importError('LOCAL_REVIEW_CAPACITY')
  const [eventIds]=await connection.execute('SELECT event_id AS eventId FROM catledger_economic_events WHERE uid=? AND update_id=?',[uid,updateId])
  const events = await selectDomainEvents(connection, uid, updateId, eventIds.map(event => event.eventId))
  const issues = await repository.selectIssues(connection, uid, updateId)
  const [members] = await connection.execute(`SELECT member_id AS memberId,issue_id AS issueId,object_type AS objectType,
    object_id AS objectId,object_version AS objectVersion,member_role AS memberRole,sort_order AS sortOrder
    FROM catledger_review_issue_members WHERE uid=? AND update_id=? ORDER BY issue_id,sort_order,member_id`, [uid, updateId])
  const [evidence] = await connection.execute(`SELECT v.evidence_id AS evidenceId,v.row_id AS rowId,v.event_id AS eventId,
    v.evidence_role AS evidenceRole,i.identity_kind AS identityKind,i.identity_key AS identityKey,i.core_digest AS coreDigest
    FROM catledger_event_evidence v JOIN catledger_import_rows r ON r.uid=v.uid AND r.row_id=v.row_id
    LEFT JOIN catledger_source_identities i ON i.uid=r.uid AND i.identity_id=r.identity_id
    WHERE v.uid=? AND v.update_id=? ORDER BY (v.evidence_role='primary') DESC,v.evidence_id`, [uid, updateId])
  const [raw] = await connection.execute(`SELECT r.row_id AS rowId,r.raw_fields_json AS fields
    FROM catledger_import_rows r JOIN catledger_finance_update_sources s ON s.uid=r.uid AND s.batch_id=r.batch_id
    WHERE s.uid=? AND s.update_id=? ORDER BY s.source_order,r.source_row_number,r.row_id`, [uid, updateId])
  const [relations] = await connection.execute(`SELECT relation_id AS relationId,relation_type AS relationType,status,
    source_event_id AS sourceEventId,target_event_id AS targetEventId,amount_minor AS amountMinor,currency,manual,version
    FROM catledger_economic_event_relations WHERE uid=? AND update_id=?`, [uid, updateId])
  const [links] = await connection.execute(`SELECT link_id AS linkId,event_id AS eventId,transaction_id AS transactionId,
    role,creation_method AS creationMethod,transaction_version AS transactionVersion FROM catledger_economic_event_transactions
    WHERE uid=? AND update_id=? AND superseded_at IS NULL`, [uid, updateId])
  const [accounts] = await connection.execute(`SELECT account_id AS accountId,name,type,nature,currency,version,archived_at AS archivedAt
    FROM catledger_accounts WHERE uid=?`, [uid])
  const [accountDrafts] = await connection.execute(`SELECT draft_account_id AS accountId,name,type,nature,currency
    FROM catledger_finance_update_account_drafts WHERE uid=? AND update_id=? AND materialized_at IS NULL`, [uid, updateId])
  const [categories] = await connection.execute(`SELECT c.category_id AS categoryId,c.name,c.kind,c.system_key AS systemKey,
    c.parent_id AS parentId,p.name AS parentName,c.sort_order AS sortOrder,c.version,c.archived_at AS archivedAt
    FROM catledger_categories c LEFT JOIN catledger_categories p ON p.uid=c.uid AND p.category_id=c.parent_id WHERE c.uid=?`, [uid])
  const [loans] = await connection.execute(`SELECT loan_id AS loanId,name,account_id AS accountId,version,
    baseline_principal_minor AS baselinePrincipalMinor,baseline_date AS baselineDate,archived_at AS archivedAt
    FROM catledger_loans WHERE uid=? AND deleted_at IS NULL`, [uid])
  const chargeStore = require('./loan-charge-store')
  const [contracts] = await connection.execute(chargeStore.CONTRACT_SQL + ' WHERE uid=?', [uid])
  const [charges] = await connection.execute(chargeStore.CHARGE_SQL + ' WHERE f.uid=? ORDER BY f.charge_date,f.charge_id', [uid])
  const [actions] = await connection.execute(`SELECT action_id AS actionId,action_type AS actionType,decision_json AS decision
    FROM catledger_finance_actions WHERE uid=? AND update_id=? AND decision_json IS NOT NULL`, [uid, updateId])
  const historyGroups = await require('./historical-duplicates').historicalGroups(connection, uid, updateId)
  const refunds = await refundReferences(connection, uid, updateId, events)
  const history = await historyReferences(connection, uid, [
    ...members.filter(row => row.objectType === 'transaction').map(row => row.objectId),
    ...links.map(row => row.transactionId), ...rows.map(row => row.existingTransactionId),
    ...historyGroups.flatMap(group => group.candidates.map(row => row.transactionId)), ...refunds.candidates.map(row => row.id)
  ])
  for(const table of [accounts,categories,loans,contracts,relations])for(const row of table)if(row.version!=null)row.version=Number(row.version)
  for(const row of members)row.objectVersion=Number(row.objectVersion)
  return { protocolVersion: 3, ruleVersion: PLAN_VERSION, update, sources, events, issues, members, rows,
    raw: raw.map(row => ({ rowId: row.rowId, fields: repository.parseJson(row.fields, []) })), evidence, relations, links,
    accounts, accountDrafts, categories, loans, paymentMappings: await repository.selectPaymentMappings(connection, uid, updateId), contracts: contracts.map(row => ({ ...row, authorization: repository.parseJson(row.authorization, {}) })),
    charges: charges.map(chargeStore.publicCharge), actions: actions.map(row => ({ ...row, decision: repository.parseJson(row.decision, {}) })),
    history, historyGroups, refundCandidates: refunds.candidates,
    historyCoverage: { duplicates: events.map(event => ({ eventId: event.eventId, amountMinor: event.amountMinor, utcAt: event.utcAt,
      ledgerAccountId: event.ledgerAccountId, counterpartyLedgerAccountId: event.counterpartyLedgerAccountId, flowDirection: event.flowDirection })),
      refunds: refunds.coverage },
    summary: {update,sources:sources.map(({analysis,...source})=>({...source,observationsPassed:require('./statement-analysis').analysisFullyObserved(analysis)}))} }
}
module.exports = { loadFacts, historyReferences, refundReferences }
