const { expectedAccountType } = require('./payment-account')
const { ASSETS, DEBTS, funds } = require('./funds-route')

const TYPES = Object.freeze(['cash', 'bank', 'wallet', 'credit', 'other_asset', 'other_liability'])

function actualSide(event = {}, role = 'subject') {
  if (role === 'mapping_from' || role === 'from' || /^payment_component_\d+$/.test(role)) return 'source'
  if (['mapping_to', 'to', 'payment_target', 'repayment_target'].includes(role)) return 'destination'
  if (!['subject', 'ordinary', 'ledger_account'].includes(role)) return null
  if (event.fieldSources?.fundsProjection?.accountOrder === 'actual' || event.fundsProjection?.accountOrder === 'actual') {
    return event.sourceDirection === 'income' ? 'destination' : 'source'
  }
  return ['income', 'refund'].includes(event.economicNature) || funds(event).reverse ? 'destination' : 'source'
}

// 类型与实际资金端共享一个契约；显示名称只在来源没有明确类型时提供默认值。
function rules(reference = {}, { event = {}, memberRole, side } = {}) {
  const value = reference.value || reference.label || ''
  let expected = Object.prototype.hasOwnProperty.call(reference, 'expectedAccountType')
    ? reference.expectedAccountType : expectedAccountType(reference.sourceType, value)
  const role = memberRole || reference.memberRole || reference.fundsSide || reference.role || 'subject'
  const nature = event.fieldSources?.accountOwnership?.businessNature || event.economicNature ||
    (role === 'repayment_target' || role === 'payment_target' ? 'repayment' : '')
  const endpoint = side || actualSide({ ...event, economicNature: nature }, role)
  const protectedSource = event.fieldSources?.installment || event.installment || event.fieldSources?.disbursement || event.disbursement
  let allowed = null
  if (!protectedSource && nature === 'repayment' && endpoint) allowed = [...(endpoint === 'source' ? ASSETS : DEBTS)]
  if (!protectedSource && nature === 'borrow' && endpoint) allowed = [...(endpoint === 'source' ? DEBTS : ASSETS)]
  // “某银行(尾号)”在还入目标位置只说明机构，不能据此把负债端建议成储蓄账户。
  if (allowed && allowed.every(type => DEBTS.has(type)) && expected === 'bank' &&
      !/储蓄|借记/u.test(value)) expected = null
  if (expected && TYPES.includes(expected)) allowed = allowed ? allowed.filter(type => type === expected) : [expected]
  if (!allowed) allowed = [...TYPES]
  // 页面读取服务端按实际成员角色算出的范围；只允许收窄，不能靠显示标签放宽。
  if (Array.isArray(reference.allowedAccountTypes)) allowed = allowed.filter(type => reference.allowedAccountTypes.includes(type))
  const fallback = /主卡/u.test(value) ? 'credit' : reference.sourceType === 'bank' ? 'bank' : 'wallet'
  const defaultAccountType = allowed.includes(reference.defaultAccountType) ? reference.defaultAccountType
    : expected && allowed.includes(expected) ? expected
    : allowed.includes(fallback) ? fallback : allowed[0] || null
  return { expectedAccountType: expected || null, allowedAccountTypes: allowed, defaultAccountType,
    fundsRole: endpoint }
}

function compatible(reference, account, context) {
  if (!account || !account.accountId || account.archivedAt != null || account.disabledAt != null ||
      account.supersededAt != null || account.unavailable) return false
  return account.currency === (reference.binding?.currency || reference.currency || 'CNY') &&
    rules(reference, context).allowedAccountTypes.includes(account.type)
}

function forMembers(contexts) {
  const values = contexts.map(({ reference, event, memberRole }) => event
    ? rules(reference || { currency: event.currency }, { event, memberRole }).allowedAccountTypes : [])
  return values.length ? TYPES.filter(type => values.every(allowed => allowed.includes(type))) : []
}

module.exports = { TYPES, actualSide, rules, compatible, forMembers }
