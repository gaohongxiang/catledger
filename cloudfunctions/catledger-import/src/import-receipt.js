const { importError } = require('./errors')

function encodeReceipt(result) { return { receiptVersion: 1, kind: 'value', value: result } }

function readReceipt(stored) {
  const receipt = typeof stored === 'string' ? JSON.parse(stored) : stored
  // 引用不是当次操作事实。历史引用只能经离线核实转换，不能读取当前视图伪造回执。
  if (!receipt || receipt.receiptVersion !== 1 || receipt.kind !== 'value' || receipt.value == null) {
    throw importError('RECEIPT_RECONCILIATION_REQUIRED')
  }
  return receipt.value
}
module.exports = { encodeReceipt, readReceipt }
