// 仅使用合成账单；不会连接非本机数据库。先在一次性测试库运行 test:db 建立 schema。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const root = path.resolve(__dirname, '..')
const indexPath = path.join(root, 'miniprogram/pages/import-workbench/index.js')
const modelPath = path.join(root, 'miniprogram/pages/import-workbench/model.js')

function pageRuntime(ref) {
  const source = file => ref ? execFileSync('git', ['show', ref + ':' + path.relative(root, file)], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(source(modelPath), { module, require: createRequire(modelPath) })
  let definition
  vm.runInNewContext(source(indexPath), { Page: value => { definition = value }, getApp: () => ({ globalData: {} }),
    require: name => name === './model' ? module.exports : ['./presentation', './final-detail', '../../services/view-patch'].includes(name) ? createRequire(indexPath)(name) : {} })
  return Object.assign({}, definition, { _accountUiDrafts: new Map(), data: JSON.parse(JSON.stringify(definition.data)), bytes: 0,
    setData(patch) {
      this.bytes += Buffer.byteLength(JSON.stringify(patch))
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
        let target = this.data
        for (const part of parts.slice(0, -1)) target = target[part]
        target[parts.at(-1)] = value
      }
    } })
}

function syntheticView(count) {
  const events = Array.from({ length: count }, (_, i) => ({ eventId: 'synthetic-event-' + i, status: 'ready',
    amountMinor: '100', economicNature: 'expense', flowDirection: 'outflow', categoryId: 'synthetic-category',
    ledgerAccountId: 'synthetic-account', localAt: '2026-09-01 12:00:00', duplicateEvidenceCount: i % 10 === 0 ? 1 : 0,
    primaryEvidence: { sourceType: 'wechat', item: '合成测试商品', counterparty: '合成商户', paymentMethod: '微信零钱' } }))
  return { update: { updateId: 'synthetic-update', version: 1, status: 'review', counts: { readyEvents: count } },
    events, issues: [], sources: [], accounts: [{ accountId: 'synthetic-account', name: '合成账户', type: 'wallet' }],
    categories: [{ categoryId: 'synthetic-category', kind: 'expense', name: '合成分类' }],
    accountDrafts: [], accountMappingDrafts: [], coverage: { selectedEventsReadyToPost: true } }
}

function clientMetrics(view, ref) {
  const page = pageRuntime(ref), samples = []
  for (const step of [1, 2, 3, 4]) {
    page.data.currentStep = step
    page.data.activeReviewStatus = 'completed'
    for (let iteration = 0; iteration < 3; iteration++) {
      page.bytes = 0
      const start = performance.now()
      page.applyUpdateView(view, true)
      samples.push({ step, iteration, ms: Math.round(performance.now() - start), setDataBytes: page.bytes,
        pageDataBytes: Buffer.byteLength(JSON.stringify(page.data)) })
    }
  }
  return samples
}

async function databaseMetrics(rowsPerFile) {
  const env = process.env
  if (!['127.0.0.1', 'localhost'].includes(env.CATLEDGER_TEST_DB_HOST) || !/_test$/.test(env.CATLEDGER_TEST_DB_NAME || '')) {
    throw new Error('仅允许本机、名称以 _test 结尾的一次性测试库')
  }
  const mysql = require('../cloudfunctions/catledger-import/node_modules/mysql2/promise')
  const { hashWechatSubject } = require('../cloudfunctions/catledger-import/src/handler')
  const { createImportService } = require('../cloudfunctions/catledger-import/src/import-service')
  const pool = mysql.createPool({ host: env.CATLEDGER_TEST_DB_HOST, port: Number(env.CATLEDGER_TEST_DB_PORT || 3306),
    user: env.CATLEDGER_TEST_DB_USER, password: env.CATLEDGER_TEST_DB_PASSWORD, database: env.CATLEDGER_TEST_DB_NAME,
    dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 4 })
  const observer = require('./performance-observer').createObserver(pool)
  const observed = observer.pool
  const objects = new Map()
  const service = createImportService({ getPool: () => observed, storage: {
    async downloadExact(_, key) { return objects.get(key) }, async remove() { return true } } })
  const user = { uid: randomUUID(), accountId: randomUUID(), subjectHash: hashWechatSubject('synthetic-benchmark-' + randomUUID()) }
  const context = data => ({ provider: 'wechat-mini', subjectHash: user.subjectHash, data })
  async function measure(stage, operation) {
    observer.reset()
    const cpuStart = process.cpuUsage()
    const heapBefore = process.memoryUsage().heapUsed
    const start = performance.now()
    const result = await operation()
    const stats = observer.snapshot()
    if (['prepareUpdate', 'resolveAccounts', 'post'].includes(stage) && stats.sqlCount > require('../cloudfunctions/catledger-import/src/performance-contract').ordinarySqlBudget(stage, rowsPerFile * 5)) throw new Error('SQL budget exceeded: ' + stage)
    process.stdout.write(JSON.stringify({ kind: 'server', rows: rowsPerFile * 5, stage, ms: Math.round(performance.now() - start),
      ...stats, cpuMicros: process.cpuUsage(cpuStart), heapBefore, heapAfter: process.memoryUsage().heapUsed, responseBytes: Buffer.byteLength(JSON.stringify(result)) }) + '\n')
    return result
  }
  try {
    await pool.execute("INSERT INTO catledger_users (uid, status) VALUES (?, 'active')", [user.uid])
    await pool.execute("INSERT INTO catledger_user_identities (uid, provider, subject_hash) VALUES (?, 'wechat-mini', ?)", [user.uid, user.subjectHash])
    await pool.execute("INSERT INTO catledger_accounts (uid, account_id, type, nature, name, normalized_name, currency) VALUES (?, ?, 'wallet', 'asset', '合成账户', '合成账户', 'CNY')", [user.uid, user.accountId])
    const contents = Array.from({ length: 5 }, (_, file) => Buffer.from([
      '微信支付账单明细,,,,,,,,,,,',
      '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
      ...Array.from({ length: rowsPerFile }, (_, row) => `2026-09-01 12:00:00,商户消费,合成商户,合成商品,支出,1.00,微信零钱,支付成功,SYNTHETIC-${file}-${row},,,`)
    ].join('\n')))
    const prepared = await measure('prepareFiles', () => service.prepareMany(context({ requestId: randomUUID(),
      files: contents.map((buffer, i) => ({ fileName: '合成性能' + i + '.csv', size: buffer.length })) })))
    const batches = []
    for (const [i, file] of prepared.files.entries()) {
      objects.set(file.cloudPath, contents[i])
      const result = await measure('parseFile' + (i + 1), () => service.parseFile(context({ requestId: randomUUID(),
        importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })))
      batches.push(result.batch.batchId)
    }
    let view = await measure('prepareUpdate', () => service.financeUpdatePrepare(context({ requestId: randomUUID(), resultMode: 'receipt', batchIds: batches })))
    const updateId = view.update.updateId
    view = await measure('organize', () => service.financeUpdateOrganize(context({ requestId: randomUUID(), resultMode: 'receipt', updateId, version: view.update.version })))
    view = await measure('getCold', () => service.financeUpdateSummary(context({ updateId })))
    await measure('getWarm', () => service.financeUpdateSummary(context({ updateId })))
    if (view.freshness.requiresAccountGroupRefresh) view = await measure('refreshGroups', () => service.reviewIssueRefreshAccountGroups(context({ requestId: randomUUID(), resultMode: 'receipt', updateId, version: view.update.version })))
    const issuePage = await service.reviewIssueList(context({ protocolVersion: 2, updateId, issueType: 'account_mapping', status: 'open', pageSize: 100 }))
    if (issuePage.nextCursor) throw new Error('ordinary benchmark account groups exceed one page')
    const decisions = issuePage.items.filter(issue => issue.issueType === 'account_mapping' && issue.status === 'open')
      .map(issue => ({ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: user.accountId } }))
    if (decisions.length) view = await measure('resolveAccounts', () => service.reviewIssueResolveAccountMappings(context({ requestId: randomUUID(), resultMode: 'receipt', updateId, updateVersion: view.update.version, decisions })))
    await measure('firstEventPage', () => service.economicEventList(context({ updateId })))
    if (process.argv.includes('--inspect-plan')) {
      const { inspectSelect } = require('./performance-query-plans')
      const { existingTransactionsForUpdate } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
      const { selectEvents } = require('../cloudfunctions/catledger-import/src/finance-update-repository')
      for (const [query, operation] of [['history', connection => existingTransactionsForUpdate(connection, user.uid, updateId)],
        ['evidenceCounts', connection => selectEvents(connection, user.uid, updateId)]]) {
        process.stdout.write(JSON.stringify({ kind: 'plan', rows: rowsPerFile * 5, query, plans: await inspectSelect(pool, operation) }) + '\n')
      }
    }
    const posted = await measure('post', () => service.financeUpdatePost(context({ requestId: randomUUID(), resultMode: 'receipt', updateId, version: view.update.version })))
    if (posted.posting.createdTransactionCount !== rowsPerFile * 5) throw new Error('合成账单入账数量不一致')
  } finally { await pool.end() }
}

async function main() {
  const args = process.argv.slice(2)
  const baseline = args.includes('--baseline-ref') ? args[args.indexOf('--baseline-ref') + 1] : null
  const selectedRows = args.includes('--rows') ? Number(args[args.indexOf('--rows') + 1]) : null
  if (selectedRows !== null && ![1000, 5000, 24990].includes(selectedRows)) throw new Error('invalid benchmark size')
  const sizes = selectedRows ? [selectedRows / 5] : args.includes('--small') ? [1000] : [200, 1000, 4998]
  process.stdout.write(JSON.stringify({ kind: 'environment', node: process.version, platform: process.platform,
    database: 'local isolated MySQL 8.4', files: 5, state: 'first-call then same-process warm; no device/network timing' }) + '\n')
  for (const size of sizes) {
    const view = syntheticView(size * 5)
    process.stdout.write(JSON.stringify({ kind: 'client', rows: size * 5, baseline: baseline || 'working-tree', samples: clientMetrics(view, baseline) }) + '\n')
    if (args.includes('--database')) await databaseMetrics(size)
  }
}
if (require.main === module) main().catch(error => { process.stderr.write('合成性能验证失败：' + (error.publicCode || error.code || error.name) + '\n'); process.exitCode = 1 })
module.exports = { syntheticView, pageRuntime, clientMetrics }
