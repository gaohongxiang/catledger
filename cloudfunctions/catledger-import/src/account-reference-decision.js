const ownership = require('./account-ownership')
const { funds } = require('./editor-fields')
const { importError } = require('./errors')

// 来源引用的角色与实际资金角色在此转换一次。外部是归属事实，不是付款账户 ID。
function sideFor(event, role) {
  if (role === 'mapping_from') return 'source'
  if (role === 'mapping_to' || role === 'payment_target') return 'destination'
  if (role !== 'subject') return null
  return ['income', 'refund'].includes(event.economicNature) || funds(event).reverse ? 'destination' : 'source'
}
function supported(event, role = 'subject') {
  const fields = event.fieldSources || {}
  return Boolean(sideFor(event, role) && ownership.resolve(event).supported &&
    !fields.installment && !fields.disbursement && !fields.installmentPlan &&
    ownership.read(event).businessNature !== 'borrow')
}
function apply(event, role, kind, accountId = null, options = {}) {
  if (!supported(event, role) || !['ledger', 'external'].includes(kind)) throw importError('VALIDATION_ERROR')
  const current = ownership.read(event), side = sideFor(event, role)
  const value = { source: current.source, destination: current.destination,
    [side]: { kind, accountId: kind === 'ledger' ? accountId : null } }
  if (value.source.kind === 'external' && value.destination.kind === 'external') value.noLedgerImpact = true
  return ownership.apply(event, value, options)
}
module.exports = { apply, sideFor, supported }
