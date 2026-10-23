// 合成 v34 夹具：保留来源身份，仅恢复当时花呗/信用购各自的账户语义。
const { digestParts } = require('../../src/digest')
async function legacyAlipayAccounts(pool, uid, batchId) {
  const [rows] = await pool.execute('SELECT row_id AS rowId,payment_method_raw AS method,semantic_json AS semantic FROM catledger_import_rows WHERE uid=? AND batch_id=?', [uid, batchId])
  for (const row of rows) {
    if (!['花呗', '江苏银行信用购'].includes(row.method)) continue
    const semantic = typeof row.semantic === 'string' ? JSON.parse(row.semantic) : row.semantic
    const key = digestParts('payment-method-v1', 'alipay', row.method)
    const legacy = reference => reference && reference.sourceType === 'alipay' && reference.referenceKind === 'atomic'
      ? { ...reference, paymentMethodKey: key, accountIdentityKey: 'account-identity-v2:alipay:' + row.method,
        label: row.method === '花呗' ? '支付宝花呗' : row.method } : reference
    for (const field of ['ledgerAccountRef', 'fromAccountRef', 'toAccountRef']) semantic[field] = legacy(semantic[field])
    await pool.execute('UPDATE catledger_import_rows SET payment_method_key=?,semantic_json=? WHERE uid=? AND row_id=?', [key, JSON.stringify(semantic), uid, row.rowId])
  }
}
module.exports = { legacyAlipayAccounts }
