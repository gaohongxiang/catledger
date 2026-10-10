const { chunks, insertMany, updateEvents, loadEventContexts } = require('./sql-batch')
const { loadRefundPostingContext } = require('./refund-posting-context')
const { commandResult } = require('./command-result')
const { loadBatchSemanticRows, reconcileCurrentUpdate } = require('./review/reconciliation')
const { resolveAccountMappings } = require('./account-mapping-policy')
const { selectDomainEvents, loadReferenceCatalog } = require('./review/event-store')
const { eventAllocation, allocationAccountsValid } = require('./funds-allocation')
const { randomUUID } = require('node:crypto')
const { materializeAccountDrafts, reachableAccountIds } = require('./account-draft')
const { digestParts } = require('./digest')
const { importError } = require('./errors')
const { executeIdempotentMutation } = require('./import-transaction')
const {
  insertAction,
  parseJson,
  selectPaymentMappings,
  selectActiveAccounts,
  selectEvents,
  selectSources,
  selectUpdate
} = require('./finance-update-repository')
const { evaluatePostability } = require('./organizer-model')
const { projectedEvent, mappingRowsForEvent, validateMappingTarget } = require('./review-issue-service')
const { PLAN_VERSION } = require('./domain-versions')
const { validateUuid, validateVersion } = require('./validation')
const { paymentResolutionForEvent } = require('./payment-resolution')
const { repaymentAllocationsForEvent, isAggregateRepayment } = require('./repayment-allocation')
const installmentItems = require('./installment-items')
const explicitRepayment = require('./explicit-repayment')
const { coverageFor } = require('./loan-transaction-guard')
const { loadLoanContext } = require('./loan-snapshots')
const { rebuildPrincipal } = require('./loan-timeline')
const loanChargePlan = require('./loan-charge-plan')
const { inspectCoverage } = require('./import-coverage')

const POSTING_RULE_VERSION = 'finance-posting-v2'

function publicTransaction(row) {
  return {
    transactionId: row.transactionId,
    type: row.type,
    occurredAtUtc: row.occurredAtUtc,
    occurredLocalAt: row.occurredLocalAt,
    timezoneOffsetMinutes: Number(row.timezoneOffsetMinutes),
    amountMinor: String(row.amountMinor),
    currency: row.currency,
    sourceAccountId: row.sourceAccountId,
    destinationAccountId: row.destinationAccountId,
    categoryId: row.categoryId,
    originalTransactionId: row.originalTransactionId,
    note: row.note,
    version: Number(row.version),
    origin: row.origin,
    importId: row.importId,
    deletedAt: row.deletedAt
  }
}

async function loadAffectedAccounts(connection, uid, accountIds) {
  if (accountIds.length === 0) return new Map()
  const [rows] = await connection.execute(
    `SELECT account_id AS accountId, type, nature, currency,
            balance_minor AS balanceMinor, version, archived_at AS archivedAt
       FROM catledger_accounts
      WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(',')})
      ORDER BY account_id FOR UPDATE`,
    [uid, accountIds]
  )
  if (rows.length !== accountIds.length || rows.some((row) => row.archivedAt != null)) throw importError('VALIDATION_ERROR')
  return new Map(rows.map((row) => [row.accountId, row]))
}

function deltaForDraft(draft) {
  if (draft.type === 'income' || draft.type === 'refund') return [[draft.destinationAccountId, BigInt(draft.amountMinor)]]
  if (draft.type === 'expense') return [[draft.sourceAccountId, -BigInt(draft.amountMinor)]]
  if (draft.type === 'transfer') return [[draft.sourceAccountId, -BigInt(draft.amountMinor)], [draft.destinationAccountId, BigInt(draft.amountMinor)]]
  throw importError('VALIDATION_ERROR')
}

function transactionDraft(event, originalTransaction = null) {
  if (event.fieldSources && event.fieldSources.refundSourceConflict) throw importError('UNRESOLVED_IMPORT')
  const nature = event.economicNature
  const draft = {
    eventId: event.eventId,
    transactionId: randomUUID(),
    amountMinor: String(event.amountMinor),
    currency: event.currency,
    occurredAtUtc: event.utcAt,
    occurredLocalAt: event.localAt,
    timezoneOffsetMinutes: event.timezoneOffsetMinutes,
    sourceAccountId: null,
    destinationAccountId: null,
    categoryId: event.categoryId,
    originalTransactionId: null,
    note: event.note || '',
    version: 1
  }
  if (nature === 'income') {
    draft.type = 'income'
    draft.destinationAccountId = event.ledgerAccountId
  } else if (nature === 'expense' || nature === 'fee') {
    draft.type = 'expense'
    draft.sourceAccountId = event.ledgerAccountId
  } else if (nature === 'refund') {
    draft.type = 'refund'
    draft.destinationAccountId = event.ledgerAccountId
    draft.originalTransactionId = originalTransaction ? originalTransaction.transactionId : null
    draft.categoryId = originalTransaction && originalTransaction.categoryId || null
  } else if (['internal_transfer', 'repayment', 'borrow'].includes(nature)) {
    draft.type = 'transfer'
    const reverse = event.sourceDirection === 'income'
    draft.sourceAccountId = reverse ? event.counterpartyLedgerAccountId : event.ledgerAccountId
    draft.destinationAccountId = reverse ? event.ledgerAccountId : event.counterpartyLedgerAccountId
    draft.categoryId = null
  } else {
    throw importError('UNRESOLVED_IMPORT')
  }
  if (!draft.sourceAccountId && !draft.destinationAccountId) throw importError('UNRESOLVED_IMPORT')
  if (draft.type === 'transfer' && (!draft.sourceAccountId || !draft.destinationAccountId || draft.sourceAccountId === draft.destinationAccountId)) {
    throw importError('VALIDATION_ERROR')
  }
  return draft
}

function transactionDrafts(event, originalTransaction = null) {
  if (event.fieldSources && event.fieldSources.refundSourceConflict) throw importError('UNRESOLVED_IMPORT')
  const explicit = explicitRepayment.draftsForEvent(event)
  if (explicit) return explicit
  if (event.fieldSources && event.fieldSources.paymentResolution) {
    const payment = paymentResolutionForEvent(event)
    if (!payment.valid) throw importError('UNRESOLVED_IMPORT')
    return payment.allocations.map((item) => {
      const draft = transactionDraft({ ...event, economicNature: 'expense', ledgerAccountId: item.accountId, amountMinor: item.amountMinor })
      if (payment.resolution.nature === 'repayment') {
        draft.type = 'transfer'; draft.destinationAccountId = payment.resolution.targetAccountId; draft.categoryId = null
      }
      return draft
    })
  }
  if (isAggregateRepayment(event)) {
    const allocation = repaymentAllocationsForEvent(event)
    if (!allocation.valid) throw importError('UNRESOLVED_IMPORT')
    return allocation.allocations.map((item) => transactionDraft({
      ...event,
      sourceDirection: 'expense',
      amountMinor: item.amountMinor,
      counterpartyLedgerAccountId: item.accountId
    }, originalTransaction))
  }
  return [transactionDraft(event, originalTransaction)]
}

async function validateCurrentRefunds(connection, uid, updateId) {
  const [[conflict]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_economic_events
    WHERE uid = ? AND update_id = ? AND status = 'ready'
      AND JSON_EXTRACT(field_sources_json, '$.refundSourceConflict') IS NOT NULL`, [uid, updateId])
  if (Number(conflict.count) > 0) throw importError('UNRESOLVED_IMPORT')
  const [relations] = await connection.execute(`SELECT r.source_event_id AS sourceId, r.target_event_id AS targetId,
    r.amount_minor AS relationAmount, r.currency AS relationCurrency, refund.amount_minor AS refundAmount,
    refund.currency AS refundCurrency, refund.status AS refundStatus, refund.event_utc_at AS refundAt,
    original.economic_nature AS originalNature, original.status AS originalStatus, original.amount_minor AS originalAmount,
    original.currency AS originalCurrency, original.event_utc_at AS originalAt,
    JSON_EXTRACT(original.field_sources_json, '$.paymentResolution') AS paymentResolution
    FROM catledger_economic_event_relations r
    JOIN catledger_economic_events refund ON refund.uid = r.uid AND refund.event_id = r.source_event_id
    JOIN catledger_economic_events original ON original.uid = r.uid AND original.event_id = r.target_event_id
    WHERE r.uid = ? AND r.update_id = ? AND r.relation_type = 'refund_of' AND r.status = 'confirmed'
      AND refund.status = 'ready'`, [uid, updateId])
  const totals = new Map()
  for (const relation of relations) {
    if (!['expense', 'fee'].includes(relation.originalNature) || !['ready', 'excluded'].includes(relation.originalStatus) ||
        relation.sourceId === relation.targetId || String(relation.relationAmount) !== String(relation.refundAmount) ||
        relation.refundCurrency !== relation.originalCurrency || relation.relationCurrency !== relation.refundCurrency ||
        !relation.refundAt || !relation.originalAt || String(relation.refundAt) < String(relation.originalAt) || relation.paymentResolution != null && relation.paymentResolution !== 'null') throw importError('UNRESOLVED_IMPORT')
    totals.set(relation.targetId, (totals.get(relation.targetId) || 0n) + BigInt(relation.refundAmount))
    if (totals.get(relation.targetId) > BigInt(relation.originalAmount)) throw importError('UNRESOLVED_IMPORT')
  }
}

async function validateEventState(connection, uid, updateId, events) {
  const context = await loadEventContexts(connection, uid, updateId)
  const [[blocking]] = await connection.execute(`SELECT COUNT(*) AS count FROM catledger_review_issues
    WHERE uid = ? AND update_id = ? AND status = 'open' AND blocking = 1`, [uid, updateId])
  if (Number(blocking.count) > 0) throw importError('UNRESOLVED_IMPORT')
  for (const event of events) {
    const evaluated = evaluatePostability(event, context.get(event.eventId))
    if (!['ready', 'excluded'].includes(evaluated.status) || evaluated.status !== event.status) throw importError('UNRESOLVED_IMPORT')
  }
  await validateCurrentRefunds(connection, uid, updateId)
}

async function loadPostingEvents(connection, uid, updateId) {
  const events = await selectEvents(connection, uid, updateId, { includeFieldSources: true })
  const [rows] = await connection.execute(
    `SELECT e.event_id AS eventId, e.event_utc_at AS utcAt,
            e.event_local_date AS localDate, e.timezone_offset_minutes AS timezoneOffsetMinutes,
            r.normalized_direction AS sourceDirection, r.note_raw AS sourceNote,
            r.item_raw AS item, r.counterparty_raw AS counterparty, s.import_id AS importId
       FROM catledger_economic_events e
       JOIN catledger_event_evidence v
         ON v.uid = e.uid AND v.update_id = e.update_id AND v.event_id = e.event_id AND v.evidence_role = 'primary'
       JOIN catledger_import_rows r ON r.uid = v.uid AND r.row_id = v.row_id
       JOIN catledger_finance_update_sources s
         ON s.uid = e.uid AND s.update_id = e.update_id AND s.batch_id = r.batch_id
      WHERE e.uid = ? AND e.update_id = ?
      ORDER BY e.event_utc_at, e.event_id`,
    [uid, updateId]
  )
  const byId = new Map(rows.map((row) => [row.eventId, row]))
  return events.map((event) => {
    const row = byId.get(event.eventId)
    const editorText = require('./editor-fields').effectiveText(event, row || {})
    const note = [row && row.item, editorText.counterparty, editorText.note].filter(Boolean).join(' · ').slice(0, 200)
    return {
      ...event,
      utcAt: row && row.utcAt,
      localDate: row && row.localDate,
      timezoneOffsetMinutes: row && Number(row.timezoneOffsetMinutes),
      sourceDirection: row && row.sourceDirection,
      importId: row && row.importId,
      note
    }
  })
}

async function takeSnapshots(connection, uid, updateId, actionId, accountIds) {
  const [accounts] = await connection.execute(
    `SELECT account_id AS accountId, balance_minor AS balanceMinor, version
       FROM catledger_accounts
      WHERE uid = ? AND account_id IN (${accountIds.map(() => '?').join(',')})
      ORDER BY account_id FOR UPDATE`,
    [uid, ...accountIds]
  )
  await insertMany(connection, `INSERT INTO catledger_finance_account_snapshots
    (uid, snapshot_id, update_id, action_id, account_id, balance_minor,
     account_version, currency, snapshot_role) VALUES`, accounts.map(account => [uid, randomUUID(), updateId, actionId,
    account.accountId, String(account.balanceMinor), Number(account.version), 'CNY', 'before_post']))
  return accounts
}

async function publishAccountMappings(connection, uid, updateId, actionId, postingMappings = null, { previous: suppliedPrevious = null, published: suppliedPublished = null } = {}) {
  const mappings = postingMappings || (await connection.execute(
    `SELECT d.draft_mapping_id AS draftMappingId, d.source_type AS sourceType,
            d.payment_method_key AS paymentMethodKey, d.payment_method_hint AS paymentMethodHint,
            d.mapping_action AS mappingAction, d.account_id AS accountId, d.default_scope AS defaultScope
       FROM catledger_finance_update_account_mapping_drafts d
      WHERE d.uid = ? AND d.update_id = ?
        AND (d.mapping_action = 'account' OR d.default_scope = 'future')
      ORDER BY d.created_at, d.draft_mapping_id`,
    [uid, updateId]
  ))[0]
  const active = suppliedPrevious || (mappings.length ? (await connection.execute(`SELECT mapping_id AS mappingId, source_type AS sourceType,
    payment_method_key AS paymentMethodKey, mapping_action AS mappingAction, account_id AS accountId,
    version, disabled_at AS disabledAt FROM catledger_import_account_mappings WHERE uid = ? ORDER BY mapping_id FOR UPDATE`, [uid]))[0] : [])
  const before = new Map(active.map(row => [row.sourceType + ':' + row.paymentMethodKey, row]))
  const published = suppliedPublished || (mappings.length ? (await connection.execute(`SELECT s.source_type_snapshot AS sourceType, r.payment_method_key AS paymentMethodKey,
    r.semantic_json AS semantic FROM catledger_finance_update_sources s JOIN catledger_import_rows r ON r.uid=s.uid AND r.batch_id=s.batch_id
    WHERE s.uid=? AND s.update_id=?`, [uid, updateId]))[0] : [])
  const referenceMap = new Map(), accountMap = new Map()
  const ids = [...new Set(mappings.map(row => row.accountId).filter(Boolean))]
  if (ids.length) for (const part of chunks(ids.map(id => [id]))) {
    const [rows] = await connection.execute(`SELECT account_id AS accountId,type FROM catledger_accounts WHERE uid=? AND account_id IN (${part.map(() => '?').join(',')})`, [uid, ...part.flat()])
    rows.forEach(row => accountMap.set(row.accountId, row))
  }
  for (const row of published) {
    const semantic = parseJson(row.semantic, {})
    const references = [semantic.sourceAccount && { ...semantic.sourceAccount, sourceType: row.sourceType, paymentMethodKey: row.paymentMethodKey },
      semantic.fundsProjection && semantic.fundsProjection.from, semantic.fundsProjection && semantic.fundsProjection.to].filter(Boolean)
    for (const ref of references) {
      const key = (ref.sourceType || row.sourceType) + ':' + ref.paymentMethodKey
      if (!referenceMap.has(key) && ref.paymentMethodKey) referenceMap.set(key, { ...ref, sourceType: ref.sourceType || row.sourceType })
    }
  }
  for (const mapping of mappings) {
    if (mapping.mappingAction === 'account' && !mapping.accountId) continue
    const key = mapping.sourceType + ':' + mapping.paymentMethodKey
    // 历史永久映射的类型不匹配时必须拒绝，不能发布到后续账单。
    const historical = { ...mapping, mappingScope: 'history' }
    if (!require('./account-mapping-policy').compatibleMapping(historical, referenceMap.get(key) || mapping, accountMap)) throw importError('VALIDATION_ERROR')
    const previous = before.get(key)
    const scope = mapping.mappingAction === 'ignore' ? 'future' : 'account'
    const reason = mapping.mappingAction === 'ignore' ? 'source_account_ignored_default' : 'source_account_mapping_confirmed'
    await connection.execute(
      `INSERT INTO catledger_import_account_mappings
         (uid, mapping_id, source_type, payment_method_key, payment_method_hint,
          mapping_action, account_id, version, disabled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)
       ON DUPLICATE KEY UPDATE mapping_action = VALUES(mapping_action), account_id = VALUES(account_id),
         payment_method_hint = VALUES(payment_method_hint), disabled_at = NULL, version = version + 1`,
      [uid, randomUUID(), mapping.sourceType, mapping.paymentMethodKey, String(mapping.paymentMethodHint || '').slice(0, 128), mapping.mappingAction, mapping.accountId || null]
    )
    const [[updated]] = await connection.execute(`SELECT mapping_id AS mappingId, version FROM catledger_import_account_mappings
      WHERE uid = ? AND source_type = ? AND payment_method_key = ? FOR UPDATE`, [uid, mapping.sourceType, mapping.paymentMethodKey])
    await connection.execute(`INSERT INTO catledger_finance_update_effects
      (uid, effect_id, update_id, action_id, effect_type, object_id, before_json, after_json, rule_version)
      VALUES (?, ?, ?, ?, 'account_mapping', ?, ?, ?, ?)`,
    [uid, randomUUID(), updateId, actionId, updated.mappingId, JSON.stringify(previous || null), JSON.stringify({
      mappingAction: mapping.mappingAction, accountId: mapping.accountId || null, version: Number(updated.version),
      defaultScope: scope, reasonCode: reason
    }), POSTING_RULE_VERSION])
    before.set(key, { ...updated, sourceType: mapping.sourceType, paymentMethodKey: mapping.paymentMethodKey,
      mappingAction: mapping.mappingAction, accountId: mapping.accountId || null, disabledAt: null })
  }
}

async function validatePostingMappings(connection, uid, updateId, selectedEvents, mappingRows, suppliedCatalog = null) {
  const events = selectedEvents.filter(event => event.status === 'ready')
  const catalog = suppliedCatalog || await loadReferenceCatalog(connection, uid, updateId, events)
  const accounts = [...catalog.accounts.values(), ...catalog.drafts.values()]
  const references = events.flatMap(event => mappingRowsForEvent(event).map(item => item.reference))
  const resolution = resolveAccountMappings({ references, mappings: mappingRows, accounts })
  if (resolution.conflictIdentityKeys.size) throw importError('UNRESOLVED_IMPORT')
  for (const event of events) {
    const projected = projectedEvent(event, resolution.index)
    if (projected.ledgerAccountId !== event.ledgerAccountId || projected.counterpartyLedgerAccountId !== event.counterpartyLedgerAccountId) throw importError('UNRESOLVED_IMPORT')
    for (const { reference, accountId } of mappingRowsForEvent(event)) {
      if (accountId) await validateMappingTarget(connection, uid, updateId, event, reference, accountId, catalog)
    }
  }
}

async function postingMappingRows(connection, uid, updateId, selectedEvents, mappingRows, { drafts: suppliedDrafts = null, references: suppliedReferences = null } = {}) {
  const drafts = suppliedDrafts || (await connection.execute(`SELECT draft_mapping_id AS draftMappingId, event_id AS eventId,
    source_type AS sourceType, payment_method_key AS paymentMethodKey, payment_method_hint AS paymentMethodHint,
    mapping_action AS mappingAction, account_id AS accountId, default_scope AS defaultScope
    FROM catledger_finance_update_account_mapping_drafts WHERE uid=? AND update_id=? ORDER BY created_at,draft_mapping_id`, [uid, updateId]))[0]
  const refs = suppliedReferences || selectedEvents.filter(event => event.status === 'ready').flatMap(event => mappingRowsForEvent(event).map(item => ({ ...item, event })))
  const byEvent = new Map()
  for (const row of refs) { if (!byEvent.has(row.event.eventId)) byEvent.set(row.event.eventId, []); byEvent.get(row.event.eventId).push(row) }
  const results = []
  for (const mapping of drafts) {
    if (mapping.mappingAction === 'ignore') { if (mapping.defaultScope === 'future') results.push(mapping); continue }
    const actual = (byEvent.get(mapping.eventId) || []).find(row => row.reference.sourceType === mapping.sourceType &&
      row.reference.paymentMethodKey === mapping.paymentMethodKey && row.accountId === mapping.accountId)
    if (actual) results.push(mapping)
  }
  const grouped = new Map()
  for (const mapping of results) {
    const key = mapping.sourceType + ':' + mapping.paymentMethodKey
    const prior = grouped.get(key)
    if (prior && (prior.accountId !== mapping.accountId || prior.mappingAction !== mapping.mappingAction)) throw importError('UNRESOLVED_IMPORT')
    grouped.set(key, mapping)
  }
  return [...grouped.values()]
}

async function recordSideEffects(connection, uid, updateId, actionId, createdAccounts) {
  for (const account of createdAccounts) {
    await connection.execute(`INSERT INTO catledger_finance_update_effects
      (uid,effect_id,update_id,action_id,effect_type,object_id,before_json,after_json,rule_version)
      VALUES (?,?,?,?, 'account_created',?,NULL,?,?)`,
    [uid, randomUUID(), updateId, actionId, account.accountId, JSON.stringify({ accountId: account.accountId, type: account.type, name: account.name }), POSTING_RULE_VERSION])
  }
}

async function savePostingTransactions(connection, uid, updateId, actionId, drafts, { links = null } = {}) {
  await insertMany(connection, `INSERT INTO catledger_transactions
    (uid,transaction_id,type,occurred_at_utc,occurred_local_at,timezone_offset_minutes,
     amount_minor,currency,source_account_id,destination_account_id,category_id,original_transaction_id,note,version,origin,import_id)
    VALUES`, drafts.map(draft => [uid,draft.transactionId,draft.type,draft.occurredAtUtc,draft.occurredLocalAt,draft.timezoneOffsetMinutes,
      draft.amountMinor,draft.currency,draft.sourceAccountId,draft.destinationAccountId,draft.categoryId,draft.originalTransactionId,
      draft.note,draft.version,'import',draft.importId]))
  const audit = drafts.map(draft => [uid,randomUUID(),draft.transactionId,actionId,'create',null,
    JSON.stringify({ ...draft,origin:'import',deletedAt:null }),POSTING_RULE_VERSION])
  await insertMany(connection, `INSERT INTO catledger_transaction_audits
    (uid,audit_id,transaction_id,action_id,operation,before_json,after_json,rule_version) VALUES`, audit)
  if (links) await insertMany(connection, `INSERT INTO catledger_economic_event_transactions
    (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version) VALUES`, links)
}

async function loadExistingEventLinks(connection, uid, updateId) {
  const [rows] = await connection.execute(`SELECT l.event_id AS eventId, l.transaction_id AS transactionId,
    l.role, l.transaction_version AS transactionVersion, t.deleted_at AS deletedAt, t.version AS currentVersion
    FROM catledger_economic_event_transactions l JOIN catledger_transactions t ON t.uid=l.uid AND t.transaction_id=l.transaction_id
    WHERE l.uid=? AND l.update_id=? AND l.superseded_at IS NULL AND l.role IN ('primary','refund_transaction','repayment_allocation','payment_allocation','historical_primary')
    ORDER BY l.created_at,l.link_id`, [uid, updateId])
  const byEvent = new Map()
  for (const row of rows) {
    if (row.deletedAt != null || Number(row.currentVersion) !== Number(row.transactionVersion)) throw importError('CONFLICT')
    const list = byEvent.get(row.eventId) || []; list.push(row); byEvent.set(row.eventId, list)
  }
  return byEvent
}

async function postOrdinaryEvents(connection, uid, updateId, actionId, events, identityIds, sourceByEvent, balances, { refundContext = null } = {}) {
  const drafts = [], links = [], reused = [], preparedInstallments = []
  for (const event of events) {
    const installment = await installmentItems.prepareImport(connection, uid, event, identityIds.get(event.eventId) || [])
    if (installment && (installment.component === 'principal' || installment.skipFinancial)) {
      preparedInstallments.push({ prepared: installment, transactionId: null })
      continue
    }
    if (installment && installment.reuseTransactionId) {
      reused.push({ ...event, transactionId: installment.reuseTransactionId, transactionVersion: installment.reuseTransactionVersion, installment })
      continue
    }
    const original = event.economicNature === 'refund' ? refundContext.take(event) : null
    const pieces = transactionDrafts(event, original)
    for (const [index, draft] of pieces.entries()) {
      draft.importId = sourceByEvent.get(event.eventId) || event.importId
      drafts.push(draft)
      const role = event.fieldSources.paymentResolution ? 'payment_allocation' : isAggregateRepayment(event) ? 'repayment_allocation' : event.economicNature === 'refund' ? 'refund_transaction' : 'primary'
      links.push([uid,randomUUID(),updateId,event.eventId,draft.transactionId,role,'created',POSTING_RULE_VERSION,draft.version])
      for (const [accountId,delta] of deltaForDraft(draft)) balances.set(accountId,(balances.get(accountId) || 0n)+delta)
      if (installment && index === 0) preparedInstallments.push({ prepared: installment, transactionId: draft.transactionId })
    }
  }
  await savePostingTransactions(connection,uid,updateId,actionId,drafts,{links})
  for (const { prepared, transactionId } of preparedInstallments) await installmentItems.persistImport(connection,uid,prepared,transactionId)
  for (const event of reused) {
    await connection.execute(`INSERT INTO catledger_economic_event_transactions
      (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version)
      VALUES (?,?,?,?,?,'historical_primary','reused',?,?)`,
    [uid,randomUUID(),updateId,event.eventId,event.transactionId,POSTING_RULE_VERSION,event.transactionVersion])
    await installmentItems.persistImport(connection,uid,event.installment,event.transactionId)
  }
  return { created: drafts.length, reused: reused.length, drafts }
}

async function applyBalances(connection, uid, balances) {
  for (const part of chunks([...balances].map(([id,delta]) => [id,String(delta)]).sort((a,b)=>a[0].localeCompare(b[0])), { parametersPerRow:3, fixedParameters:1 })) {
    await connection.execute(`UPDATE catledger_accounts SET balance_minor=balance_minor+CASE account_id ${part.map(()=>'WHEN ? THEN ?').join(' ')} END,
      version=version+1 WHERE uid=? AND account_id IN (${part.map(()=>'?').join(',')})`,[...part.flat(),uid,...part.map(row=>row[0])])
  }
}

function orderedPostingEvents(events) {
  return [...events].sort((left,right)=>Number(left.economicNature==='refund')-Number(right.economicNature==='refund') ||
    String(left.utcAt || '').localeCompare(String(right.utcAt || '')) || left.eventId.localeCompare(right.eventId))
}

async function loadIdentitiesByEvent(connection, uid, updateId) {
  const [rows] = await connection.execute(`SELECT e.event_id AS eventId,r.identity_id AS identityId FROM catledger_event_evidence e
    JOIN catledger_import_rows r ON r.uid=e.uid AND r.row_id=e.row_id
    WHERE e.uid=? AND e.update_id=? AND e.evidence_role<>'discarded' AND r.identity_id IS NOT NULL`,[uid,updateId])
  const map = new Map()
  for (const row of rows) { const ids=map.get(row.eventId)||[]; if(!ids.includes(row.identityId))ids.push(row.identityId); map.set(row.eventId,ids) }
  return map
}

async function postExplicitRepayments(connection, uid, updateId, actionId, events, balances) {
  let created = 0
  const transactions = []
  for (const event of events) {
    const input = explicitRepayment.inputForEvent(event)
    if (!input) throw importError('UNRESOLVED_IMPORT')
    const result = await explicitRepayment.booking.book(connection, uid, { ...input, requestId: actionId }, {
      actionId, sourceUpdateId: updateId, sourceEventId: event.eventId, origin:'import', importId:event.importId,
      deferBalances:true, deferPrincipal:true
    })
    created += result.transactions.length
    for (const draft of result.transactions) {
      transactions.push(draft)
      for (const [accountId, delta] of deltaForDraft(draft)) balances.set(accountId,(balances.get(accountId)||0n)+delta)
    }
  }
  return { created, transactions }
}

async function rebuildAffectedPrincipal(connection, uid, events) {
  const loanIds = [...new Set(events.map(event=>event.fieldSources.loanRepayment && event.fieldSources.loanRepayment.loanId).filter(Boolean))].sort()
  for(const loanId of loanIds) await rebuildPrincipal(connection,uid,loanId)
}

async function receiptForPosted(connection, uid, updateId) {
  const [[row]] = await connection.execute(`SELECT created_transaction_count AS createdTransactionCount,reused_transaction_count AS reusedTransactionCount
    FROM catledger_finance_update_postings WHERE uid=? AND update_id=? AND state='completed' ORDER BY completed_at DESC LIMIT 1`,[uid,updateId])
  if(!row) throw importError('CONFLICT')
  return commandResult(connection,uid,updateId,{posting:{createdTransactionCount:Number(row.createdTransactionCount),reusedTransactionCount:Number(row.reusedTransactionCount)}})
}

async function financialSourceRows(connection, uid, updateId) {
  return (await connection.execute(`SELECT r.row_id AS rowId, r.normalized_direction AS direction, r.semantic_json AS semantic,
    r.source_profile_id AS sourceProfileId, r.identity_id AS identityId FROM catledger_import_rows r
    JOIN catledger_finance_update_sources s ON s.uid=r.uid AND s.batch_id=r.batch_id
    WHERE s.uid=? AND s.update_id=?`,[uid,updateId]))[0]
}

async function assertNoExternalIdentityReuse(connection, uid, updateId, selectedEvents, identityIds) {
  const ids = [...new Set(selectedEvents.flatMap(event=>identityIds.get(event.eventId)||[]))]
  for (const part of chunks(ids.map(id=>[id]))) {
    const [linked] = await connection.execute(`SELECT DISTINCT r.identity_id AS identityId FROM catledger_import_rows r
      JOIN catledger_event_evidence v ON v.uid=r.uid AND v.row_id=r.row_id AND v.evidence_role<>'discarded'
      JOIN catledger_economic_event_transactions l ON l.uid=v.uid AND l.event_id=v.event_id AND l.superseded_at IS NULL
        AND l.role IN ('primary','refund_transaction','payment_allocation','repayment_allocation','historical_primary')
      JOIN catledger_transactions t ON t.uid=l.uid AND t.transaction_id=l.transaction_id AND t.deleted_at IS NULL
      WHERE r.uid=? AND r.identity_id IN (${part.map(()=>'?').join(',')}) AND l.update_id<>?`,[uid,...part.flat(),updateId])
    if (linked.length) throw importError('CONFLICT')
  }
}

async function reconcileBeforePost(connection, uid, updateId, actionId, version) {
  const state = await reconcileCurrentUpdate(connection,uid,updateId,{actionId,expectedVersion:version})
  if (state.changed) throw importError('UNRESOLVED_IMPORT')
}

function createFinanceUpdatePosting({ getPool }) {
  return {
    post(context) {
      const updateId = validateUuid(context.data.updateId)
      const version = validateVersion(context.data.version)
      return executeIdempotentMutation({getPool,...context,action:'financeUpdates.post',operation:async(connection,uid,data,requestDigest,idempotencyKeyDigest)=>{
        const update=await selectUpdate(connection,uid,updateId,{forUpdate:true})
        if (update.status==='posted') return receiptForPosted(connection,uid,updateId)
        if (update.status!=='review' || Number(update.version)!==version || update.planVersion!==PLAN_VERSION) throw importError('CONFLICT')
        const actionId=await insertAction(connection,uid,{updateId,expectedVersion:version,appliedVersion:version+1,actionType:'post_update',requestDigest,idempotencyKeyDigest,status:'started'})
        await reconcileBeforePost(connection,uid,updateId,actionId,version)
        const events=await loadPostingEvents(connection,uid,updateId)
        await validateEventState(connection,uid,updateId,events)
        const selected=events.filter(event=>event.status==='ready')
        const coverage=await inspectCoverage(connection,uid,updateId,events)
        if(!coverage.selectedEventsReadyToPost) throw importError('UNRESOLVED_IMPORT')
        const identityIds=await loadIdentitiesByEvent(connection,uid,updateId)
        await assertNoExternalIdentityReuse(connection,uid,updateId,selected,identityIds)
        const mappingRows=await selectPaymentMappings(connection,uid,updateId)
        const catalog=await loadReferenceCatalog(connection,uid,updateId,selected)
        await validatePostingMappings(connection,uid,updateId,selected,mappingRows,catalog)
        const paymentMappingRows=await postingMappingRows(connection,uid,updateId,selected,mappingRows)
        const createdAccounts=await materializeAccountDrafts(connection,uid,updateId,reachableAccountIds(selected))
        const accountIds=[...reachableAccountIds(selected)].sort()
        const accounts=await loadAffectedAccounts(connection,uid,accountIds)
        for(const event of selected) {
          if(!require('./editor-fields').accountRolesValid(event, accounts)) throw importError('VALIDATION_ERROR')
          const allocation=eventAllocation(event)
          if(allocation.kind==='conflict' || allocation.valid&&!allocationAccountsValid(event,allocation,accounts)) throw importError('UNRESOLVED_IMPORT')
        }
        const beforeSnapshots=accountIds.length?await takeSnapshots(connection,uid,updateId,actionId,accountIds):[]
        const sourceByEvent=new Map(events.map(event=>[event.eventId,event.importId]))
        const balances=new Map()
        const explicit=selected.filter(event=>event.fieldSources.loanRepayment && explicitRepayment.inputForEvent(event))
        const explicitIds=new Set(explicit.map(event=>event.eventId))
        const ordinary=orderedPostingEvents(selected.filter(event=>!explicitIds.has(event.eventId)))
        const nonRefund=ordinary.filter(event=>event.economicNature!=='refund')
        const refunds=ordinary.filter(event=>event.economicNature==='refund')
        const first=await postOrdinaryEvents(connection,uid,updateId,actionId,nonRefund,identityIds,sourceByEvent,balances)
        const loanResult=await postExplicitRepayments(connection,uid,updateId,actionId,explicit,balances)
        const refundContext=await loadRefundPostingContext(connection,uid,updateId,refunds.map(event=>event.eventId))
        const refunded=await postOrdinaryEvents(connection,uid,updateId,actionId,refunds,identityIds,sourceByEvent,balances,{refundContext})
        await applyBalances(connection,uid,balances)
        await rebuildAffectedPrincipal(connection,uid,explicit)
        await installmentItems.persistReviewedImports(connection,uid,updateId,events,identityIds)
        await publishAccountMappings(connection,uid,updateId,actionId,paymentMappingRows)
        await recordSideEffects(connection,uid,updateId,actionId,createdAccounts)
        for (const part of chunks(selected.map(event=>[event.eventId,event.version]))) {
          const [changed]=await connection.execute(`UPDATE catledger_economic_events SET status='posted',state='posted',version=version+1
            WHERE uid=? AND update_id=? AND (event_id,version) IN (${part.map(()=>'(?,?)').join(',')})`,[uid,updateId,...part.flat()])
          if(changed.affectedRows!==part.length) throw importError('CONFLICT')
        }
        const created=first.created+loanResult.created+refunded.created,reused=first.reused+refunded.reused
        await connection.execute(`INSERT INTO catledger_finance_update_postings
          (uid,posting_id,update_id,action_id,state,created_transaction_count,reused_transaction_count,started_at,completed_at)
          VALUES (?,?,?,?,'completed',?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,[uid,randomUUID(),updateId,actionId,created,reused])
        await connection.execute(`UPDATE catledger_finance_updates SET status='posted',version=version+1,current_action_id=?,
          posted_event_count=?,ready_event_count=0,needs_action_event_count=0,error_code=NULL WHERE uid=? AND update_id=? AND version=?`,[actionId,selected.length,uid,updateId,version])
        await connection.execute(`UPDATE catledger_finance_actions SET status='applied',completed_at=CURRENT_TIMESTAMP(3)
          WHERE uid=? AND action_id=?`,[uid,actionId])
        await connection.execute(`UPDATE catledger_import_files f JOIN catledger_finance_update_sources s ON s.uid=f.uid AND s.import_id=f.import_id
          SET f.state='committed',f.version=f.version+1 WHERE s.uid=? AND s.update_id=? AND f.state='review_ready'`,[uid,updateId])
        const result=await commandResult(connection,uid,updateId,{posting:{createdTransactionCount:created,reusedTransactionCount:reused}})
        return result
      }})
    }
  }
}

module.exports = {
  POSTING_RULE_VERSION,
  createFinanceUpdatePosting,
  publicTransaction,
  transactionDraft,
  transactionDrafts,
  validateCurrentRefunds,
  validateEventState,
  loadPostingEvents,
  publishAccountMappings,
  validatePostingMappings,
  postingMappingRows
}
