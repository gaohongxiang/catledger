const money = require('./money')
const DAY_OPTIONS = ['未设置'].concat(Array.from({ length: 31 }, function (_, i) { return '每月 ' + (i + 1) + ' 日' }))
const UNAVAILABLE = '账单设置暂不可用，请更新服务后重试'

function draft(account) {
  account = account || {}
  return { statementDay: account.statementDay || 0, repaymentDay: account.repaymentDay || 0,
    creditLimitYuan: account.creditLimitMinor == null ? '' : money.minorToYuan(account.creditLimitMinor) }
}

function payload(values) {
  const result = {}
  ;['statementDay', 'repaymentDay'].forEach(function (field) {
    const value = values[field]
    if (!Number.isInteger(value) || value < 0 || value > 31) throw new Error('请选择每月 1 至 31 日，或未设置')
    result[field] = value || null
  })
  const yuan = String(values.creditLimitYuan || '').trim()
  result.creditLimitMinor = yuan ? money.yuanToMinor(yuan, { allowZero: true }) : null
  const amount = result.creditLimitMinor
  if (amount && (amount.length > 19 || (amount.length === 19 && amount > '9223372036854775807'))) throw new Error('信用额度超出支持范围')
  return result
}

function assertSaved(result, fields) {
  if (['statementDay', 'repaymentDay', 'creditLimitMinor'].some(function (key) { return result[key] !== fields[key] })) {
    throw new Error('账单设置未确认保存，请重新打开账户核对')
  }
}

module.exports = { DAY_OPTIONS, UNAVAILABLE, draft, payload, assertSaved }
