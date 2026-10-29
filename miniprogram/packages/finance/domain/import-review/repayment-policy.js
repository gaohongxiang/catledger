// 还款的纯规则：资金路径两端、本息费组成与交易草稿。客户端核对和正式入账共用。
// 付款端只能是资产账户；收款端只能是负债账户。信用卡和其他负债都能创建分期/贷款计划，
// 所以“能不能关联计划”就是“是不是负债账户”，不再按账户类型另开特例。
const ASSET_TYPES = Object.freeze(['cash', 'bank', 'wallet', 'other_asset'])
const LIABILITY_TYPES = Object.freeze(['credit', 'other_liability'])
function route(asset, debt) {
  return Boolean(asset && debt && ASSET_TYPES.includes(asset.type) && LIABILITY_TYPES.includes(debt.type))
}
// 导入还款什么时候要落一条贷款付款记录：用户明确关联了计划，或收款端是贷款账户（还入即视为还这笔贷款）。
// 信用卡不关联计划时只是一次卡债清偿，不产生待分配付款。
function writesLoanPayment(decision, debt) {
  return Boolean(decision && debt && (decision.mode === 'associate' || debt.type === 'other_liability'))
}
function createRepaymentPolicy(error) {
  function id(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw error('VALIDATION_ERROR')
    return value
  }
  function amount(value, positive = false) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n || (positive && value === '0')) throw error('VALIDATION_ERROR')
    return value
  }
  function normalize(value, totalMinor) {
    if (!value || value.confirmed !== true || !['defer','associate'].includes(value.mode)) throw error('VALIDATION_ERROR')
    const result = { chargeAllocations: require('./loan-charge-coverage').normalizeCoverage(value.chargeAllocations), confirmed: true, mode: value.mode, assetAccountId: id(value.assetAccountId), liabilityAccountId: id(value.liabilityAccountId) }
    for (const field of ['principal','interest','fee']) result[field + 'Minor'] = amount(value[field + 'Minor'])
    if (['principal','interest','fee'].reduce((sum, field) => sum + BigInt(result[field + 'Minor']), 0n) !== BigInt(amount(totalMinor, true))) throw error('VALIDATION_ERROR')
    for (const field of ['interest','fee']) {
      const minor = result[field + 'Minor'], treatment = value[field + 'Treatment']
      // 明确填 0 就是没有这一项，不要求选择处理方式；未知才是留空。
      if (minor === '0') {
        result[field + 'Treatment'] = ['expense','accrued'].includes(treatment) ? treatment : 'expense'
        result[field + 'CategoryId'] = null
        continue
      }
      if (!['expense','accrued'].includes(treatment)) throw error('VALIDATION_ERROR')
      result[field + 'Treatment'] = treatment
      result[field + 'CategoryId'] = treatment === 'expense' ? id(value[field + 'CategoryId']) : null
    }
    if (result.mode === 'associate') {
      result.loanId = id(value.loanId)
      if (!Number.isSafeInteger(value.loanVersion) || value.loanVersion < 1) throw error('VALIDATION_ERROR')
      result.loanVersion = value.loanVersion
    }
    return result
  }
  function drafts(input) {
    const result = []
    let transfer = BigInt(input.principalMinor)
    for (const field of ['interest','fee']) {
      if (input[field + 'Treatment'] === 'accrued') transfer += BigInt(input[field + 'Minor'])
      else if (input[field + 'Minor'] !== '0') {
        const selected=(input.chargeAllocations||[]).filter(c=>c.component===field)
        const portions=selected.length?selected:[{amountMinor:input[field+'Minor']}]
        for(const portion of portions)result.push({type:'expense',sourceAccountId:input.assetAccountId,destinationAccountId:null,
          categoryId:input[field+'CategoryId'],originalTransactionId:null,amountMinor:portion.amountMinor,role:'repayment_allocation',
          ...(portion.chargeId?{chargeId:portion.chargeId}:{})})
      }
    }
    if (transfer) result.unshift({ type: 'transfer', sourceAccountId: input.assetAccountId, destinationAccountId: input.liabilityAccountId,
      categoryId: null, originalTransactionId: null, amountMinor: String(transfer), role: 'repayment_allocation' })
    return result
  }
  return { id, amount, normalize, drafts, route }
}
module.exports = { createRepaymentPolicy, route, writesLoanPayment, ASSET_TYPES, LIABILITY_TYPES }
