function validRevision(value) {
  return typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) &&
    (value.length < 20 || value <= '18446744073709551615')
}
function validMetadata(value) {
  return value && value.readVersion === 1 && typeof value.uid === 'string' && /^[1-9]\d{9}$/.test(value.uid) &&
    validRevision(value.dataRevision) && typeof value.unchanged === 'boolean'
}
function compare(a, b) { return a.length === b.length ? (a === b ? 0 : a > b ? 1 : -1) : a.length > b.length ? 1 : -1 }
function assertMetadata(value, uid) {
  if (!validMetadata(value) || (uid && uid !== value.uid)) {
    throw Object.assign(new Error('读取版本校验失败，请重新打开页面'), { code: 'INVALID_RESPONSE' })
  }
  return value
}
module.exports = { validRevision, validMetadata, compare, assertMetadata }
