const { scopedStableReferences, timeValue } = require('./evidence-matching')
const { getRowSemantic } = require('./row-semantic-resolver')

// 只接受平台交易号/订单号。商户自编号、相同金额/日期/商户都不能证明这一组矛盾。
function references(event) {
  return (event.relationEvidence && event.relationEvidence.scopedStableReferences || [])
    .filter(value => /^(?:alipay|wechat)\|(?:transaction|order):/u.test(value) && !/[*＊•·xX]{2,}/u.test(value))
}

function sameSource(left, right, sourceType) {
  const a = left.relationEvidence && left.relationEvidence.rows || []
  const b = right.relationEvidence && right.relationEvidence.rows || []
  return a.some(x => b.some(y => x.sourceType === sourceType && x.sourceType === y.sourceType &&
    (!x.sourceProfileId || !y.sourceProfileId || x.sourceProfileId === y.sourceProfileId)))
}

function reliableSharedReference(left, right) {
  const refs = new Set(references(left))
  return references(right).some(reference => refs.has(reference) && sameSource(left, right, reference.split('|')[0]))
}

function findRefundSourceConflicts(events) {
  const byReference = new Map()
  for (const original of events) {
    if ((original.existingTransactionIds || []).length || !['expense', 'fee'].includes(original.economicNature)) continue
    const rows = original.relationEvidence && original.relationEvidence.rows || []
    if (!rows.length || !rows.every(row => row.direction === 'expense' && ['closed', 'failed'].includes(row.moneyEffect))) continue
    for (const reference of references(original)) {
      if (!byReference.has(reference)) byReference.set(reference, [])
      byReference.get(reference).push(original)
    }
  }
  const result = []
  for (const refund of events) {
    if (refund.economicNature !== 'refund' || !['ready', 'needs_action'].includes(refund.status)) continue
    const rows = refund.relationEvidence && refund.relationEvidence.rows || []
    if (!rows.length || !rows.every(row => row.sourceAction === 'refund_credit' && row.moneyEffect === 'financial')) continue
    const matches = new Map()
    for (const reference of references(refund)) for (const original of byReference.get(reference) || []) {
      const before = timeValue(original.utcAt), after = timeValue(refund.utcAt)
      if (original.eventId !== refund.eventId && original.currency === refund.currency &&
          before != null && after != null && before <= after && sameSource(original, refund, reference.split('|')[0])) matches.set(original.eventId, original)
    }
    if (matches.size) result.push({ refund, originals: [...matches.values()] })
  }
  return result
}

function withRefundSourceEvidence(event, rows) {
  return { ...event,
    existingTransactionIds: [...new Set(rows.map(row => row.existingTransactionId).filter(Boolean))],
    relationEvidence: {
      scopedStableReferences: [...new Set(rows.flatMap(scopedStableReferences))],
      rows: rows.map(row => ({ sourceType: row.sourceType, sourceProfileId: row.sourceProfileId,
        direction: row.direction, sourceAction: getRowSemantic(row).sourceAction, moneyEffect: getRowSemantic(row).moneyEffect }))
    }
  }
}

function applyRefundSourceConflict(event, originals) {
  return { ...event, status: 'needs_action',
    fieldSources: { ...event.fieldSources, refundSourceConflict: { version: 1,
      originalEventIds: originals.map(original => original.eventId).sort() } },
    reasonCodes: [...new Set([...(event.reasonCodes || []), 'refund_source_conflict'])]
  }
}

module.exports = { findRefundSourceConflicts, withRefundSourceEvidence, applyRefundSourceConflict, reliableSharedReference }
