const { VERSION: BINDING_VERSION, fullAccountNumber } = require('./account-binding')
const { TYPES } = require('./account-type-policy')
const { primaryInstrument, safeDisplayName } = require('./payment-account')
const { digestParts } = require('./portable-digest')

// These groups describe one explicit, current-batch confirmation. They never
// replace a source binding, account identity, issue ID or saved user decision.
const OWN_SOURCE_ROLES = new Set(['ledger_account', 'payment_method'])
const ACCOUNT_ROLES = new Set([...OWN_SOURCE_ROLES, 'platform_balance', 'platform_savings',
  'counterparty_account', 'repayment_target'])
const SOURCE_TYPES = new Set(['alipay', 'wechat', 'bank'])
const BLOCKED_DECISIONS = new Set(['external', 'excluded'])
const DATE_LABEL = /(?:19|20)\d{2}\s*[-/.年]\s*(?:0?[1-9]|1[0-2])\s*[-/.月]\s*(?:0?[1-9]|[12]\d|3[01])\s*日?/gu

function text(value) { return String(value == null ? '' : value).normalize('NFKC').trim() }
function compare(left, right) { return left < right ? -1 : left > right ? 1 : 0 }
function unique(values) { return [...new Set(values)] }
function intersection(values) { return TYPES.filter(type => values.every(allowed => allowed.includes(type))) }
function currency(value) { return text(value).toUpperCase() }

// A tail can suggest a shared confirmation only with the same institution and
// card kind. In particular, a person's name and a generic wallet name are not
// account locators. Do not use the legacy portable key: it truncates full numbers.
function cardEvidence(reference = {}) {
  if (!reference || typeof reference !== 'object') return null
  const sourceType = reference.sourceType
  if (!SOURCE_TYPES.has(sourceType)) return null
  const raw = primaryInstrument(reference.value || reference.label)
  if (!raw) return null
  const number = fullAccountNumber(sourceType, raw)
  const binding = reference.binding
  const reliableBinding = binding?.version === BINDING_VERSION && binding.scopeKind === 'instrument' &&
    binding.identityKind === 'full_number' && binding.reusable === true &&
    /^[a-f0-9]{64}$/i.test(binding.identityKey || '')
  let strongKey = reliableBinding ? binding.identityKey : null
  // A raw number rejected by parsing (for example a rounded spreadsheet cell)
  // must not silently regain strong identity here. An explicitly reliable raw
  // number supports callers that have not yet built a scoped reference.
  if (number) {
    const expected = digestParts(BINDING_VERSION, 'full_number', number)
    if (strongKey && strongKey !== expected) return null
    if (!strongKey && reference.numberReliable === true && !binding) strongKey = expected
    if (!strongKey) return null
  }
  const value = text(raw).replace(DATE_LABEL, ' ').replace(/^(?:支付宝(?:支付)?|微信(?:支付)?)/u, '').trim()
  const credit = /信用卡|贷记卡/u.test(value), debit = /储蓄卡|借记卡/u.test(value)
  if (credit && debit) return null
  const expected = reference.expectedAccountType
  const cardKind = credit ? 'credit' : debit ? 'bank' : ['bank', 'credit'].includes(expected) ? expected : null
  if (cardKind && expected && cardKind !== expected) return null
  const tails = []
  if (number) tails.push(number.slice(-4))
  for (const pattern of [/(?:尾号|末四位|后四位)\s*[:：]?\s*\(?\s*(\d{4})\s*\)?(?!\d)/gu,
    /[*＊•xX]{2,}\s*\(?\s*(\d{4})\s*\)?(?!\d)/gu, /\(\s*(\d{4})\s*\)/gu]) {
    let match
    while ((match = pattern.exec(value))) tails.push(match[1])
  }
  const distinctTails = unique(tails)
  if (distinctTails.length > 1) return null
  const tail = distinctTails[0]
  const institution = value.replace(/(?:\d[ -]?){7,}\d/gu, '')
    .replace(/(?:尾号|末四位|后四位)\s*[:：]?\s*\(?\s*\d{4}\s*\)?/gu, '')
    .replace(/[*＊•xX]{2,}\s*\(?\s*\d{4}\s*\)?/gu, '')
    .replace(/\(\s*\d{4}\s*\)/gu, '')
    .replace(/信用卡|贷记卡|储蓄卡|借记卡|主卡|卡号|账号|账户/gu, '')
    .replace(/[^A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff]/gu, '').toLowerCase()
  const namedInstitution = /(?:银行|信用社|联社)$/u.test(institution) &&
    !['银行', '信用社', '联社'].includes(institution) && !/\d/u.test(institution)
  const weakKey = tail && cardKind && namedInstitution
    ? digestParts('account-confirmation-tail-v1', institution, cardKind, tail) : null
  return strongKey || weakKey ? { strongKey, weakKey, cardKind } : null
}

function normalizedEntry(entry) {
  const issueId = text(entry?.issueId)
  if (!issueId || !Array.isArray(entry.members) || !entry.members.length ||
      BLOCKED_DECISIONS.has(entry.decision)) return null
  const confirmed = entry.status === 'resolved' && entry.decision === 'account' && Boolean(text(entry.accountId))
  const pending = entry.status === 'open' && entry.decision === 'pending' && !entry.accountId
  if (!confirmed && !pending) return null
  const accountId = confirmed ? text(entry.accountId) : null
  const members = entry.members
  if (members.some(member => !text(member?.eventId) || !ACCOUNT_ROLES.has(member.reference?.role) ||
      !SOURCE_TYPES.has(member.reference?.sourceType) || BLOCKED_DECISIONS.has(member.decision) ||
      member.accountId && text(member.accountId) !== accountId ||
      member.decision === 'account' && (!confirmed || !member.accountId))) return null
  const currencies = unique([entry.currency, ...members.flatMap(member =>
    [member.currency, member.reference?.currency, member.reference?.binding?.currency])].filter(Boolean).map(currency))
  if (currencies.length !== 1) return null
  const allowed = [Array.isArray(entry.allowedAccountTypes) ? entry.allowedAccountTypes : []]
  members.forEach(member => {
    const reference = member.reference
    if (Array.isArray(member.allowedAccountTypes)) allowed.push(member.allowedAccountTypes)
    if (Array.isArray(reference.allowedAccountTypes)) allowed.push(reference.allowedAccountTypes)
    if (reference.expectedAccountType) allowed.push([reference.expectedAccountType])
  })
  const evidence = members.map(member => cardEvidence(member.reference))
  evidence.forEach(value => { if (value?.cardKind) allowed.push([value.cardKind]) })
  const allowedAccountTypes = intersection(allowed)
  if (!allowedAccountTypes.length) return null
  const strongKeys = unique(evidence.filter(Boolean).map(value => value.strongKey).filter(Boolean))
  const weakKeys = unique(evidence.filter(Boolean).map(value => value.weakKey).filter(Boolean))
  const ownSource = members.every(member => OWN_SOURCE_ROLES.has(member.reference.role))
  const consistent = strongKeys.length <= 1 && (strongKeys.length
    ? evidence.every(value => value && (value.strongKey === strongKeys[0] ||
      !value.strongKey && value.weakKey && evidence.some(other => other?.strongKey && other.weakKey === value.weakKey)))
    : weakKeys.length === 1 && evidence.every(value => value?.weakKey === weakKeys[0]))
  return { original: entry, issueId, accountId, pending, members, currency: currencies[0], allowedAccountTypes,
    candidate: ownSource && consistent, strongKey: strongKeys[0] || null, weakKeys }
}

function groupCompatible(entries) {
  if (unique(entries.map(entry => entry.currency)).length !== 1 ||
      unique(entries.map(entry => entry.accountId).filter(Boolean)).length > 1 ||
      !intersection(entries.map(entry => entry.allowedAccountTypes)).length) return false
  const events = new Map()
  for (const entry of entries) for (const member of entry.members) {
    const eventId = text(member.eventId), side = member.actualSide
    if (!events.has(eventId)) events.set(eventId, { issues: new Set(), sides: new Set(), unknown: false })
    const event = events.get(eventId)
    event.issues.add(entry.issueId)
    if (['source', 'destination'].includes(side)) event.sides.add(side)
    else event.unknown = true
    // Across separate events the same card may receive or pay. Within one event
    // the two ends remain separate, including when an end cannot be established.
    if (event.sides.size > 1 || event.issues.size > 1 && event.unknown) return false
  }
  return true
}

function descriptor(entries, conflictReason) {
  const sorted = [...entries].sort((left, right) => compare(left.issueId, right.issueId))
  const issueIds = sorted.map(entry => entry.issueId), sources = new Map(), events = new Set()
  for (const entry of sorted) for (const member of entry.members) {
    const sourceId = text(member.sourceId), sourceType = member.sourceType || member.reference.sourceType
    const fileName = text(member.fileName), eventId = text(member.eventId)
    const sourceKey = sourceId || digestParts(sourceType, fileName, member.reference.binding?.scopeKey || entry.issueId)
    if (!sources.has(sourceKey)) sources.set(sourceKey, { sourceId, sourceType, fileName, events: new Set() })
    sources.get(sourceKey).events.add(eventId)
    events.add(eventId)
  }
  const first = sorted[0], reference = first.members[0].reference
  return {
    groupId: 'account-confirmation:' + digestParts('account-confirmation-group-v1', ...issueIds),
    issueIds, anchorIssueId: issueIds[0],
    label: safeDisplayName(first.original.label || reference.label || reference.value || '账户'),
    allowedAccountTypes: intersection(sorted.map(entry => entry.allowedAccountTypes)), currency: first.currency,
    memberCount: events.size, sourceCount: sources.size,
    sources: [...sources.values()].sort((left, right) => compare(left.sourceId, right.sourceId) ||
      compare(left.sourceType, right.sourceType) || compare(left.fileName, right.fileName))
      .map(source => ({ sourceId: source.sourceId, sourceType: source.sourceType, fileName: source.fileName, count: source.events.size })),
    candidate: sorted.some(entry => entry.pending), accountId: sorted.find(entry => entry.accountId)?.accountId || null,
    canExternal: sorted.every(entry => entry.original.canExternal === true),
    ...(conflictReason ? { conflictReason } : {})
  }
}

/**
 * Build display-only confirmation groups from the complete batch, before paging.
 * Each entry contains issueId, status, decision, accountId, currency,
 * allowedAccountTypes, canExternal and members[{eventId, actualSide, reference,
 * sourceId, sourceType, fileName}]. accountId is an explicit saved choice, never
 * a suggestion. Original issues and references must remain independently saved.
 * Only groups containing at least two original issues are returned.
 */
function buildGroups(input = []) {
  if (!Array.isArray(input)) return []
  const idCounts = new Map()
  input.forEach(entry => { const id = text(entry?.issueId); idCounts.set(id, (idCounts.get(id) || 0) + 1) })
  const entries = input.map(normalizedEntry).filter(entry => entry && idCounts.get(entry.issueId) === 1)
    .sort((left, right) => compare(left.issueId, right.issueId))
  const strongByTail = new Map(), strongGroups = new Map(), weakGroups = new Map()
  // Look for contradictory full numbers across the complete input, including
  // excluded/other-party entries. Filtering a card from the UI is not evidence
  // that an indistinguishable weak tail belongs to another card.
  for (const entry of input) for (const member of Array.isArray(entry?.members) ? entry.members : []) {
    const evidence = cardEvidence(member?.reference), unit = currency(entry.currency || member?.reference?.binding?.currency)
    if (!evidence?.strongKey || !evidence.weakKey || !unit) continue
    const key = unit + ':' + evidence.weakKey
    if (!strongByTail.has(key)) strongByTail.set(key, new Set())
    strongByTail.get(key).add(evidence.strongKey)
  }
  for (const entry of entries.filter(entry => entry.candidate)) {
    const map = entry.strongKey ? strongGroups : weakGroups
    const key = entry.currency + ':' + (entry.strongKey || entry.weakKeys[0])
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(entry)
  }
  const candidates = [], proposedAttachments = new Map()
  for (const [key, weak] of weakGroups) {
    const fullKeys = strongByTail.get(key) || new Set()
    if (fullKeys.size > 1) continue // A weak tail must never bridge two full numbers.
    const fullKey = [...fullKeys][0], strongKey = weak[0].currency + ':' + fullKey
    const strong = fullKey && strongGroups.get(strongKey)
    if (strong) {
      if (!proposedAttachments.has(strongKey)) proposedAttachments.set(strongKey, [])
      proposedAttachments.get(strongKey).push(...weak)
    } else candidates.push(weak)
  }
  // Check all aliases together. Picking the first weak bucket would silently
  // favor one manual choice when another alias has been assigned elsewhere.
  for (const [key, weak] of proposedAttachments) {
    const combined = [...strongGroups.get(key), ...weak]
    if (groupCompatible(combined)) strongGroups.set(key, combined)
  }
  candidates.push(...strongGroups.values())
  const result = [], used = new Set()
  for (const group of candidates) {
    if (group.length < 2 || !group.some(entry => entry.pending) || !groupCompatible(group)) continue
    const collision = group.some(entry => entry.strongKey && entry.weakKeys.some(key =>
      strongByTail.get(entry.currency + ':' + key)?.size > 1))
    result.push(descriptor(group, collision ? 'distinct_full_numbers_share_tail' : null))
    group.forEach(entry => used.add(entry.issueId))
  }
  // Explicitly bound instances of the same ledger account can share a display
  // card even without a number. This does not assert their raw labels are equal.
  const confirmedGroups = new Map()
  for (const entry of entries) {
    if (!entry.accountId || used.has(entry.issueId)) continue
    const key = entry.currency + ':' + entry.accountId
    if (!confirmedGroups.has(key)) confirmedGroups.set(key, [])
    confirmedGroups.get(key).push(entry)
  }
  for (const group of confirmedGroups.values()) {
    if (group.length >= 2 && groupCompatible(group)) result.push(descriptor(group))
  }
  return result.sort((left, right) => compare(left.anchorIssueId, right.anchorIssueId))
}

module.exports = { buildGroups }
