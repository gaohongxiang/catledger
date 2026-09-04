const {
  accountIdentityKeyForReference,
  expectedAccountType,
  paymentReferenceKey
} = require('./payment-account')

const MAPPING_SCOPE_PRIORITY = Object.freeze({
  inferred: 10,
  history: 20,
  batch: 30,
  event: 40
})

function mappingPriority(mapping) {
  return MAPPING_SCOPE_PRIORITY[mapping && mapping.mappingScope] || MAPPING_SCOPE_PRIORITY.batch
}

function compatibleMapping(mapping, reference, accountsById) {
  if (!mapping || !reference || !['account', 'ignore'].includes(mapping.mappingAction)) return false
  if (mapping.mappingAction === 'ignore') return !mapping.accountId
  if (!mapping.accountId) return false
  if (mapping.mappingScope !== 'history') return true
  const account = accountsById.get(mapping.accountId)
  const actualType = mapping.accountType || account && account.type || null
  const expectedType = expectedAccountType(mapping.sourceType, mapping.paymentMethodHint || reference.label)
  return !expectedType || !actualType || actualType === expectedType
}

function decisionFingerprint(mapping) {
  return mapping.mappingAction === 'account'
    ? `account:${mapping.accountId}`
    : 'ignore'
}

// PaymentReference 级别的索引也复用同一套优先级与冲突语义。
// planner、账户确认后的增量重算、整理问题处理都调用这里，任何阶段
// 都不能再各自实现“最后一个覆盖前一个”。
function createMappingIndex(mappings = []) {
  const index = new Map()
  const selected = new Map()
  for (const mapping of mappings) {
    if (!mapping || !mapping.sourceType || !mapping.paymentMethodKey ||
        !['account', 'ignore'].includes(mapping.mappingAction)) continue
    if (mapping.mappingScope === 'history' && mapping.mappingAction === 'account') {
      const expectedType = expectedAccountType(mapping.sourceType, mapping.paymentMethodHint)
      if (expectedType && mapping.accountType && mapping.accountType !== expectedType) continue
    }
    const key = paymentReferenceKey(mapping)
    const priority = mappingPriority(mapping)
    const accountId = mapping.mappingAction === 'account' ? mapping.accountId || null : null
    const prior = selected.get(key)
    if (prior && prior.priority > priority) continue
    if (prior && prior.priority === priority && prior.accountId !== accountId) {
      selected.set(key, { priority, accountId: null, conflict: true })
      index.set(key, null)
      continue
    }
    selected.set(key, { priority, accountId, conflict: false })
    index.set(key, accountId)
  }
  return index
}

// 把“现实账户身份”和“账单来源引用”分开裁决：界面按现实账户只问一次，
// 但结果仍展开成每个 sourceType + paymentMethodKey，供证据、草稿和 posting 使用。
function resolveAccountMappings({ references = [], mappings = [], accounts = [] }) {
  const referencesByKey = new Map()
  for (const reference of references) {
    const key = paymentReferenceKey(reference)
    if (!key || !accountIdentityKeyForReference(reference)) continue
    if (!referencesByKey.has(key)) referencesByKey.set(key, reference)
  }
  const groups = new Map()
  for (const reference of referencesByKey.values()) {
    const identityKey = accountIdentityKeyForReference(reference)
    const group = groups.get(identityKey) || []
    group.push(reference)
    groups.set(identityKey, group)
  }
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]))
  const candidatesByReference = new Map()
  for (const mapping of mappings) {
    const key = paymentReferenceKey(mapping)
    const reference = referencesByKey.get(key)
    if (!reference || !compatibleMapping(mapping, reference, accountsById)) continue
    const candidates = candidatesByReference.get(key) || []
    candidates.push(mapping)
    candidatesByReference.set(key, candidates)
  }

  const resolved = []
  const conflictIdentityKeys = new Set()
  const ignoredIdentityKeys = new Set()
  for (const [identityKey, groupReferences] of groups) {
    const candidates = groupReferences.flatMap((reference) => (
      candidatesByReference.get(paymentReferenceKey(reference)) || []
    ))
    if (!candidates.length) continue
    const priority = Math.max(...candidates.map(mappingPriority))
    const strongest = candidates.filter((mapping) => mappingPriority(mapping) === priority)
    const decisions = new Set(strongest.map(decisionFingerprint))
    if (decisions.size !== 1) {
      conflictIdentityKeys.add(identityKey)
      continue
    }
    const selected = [...strongest].sort((left, right) => (
      paymentReferenceKey(left).localeCompare(paymentReferenceKey(right)) ||
      String(left.accountId || '').localeCompare(String(right.accountId || ''))
    ))[0]
    if (selected.mappingAction === 'ignore' && selected.mappingScope === 'history') {
      ignoredIdentityKeys.add(identityKey)
      continue
    }
    for (const reference of groupReferences) {
      resolved.push({
        ...selected,
        sourceType: reference.sourceType,
        paymentMethodKey: reference.paymentMethodKey,
        paymentMethodHint: reference.label || selected.paymentMethodHint || '',
        accountIdentityKey: identityKey,
        propagated: paymentReferenceKey(reference) !== paymentReferenceKey(selected)
      })
    }
  }
  return { mappings: resolved, conflictIdentityKeys, ignoredIdentityKeys }
}

module.exports = {
  MAPPING_SCOPE_PRIORITY,
  createMappingIndex,
  mappingPriority,
  resolveAccountMappings
}
