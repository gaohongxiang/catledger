const STRONG_REFERENCE_WINDOW_MS = 72 * 60 * 60 * 1000

function timeValue(value) {
  if (!value) return null
  const parsed = Date.parse(String(value).replace(' ', 'T') + 'Z')
  return Number.isFinite(parsed) ? parsed : null
}

function normalizedText(row) {
  return `${row.counterparty || ''} ${row.item || ''} ${row.sourceNote || ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160)
}

function stableReferences(row) {
  return [
    ['transaction', row.sourceTransactionId],
    ['order', row.sourceOrderId],
    ['merchant_order', row.sourceMerchantOrderId]
  ].filter(([, value]) => typeof value === 'string' && value.normalize('NFKC').trim().length >= 6)
    .map(([kind, value]) => `${kind}:${value.normalize('NFKC').trim().toLowerCase()}`)
}

function scopedStableReferences(row) {
  return stableReferences(row).map((reference) => `${row.sourceType || 'unknown'}|${reference}`)
}

function compatibleCore(left, right, windowMs = STRONG_REFERENCE_WINDOW_MS) {
  if (String(left.amountMinor) !== String(right.amountMinor) || left.currency !== right.currency || left.direction !== right.direction) {
    return false
  }
  const leftTime = timeValue(left.utcAt)
  const rightTime = timeValue(right.utcAt)
  return leftTime != null && rightTime != null && Math.abs(leftTime - rightTime) <= windowMs
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index)
  function find(value) {
    let current = value
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  return {
    find,
    union(left, right) {
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
    }
  }
}

function groupEvidence(rows) {
  const groups = new Map()
  const union = unionFind(rows.length)
  const identityIndexes = new Map()
  const referenceIndexes = new Map()

  rows.forEach((row, index) => {
    if (row.identityId && row.identityState !== 'identity_conflict') {
      const prior = identityIndexes.get(row.identityId)
      if (prior != null) union.union(prior, index)
      else identityIndexes.set(row.identityId, index)
    }
    stableReferences(row).forEach((reference) => {
      const candidates = referenceIndexes.get(reference) || []
      for (const prior of candidates) {
        if (rows[prior].sourceType !== row.sourceType && compatibleCore(rows[prior], row)) {
          union.union(prior, index)
        }
      }
      candidates.push(index)
      referenceIndexes.set(reference, candidates)
    })
  })

  rows.forEach((row, index) => {
    const root = union.find(index)
    const group = groups.get(root) || []
    group.push(row)
    groups.set(root, group)
  })
  return [...groups.values()].map((group) => group.sort((left, right) => (
    left.sourceOrder - right.sourceOrder || left.rowNumber - right.rowNumber || left.rowId.localeCompare(right.rowId)
  )))
}

module.exports = { STRONG_REFERENCE_WINDOW_MS, timeValue, normalizedText, stableReferences, scopedStableReferences, compatibleCore, groupEvidence }
