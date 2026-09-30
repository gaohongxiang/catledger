// 仅复用仓库已支持的列结构。所有值为合成反例，不证明平台真实导出状态语义。
const { randomUUID } = require('node:crypto')
const { parseEvidenceFile } = require('../../cloudfunctions/catledger-import/src/parsers')
const { buildOrganizePlan } = require('../../cloudfunctions/catledger-import/src/organizer-planner')
const header = '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,交易订单号,订单号'
function bill({ status = '交易关闭', refundAmount = '20.00', refundAccount = '余额', sameOrder = true, refund = true, prefix = 'SYNTH-STATUS' } = {}) {
  return Buffer.from([header,
    `2026-01-31 12:00:00,购物,合成商户,合成原消费,20.00,支出,余额,${status},${prefix}-ORIGINAL,${prefix}-ORDER`,
    ...(refund ? [`2026-02-02 12:00:00,退款,合成商户,合成退款,${refundAmount},收入,${refundAccount},退款成功,${prefix}-REFUND,${prefix}-${sameOrder ? 'ORDER' : 'OTHER'}`] : [])
  ].join('\n'))
}
async function plan(options = {}, rowChanges = () => ({})) {
  const document = await parseEvidenceFile({ content: bill(options), extension: 'csv', timezoneOffsetMinutes: -480 })
  const rows = document.rows.map((row, index) => ({
    ...row.normalized, rowId: randomUUID(), batchId: 'synthetic-batch', sourceOrder: 0, rowNumber: index + 1,
    parseState: row.parseState, identityId: randomUUID(), identityState: 'new', sourceProfileId: 'synthetic-source',
    sourceType: document.descriptor.sourceType, sourceFormat: document.descriptor.sourceFormat,
    rawStatus: row.raw.status, rawTransactionType: row.raw.transactionType, semantic: row.semantic,
    sourceTransactionId: row.identifiers.transactionId, sourceOrderId: row.identifiers.orderId,
    sourceMerchantOrderId: row.identifiers.merchantOrderId, ...rowChanges(index)
  }))
  return buildOrganizePlan({ updateId: randomUUID(), rows, accounts: [
    { accountId: 'synthetic-wallet', name: '支付宝账户余额', type: 'wallet', currency: 'CNY' },
    { accountId: 'synthetic-savings', name: '余额宝', type: 'wallet', currency: 'CNY' }
  ] })
}
async function prepare(h, content) {
  const { files } = await h.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成状态反例.csv', size: content.length }] })
  const file = files[0]
  h.services.objects.set(file.cloudPath, content)
  const parsed = await h.imp('imports.parseFile', { requestId: randomUUID(), importId: file.importId,
    fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
  return h.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
}
module.exports = { bill, plan, prepare }
