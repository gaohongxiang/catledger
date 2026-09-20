const money = require('../../utils/money')
const { addMinor } = require('../../utils/minor-arithmetic')
function decision(data) {
  if (!data.confirmed) throw new Error('请确认这是已实际支付的借款还款，并核对本息费')
  const asset = data.assets[data.assetIndex], debt = data.debts[data.debtIndex]
  if (!asset || !debt) throw new Error('请选择付款账户和借款账户')
  const value = { confirmed:true,mode:data.linkIndex === 1 ? 'associate' : 'defer',assetAccountId:asset.accountId,liabilityAccountId:debt.accountId }
  for (const field of ['principal','interest','fee']) {
    if (String(data[field + 'Yuan']).trim() === '') throw new Error('本金、利息、费用都需要确认；没有的请填 0，未知请留待核对')
    value[field + 'Minor'] = money.yuanToMinor(data[field + 'Yuan'],{ allowZero:true })
  }
  for (const field of ['interest','fee']) {
    value[field + 'Treatment'] = data[field + 'Index'] === 1 ? 'accrued' : 'expense'
    const category = data.categories[data[field + 'CategoryIndex']]
    if (value[field + 'Minor'] !== '0' && value[field + 'Treatment'] === 'expense' && !category) throw new Error('请选择利息和费用的支出分类')
    value[field + 'CategoryId'] = value[field + 'Minor'] !== '0' && value[field + 'Treatment'] === 'expense' ? category.id : null
  }
  if (addMinor(value.principalMinor,addMinor(value.interestMinor,value.feeMinor)) !== money.yuanToMinor(data.totalYuan)) throw new Error('本息费合计必须等于实际付款总额')
  if (value.mode === 'associate') {
    const loan = data.loans[data.loanIndex]
    if (!loan) throw new Error('请选择要关联的贷款，或明确选择暂不关联')
    value.loanId = loan.loanId; value.loanVersion = loan.version
  }
  return value
}
function fields(value, categories) {
  const result = { linkIndex:value.mode === 'associate' ? 1 : 0 }
  for (const field of ['principal','interest','fee']) result[field + 'Yuan'] = value[field + 'Minor'] == null ? '' : money.minorToYuan(value[field + 'Minor'])
  for (const field of ['interest','fee']) {
    result[field + 'Index'] = value[field + 'Treatment'] === 'accrued' ? 1 : 0
    result[field + 'CategoryIndex'] = categories.findIndex(c => c.id === value[field + 'CategoryId'])
  }
  return result
}
module.exports = { decision,fields }
