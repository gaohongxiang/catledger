// 同一合成负载可加载基线检出与当前检出；只报告本机 handler/Page 数据，不代表云端或真机耗时。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')

const sourceRoot = path.resolve(process.env.CATLEDGER_PERF_SOURCE_ROOT || path.join(__dirname, '..'))
const fromSource = file => require(path.join(sourceRoot, file))
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const round = value => Math.round(value * 10) / 10
const git = args => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim()
const transactionFingerprints = new Set(['beginTransaction', 'commit', 'rollback']
  .map(value => createHash('sha256').update(value).digest('hex').slice(0, 16)))

function sourceDigest() {
  const hash = createHash('sha256')
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    .filter(file => /^(cloudfunctions|shared|miniprogram|scripts|test)\//.test(file) && /\.(js|json|wxml|wxss)$/.test(file)).sort()
  for (const file of files) hash.update(file + '\0').update(fs.readFileSync(path.join(sourceRoot, file))).update('\0')
  return hash.digest('hex')
}

function sqlMetrics(observers) {
  const metrics = { sqlCount: 0, sqlStatements: 0, sqlMs: 0, userLockHoldMs: 0, userLockWaitMs: 0 }
  for (const observer of observers) {
    const result = observer.snapshot()
    for (const key of ['sqlCount', 'sqlMs', 'userLockHoldMs', 'userLockWaitMs']) metrics[key] += result[key]
    metrics.sqlStatements += result.sqlCount - result.sqlFingerprints
      .filter(record => transactionFingerprints.has(record.fingerprint)).reduce((sum, record) => sum + record.count, 0)
  }
  return metrics
}

function meter(ui, page, observers, sample) {
  let active
  const respond = ui.respond, setData = page.setData
  const difference = before => Object.fromEntries(Object.entries(sqlMetrics(observers)).map(([key, value]) => [key, round(value - before[key])]))
  // 包在 onLoad 之前，记录 boundedSetData 实际交给原生桥接层的每个分块。
  page.setData = function (patch, callback) {
    if (active) {
      const size = bytes(patch)
      active.sets++; active.setDataBytes += size; active.maxSetDataBytes = Math.max(active.maxSetDataBytes, size)
    }
    return setData.call(this, patch, callback)
  }
  ui.respond = async (action, data) => {
    const operation = active, before = operation && sqlMetrics(observers), start = performance.now()
    const result = await respond(action, data)
    if (operation) {
      const size = bytes(result)
      operation.responseBytes += size; operation.maxResponseBytes = Math.max(operation.maxResponseBytes, size)
      if (action === 'loans.confirmInstallments') sample({ name: 'save-600-transaction', requests: 1, ...difference(before),
        requestBytes: bytes({ action, data }), responseBytes: size, maxResponseBytes: size, ms: round(performance.now() - start) })
    }
    return result
  }
  return name => {
    assert.equal(active, undefined)
    const operation = active = { name, before: sqlMetrics(observers), start: performance.now(), firstCall: ui.calls.length,
      responseBytes: 0, maxResponseBytes: 0, sets: 0, setDataBytes: 0, maxSetDataBytes: 0 }
    return () => {
      active = undefined
      const calls = ui.calls.slice(operation.firstCall)
      const { before, start, firstCall, ...result } = operation
      Object.assign(result, { requests: calls.length, actions: calls.map(call => call.action), ...difference(before),
        requestBytes: calls.reduce((sum, { name: functionName, ...envelope }) => sum + bytes(envelope), 0),
        ms: round(performance.now() - start) })
      sample(result)
      return result
    }
  }
}

async function importUpdate(services, call, syntheticBill) {
  const contents = Array.from({ length: 5 }, (_, index) => syntheticBill(200, 'SYNTHETIC-PERF-' + index))
  const prepared = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(),
    files: contents.map((content, index) => ({ fileName: '合成性能-' + index + '.csv', size: content.length })) })
  const batchIds = []
  for (const [index, file] of prepared.files.entries()) {
    services.objects.set(file.cloudPath, contents[index])
    const parsed = await call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId,
      fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
    batchIds.push(parsed.batch.batchId)
  }
  return call(services.import, 'financeUpdates.prepare', { requestId: randomUUID(), batchIds })
}

test('同检出真实Page导入摘要与600期保存性能证据', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 900000 }, async t => {
  const runs = Number(process.env.CATLEDGER_PERF_RUNS || 1)
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10)
  // 每次进程只加载一份有 .git 的检出，源文件摘要包含未提交改动。
  assert.ok(fs.existsSync(path.join(sourceRoot, '.git')))
  const { isolatedMysql } = fromSource('scripts/isolated-mysql')
  const grants = fromSource('scripts/runtime-role-grants')
  const { createObserver } = fromSource('scripts/performance-observer')
  const { localServices, call, syntheticBill } = fromSource('test/helpers/local-services')
  const { runtime } = fromSource('test/helpers/read-runtime')
  const { plan } = fromSource('test/helpers/loan-charges')
  const report = { environment: { source: git(['rev-parse', 'HEAD']), sourceFilesSha256: sourceDigest(),
    measurementSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    workingTreeChanged: !!git(['status', '--porcelain']), node: process.version, platform: os.platform(), arch: os.arch(),
    cpu: os.cpus()[0].model, runs, importFiles: 5, importRows: 1000, repaymentPeriods: 600,
    isolation: 'fresh schema per run; separate API/import minimum-grant roles; local loopback; synthetic records',
    metricDefinitions: { sqlCount: 'all observed database round trips including BEGIN/COMMIT/ROLLBACK',
      sqlStatements: 'execute/query calls excluding transaction control',
      userLockHoldMs: 'successful SELECT uid FROM catledger_users FOR UPDATE through COMMIT/ROLLBACK',
      bytes: 'UTF-8 JSON envelope bytes; setData records actual bridge patches after chunking',
      importFirst: 'first summary read in fresh Page/schema; not a cold database buffer pool',
      timing: 'instrumented local handler/Page wall time; no cloud/network/phone render time' } }, samples: [] }
  for (let run = 1; run <= runs; run++) {
    const lab = await isolatedMysql()
    const pages = []
    try {
      const [[version]] = await lab.owner.query('SELECT VERSION() AS version')
      report.environment.mysql = version.version
      const apiObserver = createObserver(await lab.role('api', grants.api))
      const importObserver = createObserver(await lab.role('import', grants.importer))
      const observers = [apiObserver, importObserver]
      const services = localServices({ apiPool: apiObserver.pool, importPool: importObserver.pool,
        subject: 'synthetic-review-perf-' + randomUUID(), now: () => Date.parse('2026-04-30T12:00:00Z') })
      const identity = await call(services.api, 'bootstrap')
      const sample = result => { const value = { run, ...result }; report.samples.push(value); t.diagnostic(JSON.stringify(value)) }
      function pageFor(name) {
        const ui = runtime(), pending = new Set()
        ui.uid = ui.app.globalData.uid = identity.uid
        ui.rawResponse = true
        ui.respond = (action, data) => {
          const response = (/^(imports|financeUpdates|reviewIssues|economicEvents)\./.test(action) ? services.import : services.api)({ action, data })
          pending.add(response)
          response.then(() => pending.delete(response), () => pending.delete(response))
          return response
        }
        // Page.load 结束后仍可有候选读取；待页面发起的请求全部完成，再划定下一次用户操作的区间。
        async function settle() {
          const started = performance.now()
          do {
            await Promise.allSettled([...pending])
            await new Promise(resolve => setImmediate(resolve))
            assert.ok(performance.now() - started < 30000, '页面请求未在计量边界内完成')
          } while (pending.size)
        }
        const page = ui.page(name)
        pages.push(page)
        return { ui, page, settle, measure: meter(ui, page, observers, sample) }
      }
      const update = await importUpdate(services, call, syntheticBill)
      const imported = pageFor('import-workbench')
      imported.page.onLoad({ fresh: '1' })
      imported.page.setData({ update: { updateId: update.updateId, version: update.appliedVersion, status: update.status }, currentStep: 1 })
      for (const name of ['import-summary-first', 'import-summary-repeat']) {
        const finish = imported.measure(name)
        await imported.page.retryPagedView()
        await imported.settle()
        const result = finish()
        assert.equal(imported.page.data.pageError, '')
        assert.equal(imported.page.data.coverage.dataRows, 1000)
        assert.equal(imported.page.data.sources.length, 5)
        assert.deepEqual(result.actions, ['financeUpdates.summary'])
        assert.ok(result.maxResponseBytes <= 64 * 1024)
        assert.ok(result.maxSetDataBytes <= 64 * 1024)
      }
      const { accountId } = await call(services.api, 'accounts.create', { requestId: randomUUID(), type: 'credit', name: '合成性能负债',
        openingDisplayBalanceMinor: '600000', occurredLocalAt: '2020-01-01T00:00:00', timezoneOffsetMinutes: -480 })
      await call(services.api, 'accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成性能银行卡',
        openingDisplayBalanceMinor: '9000000', occurredLocalAt: '2020-01-01T00:00:00', timezoneOffsetMinutes: -480 })
      const loan = await call(services.api, 'loans.create', { ...plan, accountId, requestId: randomUUID(), scheduleTerms: 600,
        baselinePrincipalMinor: '0', installmentSetup: { ...plan.installmentSetup, originalPrincipalMinor: '30000000', historicalPaidTerms: 600 } })
      const long = pageFor('loan-detail')
      long.page.onLoad({ loanId: loan.loanId })
      await long.page.load()
      await long.settle()
      assert.equal(long.page.data.errorMessage, '')
      assert.equal(long.page.data.detailError, '')
      if ('historyCoverageError' in long.page.data) assert.equal(long.page.data.historyCoverageError, '')
      assert.equal(long.page.data.repaymentRows.length, 600)
      const before = (await call(services.api, 'accounts.list')).accounts
      const finish = long.measure('save-600-with-refresh')
      assert.equal(await long.page.saveRepayments(), true)
      await long.settle()
      const result = finish()
      assert.ok(result.maxResponseBytes <= 256 * 1024)
      assert.ok(result.maxSetDataBytes <= 256 * 1024)
      assert.equal(long.ui.calls.filter(item => item.action === 'loans.confirmInstallments').length, 1)
      assert.equal(long.ui.calls.find(item => item.action === 'loans.confirmInstallments').data.repayments.length, 600)
      assert.deepEqual((await call(services.api, 'accounts.list')).accounts, before)
      const [[saved]] = await lab.owner.execute('SELECT progress_json AS progress FROM catledger_loans WHERE uid=? AND loan_id=?', [identity.uid, loan.loanId])
      const progress = typeof saved.progress === 'string' ? JSON.parse(saved.progress) : saved.progress
      assert.equal(Object.keys(progress.historyFacts).length, 600)
    } finally {
      for (const page of pages) if (page.onUnload) page.onUnload()
      await lab.close()
    }
  }
  assert.equal(sourceDigest(), report.environment.sourceFilesSha256, '测量期间源文件发生变化，需固定最终代码后重测')
  t.diagnostic(JSON.stringify({ environment: report.environment }))
  if (process.env.CATLEDGER_PERF_OUTPUT) fs.writeFileSync(process.env.CATLEDGER_PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
})
