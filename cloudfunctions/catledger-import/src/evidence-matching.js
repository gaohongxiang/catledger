const STRONG_REFERENCE_WINDOW_MS = 72 * 60 * 60 * 1000
const { digestParts } = require('./digest')

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

function compareEvidence(left, right) {
  return left.sourceOrder - right.sourceOrder || left.rowNumber - right.rowNumber || left.rowId.localeCompare(right.rowId)
}

function strongIdentity(row) {
  if (row.identityKind === 'physical_record') return null
  const clean = value => typeof value === 'string' && value.trim() && !/[*＊•·xX]{2,}/.test(value)
  if (row.identityKind || clean(row.sourceTransactionId) || clean(row.sourceOrderId) && clean(row.sourceMerchantOrderId)) {
    return row.identityId || JSON.stringify([row.sourceProfileId || '', row.sourceTransactionId || '', row.sourceOrderId || '', row.sourceMerchantOrderId || ''])
  }
  return null
}

function hasSourceIdentityConflict(rows) {
  const identities = new Map()
  for (const row of rows) {
    const identity = strongIdentity(row)
    if (!identity) continue
    const scope = row.sourceType || 'unknown'
    if (identities.has(scope) && identities.get(scope) !== identity) return true
    identities.set(scope, identity)
  }
  return false
}

function hasGroupConflict(rows) {
  if (hasSourceIdentityConflict(rows)) return true
  if (rows.length < 2) return false
  const times = rows.map(row => timeValue(row.utcAt))
  return rows.some(row => !compatibleCore(rows[0], row)) ||
    Math.max(...times) - Math.min(...times) > STRONG_REFERENCE_WINDOW_MS
}

function identityGroups(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = row.identityId && row.identityState !== 'identity_conflict' ? row.identityId : row.rowId
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return [...groups.values()].map(group => group.sort(compareEvidence)).sort((a, b) => compareEvidence(a[0], b[0]))
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
  // 先完成候选分量再整体裁决，不能贪心保留第一条边而把结果交给输入顺序。
  return [...groups.values()].flatMap((rows) => {
    const atomic = identityGroups(rows)
    if (atomic.length < 2 || !hasGroupConflict(rows)) return [rows.sort(compareEvidence)]
    const conflictKey = digestParts('evidence-group-conflict-v1', ...rows.map(row => row.identityId || row.rowId).sort())
    return atomic.map(group => Object.assign(group, { conflictKey }))
  }).sort((a, b) => compareEvidence(a[0], b[0]))
}

module.exports = { STRONG_REFERENCE_WINDOW_MS, timeValue, normalizedText, stableReferences, scopedStableReferences,
  compatibleCore, groupEvidence, hasSourceIdentityConflict, hasGroupConflict, identityGroups }
