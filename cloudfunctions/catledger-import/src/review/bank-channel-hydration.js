const { selectPlanningRows } = require('../finance-update-repository')
const { selectDomainEvents } = require('./event-store')

async function hydrate(connection, uid, updateId, events = null, rows = null, { forUpdate = true } = {}) {
  rows = rows || await selectPlanningRows(connection, uid, updateId)
  const [links] = await connection.execute(`SELECT e.event_id AS eventId, e.row_id AS rowId, e.evidence_id AS evidenceId,
    e.evidence_role AS role, i.identity_kind AS identityKind FROM catledger_event_evidence e
    JOIN catledger_import_rows r ON r.uid = e.uid AND r.row_id = e.row_id
    LEFT JOIN catledger_source_identities i ON i.uid = r.uid AND i.identity_id = r.identity_id
    WHERE e.uid = ? AND e.update_id = ? AND e.evidence_role <> 'discarded'
    ORDER BY (e.evidence_role = 'primary') DESC, e.evidence_id`, [uid, updateId])
  events = events || await selectDomainEvents(connection, uid, updateId, [...new Set(links.map(link => link.eventId))], { forUpdate })
  const hydrated = hydrateEvidence(events, rows, links)
  // 还款候选的银行端是本人信用卡，不能把同名的资产账户当作还入端。
  // 元数据只用于本次核对，不写入来源或列表快照。
  if (hydrated.some(event => event.sourceType === 'bank' && event.economicNature === 'repayment')) {
    const [accounts] = await connection.execute(`SELECT account_id AS accountId,name,type,currency,archived_at AS archivedAt
      FROM catledger_accounts WHERE uid = ? AND archived_at IS NULL
      UNION ALL SELECT draft_account_id AS accountId,name,type,currency,NULL AS archivedAt
      FROM catledger_finance_update_account_drafts WHERE uid = ? AND update_id = ? AND materialized_at IS NULL`, [uid, uid, updateId])
    const byAccount = new Map(accounts.map(account => [account.accountId, account]))
    for (const event of hydrated) {
      event.ledgerAccountFacts = byAccount.get(event.ledgerAccountId) || null
      event.counterpartyAccountFacts = byAccount.get(event.counterpartyLedgerAccountId) || null
    }
  }
  return hydrated
}

function hydrateEvidence(events, rows, links) {
  const byId = new Map(rows.map(row => [row.rowId, row]))
  const rowsByEvent = new Map()
  for (const link of links) {
    if (!rowsByEvent.has(link.eventId)) rowsByEvent.set(link.eventId, [])
    if (byId.has(link.rowId)) rowsByEvent.get(link.eventId).push({ ...byId.get(link.rowId), identityKind: link.identityKind })
  }
  return events.map(event => ({ ...event, sourceType: (rowsByEvent.get(event.eventId) || [])[0]?.sourceType,
    relationEvidence: { rows: rowsByEvent.get(event.eventId) || [] } }))
}

function hasBankPlatformEvidence(events) {
  const types = new Set(events.flatMap(event => event.relationEvidence.rows.map(row => row.sourceType)))
  return types.has('bank') && (types.has('wechat') || types.has('alipay'))
}

module.exports = { hydrate, hydrateEvidence, hasBankPlatformEvidence }
