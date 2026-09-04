const REFUND_MATCH_KIND = Object.freeze({
  EXACT_REFERENCE: 'exact_reference',
  EXPLICIT_EVIDENCE: 'explicit_refund_evidence',
  ITEM_EVIDENCE: 'item_evidence',
  MERCHANT_EVIDENCE: 'merchant_evidence'
})

const MATCH_RANK = Object.freeze({
  [REFUND_MATCH_KIND.EXACT_REFERENCE]: 1,
  [REFUND_MATCH_KIND.EXPLICIT_EVIDENCE]: 2,
  [REFUND_MATCH_KIND.ITEM_EVIDENCE]: 3,
  [REFUND_MATCH_KIND.MERCHANT_EVIDENCE]: 4
})

const AUTO_CONFIRM_KINDS = new Set([
  REFUND_MATCH_KIND.EXACT_REFERENCE,
  REFUND_MATCH_KIND.EXPLICIT_EVIDENCE
])

const STRONG_REFERENCE_WINDOW_MS = 72 * 60 * 60 * 1000
const ITEM_EVIDENCE_WINDOW_MS = 72 * 60 * 60 * 1000
const REFUND_CANDIDATE_WINDOW_MS = 180 * 24 * 60 * 60 * 1000

function timeValue(value) {
  if (!value) return null
  const parsed = Date.parse(String(value).replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) ? parsed : null
}

function canonicalEvidenceText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160)
}

function canonicalItemText(value) {
  const withoutBusinessPrefix = String(value || '').normalize('NFKC').toLowerCase().trim()
    .replace(/^(?:(?:退款|全款交易|交易商品|商品)(?:成功|到账)?[\s:：\-—_|｜]*)+/u, '')
  return canonicalEvidenceText(withoutBusinessPrefix)
}

function explicitRefundAmountFromStatus(value) {
  const status = String(value || '').normalize('NFKC')
  const match = status.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)/u)
  if (!match) return null
  const parts = match[1].split('.')
  return BigInt(parts[0]) * 100n + BigInt((parts[1] || '').padEnd(2, '0'))
}

function accountsCompatibleForRelation(left, right) {
  if (left.ledgerAccountId && right.ledgerAccountId) return left.ledgerAccountId === right.ledgerAccountId
  return Boolean(left.accountGroupingKey && left.accountGroupingKey === right.accountGroupingKey)
}

function baseCandidateEligible(refund, original) {
  if (!refund || !original || refund.eventId === original.eventId) return false
  if (!['expense', 'fee'].includes(original.economicNature) || original.status === 'excluded') return false
  if (original.currency !== refund.currency || original.amountMinor == null || refund.amountMinor == null) return false
  if (BigInt(original.amountMinor) < BigInt(refund.amountMinor)) return false
  const refundTime = timeValue(refund.utcAt)
  const originalTime = timeValue(original.utcAt)
  if (refundTime == null || originalTime == null || refundTime < originalTime) return false
  if (refundTime - originalTime > REFUND_CANDIDATE_WINDOW_MS) return false
  return accountsCompatibleForRelation(refund, original)
}

function sharedScopedReference(refund, original) {
  const refundReferences = new Set(refund.relationEvidence && refund.relationEvidence.scopedStableReferences || [])
  const originalReferences = original.relationEvidence && original.relationEvidence.scopedStableReferences || []
  return originalReferences.some((reference) => refundReferences.has(reference))
}

function explicitSourceRefundMatch(refund, original) {
  const refundRows = refund.relationEvidence && refund.relationEvidence.rows || []
  const originalRows = original.relationEvidence && original.relationEvidence.rows || []
  return originalRows.some((originalRow) => refundRows.some((refundRow) => {
    if (originalRow.sourceType !== refundRow.sourceType ||
        originalRow.economicEffect !== 'refund' || refundRow.economicEffect !== 'refund' ||
        originalRow.direction !== 'expense' || !['income', 'neutral'].includes(refundRow.direction) ||
        originalRow.amountMinor == null || refundRow.amountMinor == null ||
        originalRow.currency !== refundRow.currency) return false
    const originalTime = timeValue(originalRow.utcAt)
    const refundTime = timeValue(refundRow.utcAt)
    if (originalTime == null || refundTime == null || refundTime < originalTime ||
        refundTime - originalTime > STRONG_REFERENCE_WINDOW_MS) return false
    const expectedRefund = explicitRefundAmountFromStatus(originalRow.rawStatus)
    const originalMerchant = canonicalEvidenceText(originalRow.counterparty)
    const refundMerchant = canonicalEvidenceText(refundRow.counterparty)
    return expectedRefund != null && expectedRefund === BigInt(refundRow.amountMinor) &&
      BigInt(refundRow.amountMinor) <= BigInt(originalRow.amountMinor) &&
      originalMerchant.length >= 2 && originalMerchant === refundMerchant
  }))
}

function merchantEvidenceMatch(refund, original) {
  if (refund.sourceType !== original.sourceType) return false
  const refundMerchant = canonicalEvidenceText(refund.display && refund.display.counterparty)
  const originalMerchant = canonicalEvidenceText(original.display && original.display.counterparty)
  return refundMerchant.length >= 2 && refundMerchant === originalMerchant
}

function itemEvidenceMatch(refund, original) {
  if (refund.sourceType !== original.sourceType || refund.amountMinor !== original.amountMinor) return false
  const refundTime = timeValue(refund.utcAt)
  const originalTime = timeValue(original.utcAt)
  if (refundTime == null || originalTime == null || refundTime < originalTime ||
      refundTime - originalTime > ITEM_EVIDENCE_WINDOW_MS) return false
  const refundItem = canonicalItemText(refund.display && refund.display.item)
  const originalItem = canonicalItemText(original.display && original.display.item)
  return refundItem.length >= 6 && refundItem === originalItem
}

function matchKind(refund, original) {
  if (sharedScopedReference(refund, original)) return REFUND_MATCH_KIND.EXACT_REFERENCE
  if (explicitSourceRefundMatch(refund, original)) return REFUND_MATCH_KIND.EXPLICIT_EVIDENCE
  if (itemEvidenceMatch(refund, original)) return REFUND_MATCH_KIND.ITEM_EVIDENCE
  if (merchantEvidenceMatch(refund, original)) return REFUND_MATCH_KIND.MERCHANT_EVIDENCE
  return null
}

function selectRefundCandidates(refund, events) {
  const matches = (events || []).filter((event) => baseCandidateEligible(refund, event))
    .map((event) => ({ event, matchKind: matchKind(refund, event) }))
    .filter((candidate) => candidate.matchKind)
  if (!matches.length) return { candidates: [], autoConfirm: false, matchKind: null }
  const bestRank = Math.min(...matches.map((candidate) => MATCH_RANK[candidate.matchKind]))
  const candidates = matches.filter((candidate) => MATCH_RANK[candidate.matchKind] === bestRank)
    .sort((left, right) => {
      const leftTime = timeValue(left.event.utcAt) || 0
      const rightTime = timeValue(right.event.utcAt) || 0
      return rightTime - leftTime || left.event.eventId.localeCompare(right.event.eventId)
    })
  return {
    candidates,
    matchKind: candidates[0].matchKind,
    autoConfirm: candidates.length === 1 && AUTO_CONFIRM_KINDS.has(candidates[0].matchKind)
  }
}

function candidateReasonCode(kind) {
  if (kind === REFUND_MATCH_KIND.EXACT_REFERENCE) return 'refund_exact_reference_candidate'
  if (kind === REFUND_MATCH_KIND.EXPLICIT_EVIDENCE) return 'refund_explicit_evidence_candidate'
  if (kind === REFUND_MATCH_KIND.ITEM_EVIDENCE) return 'refund_item_evidence_candidate'
  return 'refund_merchant_evidence_candidate'
}

function autoReasonCode(kind) {
  if (kind === REFUND_MATCH_KIND.EXACT_REFERENCE) return 'auto_refund_exact_reference'
  return 'auto_refund_explicit_evidence'
}

module.exports = {
  REFUND_MATCH_KIND,
  autoReasonCode,
  baseCandidateEligible,
  candidateReasonCode,
  selectRefundCandidates
}
