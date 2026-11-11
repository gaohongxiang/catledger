class LedgerError extends Error {
  constructor(publicCode, message, fields) {
    super(message || publicCode)
    this.name = 'LedgerError'
    this.publicCode = publicCode
    // fields: 可选，指出错的字段名数组，供前端高亮对应输入框（如 ['ratePpm']）。
    if (Array.isArray(fields) && fields.length) this.fields = fields.slice(0, 8)
  }
}

function ledgerError(publicCode, message, fields) {
  return new LedgerError(publicCode, message, fields)
}

module.exports = {
  LedgerError,
  ledgerError
}
