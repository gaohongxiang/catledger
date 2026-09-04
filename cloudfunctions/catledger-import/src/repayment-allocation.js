const REPAYMENT_ALLOCATION_VERSION = 'repayment-allocation-v1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POSITIVE_MINOR_RE = /^[1-9]\d{0,18}$/

function invalid(reason) {
  return { valid: false, reason, allocations: [] }
}

function inspectRepaymentAllocations(value, totalAmountMinor) {
  if (!Array.isArray(value) || value.length === 0) return invalid('repayment_allocation_required')
  if (value.length > 20 || !POSITIVE_MINOR_RE.test(String(totalAmountMinor || ''))) {
    return invalid('repayment_allocation_invalid')
  }
  const accountIds = new Set()
  const allocations = []
  let total = 0n
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        !UUID_RE.test(String(item.accountId || '')) || !POSITIVE_MINOR_RE.test(String(item.amountMinor || ''))) {
      return invalid('repayment_allocation_invalid')
    }
    if (accountIds.has(item.accountId)) return invalid('repayment_allocation_account_duplicate')
    accountIds.add(item.accountId)
    const amountMinor = String(item.amountMinor)
    total += BigInt(amountMinor)
    allocations.push({ accountId: item.accountId, amountMinor })
  }
  if (total !== BigInt(totalAmountMinor)) return invalid('repayment_allocation_amount_mismatch')
  return {
    valid: true,
    reason: '',
    allocations: allocations.sort((left, right) => left.accountId.localeCompare(right.accountId))
  }
}

function repaymentAllocationsForEvent(event) {
  const fieldSources = event && event.fieldSources || {}
  if (fieldSources.repaymentAllocationVersion !== REPAYMENT_ALLOCATION_VERSION) {
    return invalid('repayment_allocation_required')
  }
  const allocation = inspectRepaymentAllocations(fieldSources.repaymentAllocations, event && event.amountMinor)
  if (!allocation.valid || !isAggregateRepayment(event)) return allocation
  const allowedAccountIds = new Set((fieldSources.fundsProjection.to.candidates || [])
    .map((candidate) => candidate && candidate.accountId)
    .filter((accountId) => UUID_RE.test(String(accountId || ''))))
  if (allowedAccountIds.size === 0 || allocation.allocations.some((item) => !allowedAccountIds.has(item.accountId))) {
    return invalid('repayment_allocation_target_not_allowed')
  }
  return allocation
}

function isAggregateRepayment(event) {
  const projection = event && event.fieldSources && event.fieldSources.fundsProjection
  return Boolean(event && event.economicNature === 'repayment' && projection && projection.to &&
    projection.to.referenceKind === 'aggregate')
}

module.exports = {
  REPAYMENT_ALLOCATION_VERSION,
  inspectRepaymentAllocations,
  isAggregateRepayment,
  repaymentAllocationsForEvent
}
