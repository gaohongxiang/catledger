const { SEMANTIC_HARD_BLOCKERS } = require('./semantic-policy')

const RELATION_BLOCKERS = new Set([
  ...SEMANTIC_HARD_BLOCKERS,
  'core_fields_conflict', 'core_fields_missing', 'economic_nature_required',
  'identity_conflict', 'identity_review_required', 'postability_direction_conflict',
  'refund_relation_ambiguous', 'refund_relation_invalid', 'refund_relation_required',
  'relation_ambiguous', 'transaction_status_unknown'
])

// 归宿只有这个入口生成。用户排除改变是否入账，不改来源是否已被理解。
function deriveRowDisposition(row, links, eventsById) {
  const semantic = row.semantic
  const active = links.filter((link) => link.evidenceRole !== 'discarded')
  const event = active.length === 1 ? eventsById.get(active[0].eventId) : null
  const invalid = row.parseState !== 'valid'
  const conflict = active.length > 1 || semantic && semantic.resolutionStatus === 'conflict'
  const recognized = !invalid && !conflict && semantic && semantic.resolutionStatus === 'resolved' &&
    !(row.issues || []).some((issue) => ['row_extra_columns', 'file_header_unknown'].includes(issue.code)) &&
    !(event && (event.reasonCodes || []).some((reason) => RELATION_BLOCKERS.has(reason)))
  let disposition
  if (invalid) disposition = 'invalid'
  else if (active.length > 1) disposition = 'needs_confirmation'
  else if (semantic && ['non_financial', 'failed', 'closed'].includes(semantic.moneyEffect)) disposition = 'non_financial'
  else if ((!active.length && links.some((link) => link.evidenceRole === 'discarded')) ||
      event && event.status === 'excluded' && !(event.reasonCodes || []).includes('already_posted')) disposition = 'user_excluded'
  else if (!event) disposition = 'unassigned'
  else if (active[0].evidenceRole === 'duplicate' || (event.reasonCodes || []).includes('already_posted')) disposition = 'duplicate'
  else if (!recognized || event.status === 'needs_action') disposition = 'needs_confirmation'
  else disposition = 'financial'
  return { rowId: row.rowId, disposition, recognized: Boolean(recognized && disposition !== 'unassigned'), conflict: Boolean(conflict) }
}

module.exports = { deriveRowDisposition, RELATION_BLOCKERS }
