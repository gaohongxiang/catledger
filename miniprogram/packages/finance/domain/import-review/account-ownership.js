const { ASSETS, DEBTS, MOVEMENTS, funds, overrides } = require('./funds-route')
const { FIELD_MASK } = require('./manual-field-mask')
const { importError } = require('./errors')

const VERSION = 'account-ownership-v1'
const KINDS = new Set(['ledger', 'external', 'unknown'])
const NATURES = new Set(['income', 'expense', 'fee', 'refund', 'internal_transfer', 'repayment', 'borrow', 'unknown'])
const EXTERNAL_REASON = 'external_no_ledger_effect'
const LEGACY_VERSIONS = new Set(['repayment-ownership-v1', 'repayment-ownership-v2'])
const has = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const fail = () => { throw importError('VALIDATION_ERROR') }

function legacyDecision(event) {
  const value = event.fieldSources && event.fieldSources.repaymentOwnership
  return value && LEGACY_VERSIONS.has(value.version) && value.confirmedBy === 'user' &&
    ['self', 'other'].includes(value.owner) ? value : null
}

function canonicalDecision(event) {
  const value = event.fieldSources && event.fieldSources.accountOwnership
  return value && value.version === VERSION && value.confirmedBy === 'user' &&
    NATURES.has(value.businessNature) && KINDS.has(value.source) && KINDS.has(value.destination) &&
    (!has(value, 'noLedgerImpact') || typeof value.noLedgerImpact === 'boolean') ? value : null
}

// Account IDs live only on the event. A source row's income/expense direction
// reverses movement storage, but never reverses the actual funding direction.
function actualAccounts(event) {
  if (['income', 'refund'].includes(event.economicNature)) return {
    sourceAccountId: event.counterpartyLedgerAccountId || null,
    destinationAccountId: event.ledgerAccountId || null
  }
  return funds(event)
}

function read(event = {}) {
  const fields = event.fieldSources || {}, canonical = canonicalDecision(event)
  // A malformed new decision must not revive a conflicting legacy decision.
  const canonicalPresent = has(fields, 'accountOwnership') && fields.accountOwnership != null
  const legacy = canonicalPresent ? null : legacyDecision(event)
  const route = actualAccounts(event)
  const businessNature = canonical ? canonical.businessNature : legacy ? 'repayment' : event.economicNature || 'unknown'
  let source = route.sourceAccountId ? 'ledger' : ['income', 'refund'].includes(event.economicNature) ? 'external' : 'unknown'
  let destination = route.destinationAccountId ? 'ledger' : ['expense', 'fee'].includes(event.economicNature) ? 'external' : 'unknown'
  if (canonical) { source = canonical.source; destination = canonical.destination }
  else if (legacy) {
    source = route.sourceAccountId ? 'ledger' : 'unknown'
    destination = legacy.owner === 'other' ? 'external' : route.destinationAccountId ? 'ledger' : 'unknown'
  }
  return {
    businessNature,
    source: { kind: source, accountId: route.sourceAccountId || null },
    destination: { kind: destination, accountId: route.destinationAccountId || null },
    explicit: Boolean(canonical || legacy),
    origin: canonicalPresent ? 'canonical' : legacy ? 'legacy' : 'implicit',
    invalid: canonicalPresent && !canonical,
    noLedgerImpact: Boolean(canonical && canonical.noLedgerImpact),
    pendingLegacyTreatment: Boolean(legacy && legacy.owner === 'other' && legacy.treatment === 'pending')
  }
}

function complex(event) {
  const fields = event.fieldSources || {}, editor = overrides(event)
  return Boolean(fields.paymentResolution || editor.composition !== 'single' && (fields.paymentAccounts || []).length ||
    (fields.repaymentAllocations || []).length || editor.incompleteComposition ||
    fields.repaymentChannelResolution || fields.bankChannelResolution ||
    fields.loanRepayment || editor.incompleteRepayment)
}

function protectedBusiness(event) {
  const fields = event.fieldSources || {}
  return Boolean(fields.installment || fields.disbursement || fields.installmentPlan)
}

function accountIndex(accounts) {
  if (accounts == null) return null
  return Array.isArray(accounts) ? new Map(accounts.map(account => [account.accountId, account])) : accounts
}

function accountReasons(view, event, accounts) {
  const index = accountIndex(accounts), reasons = []
  for (const side of ['source', 'destination']) {
    const endpoint = view[side]
    if (endpoint.kind === 'unknown' || endpoint.kind === 'ledger' && !endpoint.accountId) {
      reasons.push('account_' + side + '_required')
      continue
    }
    if (endpoint.kind !== 'ledger') {
      if (endpoint.accountId) reasons.push('account_ownership_invalid')
      continue
    }
    if (!index) continue // Existence and permissions remain the caller's transaction check.
    const account = index.get(endpoint.accountId)
    if (!account || account.archivedAt != null || account.disabledAt != null ||
        account.currency !== (event.currency || 'CNY')) {
      reasons.push('account_ownership_invalid')
      continue
    }
    if (view.businessNature === 'repayment' && !protectedBusiness(event)) {
      if (!(side === 'source' ? ASSETS : DEBTS).has(account.type)) reasons.push('account_ownership_invalid')
    } else if (view.businessNature === 'borrow') {
      if (!(side === 'source' ? DEBTS : ASSETS).has(account.type)) reasons.push('account_ownership_invalid')
    }
  }
  if (view.source.kind === 'ledger' && view.destination.kind === 'ledger' &&
      view.source.accountId && view.source.accountId === view.destination.accountId) reasons.push('account_ownership_invalid')
  return reasons
}

// Derivation does not save accounts, rewrite source evidence, or create money.
// Ordinary income/expense already imply their external counterparty; they do
// not acquire another ownership question just by passing through this reader.
function resolve(event, { accounts } = {}) {
  const view = read(event), supported = !complex(event)
  const result = { ...view, supported, economicNature: event.economicNature,
    flowDirection: event.flowDirection, noLedgerImpact: false, requiresDecision: false, reasons: [] }
  if (!supported) return result
  const reasons = accountReasons(view, event, accounts)
  if (view.invalid) reasons.push('account_ownership_invalid')
  if (view.pendingLegacyTreatment) reasons.push('account_ownership_recheck_required')
  const from = view.source.kind, to = view.destination.kind
  const missing = from === 'unknown' || to === 'unknown' ||
    from === 'ledger' && !view.source.accountId || to === 'ledger' && !view.destination.accountId
  result.requiresDecision = Boolean((view.explicit || view.businessNature === 'repayment') && missing)
  if (view.invalid || view.pendingLegacyTreatment || missing) {
    result.reasons = [...new Set(reasons)]
    return result
  }
  if (from === 'external' && to === 'external') {
    if (view.noLedgerImpact && view.explicit) result.noLedgerImpact = true
    else reasons.push('external_no_ledger_effect_required')
  } else if (view.noLedgerImpact) reasons.push('account_ownership_invalid')
  else if (['repayment', 'internal_transfer'].includes(view.businessNature) && !protectedBusiness(event)) {
    result.economicNature = from === 'ledger' && to === 'ledger' ? view.businessNature
      : from === 'ledger' ? 'expense' : 'income'
    result.flowDirection = result.economicNature === 'expense' ? 'outflow' : result.economicNature === 'income' ? 'inflow' : 'neutral'
  } else if (view.businessNature === 'borrow' || protectedBusiness(event)) {
    // A loan or installment retains its own source/plan contract. Crossing the
    // ledger boundary cannot turn its principal into ordinary income/expense.
    if (MOVEMENTS.has(view.businessNature) && (from !== 'ledger' || to !== 'ledger')) reasons.push('account_ownership_business_required')
  } else if (['income', 'refund'].includes(view.businessNature)) {
    if (from !== 'external' || to !== 'ledger') reasons.push('account_ownership_business_required')
  } else if (['expense', 'fee'].includes(view.businessNature)) {
    if (from !== 'ledger' || to !== 'external') reasons.push('account_ownership_business_required')
  }
  result.reasons = [...new Set(reasons)]
  return result
}

function endpoint(value, current) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !KINDS.has(value.kind) ||
      Object.keys(value).some(key => !['kind', 'accountId'].includes(key))) fail()
  if (value.kind !== 'ledger') {
    if (value.accountId != null) fail()
    return { kind: value.kind, accountId: null }
  }
  const accountId = has(value, 'accountId') ? value.accountId : current.kind === 'ledger' ? current.accountId : null
  if (accountId != null && (typeof accountId !== 'string' || !accountId.trim())) fail()
  return { kind: 'ledger', accountId: accountId || null }
}

function storedAccounts(event, nature, source, destination) {
  if (['income', 'refund'].includes(nature)) return { ledgerAccountId: destination.accountId,
    counterpartyLedgerAccountId: source.accountId }
  const reverse = MOVEMENTS.has(nature) && funds({ ...event, economicNature: nature }).reverse
  return { ledgerAccountId: reverse ? destination.accountId : source.accountId,
    counterpartyLedgerAccountId: reverse ? source.accountId : destination.accountId }
}

function apply(event, value, options = {}) {
  if (!event || complex(event) || ['posted', 'corrected'].includes(event.status) ||
      !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['source', 'destination', 'noLedgerImpact'].includes(key)) ||
      has(value, 'noLedgerImpact') && typeof value.noLedgerImpact !== 'boolean') fail()
  const current = read(event), source = endpoint(value.source, current.source), destination = endpoint(value.destination, current.destination)
  if (!NATURES.has(current.businessNature)) fail()
  const bothExternal = source.kind === 'external' && destination.kind === 'external'
  if (bothExternal !== (value.noLedgerImpact === true)) fail()
  const decision = { version: VERSION, confirmedBy: 'user', businessNature: current.businessNature,
    source: source.kind, destination: destination.kind, ...(bothExternal ? { noLedgerImpact: true } : {}) }
  const fieldSources = { ...event.fieldSources, accountOwnership: decision }
  delete fieldSources.repaymentOwnership
  if (fieldSources.editorOverrides && has(fieldSources.editorOverrides, 'ownershipCleared')) {
    fieldSources.editorOverrides = { ...fieldSources.editorOverrides }
    delete fieldSources.editorOverrides.ownershipCleared
  }
  // First express the chosen actual endpoints in the original business route,
  // then derive the accounting presentation and store its canonical accounts.
  const base = { ...event, economicNature: current.businessNature, fieldSources,
    ...storedAccounts(event, current.businessNature, source, destination) }
  const resolved = resolve(base, options)
  if (resolved.reasons.includes('account_ownership_invalid') || resolved.reasons.includes('account_ownership_business_required')) fail()
  const next = { ...event, ...storedAccounts(event, resolved.economicNature, source, destination),
    economicNature: resolved.economicNature, flowDirection: resolved.flowDirection, fieldSources,
    manualFieldMask: ((event.manualFieldMask || 0) & ~FIELD_MASK.repaymentOwnership) |
      FIELD_MASK.ledgerAccountId | FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.economicNature | FIELD_MASK.flowDirection,
    reasonCodes: (event.reasonCodes || []).filter(reason => !/^repayment_(?:ownership|other_treatment)_/.test(reason) &&
      !/^account_(?:source|destination)_required$/.test(reason) && !/^account_ownership_/.test(reason) &&
      ![EXTERNAL_REASON, 'external_no_ledger_effect_required'].includes(reason)) }
  if (resolved.economicNature !== event.economicNature || MOVEMENTS.has(resolved.economicNature)) next.categoryId = null
  if (resolved.noLedgerImpact) {
    next.status = 'excluded'
    next.categoryId = null
    next.reasonCodes = next.reasonCodes.filter(reason => !['manual_exclusion', 'account_mapping_excluded', 'source_account_ignored_default'].includes(reason))
    next.reasonCodes.push(EXTERNAL_REASON)
  } else if (event.status === 'ready' || event.status === 'excluded' && current.noLedgerImpact) next.status = 'needs_action'
  next.reasonCodes = [...new Set([...next.reasonCodes, ...resolved.reasons])]
  return next
}

module.exports = { VERSION, EXTERNAL_REASON, apply, read, resolve }
