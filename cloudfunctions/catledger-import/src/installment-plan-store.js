const { importError } = require('./errors')
const { hintOf, isPlanSource } = require('./installment-business')

// 零流水登记仍是已处理来源。只读当前仍已入账的批次，撤销后的来源可以重新处理。
function postedPlanSql(rowAlias = 'r') {
  return `(SELECT JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.installmentPlan.loanId'))
    FROM catledger_import_rows old_row JOIN catledger_event_evidence old_evidence
      ON old_evidence.uid=old_row.uid AND old_evidence.row_id=old_row.row_id AND old_evidence.evidence_role<>'discarded'
    JOIN catledger_economic_events old ON old.uid=old_evidence.uid AND old.event_id=old_evidence.event_id
    JOIN catledger_finance_updates old_update ON old_update.uid=old.uid AND old_update.update_id=old.update_id
    JOIN catledger_loans processed_plan ON processed_plan.uid=old.uid
      AND processed_plan.loan_id=JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.installmentPlan.loanId'))
      AND processed_plan.deleted_at IS NULL
    WHERE old_row.uid=${rowAlias}.uid AND old_row.identity_id=${rowAlias}.identity_id AND old_update.status='posted'
      AND JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.installmentPlan.action')) IN ('link','create')
      AND (old.status='posted' AND (JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.disbursement.role'))='registration'
        OR JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.disbursement.role'))='disbursement'
        AND EXISTS (SELECT 1 FROM catledger_economic_event_transactions applied_link JOIN catledger_transactions applied
          ON applied.uid=applied_link.uid AND applied.transaction_id=applied_link.transaction_id AND applied.deleted_at IS NULL
          WHERE applied_link.uid=old.uid AND applied_link.event_id=old.event_id AND applied_link.superseded_at IS NULL))
        OR old.status='excluded' AND JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.disbursement.role'))='offset'
        AND EXISTS (SELECT 1 FROM catledger_event_evidence partner_evidence JOIN catledger_economic_events partner_event
          ON partner_event.uid=partner_evidence.uid AND partner_event.event_id=partner_evidence.event_id
          WHERE partner_evidence.uid=old.uid AND partner_evidence.update_id=old.update_id
            AND partner_evidence.row_id=JSON_UNQUOTE(JSON_EXTRACT(old.field_sources_json,'$.disbursement.partnerRowId'))
            AND partner_evidence.evidence_role<>'discarded' AND partner_event.status='posted'
            AND EXISTS (SELECT 1 FROM catledger_economic_event_transactions applied_link JOIN catledger_transactions applied
              ON applied.uid=applied_link.uid AND applied.transaction_id=applied_link.transaction_id AND applied.deleted_at IS NULL
              WHERE applied_link.uid=partner_event.uid AND applied_link.event_id=partner_event.event_id AND applied_link.superseded_at IS NULL)))
    ORDER BY old.update_id,old.event_id LIMIT 1)`
}

async function validatePlan(connection, uid, event) {
  if (!isPlanSource(event)) return null
  const plan = event.fieldSources.installmentPlan, hint = hintOf(event)
  if (!plan || plan.action === 'skip') return null
  if (!plan.loanId || plan.accountId !== event.ledgerAccountId) throw importError('LOAN_SOURCE_MISMATCH')
  const [[loan]] = await connection.execute(`SELECT l.loan_id AS loanId,l.account_id AS accountId,l.schedule_terms AS terms,
    l.kind,l.archived_at AS archivedAt,l.deleted_at AS deletedAt,a.type AS accountType
    FROM catledger_loans l JOIN catledger_accounts a ON a.uid=l.uid AND a.account_id=l.account_id
    WHERE l.uid=? AND l.loan_id=? AND a.archived_at IS NULL FOR UPDATE`, [uid, plan.loanId])
  if (!loan || loan.kind !== 'installment' || loan.archivedAt != null || loan.deletedAt != null ||
      loan.accountId !== event.ledgerAccountId || loan.accountType !== 'credit' ||
      Number(loan.terms) !== Number(plan.totalTerms) || hint.totalTerms && Number(loan.terms) !== Number(hint.totalTerms)) {
    throw importError('LOAN_SOURCE_MISMATCH')
  }
  return loan
}

// 调用方先锁来源 identity；名称/月/金额只用于候选，不能作为来源唯一身份。
async function recordPlan(connection, uid, event, identityIds, inBatch) {
  const loan = await validatePlan(connection, uid, event)
  if (!loan) return
  const ids = [...new Set(identityIds)]
  if (!ids.length) throw importError('IDENTITY_CONFLICT')
  const [history] = await connection.execute(`SELECT DISTINCT r.identity_id AS identityId,${postedPlanSql('r')} AS loanId
    FROM catledger_import_rows r WHERE r.uid=? AND r.identity_id IN (${ids.map(() => '?').join(',')})`, [uid, ...ids])
  for (const id of ids) {
    const previous = history.find(row => row.identityId === id && row.loanId)
    const claimed = inBatch.get(id) || previous && previous.loanId
    if (claimed && claimed !== loan.loanId) throw importError('LOAN_SOURCE_MISMATCH')
    inBatch.set(id, loan.loanId)
  }
  // 来源身份与其计划由已入账事件持久化；没有合同号就不伪造一个合同绑定键。
  const hint = hintOf(event)
  if (hint.referenceKey) {
    const key = hint.referenceKey
    const [[binding]] = await connection.execute(`SELECT loan_id AS loanId FROM catledger_installment_bindings
      WHERE uid=? AND account_id=? AND reference_key=? FOR UPDATE`, [uid, event.ledgerAccountId, key])
    if (binding && binding.loanId !== loan.loanId) throw importError('LOAN_SOURCE_MISMATCH')
    if (!binding) await connection.execute(`INSERT INTO catledger_installment_bindings (uid,account_id,reference_key,loan_id) VALUES (?,?,?,?)`,
      [uid, event.ledgerAccountId, key, loan.loanId])
  }
  await connection.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?', [uid, loan.loanId])
}
module.exports = { postedPlanSql, validatePlan, recordPlan }
