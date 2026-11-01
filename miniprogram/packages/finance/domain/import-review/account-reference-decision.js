const ownership = require('./account-ownership')
const { funds } = require('./editor-fields')
const { importError } = require('./errors')

// 来源引用的角色与实际资金角色在此转换一次。外部是归属事实，不是付款账户 ID。
function sideFor(event, role) {
  if (role === 'mapping_from') return 'source'
  if (role === 'mapping_to' || role === 'payment_target') return 'destination'
  if (role !== 'subject') return null
  if (event.fieldSources?.fundsProjection?.accountOrder === 'actual') {
    return event.sourceDirection === 'income' ? 'destination' : 'source'
  }
  return ['income', 'refund'].includes(event.economicNature) || funds(event).reverse ? 'destination' : 'source'
}
function canRecord(event, role = 'subject', reference = require('./account-ownership-recheck').referenceFor(event, role)) {
  return Boolean(event && ['ready', 'needs_action', 'excluded'].includes(event.status) &&
    (sideFor(event, role) || /^payment_component_\d+$/.test(role) && reference?.memberRole === role))
}
function supported(event, role = 'subject') {
  const fields = event.fieldSources || {}
  return Boolean(sideFor(event, role) && ownership.resolve(event).supported &&
    !fields.installment && !fields.disbursement && !fields.installmentPlan &&
    ownership.read(event).businessNature !== 'borrow')
}
function apply(event, role, kind, accountId = null, options = {}) {
  const recheck = require('./account-ownership-recheck'), reference = options.reference || recheck.referenceFor(event, role)
  if (kind === 'external' && canRecord(event, role, reference) && recheck.requiresReview(event)) {
    return recheck.record(event, role, reference, sideFor(event, role) || (/^payment_component_/.test(role) ? 'source' : null))
  }
  if (!supported(event, role) || !['ledger', 'external'].includes(kind)) throw importError('VALIDATION_ERROR')
  event = recheck.clear(event, role, reference)
  const current = ownership.read(event), side = sideFor(event, role)
  const value = { source: current.source, destination: current.destination,
    [side]: { kind, accountId: kind === 'ledger' ? accountId : null } }
  if (value.source.kind === 'external' && value.destination.kind === 'external') value.noLedgerImpact = true
  return ownership.apply(event, value, options)
}
module.exports = { apply, sideFor, supported, canRecord }
