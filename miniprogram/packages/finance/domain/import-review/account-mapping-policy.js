const { accountIdentityKeyForReference, expectedAccountType, paymentReferenceKey } = require('./payment-account')
const binding = require('./account-binding')
const { digestParts } = require('./portable-digest')

const MAPPING_SCOPE_PRIORITY = Object.freeze({ inferred: 10, history_alias: 15, history: 20, batch_alias: 25, batch: 30, event: 40 })
function mappingPriority(mapping) { return MAPPING_SCOPE_PRIORITY[mapping && mapping.mappingScope] || MAPPING_SCOPE_PRIORITY.batch }
function decisionFingerprint(mapping) { return mapping.mappingAction === 'account' ? 'account:' + mapping.accountId : mapping.mappingAction }
function mappingAccount(mapping, accountsById) {
  return accountsById.get(mapping.accountId) || (mapping.accountType && mapping.accountCurrency ? {
    accountId: mapping.accountId, type: mapping.accountType, currency: mapping.accountCurrency,
    archivedAt: mapping.accountArchivedAt, supersededAt: mapping.accountSupersededAt
  } : null)
}
function bindingKeyValid(mapping, proof) {
  return proof && proof.version === binding.VERSION && proof.confirmedBy === 'user' &&
    mapping.paymentMethodKey === digestParts(binding.VERSION, mapping.sourceType, proof.scopeKind,
      proof.scopeKey, proof.identityKey, proof.currency)
}
function compatibleMapping(mapping, reference, accountsById = new Map()) {
  if (!mapping || !['account', 'external', 'ignore'].includes(mapping.mappingAction)) return false
  const scope = mapping.mappingScope || 'batch'
  if (['inferred', 'history_alias', 'batch_alias'].includes(scope)) return false
  const proof = binding.bindingFor(mapping)
  if (scope === 'history' && (!bindingKeyValid(mapping, proof) || !proof.reusable || mapping.mappingAction === 'ignore')) return false
  if (reference?.binding && !binding.bindingMatches(mapping, reference, { reusable: scope === 'history' })) return false
  if (mapping.mappingAction !== 'account') return !mapping.accountId
  const account = mappingAccount(mapping, accountsById)
  const ref = reference || { sourceType: mapping.sourceType, label: mapping.paymentMethodHint,
    binding: proof, expectedAccountType: expectedAccountType(mapping.sourceType, mapping.paymentMethodHint) }
  return binding.compatibleAccount(ref, account)
}
function resolution(mapping) {
  return { kind: mapping.mappingAction === 'account' ? 'ledger' : mapping.mappingAction,
    accountId: mapping.mappingAction === 'account' ? mapping.accountId : null,
    binding: binding.bindingFor(mapping), mappingScope: mapping.mappingScope || 'batch' }
}
function strongest(candidates) {
  if (!candidates.length) return { selected: null, conflict: false }
  const priority = Math.max(...candidates.map(mappingPriority))
  const best = candidates.filter(item => mappingPriority(item) === priority)
  if (new Set(best.map(decisionFingerprint)).size !== 1) return { selected: null, conflict: true }
  return { selected: best[0], conflict: false }
}

// 同一裁决同时供规划、增量核对和本机使用。冲突不会被随后第三条同级记录清掉。
function createMappingIndex(mappings = [], { accounts = [], eventId = null } = {}) {
  const accountById = new Map(accounts.map(account => [account.accountId, account])), groups = new Map(), index = new Map()
  for (const mapping of mappings) {
    if (mapping.eventId && mapping.eventId !== eventId) continue
    const key = paymentReferenceKey(mapping)
    if (!key || !compatibleMapping(mapping, null, accountById)) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(mapping)
  }
  for (const [key, candidates] of groups) {
    const result = strongest(candidates)
    index.set(key, result.conflict ? { kind: 'conflict', accountId: null } : resolution(result.selected))
  }
  if (!eventId) {
    const byEvent = new Map()
    for (const mapping of mappings) if (mapping.eventId) {
      if (!byEvent.has(mapping.eventId)) byEvent.set(mapping.eventId, [])
      byEvent.get(mapping.eventId).push(mapping)
    }
    index.eventMappings = byEvent
    index.accounts = accounts
    index.commonMappings = mappings.filter(mapping => !mapping.eventId)
    index.eventIndexes = new Map()
  }
  return index
}
function indexForEvent(index, event) {
  if (index?.eventIndexes?.has(event.eventId)) return index.eventIndexes.get(event.eventId)
  if (!index?.eventMappings || !index.eventMappings.has(event.eventId)) return index
  if (!index.eventIndexes.has(event.eventId)) index.eventIndexes.set(event.eventId,
    createMappingIndex(index.commonMappings.concat(index.eventMappings.get(event.eventId)),
      { accounts: index.accounts, eventId: event.eventId }))
  return index.eventIndexes.get(event.eventId)
}
function resolutionFromIndex(index, reference) {
  const key = typeof reference === 'string' ? reference : paymentReferenceKey(reference)
  const value = index && index.get(key)
  // 兼容内部调用传入的已验证旧索引；公开决定必须经上述校验构造索引。
  return typeof value === 'string' ? { kind: 'ledger', accountId: value } : value || { kind: 'unknown', accountId: null }
}
function accountIdFromIndex(index, reference) {
  const value = resolutionFromIndex(index, reference)
  return value.kind === 'ledger' ? value.accountId : null
}
function setMappingDecision(index, reference, mappingAction, accountId, eventId = null) {
  const key = typeof reference === 'string' ? reference : paymentReferenceKey(reference)
  if (!index || !key) return
  if (eventId && index.eventMappings) {
    if (!index.eventIndexes.has(eventId)) index.eventIndexes.set(eventId, new Map(index))
    index = index.eventIndexes.get(eventId)
  }
  index.set(key, resolution({ mappingAction, accountId, mappingScope: 'batch', binding: binding.confirmedBinding(reference) }))
}

function resolveAccountMappings({ references = [], mappings = [], accounts = [] }) {
  const referencesByKey = new Map(), referencesByLegacy = new Map(), groups = new Map(), accountsById = new Map(accounts.map(account => [account.accountId, account]))
  for (const reference of references) {
    const key = paymentReferenceKey(reference), identity = accountIdentityKeyForReference(reference)
    if (!key || !identity || referencesByKey.has(key)) continue
    referencesByKey.set(key, reference)
    const legacy = paymentReferenceKey(reference.sourceType, reference.paymentMethodKey)
    if (!referencesByLegacy.has(legacy)) referencesByLegacy.set(legacy, [])
    referencesByLegacy.get(legacy).push(reference)
    if (!groups.has(identity)) groups.set(identity, [])
    groups.get(identity).push(reference)
  }
  const candidatesByKey = new Map(), suggestions = new Map()
  for (const mapping of mappings) {
    const key = paymentReferenceKey(mapping), reference = referencesByKey.get(key)
    if (reference && compatibleMapping(mapping, reference, accountsById)) {
      if (!candidatesByKey.has(key)) candidatesByKey.set(key, [])
      candidatesByKey.get(key).push(mapping)
    }
    if (mapping.mappingAction !== 'account') continue
    const account = mappingAccount(mapping, accountsById)
    if (!account) continue
    const candidates = new Set([reference, ...(referencesByLegacy.get(paymentReferenceKey(mapping.sourceType,
      binding.bindingFor(mapping)?.legacyPaymentMethodKey || mapping.paymentMethodKey)) || [])].filter(Boolean))
    for (const ref of candidates) {
      const refKey = paymentReferenceKey(ref)
      if (mapping.sourceType !== ref.sourceType || !binding.compatibleAccount(ref, account)) continue
      if (mapping.paymentMethodKey !== ref.paymentMethodKey && key !== refKey) continue
      if (!suggestions.has(refKey)) suggestions.set(refKey, new Set())
      suggestions.get(refKey).add(mapping.accountId)
    }
  }
  const resolved = [], conflictIdentityKeys = new Set(), ignoredIdentityKeys = new Set(), externalIdentityKeys = new Set()
  for (const [identityKey, groupReferences] of groups) {
    const candidates = groupReferences.flatMap(reference => candidatesByKey.get(paymentReferenceKey(reference)) || [])
    const result = strongest(candidates)
    if (result.conflict) { conflictIdentityKeys.add(identityKey); continue }
    const selected = result.selected
    if (!selected) continue
    if (selected.mappingAction === 'ignore') { ignoredIdentityKeys.add(identityKey); continue }
    if (selected.mappingAction === 'external') externalIdentityKeys.add(identityKey)
    for (const reference of groupReferences) {
      // 不把一份来源的确认扩成另一份弱引用；新引用须逐一有对应依据。
      if (reference.binding && !binding.bindingMatches(selected, reference)) continue
      const account = mappingAccount(selected, accountsById)
      resolved.push({ ...selected, sourceType: reference.sourceType,
        paymentMethodKey: reference.bindingKey || reference.paymentMethodKey,
        paymentMethodHint: reference.label || selected.paymentMethodHint || '', accountIdentityKey: identityKey,
        accountType: account?.type || null, accountCurrency: account?.currency || null,
        accountArchivedAt: account?.archivedAt || null, binding: binding.bindingFor(selected),
        propagated: paymentReferenceKey(reference) !== paymentReferenceKey(selected) })
    }
  }
  return { mappings: resolved, conflictIdentityKeys, ignoredIdentityKeys, externalIdentityKeys, suggestions }
}
module.exports = { MAPPING_SCOPE_PRIORITY, accountIdFromIndex, compatibleMapping, createMappingIndex, indexForEvent, mappingPriority,
  resolutionFromIndex, resolveAccountMappings, setMappingDecision }
