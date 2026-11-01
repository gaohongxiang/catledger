const NATURES = Object.freeze({ cash: 'asset', bank: 'asset', wallet: 'asset', credit: 'liability',
  other_asset: 'asset', other_liability: 'liability' })
const NAME_CONFLICT = '已有同名账户，请修改名称或明确选择已有账户'
const error = (code, message) => Object.assign(new Error(message || code), { code, publicCode: code })
function normalizeName(value) {
  if (typeof value !== 'string') throw error('VALIDATION_ERROR')
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (Array.from(name).length < 1 || Array.from(name).length > 32) throw error('VALIDATION_ERROR')
  return { name, normalizedName: name.toLocaleLowerCase('zh-CN') }
}
function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !NATURES[value.type] || value.currency !== 'CNY' ||
      value.creationKey != null && !/^[a-f0-9]{64}$/.test(value.creationKey)) throw error('VALIDATION_ERROR')
  return { ...normalizeName(value.name), type: value.type, nature: NATURES[value.type], currency: value.currency,
    ...(value.creationKey ? { creationKey: value.creationKey } : {}) }
}
function conflict() { throw error('ACCOUNT_NAME_CONFLICT', NAME_CONFLICT) }
module.exports = { NATURES, NAME_CONFLICT, normalizeName, validate, conflict }
