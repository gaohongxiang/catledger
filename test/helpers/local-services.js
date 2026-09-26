// 两个部署目录各自加载入口；此适配器只供本地合成验证，不进入云函数或小程序包。
const path = require('node:path')
function moduleFor(kind, name) { return require(path.resolve(__dirname, '../../cloudfunctions/catledger-' + kind + '/src/' + name)) }
function localServices({ apiPool, importPool, now = Date.now, objects = new Map(), subject = 'synthetic-local-native', logger = { warn() {}, error() {} } }) {
  const getPool = () => apiPool
  const repository = moduleFor('api', 'user-repository').createUserRepository({ getPool })
  const apiServices = moduleFor('api', 'action-registry').createActionHandlers({
    dataExportService: moduleFor('api', 'data-export-service').createDataExportService({ getPool }),
    loanService: moduleFor('api', 'loan-service').createLoanService({ getPool, now }),
    accountService: moduleFor('api', 'account-service').createAccountService({ getPool }),
    categoryService: moduleFor('api', 'category-service').createCategoryService({ getPool }),
    catalogService: moduleFor('api', 'catalog-service').createCatalogService({ getPool }),
    profileService: moduleFor('api', 'profile-service').createProfileService({ getPool }),
    transactionService: moduleFor('api', 'transaction-service').createTransactionService({ getPool })
  })
  const importer = moduleFor('import', 'import-service').createImportService({ getPool: () => importPool,
    storage: { async downloadExact(_, key) { return objects.get(key) }, async remove() { return true } } })
  const getWxContext = () => ({ OPENID: subject })
  return {
    objects, importer, apiServices,
    api: moduleFor('api', 'handler').createHandler({ getWxContext, repository, services: apiServices, logger }),
    import: moduleFor('import', 'handler').createHandler({ getWxContext, services: moduleFor('import', 'action-registry').createActionHandlers(importer), logger })
  }
}
function syntheticBill(rows, prefix = 'SYNTHETIC-LOCAL') {
  return Buffer.from(['微信支付账单明细,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    ...Array.from({ length: rows }, (_, i) => `2026-09-01 12:00:00,商户消费,合成商户,合成商品,支出,1.00,微信零钱,支付成功,${prefix}-${i},,,`)
  ].join('\n'))
}
async function call(service, action, data = {}) {
  const result = await service({ action, data })
  if (!result.ok) throw Object.assign(new Error(action + ': ' + result.error.code), { publicCode: result.error.code })
  return result.data
}
async function prepareSyntheticUpdate(services, rows, prefix) {
  const { randomUUID } = require('node:crypto'), content = syntheticBill(rows, prefix)
  const files = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成原生验证.csv', size: content.length }] })
  const file = files.files[0]; services.objects.set(file.cloudPath, content)
  const parsed = await call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId,
    fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
  return call(services.import, 'financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
}
// 仅由明确需要保留独立合成记录的场景调用；不默认跳过导入历史核对。
async function confirmSyntheticHistoryDistinct(services, update) {
  const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
  const issues = (await call(services.import, 'reviewIssues.list', { updateId: update.updateId, status: 'open' })).items
    .filter(issue => issue.primaryReasonCode === 'historical_duplicate_candidate')
  if (issues.length) await assert.rejects(call(services.import, 'financeUpdates.post', {
    requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion
  }), { publicCode: 'UNRESOLVED_IMPORT' })
  for (const issue of issues) update = await call(services.import, 'reviewIssues.resolve', {
    requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
    issueId: issue.issueId, issueVersion: issue.version, decision: 'confirm_distinct'
  })
  return update
}
module.exports = { localServices, syntheticBill, call, prepareSyntheticUpdate, confirmSyntheticHistoryDistinct }
