const REPAYMENT_ALLOCATION_VERSION = 'repayment-allocation-v2'
const EXTERNAL_REPAYMENT_VERSION = 'repayment-allocation-v3'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POSITIVE_MINOR_RE = /^[1-9]\d{0,18}$/

function invalid(reason) {
  return { valid: false, reason, allocations: [] }
}

function inspectRepaymentAllocations(value, totalAmountMinor, { allowExternal = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) return invalid('repayment_allocation_required')
  if (value.length > 20 || !POSITIVE_MINOR_RE.test(String(totalAmountMinor || ''))) {
    return invalid('repayment_allocation_invalid')
  }
  const accountIds = new Set()
  const allocations = []
  let total = 0n
  for (const item of value) {
    const external = allowExternal && item?.kind === 'external'
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        (external ? item.accountId != null : !UUID_RE.test(String(item.accountId || ''))) ||
        item.kind != null && !['ledger', 'external'].includes(item.kind) || item.kind === 'external' && !external ||
        item.referenceRole != null && !require('./account-ownership-recheck').roleValid(item.referenceRole) ||
        !POSITIVE_MINOR_RE.test(String(item.amountMinor || '')) || BigInt(item.amountMinor) > 9223372036854775807n) {
      return invalid('repayment_allocation_invalid')
    }
    if (!external && accountIds.has(item.accountId)) return invalid('repayment_allocation_account_duplicate')
    if (!external) accountIds.add(item.accountId)
    const amountMinor = String(item.amountMinor)
    total += BigInt(amountMinor)
    allocations.push({ accountId: external ? null : item.accountId, amountMinor,
      ...(external ? { kind: 'external' } : {}), ...(item.referenceRole ? { referenceRole: item.referenceRole } : {}) })
  }
  if (total !== BigInt(totalAmountMinor)) return invalid('repayment_allocation_amount_mismatch')
  return {
    valid: true,
    reason: '',
    allocations: allocations.sort((left, right) => (left.accountId || '').localeCompare(right.accountId || ''))
  }
}

function repaymentAllocationsForEvent(event) {
  const fieldSources = event && event.fieldSources || {}
  if (!['repayment-allocation-v1', REPAYMENT_ALLOCATION_VERSION, EXTERNAL_REPAYMENT_VERSION].includes(fieldSources.repaymentAllocationVersion)) {
    return invalid('repayment_allocation_required')
  }
  if (fieldSources.repaymentAllocationVersion === EXTERNAL_REPAYMENT_VERSION &&
      (fieldSources.editorOverrides?.version !== 1 || fieldSources.editorOverrides.composition !== 'repayment')) return invalid('repayment_allocation_invalid')
  const allocation = inspectRepaymentAllocations(fieldSources.repaymentAllocations, event && event.amountMinor,
    { allowExternal: fieldSources.repaymentAllocationVersion === EXTERNAL_REPAYMENT_VERSION })
  if (!allocation.valid || !isAggregateRepayment(event)) return allocation
  // v2 人工选择的资格由可信账户目录校验；来源候选仅作为推荐。
  // 已保存的 v1 决定保留原版本语义，不读时重写旧草稿。
  if ([REPAYMENT_ALLOCATION_VERSION, EXTERNAL_REPAYMENT_VERSION].includes(fieldSources.repaymentAllocationVersion)) return allocation
  const allowedAccountIds = new Set((fieldSources.fundsProjection.to.candidates || [])
    .map((candidate) => candidate && candidate.accountId)
    .filter((accountId) => UUID_RE.test(String(accountId || ''))))
  if (allowedAccountIds.size === 0 || allocation.allocations.some((item) => !allowedAccountIds.has(item.accountId))) {
    return invalid('repayment_allocation_target_not_allowed')
  }
  return allocation
}

function isAggregateRepayment(event) {
  const fields = event && event.fieldSources || {}, editor = fields.editorOverrides
  if (editor && editor.version === 1 && editor.composition) return event.economicNature === 'repayment' && editor.composition === 'repayment'
  const projection = fields.fundsProjection
  if (!(event && event.economicNature === 'repayment' && projection && projection.to &&
      projection.to.referenceKind === 'aggregate')) return false
  // 已保存的人工分配优先于后来的自动唯一推断；显式 single 编辑在上面处理。
  if (Object.prototype.hasOwnProperty.call(fields, 'repaymentAllocationVersion') ||
      Object.prototype.hasOwnProperty.call(fields, 'repaymentAllocations')) return true
  // 族账户已被解析为唯一负债账户时，这笔还款就是普通单账户还款，
  // 不再需要拆分配置；只有族内仍不唯一时才按聚合还款处理。
  if (event.counterpartyLedgerAccountId && projection.to.resolvedAccountId === event.counterpartyLedgerAccountId) return false
  return true
}

module.exports = {
  REPAYMENT_ALLOCATION_VERSION,
  EXTERNAL_REPAYMENT_VERSION,
  inspectRepaymentAllocations,
  isAggregateRepayment,
  repaymentAllocationsForEvent
}
