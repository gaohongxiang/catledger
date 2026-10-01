const path = require('node:path')
const { randomUUID } = require('node:crypto')
const defaultRoot = path.resolve(__dirname, '../..')
async function setup({ apiPool, importPool, count = 2, ambiguous = false, refund = false, reliable = true, sourceRoot = defaultRoot, subject, existingAccountId, logger }) {
  const { localServices, call } = require(path.join(sourceRoot, 'test/helpers/local-services'))
  const services = localServices({ apiPool, importPool, subject: subject || 'synthetic-pair-' + randomUUID(), logger })
  const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
  const user = await api('bootstrap')
  const accountId = existingAccountId || (await api('accounts.create', { requestId: randomUUID(), name: '合成配对信用卡', type: 'credit' })).accountId
  const prefix = randomUUID(), direction = refund ? '收入' : '支出'
  const time = index => new Date(Date.UTC(2026, 8, 1, 12, ambiguous ? 0 : index)).toISOString().slice(0, 19).replace('T', ' ')
  const contents = [Buffer.from(['微信支付账单明细,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    ...Array.from({ length: count }, (_, i) => `${time(i)},${refund ? '退款' : '商户消费'},合成商户,合成商品,${direction},12.34,合成信用卡(2222),${refund ? '退款成功' : '支付成功'},SYNTHETIC-${prefix}-${i},,,`)].join('\n')),
  Buffer.from(['交易日期,交易金额,收支,交易类型,摘要,账户,交易流水号',
    ...Array.from({ length: count }, (_, i) => `${time(i)},12.34,${direction},,财付通-合成商户,${reliable ? '9999000011112222' : '****2222'},${reliable ? 'SYNTHETIC-BANK-' + prefix + '-' + i : ''}`)].join('\n'))]
  async function prepare(inputContents = contents) {
    const batchIds = []
    for (const [index, content] of inputContents.entries()) {
      const file = (await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: `合成配对${index}.csv`, size: content.length }] })).files[0]
      services.objects.set(file.cloudPath, content)
      const data = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
      let parsed = await imp('imports.parseFile', { requestId: randomUUID(), ...data })
      if (parsed.bankPreview) {
        const preview = parsed.bankPreview
        parsed = await imp('imports.parseFile', { requestId: randomUUID(), ...data, bankMapping: { ...preview.suggested,
          schemaVersion: 1, headerRow: preview.headerRow, sheetIndex: preview.sheetIndex, headerToken: preview.headerToken, statementKind: 'credit' } })
      }
      batchIds.push(parsed.batch.batchId)
    }
    return (await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds })).updateId
  }
  const c = { services, api, imp, uid: user.uid, accountId, user, contents, prepare, updateId: await prepare() }
  c.summary = () => imp('financeUpdates.summary', { updateId: c.updateId })
  c.map = async () => {
    const page = await imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', pageSize: 100 })
    const decisions = page.items.filter(issue => issue.status === 'open').map(issue => ({ issueId: issue.issueId, issueVersion: issue.version,
      operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: accountId } }))
    if (decisions.length) await imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
      updateVersion: (await c.summary()).update.version, decisions })
  }
  c.pairings = (data = {}) => imp('reviewIssues.pairings', { updateId: c.updateId, pageSize: 20, ...data })
  c.resolve = (data) => imp('reviewIssues.resolvePairings', { requestId: randomUUID(), updateId: c.updateId, ...data })
  c.post = async () => imp('financeUpdates.post', { requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
  await c.map()
  return c
}
module.exports = { setup }
