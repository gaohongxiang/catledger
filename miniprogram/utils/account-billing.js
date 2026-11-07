const money = require('./money')
const DAY_OPTIONS = ['未设置'].concat(Array.from({ length: 31 }, function (_, i) { return '每月 ' + (i + 1) + ' 日' }))
const UNAVAILABLE = '账单设置暂不可用，请更新服务后重试'

// 账单快照（本期应还/最低还款）以元展示、以 minor 字符串提交；到期日 YYYY-MM-DD；周期 YYYYMMDD-YYYYMMDD。
function toYuan(value) {
  return value == null || value === '' ? '' : money.minorToYuan(value)
}

function draft(account) {
  account = account || {}
  return {
    statementDay: account.statementDay || 0,
    repaymentDay: account.repaymentDay || 0,
    creditLimitYuan: account.creditLimitMinor == null ? '' : money.minorToYuan(account.creditLimitMinor),
    statementDueYuan: toYuan(account.statementDueMinor),
    statementMinimumYuan: toYuan(account.statementMinimumMinor),
    statementDueDate: account.statementDueDate || '',
    statementCycle: account.statementCycle || ''
  }
}

function assertAmount(amount, label) {
  if (amount && (amount.length > 19 || (amount.length === 19 && amount > '9223372036854775807'))) {
    throw new Error(label + '超出支持范围')
  }
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
  assertAmount(result.creditLimitMinor, '信用额度')

  const dueYuan = String(values.statementDueYuan || '').trim()
  result.statementDueMinor = dueYuan ? money.yuanToMinor(dueYuan, { allowZero: true }) : null
  assertAmount(result.statementDueMinor, '本期应还')
  const minYuan = String(values.statementMinimumYuan || '').trim()
  result.statementMinimumMinor = minYuan ? money.yuanToMinor(minYuan, { allowZero: true }) : null
  assertAmount(result.statementMinimumMinor, '最低还款额')

  const date = String(values.statementDueDate || '').trim()
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('到期还款日格式应为年-月-日，或留空')
  result.statementDueDate = date || null

  const cycle = String(values.statementCycle || '').trim()
  if (cycle && !/^\d{8}-\d{8}$/u.test(cycle)) throw new Error('账单周期格式应为 YYYYMMDD-YYYYMMDD，或留空')
  result.statementCycle = cycle || null
  return result
}

function assertSaved(result, fields) {
  if (['statementDay', 'repaymentDay', 'creditLimitMinor', 'statementDueMinor', 'statementMinimumMinor',
    'statementDueDate', 'statementCycle'].some(function (key) { return result[key] !== fields[key] })) {
    throw new Error('账单设置未确认保存，请重新打开账户核对')
  }
}

module.exports = { DAY_OPTIONS, UNAVAILABLE, draft, payload, assertSaved }
