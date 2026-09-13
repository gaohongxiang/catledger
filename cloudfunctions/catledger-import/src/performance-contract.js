const { importError } = require('./errors')

const PROTOCOL_VERSION = 2
const BUDGET = Object.freeze({ request: 64 * 1024, receipt: 32 * 1024, summary: 64 * 1024,
  page: 256 * 1024, defaultPageSize: 40, maxPageSize: 100,
  sqlRows: 100, sqlParameters: 6000, sqlBytes: 512 * 1024, detailChunk: 16 * 1024 })

function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function assertBudget(value, kind) {
  if (jsonBytes(value) > BUDGET[kind]) throw importError(kind === 'request' ? 'REQUEST_TOO_LARGE' : 'PAGINATION_REQUIRED')
  return value
}
function pageSize(value) {
  if (value == null) return BUDGET.defaultPageSize
  if (!Number.isInteger(value) || value < 1 || value > BUDGET.maxPageSize) throw importError('VALIDATION_ERROR')
  return value
}
// 五份普通合成账单；异常业务另按真实异常数计量，不把异常数量隐藏进固定开销。
function ordinarySqlBudget(stage, rows) {
  const chunks = Math.ceil(rows / BUDGET.sqlRows)
  const limits = { prepareUpdate: 120 + 8 * chunks, resolveAccounts: 120 + 12 * chunks, post: 160 + 8 * chunks }
  if (!Object.hasOwn(limits, stage) || !Number.isInteger(rows) || rows < 1) throw new Error('invalid benchmark scope')
  return limits[stage]
}
module.exports = { PROTOCOL_VERSION, BUDGET, jsonBytes, assertBudget, pageSize, ordinarySqlBudget }
