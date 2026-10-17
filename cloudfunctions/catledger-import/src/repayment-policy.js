// 本息费组成的纯校验；客户端核对和正式入账共用。
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
      if (!['expense','accrued'].includes(value[field + 'Treatment'])) throw error('VALIDATION_ERROR')
      result[field + 'Treatment'] = value[field + 'Treatment']
      result[field + 'CategoryId'] = value[field + 'Treatment'] === 'expense' && result[field + 'Minor'] !== '0' ? id(value[field + 'CategoryId']) : null
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
  return { id, amount, normalize, drafts }
}
module.exports = { createRepaymentPolicy }
