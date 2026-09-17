// 原始行只作待核对证据；不从说明猜金额、不修改原始快照或生成计划。
const LABELS = new Set(['期次','期号','当前期数','总期数','分期期数','本期期数','还款期数',
  '本金','本期本金','还款本金','应还本金','利息','本期利息','还款利息','应还利息',
  '费用','本期费用','手续费','本期手续费','分期手续费','到期日','还款日','还款日期'])
function clip(value, limit) { return Array.from(typeof value === 'string' ? value : '').slice(0, limit).join('') }
function evidenceView(row) {
  const raw = typeof row.rawFields === 'string' ? JSON.parse(row.rawFields) : row.rawFields
  const fields = (Array.isArray(raw) ? raw : []).filter(f => f && typeof f.name === 'string' && typeof f.value === 'string' &&
    f.value.trim() && LABELS.has(f.name.normalize('NFKC').trim().replace(/\s*\((?:元|期)\)\s*$/, '')))
  const texts = [row.item, row.note].filter(value => typeof value === 'string' && value.trim())
  return { fields: fields.slice(0, 8).map(f => ({ label: clip(f.name, 40), value: clip(f.value, 100) })),
    description: texts.map(value => clip(value, 160)).join(' · '),
    truncated: fields.length > 8 || fields.some(f => Array.from(f.name).length > 40 || Array.from(f.value).length > 100) ||
      texts.some(value => Array.from(value).length > 160) }
}
async function repaymentEvidence(connection, uid, eventId) {
  if (!eventId) return { items: [], hasMore: false }
  const [rows] = await connection.execute(`SELECT r.raw_fields_json AS rawFields,r.item_raw AS item,r.note_raw AS note
    FROM catledger_event_evidence e JOIN catledger_import_rows r ON r.uid=e.uid AND r.row_id=e.row_id
    WHERE e.uid=? AND e.event_id=? AND e.evidence_role<>'discarded'
    ORDER BY (e.evidence_role='primary') DESC,e.evidence_id LIMIT 6`, [uid,eventId])
  const items = rows.slice(0,5).map(evidenceView).filter(row => row.fields.length || row.description)
  return { items, hasMore: rows.length > 5 || items.some(row => row.truncated) }
}
module.exports = { evidenceView, repaymentEvidence }
