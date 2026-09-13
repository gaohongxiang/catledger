// 复用现有隔离库/观察器。合成关系负载与人工确认种子，不连接真实用户或云端。
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { execFileSync } = require('node:child_process')
const { isolatedMysql } = require('./isolated-mysql')
const { createObserver } = require('./performance-observer')
const grants = require('./runtime-role-grants')
const { BUDGET } = require('../cloudfunctions/catledger-import/src/performance-contract')
const budget = require('../shared/catledger-import.json').performanceV2.complexBenchmark
const { localServices, call } = require('../test/helpers/local-services')
const SCENARIOS = ['refund_pair', 'refund_many', 'combo', 'repayment', 'history', 'upgrade']
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
function contents(scenario, count) {
  const alipay = scenario === 'repayment'
  const header = alipay ? ['支付宝(中国)网络技术有限公司 电子客户回单', '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号']
    : ['微信支付账单明细', '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注']
  const lines = Array.from({ length: count }, (_, n) => {
    if (alipay) return `2026-09-02 12:00:00,信用借还,花呗|信用购,自动还款-花呗|信用购2026年09月账单,${n + 1}.00,不计收支,合成银行储蓄卡(1234),还款成功,,SYNTHETIC-REPAY-${n},,`
    const refund = scenario === 'refund_many' ? n > 0 : scenario === 'refund_pair' && n % 2 === 1
    const group = scenario === 'refund_many' ? 0 : Math.floor(n / 2)
    const amount = scenario === 'refund_many' && n === 0 ? count + '.00' : '1.00'
    return `2026-09-0${refund ? 2 : 1} 12:00:00,${refund ? '商户退款' : '商户消费'},合成商户${scenario.startsWith('refund') ? group : ''},合成商品,${refund ? '收入' : '支出'},${amount},${scenario === 'combo' ? '微信零钱&合成银行储蓄卡(1234)' : '微信零钱'},${refund ? '退款成功' : '支付成功'},SYNTHETIC-TX-${n},${scenario.startsWith('refund') ? 'SYNTHETIC-ORDER-' + group : ''},,`
  })
  const size = Math.ceil(count / 5), result = []
  for (let i = 0; i < count; i += size) result.push(Buffer.from(header.concat(lines.slice(i, i + size)).join('\n')))
  return result
}
async function run(scenario, rows) {
  const lab = await isolatedMysql(), samples = []
  let concurrentDone = Promise.resolve([])
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    let startConcurrent = null
    const importer = createObserver(importPool, { onUserLock() { if (startConcurrent) { const start = startConcurrent; startConcurrent = null; start() } } })
    const selfObserver = createObserver(apiPool), otherObserver = createObserver(apiPool)
    const objects = new Map(), subject = 'synthetic-complex-' + randomUUID()
    const services = localServices({ apiPool, importPool: importer.pool, objects, subject })
    const sameUser = localServices({ apiPool: selfObserver.pool, importPool, subject })
    const otherUser = localServices({ apiPool: otherObserver.pool, importPool, subject: subject + '-other' })
    const user = await call(services.api, 'bootstrap'), other = await call(otherUser.api, 'bootstrap')
    const makeAccount = (service, name, type) => call(service, 'accounts.create', { requestId: randomUUID(), name, type, currency: 'CNY', openingDisplayBalanceMinor: '0', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    const wallet = await makeAccount(services.api, '合成钱包', 'wallet'), bank = await makeAccount(services.api, '合成银行', 'bank')
    const debt1 = await makeAccount(services.api, '合成贷款甲', 'credit'), debt2 = await makeAccount(services.api, '合成贷款乙', 'credit')
    const otherAccount = await makeAccount(otherUser.api, '合成独立账户', 'bank')
    async function measure(stage, fn, observer = importer) {
      observer.reset(); const begin = performance.now(), heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage()
      const result = await fn(), metrics = observer.snapshot()
      const sample = { scenario, rows, stage, ms: Math.round(performance.now() - begin), ...metrics,
        responseBytes: Buffer.byteLength(JSON.stringify(result)), heapBefore, heapAfter: process.memoryUsage().heapUsed,
        rssAfter: process.memoryUsage().rss, processMaxRssKiB: process.resourceUsage().maxRSS, cpuMicros: process.cpuUsage(cpu) }
      samples.push(sample); emit(sample)
      const bytesLimit = stage === 'firstPage' ? BUDGET.page : stage.startsWith('summary') ? BUDGET.summary : BUDGET.receipt
      if (sample.responseBytes > bytesLimit) throw new Error('complex response budget exceeded: ' + stage)
      if (process.argv.includes('--enforce') && rows === 24990) {
        if (sample.ms > budget.maxActionMsAtUpper || sample.userLockHoldMs > budget.maxUserLockHoldMsAtUpper) throw new Error('20s complex action/lock budget exceeded: ' + stage)
        if (stage === 'post' && sample.sqlCount > 120 + 12 * Math.ceil(rows / 100)) throw new Error('complex SQL budget exceeded')
      }
      return result
    }
    const payloads = contents(scenario, rows)
    async function prepare(label) {
      const files = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(), files: payloads.map((b,n) => ({ fileName: '合成关系' + n + '.csv', size: b.length })) })
      const batchIds = []
      for (let n = 0; n < files.files.length; n++) {
        const file = files.files[n]; objects.set(file.cloudPath, payloads[n])
        const parsed = await call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
        if (!parsed.batch) throw new Error('synthetic parse failed: ' + (parsed.import && parsed.import.errorCode || parsed.errorCode || parsed.status || 'no batch'))
        batchIds.push(parsed.batch.batchId)
      }
      return measure(label, () => call(services.import, 'financeUpdates.prepare', { requestId: randomUUID(), batchIds }))
    }
    let receipt = await prepare('prepare')
    const updateId = receipt.updateId
    let view = await measure('summaryBefore', () => call(services.import, 'financeUpdates.summary', { updateId }))
    if (view.freshness.requiresAccountGroupRefresh) {
      receipt = await measure('refreshGroups', () => call(services.import, 'reviewIssues.refreshAccountGroups', { requestId: randomUUID(), updateId, version: receipt.appliedVersion }))
    }
    const accountIssues = await call(services.import, 'reviewIssues.list', { updateId, group: 'accounts', pageSize: 100 })
    const decisions = accountIssues.items.filter(i => i.status === 'open').map(i => ({ issueId: i.issueId, issueVersion: i.version, operation: 'resolve', decision: 'apply_fields',
      fields: { mappingAccountId: /银行|卡/.test(i.accountContext.label) ? bank.accountId : wallet.accountId } }))
    if (accountIssues.nextCursor) throw new Error('synthetic mapping groups unexpectedly exceed one page')
    if (decisions.length) receipt = await measure('resolveAccounts', () => call(services.import, 'reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId, updateVersion: receipt.appliedVersion, decisions }))
    if (['combo', 'repayment'].includes(scenario)) {
      // 先以真实公开命令确认一个问题，验证种子合法；其余相同构成复制已确认分项，不计作用户交互性能。
      const issues = await call(services.import, 'reviewIssues.list', { updateId, group: 'review', status: 'open', pageSize: 1 })
      const issue = issues.items[0]
      if (!issue) throw new Error('complex sample has no confirmation issue')
      const detail = await call(services.import, 'reviewIssues.get', { updateId, issueId: issue.issueId, pageSize: 1 })
      const subjectAmount = BigInt((detail.subject || detail.members[0].event).amountMinor)
      const fields = scenario === 'combo' ? { paymentResolution: { version: 'payment-resolution-v2', nature: 'expense', targetAccountId: null,
        confirmedFromDetails: true, evidenceNote: '合成本机确认', allocations: [
          { componentIndex: 0, accountId: wallet.accountId, amountMinor: '60' }, { componentIndex: 1, accountId: bank.accountId, amountMinor: '40' }] } }
        : { repaymentAllocations: [{ accountId: debt1.accountId, amountMinor: String(subjectAmount * 60n / 100n) }, { accountId: debt2.accountId, amountMinor: String(subjectAmount * 40n / 100n) }] }
      receipt = await measure('confirmOneIssue', () => call(services.import, 'reviewIssues.resolve', { requestId: randomUUID(), updateId,
        updateVersion: receipt.appliedVersion, issueId: issue.issueId, issueVersion: issue.version, decision: 'apply_fields', fields }))
      const eventId = detail.subject?.eventId || detail.members[0].event.eventId
      const [[confirmed]] = await lab.owner.execute(`SELECT field_sources_json AS fields, economic_nature AS nature, flow_direction AS direction,
        ledger_account_id AS accountId, counterparty_ledger_account_id AS otherAccountId, manual_field_mask AS mask
        FROM catledger_economic_events WHERE uid=? AND event_id=?`, [user.uid, eventId])
      const patch = Object.fromEntries(['paymentAccounts','paymentResolution','repaymentAllocations','repaymentAllocationVersion']
        .filter(key => confirmed.fields[key] != null).map(key => [key, confirmed.fields[key]]))
      await lab.owner.execute(`UPDATE catledger_economic_events SET field_sources_json=JSON_MERGE_PATCH(field_sources_json,CAST(? AS JSON)),
        economic_nature=?,flow_direction=?,ledger_account_id=?,counterparty_ledger_account_id=?,manual_field_mask=?,status='ready'
        WHERE uid=? AND update_id=?`, [JSON.stringify(patch), confirmed.nature, confirmed.direction, confirmed.accountId, confirmed.otherAccountId, confirmed.mask, user.uid, updateId])
      if (scenario === 'repayment') await lab.owner.execute(`UPDATE catledger_economic_events SET field_sources_json=JSON_SET(field_sources_json,
        '$.repaymentAllocations',JSON_ARRAY(JSON_OBJECT('accountId',?,'amountMinor',CAST((amount_minor DIV 100)*60 AS CHAR)),
        JSON_OBJECT('accountId',?,'amountMinor',CAST((amount_minor DIV 100)*40 AS CHAR)))) WHERE uid=? AND update_id=?`, [debt1.accountId,debt2.accountId,user.uid,updateId])
      await lab.owner.execute("UPDATE catledger_finance_updates SET ready_event_count=?,needs_action_event_count=0 WHERE uid=? AND update_id=?", [rows,user.uid,updateId])
      await lab.owner.execute("UPDATE catledger_review_issues SET status='resolved' WHERE uid=? AND update_id=? AND status='open'", [user.uid,updateId])
    }
    if (scenario === 'upgrade') {
      await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v1' WHERE uid=? AND update_id=?", [user.uid, updateId])
      receipt = await measure('upgrade', () => call(services.import, 'financeUpdates.organize', { requestId: randomUUID(), updateId, version: receipt.appliedVersion }))
    }
    view = await measure('summary', () => call(services.import, 'financeUpdates.summary', { updateId }))
    await measure('firstPage', () => call(services.import, 'economicEvents.list', { updateId, pageSize: 40 }))
    const [[relations]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_economic_event_relations WHERE uid=? AND update_id=?', [user.uid,updateId])
    const manual = (service, account, identity) => call(service, 'transactions.create', { requestId: randomUUID(), type: 'expense', amountMinor: '1',
      sourceAccountId: account.accountId, categoryId: identity.categories.find(c => c.kind === 'expense').id,
      occurredLocalAt: '2026-09-03T10:00:00', timezoneOffsetMinutes: -480 })
    startConcurrent = () => { concurrentDone = Promise.allSettled([measure('sameUserWrite', () => manual(sameUser.api, wallet, user), selfObserver),
      measure('otherUserWrite', () => manual(otherUser.api, otherAccount, other), otherObserver)]) }
    const posted = await measure('post', () => call(services.import, 'financeUpdates.post', { requestId: randomUUID(), updateId, version: view.update.version }))
    for (const outcome of await concurrentDone) if (outcome.status === 'rejected') throw outcome.reason
    const multiplier = ['combo','repayment'].includes(scenario) ? 2 : 1
    if (posted.posting.createdTransactionCount !== rows * multiplier) throw new Error('created transaction count mismatch')
    if (scenario === 'history') {
      payloads.forEach((value, index) => { payloads[index] = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), value]) })
      const next = await prepare('historyPrepare')
      const nextView = await call(services.import, 'financeUpdates.summary', { updateId: next.updateId })
      const reused = await measure('historyPost', () => call(services.import, 'financeUpdates.post', { requestId: randomUUID(), updateId: next.updateId, version: nextView.update.version }))
      if (reused.posting.createdTransactionCount !== 0) throw new Error('history created a duplicate')
      const connection = await importer.pool.getConnection()
      try {
        const history = await measure('historyLookup', async () => ({ matches: (await require('../cloudfunctions/catledger-import/src/finance-update-posting').existingTransactionsForUpdate(connection, user.uid, next.updateId)).size }))
        if (history.matches !== rows) throw new Error('history identity lookup mismatch')
        emit({ scenario, rows, stage: 'historyPolicy', created: reused.posting.createdTransactionCount, reused: reused.posting.reusedTransactionCount, matches: history.matches, excluded: nextView.update.counts.excludedEvents })
      } finally { connection.release() }
    }
    const [[ledger]] = await lab.owner.execute("SELECT COUNT(*) AS count,SUM(amount_minor) AS amount FROM catledger_transactions WHERE uid=? AND origin='import' AND deleted_at IS NULL", [user.uid])
    const expectedAmount = scenario === 'refund_many' ? (rows * 2 - 1) * 100 : scenario === 'repayment' ? rows * (rows + 1) / 2 * 100 : rows * 100
    if (Number(ledger.count) !== rows * multiplier || Number(ledger.amount) !== expectedAmount) throw new Error('ledger amount mismatch')
    emit({ scenario, rows, stage: 'verified', relations: Number(relations.count), transactions: Number(ledger.count), amountMinor: String(ledger.amount),
      preparation: ['combo','repayment'].includes(scenario) ? 'one public confirmation then identical confirmed split fixtures seeded locally; not a full click-through timing' : 'public commands only (upgrade has a seeded old plan version)' })
  } finally { await concurrentDone; await lab.close() }
  return samples
}
async function main() {
  const args = process.argv.slice(2), rows = Number(args[args.indexOf('--rows') + 1] || 1000)
  const selected = args.includes('--scenario') ? [args[args.indexOf('--scenario') + 1]] : SCENARIOS
  if (![10,1000,5000,24990].includes(rows) || selected.some(s => !SCENARIOS.includes(s))) throw new Error('invalid scenario selection')
  emit({ stage: 'environment', head: execFileSync('git',['rev-parse','HEAD'],{ encoding:'utf8' }).trim(), node: process.version,
    mysql: '8.4 loopback isolated roles', sourceFilesSha256: require('./benchmark-performance-matrix').sourceDigest(), rows, runs: 1, memory: 'process max RSS is process lifetime high-water; action heap before/after is not peak', seed: 'synthetic only' })
  for (const scenario of selected) { if (global.gc) global.gc(); await run(scenario, rows) }
}
if (require.main === module) main().catch(error => { process.stderr.write('Complex benchmark failed: ' + (error.publicCode || error.code || error.message) + '\n'); process.exitCode = 1 })
module.exports = { contents, run }
