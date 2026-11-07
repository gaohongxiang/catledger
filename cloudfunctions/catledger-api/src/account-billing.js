const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')

// 账户资料字段：账单日/还款日/额度，以及最近一期账单汇总快照（本期应还/最低还款/到期日/周期）。
// 账单快照也可由导入入账回写，编辑页手填用于解析不到时的兜底，语义一致。
const FIELDS = ['statementDay', 'repaymentDay', 'creditLimitMinor',
  'statementDueMinor', 'statementMinimumMinor', 'statementDueDate', 'statementCycle']
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const CYCLE_PATTERN = /^\d{8}-\d{8}$/u

function normalizeDate(value) {
  const matched = typeof value === 'string' ? DATE_PATTERN.exec(value) : null
  if (!matched) throw ledgerError('VALIDATION_ERROR')
  const year = Number(matched[1]), month = Number(matched[2]), day = Number(matched[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw ledgerError('VALIDATION_ERROR')
  }
  return value
}

// 省略保留（不传 data 的键则沿用 current），null / 空串清空；旧客户端只改名时不能擦除账单资料。
function normalizeBilling(data, nature, current = {}) {
  const billing = {}
  for (const field of FIELDS) {
    const provided = Object.prototype.hasOwnProperty.call(data, field)
    const raw = provided ? data[field] : current[field]
    const moneyField = field === 'creditLimitMinor' || field === 'statementDueMinor' || field === 'statementMinimumMinor'
    // null 一律清空；金额字段的空串也视为清空（输入框清空）；日期字段的空串非法（保持既有契约）。
    const isClear = raw == null || (moneyField && typeof raw === 'string' && raw.trim() === '')
    if (isClear) {
      billing[field] = null
      continue
    }
    if (nature !== 'liability') throw ledgerError('VALIDATION_ERROR')
    if (field === 'creditLimitMinor' || field === 'statementDueMinor' || field === 'statementMinimumMinor') {
      billing[field] = parseMinorUnits(raw, { allowZero: true }).toString()
    } else if (field === 'statementDueDate') {
      billing[field] = normalizeDate(raw)
    } else if (field === 'statementCycle') {
      if (typeof raw !== 'string' || !CYCLE_PATTERN.test(raw)) throw ledgerError('VALIDATION_ERROR')
      billing[field] = raw
    } else {
      if (!Number.isInteger(raw) || raw < 1 || raw > 31) throw ledgerError('VALIDATION_ERROR')
      billing[field] = raw
    }
  }
  return billing
}

module.exports = { normalizeBilling }
