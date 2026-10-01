// 合成账单、真实 Page/service/handler、隔离 MySQL；数据桥回调仅是 VM 可见代理。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { randomUUID, createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { createObserver } = require('../scripts/performance-observer')
const { setup } = require('./helpers/bank-pairing')
const root = path.resolve(__dirname, '..')
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const round = value => Math.round(value * 100) / 100
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()

function sourceDigest(directory) {
  const hash = createHash('sha256')
  const files = git(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    .filter(file => (/^(cloudfunctions|shared|miniprogram)\//.test(file) && /\.(js|json|wxml|wxss)$/.test(file) ||
      file === 'test/helpers/read-runtime.js') && fs.existsSync(path.join(directory, file))).sort()
  for (const file of files) hash.update(file + '\0').update(fs.readFileSync(path.join(directory, file))).update('\0')
  return hash.digest('hex')
}

// 只观测真实服务的开始/结束边界。最长不重叠请求链不等于代码中的 await 因果图。
function requestMeter(stableKey, startedAt) {
  const timeline = [], counts = new Map()
  let active = 0, peak = 0, event = 0, maxCompletedRound = 0
  return {
    begin(action, data) {
      const key = stableKey(action, data)
      const existing = counts.get(key)
      if (existing) existing.count++
      else counts.set(key, { action, count: 1 })
      const row = { action, startMs: round(performance.now() - startedAt), startOrder: ++event,
        observedRound: maxCompletedRound + 1, concurrencyAtStart: ++active, endMs: null, endOrder: null, ok: null }
      peak = Math.max(peak, active); timeline.push(row)
      return ok => {
        assert.equal(row.endOrder, null, '请求完成事件不能重复计数')
        row.endMs = round(performance.now() - startedAt); row.endOrder = ++event; row.ok = ok
        active--; maxCompletedRound = Math.max(maxCompletedRound, row.observedRound)
      }
    },
    snapshot() {
      assert.equal(active, 0, '请求计量结束时仍有未完成请求')
      const duplicates = [...counts.values()].filter(row => row.count > 1), duplicateActions = {}
      for (const row of duplicates) duplicateActions[row.action] = (duplicateActions[row.action] || 0) + row.count - 1
      return { measuredRequests: timeline.length, observedSerialRequestRounds: maxCompletedRound,
        maxConcurrentRequests: peak, duplicateRequests: duplicates.reduce((total, row) => total + row.count - 1, 0),
        duplicateRequestGroups: duplicates.length, duplicateActions, failedRequests: timeline.filter(row => !row.ok).length,
        requestTimeline: timeline }
    }
  }
}

async function measure(source, c, sql, kind, issueId) {
  const { runtime } = require(path.join(source, 'test/helpers/read-runtime'))
  const ui = runtime(), pending = new Set()
  ui.uid = ui.app.globalData.uid = c.uid; ui.rawResponse = true
  const viewSessionSource = fs.readFileSync(path.join(source, 'miniprogram/services/import-view-session.js'), 'utf8')
  const cacheObservable = /observer\.record\(\s*['"]cache['"]/.test(viewSessionSource)
  const observer = ui.load('services/read-observer'), originalRecord = observer.record
  let sample, started, requests
  // 直接收取既有埋点，避免 observer 的 300 条留存上限；不打开或改变业务观测模式。
  observer.record = function (event, value) {
    if (sample && cacheObservable && event === 'cache' && /^(reviewIssues|financeUpdates|economicEvents)\./.test(value.action || '') && typeof value.hit === 'boolean') {
      const cache = sample.viewSessionCache
      cache.lookups++; cache[value.hit ? 'hits' : 'misses']++
      const action = cache.byAction[value.action] || (cache.byAction[value.action] = { lookups: 0, hits: 0, misses: 0 })
      action.lookups++; action[value.hit ? 'hits' : 'misses']++
    }
    return originalRecord.call(this, event, value)
  }
  ui.respond = (action, data) => {
    const measured = sample, finish = measured ? requests.begin(action, data) : null
    let result
    try { result = c.services.import({ action, data }) }
    catch (error) { if (finish) finish(false); throw error }
    pending.add(result)
    result.then(value => {
      pending.delete(result)
      if (finish) finish(Boolean(value && value.ok === true))
      if (measured) { const size = bytes(value); measured.responseBytes += size; measured.maxResponseBytes = Math.max(measured.maxResponseBytes, size) }
    }, () => { pending.delete(result); if (finish) finish(false) })
    return result
  }
  const settle = async () => {
    const since = performance.now()
    do { await Promise.allSettled([...pending]); await new Promise(resolve => setImmediate(resolve)); assert.ok(performance.now() - since < 30000) } while (pending.size)
  }
  const page = ui.page('import-workbench'), original = page.setData
  page.setData = function (patch, callback) {
    if (sample) { const size = bytes(patch); sample.sets++; sample.setDataBytes += size; sample.maxSetDataBytes = Math.max(sample.maxSetDataBytes, size) }
    return original.call(this, patch, function () {
      if (sample) {
        const data = page.data, elapsed = round(performance.now() - started)
        if (data.currentIssue && sample.feedbackMs === null) sample.feedbackMs = elapsed
        if (data.currentIssue && data.issueEvents.length && sample.contentMs === null) sample.contentMs = elapsed
        const ready = Object.hasOwn(data, 'issueCanSubmit') ? data.issueCanSubmit
          : Boolean(data.currentIssue && !data.busy && (kind !== 'historical' || data.historicalCandidates.length && !data.historicalLoading))
        if (ready && sample.readyMs === null) sample.readyMs = elapsed
        if (data.issueVisibleEvents.length && data.issueVisibleEvents.every(row => row.evidence && row.evidence.length && !row.evidenceLoading && !row.evidenceError) && sample.evidenceMs === null) sample.evidenceMs = elapsed
      }
      if (callback) callback.call(page)
    })
  }
  page.onLoad({ fresh: '1' })
  await page.applyUpdateView(await c.summary()); await settle()
  const results = []
  for (const mode of ['first-open', 'same-version-reopen']) {
    sql.reset(); const firstCall = ui.calls.length
    sample = { kind, mode, responseBytes: 0, maxResponseBytes: 0, sets: 0, setDataBytes: 0, maxSetDataBytes: 0,
      feedbackMs: null, contentMs: null, readyMs: null, evidenceMs: null,
      viewSessionCache: { available: cacheObservable, lookups: cacheObservable ? 0 : null, hits: cacheObservable ? 0 : null,
        misses: cacheObservable ? 0 : null, byAction: cacheObservable ? {} : null } }
    started = performance.now()
    requests = requestMeter(ui.cache.stableKey, started)
    await page.openIssue({ currentTarget: { dataset: { id: issueId } } }); await settle()
    assert.ok(page.data.currentIssue, page.data.errorMessage)
    assert.equal(page.data.issueDetailsError || '', '')
    assert.equal(page.data.historicalError || '', '')
    for (const field of ['feedbackMs', 'contentMs', 'readyMs', 'evidenceMs']) assert.notEqual(sample[field], null, kind + ':' + field)
    const metrics = sql.snapshot(), calls = ui.calls.slice(firstCall)
    const requestMetrics = requests.snapshot()
    assert.equal(requestMetrics.measuredRequests, calls.length, '每次真实页面请求都必须进入计量边界')
    Object.assign(sample, { totalMs: round(performance.now() - started), requests: calls.length, actions: calls.map(row => row.action),
      sqlCount: metrics.sqlCount, sqlMs: round(metrics.sqlMs), connectionMs: round(metrics.connectionMs), lockMs: round(metrics.userLockHoldMs) }, requestMetrics)
    assert.ok(sample.maxResponseBytes <= 256 * 1024); assert.ok(sample.maxSetDataBytes <= 64 * 1024)
    results.push(sample); sample = null; page.closeIssue(); await settle()
  }
  page.onUnload()
  observer.record = originalRecord
  return results
}

test('普通字段与历史核对弹窗同机基线/当前各3轮真实Page请求、SQL及阶段代理计量', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 300000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), sql = createObserver(await lab.role('import', grants.importer))
    const sources = process.env.CATLEDGER_PERF_BASELINE_ROOT
      ? [{ label: 'baseline', directory: path.resolve(process.env.CATLEDGER_PERF_BASELINE_ROOT) }, { label: 'current', directory: root }]
      : [{ label: 'current', directory: root }]
    const measurementSha256 = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
    const report = { environment: { runs: 3, records: 8, cpu: os.cpus()[0].model, node: process.version,
      mysql: (await lab.owner.query('SELECT VERSION() AS version'))[0][0].version,
      timing: 'local real Page/service/handler; setData callback VM proxy, excludes native rendering, real network and cloud cold-start',
      sql: 'database round trips including transaction controls; overlapping SQL ms must not be added to client wall time',
      measurementSha256, sourceHashScope: 'Git-listed JS/JSON/WXML/WXSS under cloudfunctions, shared and miniprogram, plus test/helpers/read-runtime.js; includes untracked, non-ignored source files',
      metricDefinitions: {
        requestBoundary: 'real Page cloud-call adapter entering the real local import service through its promise settlement; initial workbench summary/list and closing are excluded',
        observedSerialRequestRounds: 'longest chain of non-overlapping real requests by exact start/settlement event order: start round = 1 + maximum round already settled; zero requests gives zero rounds. This measures temporal serialization, not a proven await/causal dependency graph; concurrency limits and independent scheduling can also increase it',
        maxConcurrentRequests: 'maximum requests entered but not yet settled at the same real-service boundary; not SQL connection concurrency',
        duplicateRequests: 'within one sample, sum(count - 1) for repeated action plus canonical JSON data; object key order and omitted undefined do not change identity, array order does; first requests are excluded',
        duplicateRequestGroups: 'number of action-plus-data identities requested more than once; duplicateActions groups only excess requests by action; no arguments or identity keys are emitted',
        viewSessionCache: 'existing import-view-session cache events captured before observer retention filtering. hits includes retained responses and pending-request coalescing; these cannot be separated by the existing event. Baseline without this emitter reports available:false and null counts, not inferred zero hits',
        requestTimeline: 'actual start/settlement elapsed ms plus unrounded event order and observed round; actions only, no request arguments',
        failedRequests: 'real service rejection, synchronous throw, or response without ok:true'
      }, sources: sources.map(source => ({ label: source.label, head: git(source.directory, ['rev-parse', 'HEAD']),
        measuredSourcesSha256: sourceDigest(source.directory) })) }, samples: [] }
    for (const source of sources) {
      const c = await setup({ apiPool, importPool: sql.pool, count: 8, sourceRoot: source.directory })
      const content = Buffer.from(c.contents[1].toString().replaceAll('2026-09-01', '2026-09-02').replaceAll('SYNTHETIC-BANK-', 'SYNTHETIC-FIELDS-'))
      c.updateId = await c.prepare([content]); await c.map()
      let issues = (await c.imp('reviewIssues.list', { updateId: c.updateId, status: 'open', pageSize: 100 })).items
      const fields = issues.find(row => row.issueType === 'shared_fields')
      assert.ok(fields, '合成银行未知性质应保留普通字段核对')
      for (let run = 1; run <= 3; run++) for (const sample of await measure(source.directory, c, sql, 'fields', fields.issueId)) report.samples.push({ source: source.label, run, ...sample })
      await c.api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: c.accountId,
        categoryId: c.user.categories.find(row => row.kind === 'expense').id, amountMinor: '1234',
        occurredLocalAt: '2026-09-02T12:00:00', timezoneOffsetMinutes: -480 })
      await c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await c.summary()).update.version })
      issues = (await c.imp('reviewIssues.list', { updateId: c.updateId, status: 'open', pageSize: 100 })).items
      const historical = issues.find(row => row.primaryReasonCode === 'historical_duplicate_candidate')
      assert.ok(historical, '已记合成交易应提供历史关联入口')
      for (let run = 1; run <= 3; run++) for (const sample of await measure(source.directory, c, sql, 'historical', historical.issueId)) report.samples.push({ source: source.label, run, ...sample })
    }
    for (const source of sources) {
      const info = report.environment.sources.find(row => row.label === source.label)
      info.measuredSourcesSha256End = sourceDigest(source.directory)
      assert.equal(info.measuredSourcesSha256End, info.measuredSourcesSha256, source.label + ': 测量期间源码发生变化')
      assert.equal(git(source.directory, ['rev-parse', 'HEAD']), info.head, source.label + ': 测量期间提交发生变化')
    }
    report.environment.measurementSha256End = createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')
    assert.equal(report.environment.measurementSha256End, measurementSha256, '测量期间脚本发生变化')
    if (process.env.CATLEDGER_REVIEW_LOADING_PERF_OUTPUT) fs.writeFileSync(process.env.CATLEDGER_REVIEW_LOADING_PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    t.diagnostic(JSON.stringify(report))
  } finally { await lab.close() }
})
