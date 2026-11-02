// 上层组合已经各自验证的业务结果；底层归属事实不反向依赖业务解析器。
const facts = require('./account-ownership-recheck')
const { paymentResolutionForEvent } = require('./payment-resolution')
const { repaymentAllocationsForEvent } = require('./repayment-allocation')
const ownership = require('./account-ownership')
const { sideFor } = require('./account-reference-decision')
const { paymentReferenceKey } = require('./payment-account')
function inspect(event) {
  return { payment: paymentResolutionForEvent(event), repayment: repaymentAllocationsForEvent(event),
    ownership: ownership.read(event), sideFor }
}
function pending(event) { return facts.pending(event, inspect(event)) }
function publicState(event) { return facts.publicState(event, inspect(event)) }
function restoreAfterSplit(merged, restoredEvents, primaryId) {
  const saved = facts.entries(merged), matched = new Set()
  const restored = restoredEvents.map(event => {
    let next = { ...event, fieldSources: { ...event.fieldSources } }
    delete next.fieldSources.accountOwnershipRecheck
    next.reasonCodes = (next.reasonCodes || []).filter(reason => reason !== facts.REASON)
    const roles = ['subject', 'mapping_from', 'mapping_to', 'payment_target',
      ...(next.fieldSources.paymentAccountReferences || []).map(reference => reference.memberRole)]
    for (const [index, entry] of saved.entries()) {
      if (!entry.referenceKey) continue
      const role = [...new Set(roles)].find(role => paymentReferenceKey(facts.referenceFor(next, role)) === entry.referenceKey)
      if (!role) continue
      matched.add(index)
      next = require('./account-reference-decision').apply(next, role, 'external')
    }
    return next
  })
  // 无法再定位的旧引用留在主记录待核对，不能在拆分时悄悄遗失归属决定。
  const primary = restored.find(event => event.eventId === primaryId) || restored[0]
  if (primary) {
    const retained = saved.filter((_, index) => !matched.has(index))
    if (retained.length) {
      primary.fieldSources.accountOwnershipRecheck = { version: facts.VERSION, confirmedBy: 'user', entries: facts.entries(primary).concat(retained) }
      primary.status = 'needs_action'
      primary.reasonCodes = [...new Set(primary.reasonCodes.concat(facts.REASON))]
    }
  }
  return restored
}
module.exports = { pending, publicState, restoreAfterSplit }
