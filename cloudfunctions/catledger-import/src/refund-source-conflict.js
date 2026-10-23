const { scopedStableReferences, timeValue } = require('./evidence-matching')
const { getRowSemantic } = require('./row-semantic-resolver')

// 只接受平台交易号/订单号。商户自编号、相同金额/日期/商户都不能证明这一组矛盾。
function references(event) {
  return (event.relationEvidence && event.relationEvidence.scopedStableReferences || [])
    .filter(value => /^(?:alipay|wechat)\|(?:transaction|order):/u.test(value) && !/[*＊•·xX]{2,}/u.test(value))
}

// 支付宝的退款行会在原订单号后面追加 "_<流水>"，平台号本身就是原单的派生，
// 属于平台编码而商户自编号。只认“同一前缀 + 明确分隔符”，避免把两笔独立订单
// 因为前缀巧合当成同一笔。
function referenceMatches(left, right) {
  if (left === right) return true
  if (!/\|order:/u.test(left) || !/\|order:/u.test(right)) return false
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  const head = long.slice(0, short.length)
  const tail = long.slice(short.length)
  return head === short && /^_/u.test(tail) && short.split(':')[1].length >= 10
}

function sameSource(left, right, sourceType) {
  const a = left.relationEvidence && left.relationEvidence.rows || []
  const b = right.relationEvidence && right.relationEvidence.rows || []
  return a.some(x => b.some(y => x.sourceType === sourceType && x.sourceType === y.sourceType &&
    (!x.sourceProfileId || !y.sourceProfileId || x.sourceProfileId === y.sourceProfileId)))
}

function reliableSharedReference(left, right) {
  const refs = references(left)
  return references(right).some(reference => refs.some(own => referenceMatches(own, reference)) &&
    sameSource(left, right, reference.split('|')[0]))
}

function findRefundSourceConflicts(events) {
  const closed = []
  for (const original of events) {
    if ((original.existingTransactionIds || []).length || !['expense', 'fee'].includes(original.economicNature)) continue
    const rows = original.relationEvidence && original.relationEvidence.rows || []
    if (!rows.length || !rows.every(row => row.direction === 'expense' && ['closed', 'failed'].includes(row.moneyEffect))) continue
    if (!references(original).length) continue
    closed.push(original)
  }
  const result = []
  for (const refund of events) {
    if (refund.economicNature !== 'refund' || !['ready', 'needs_action'].includes(refund.status)) continue
    const rows = refund.relationEvidence && refund.relationEvidence.rows || []
    if (!rows.length || !rows.every(row => row.sourceAction === 'refund_credit' && row.moneyEffect === 'financial')) continue
    const refundRefs = references(refund)
    const matches = new Map()
    for (const original of closed) {
      const shared = references(original).find(own => refundRefs.some(candidate => referenceMatches(own, candidate)))
      if (!shared) continue
      const before = timeValue(original.utcAt), after = timeValue(refund.utcAt)
      if (original.eventId === refund.eventId || original.currency !== refund.currency) continue
      if (before == null || after == null || before > after) continue
      if (!sameSource(original, refund, shared.split('|')[0])) continue
      matches.set(original.eventId, original)
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
