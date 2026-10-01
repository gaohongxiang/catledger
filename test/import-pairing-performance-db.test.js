// 真 Page → 原客户端服务 → 真 handler → 本机隔离 MySQL。输出不含来源原文、参数或账户身份。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { createObserver } = require('../scripts/performance-observer')
const { setup } = require('./helpers/bank-pairing')

const root = path.resolve(__dirname, '..')
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const round = value => Math.round(value * 10) / 10
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
const enabled = Boolean(process.env.CATLEDGER_TEST_DB_HOST)

function sourceDigest(directory) {
  const hash = createHash('sha256')
  const files = git(directory, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    .filter(file => /^(cloudfunctions|shared|miniprogram)\//.test(file) && /\.(js|json|wxml|wxss)$/.test(file) && fs.existsSync(path.join(directory, file))).sort()
  for (const file of files) hash.update(file + '\0').update(fs.readFileSync(path.join(directory, file))).update('\0')
  return hash.digest('hex')
}

// 在真实服务加载之前包住实际实现；计数不复制或替换任何配对规则。
function domainMeter(directory) {
  let active = false, counts = {}
  const originals = []
  const hooks = [
    ['relation-resolver', 'buildRelations', () => 'relationBuilds'],
    ['review/reconciliation', 'refreshProjectedEvents', args => args[4] == null ? 'fullProjectionRefreshes' : 'scopedProjectionRefreshes'],
    ['review/reconciliation', 'recalculateUpdateCounts', () => 'updateCountRebuilds'],
    ['review/bank-channel-candidates', 'synchronize', () => 'bankCandidateRebuilds']
  ]
  for (const [file, name, key] of hooks) {
    const module = require(path.join(directory, 'cloudfunctions/catledger-import/src', file)), original = module[name]
    assert.equal(typeof original, 'function', file + '.' + name + ' must use the real source implementation')
    module[name] = function (...args) {
      if (active) { const label = key(args); counts[label] = (counts[label] || 0) + 1 }
      return original.apply(this, args)
    }
    originals.push(() => { module[name] = original })
  }
  return { begin() { counts = {}; active = true }, end() { active = false; return { fullProjectionRefreshes: 0, scopedProjectionRefreshes: 0,
    updateCountRebuilds: 0, bankCandidateRebuilds: 0, relationBuilds: 0, ...counts } }, close() { active = false; originals.forEach(restore => restore()) } }
}

function sqlMetrics(observers) {
  const result = { sqlCount: 0, sqlMs: 0, connectionMs: 0, userLockHoldMs: 0, userLockWaitMs: 0 }
  for (const observer of observers) {
    const metrics = observer.snapshot()
    for (const key of Object.keys(result)) result[key] += metrics[key]
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, round(value)]))
}

function pageHarness(source, c, observers) {
  const { runtime } = require(path.join(source.directory, 'test/helpers/read-runtime'))
  const ui = runtime(), pending = new Set(), actions = new Map(), seenReceipts = new Set()
  ui.uid = ui.app.globalData.uid = c.uid; ui.rawResponse = true
  let active = false, startedAt = 0, submitStartedAt = null, saved = 0
  let measurement
  const elapsed = () => round(performance.now() - startedAt)
  ui.respond = (action, data) => {
    const tracked = active
    if (tracked) {
      actions.set(action, (actions.get(action) || 0) + 1)
      measurement.requests++; measurement.requestBytes += bytes({ action, data })
    }
    const serverStart = performance.now()
    const call = (/^(imports|financeUpdates|reviewIssues|economicEvents)\./.test(action) ? c.services.import : c.services.api)({ action, data })
    pending.add(call)
    return call.then(result => {
      if (tracked) {
        const serverMs = performance.now() - serverStart
        measurement.serverMs += serverMs
        measurement.maxServerMs = Math.max(measurement.maxServerMs, serverMs)
        if (['reviewIssues.resolve', 'reviewIssues.resolvePairings'].includes(action)) {
          measurement.mutationServerMs += serverMs
          measurement.maxMutationServerMs = Math.max(measurement.maxMutationServerMs, serverMs)
        }
        const size = bytes({ result })
        measurement.responseBytes += size; measurement.maxResponseBytes = Math.max(measurement.maxResponseBytes, size)
        if (!result.ok) measurement.failedRequests++
        if (result.ok && ['reviewIssues.resolve', 'reviewIssues.resolvePairings'].includes(action) && !seenReceipts.has(data.requestId)) {
          seenReceipts.add(data.requestId)
          saved += result.data.pairing ? result.data.pairing.batchSavedCount : 1
          if (saved === measurement.pairs) measurement.allSavedMs = round(performance.now() - submitStartedAt)
        }
      }
      return result
    }).finally(() => pending.delete(call))
  }
  async function settle() {
    const start = performance.now()
    do {
      await Promise.allSettled([...pending])
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(performance.now() - start < 120000, '页面请求未在计量边界内完成')
    } while (pending.size)
  }
  const page = ui.page('import-workbench'), originalSetData = page.setData
  // 包在 onLoad 之前：之后实际交给原生桥的每个有界分块都会计数。
  page.setData = function (patch, callback) {
    if (active) {
      const size = bytes(patch)
      measurement.setDataCount++; measurement.setDataBytes += size
      measurement.maxSetDataBytes = Math.max(measurement.maxSetDataBytes, size)
    }
    return originalSetData.call(this, patch, function () {
      if (active) {
        if (measurement.firstFeedbackMs === null && (page.data.pairingSheet || page.data.currentIssue)) measurement.firstFeedbackMs = elapsed()
        if (measurement.firstContentMs === null && (page.data.pairingRows && page.data.pairingRows.length || page.data.issueVisibleEvents && page.data.issueVisibleEvents.length)) measurement.firstContentMs = elapsed()
        if (measurement.firstReadyMs === null && (page.data.pairingCanConfirm || page.data.currentIssue && page.data.currentIssue.canConfirmSame && page.data.currentMembers.length >= 2 && !page.data.busy)) measurement.firstReadyMs = elapsed()
      }
      if (callback) callback.call(page)
    })
  }
  return { ui, page, settle,
    begin(pairs) {
      observers.forEach(observer => observer.reset()); actions.clear(); seenReceipts.clear(); saved = 0
      measurement = { pairs, requests: 0, failedRequests: 0, requestBytes: 0, responseBytes: 0, maxResponseBytes: 0,
        serverMs: 0, maxServerMs: 0, mutationServerMs: 0, maxMutationServerMs: 0,
        setDataCount: 0, setDataBytes: 0, maxSetDataBytes: 0, firstFeedbackMs: null, firstContentMs: null, firstReadyMs: null,
        allSavedMs: null, interactionClicks: 0, explicitConfirmations: 0 }
      startedAt = performance.now(); active = true
    },
    click(confirm = false) {
      measurement.interactionClicks++
      if (confirm) { measurement.explicitConfirmations++; if (submitStartedAt === null) submitStartedAt = performance.now() }
    },
    finish() {
      active = false
      for (const field of ['serverMs', 'maxServerMs', 'mutationServerMs', 'maxMutationServerMs']) measurement[field] = round(measurement[field])
      return { ...measurement, totalMs: elapsed(), savedPairs: saved, actions: Object.fromEntries(actions),
        summaryReads: actions.get('financeUpdates.summary') || 0, ...sqlMetrics(observers) }
    }
  }
}

function positive(value, fallback) {
  const count = Number(value || fallback)
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 10, '性能样本数必须为 1–10')
  return count
}

test('100/1000组唯一配对真实Page到隔离MySQL：逐组基线与一次授权有界批次', { skip: !enabled, timeout: 7200000 }, async t => {
  const runs = positive(process.env.CATLEDGER_PAIRING_PERF_RUNS, 3)
  const largeRuns = positive(process.env.CATLEDGER_PAIRING_PERF_LARGE_RUNS, 1)
  const counts = (process.env.CATLEDGER_PAIRING_PERF_COUNTS || '100,1000').split(',').map(Number)
  assert.ok(counts.length && counts.every(count => [100, 1000].includes(count)))
  const sources = process.env.CATLEDGER_PERF_BASELINE_ROOT
    ? [{ label: 'baseline', directory: path.resolve(process.env.CATLEDGER_PERF_BASELINE_ROOT) }, { label: 'current', directory: root }]
    : [{ label: 'current', directory: root }]
  const sourceInfo = sources.map(source => ({ label: source.label, head: git(source.directory, ['rev-parse', 'HEAD']),
    workingTreeChanged: Boolean(git(source.directory, ['status', '--porcelain'])), measuredSourcesSha256: sourceDigest(source.directory) }))
  const report = { environment: { node: process.version, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model,
    samplesPerSource: { pairs100: runs, pairs1000: largeRuns }, sources: sourceInfo,
    measurementSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    isolation: 'fresh synthetic user and newly migrated loopback schema per sample, API/import minimum-grant roles',
    timing: 'instrumented local handler and real Page VM setData callback proxy; excludes user thinking, phone rendering, network and cloud cold-start',
    boundary: 'starts after initial workbench summary/list; counts all actual page requests through final saved summary; optional preview pagination is not simulated',
      metricDefinitions: { firstFeedbackMs: 'first sheet setData callback after opening', firstContentMs: 'first candidate/member row setData callback',
        serverMs: 'sum of real local handler invocation-to-response durations; parallel reads overlap, so not additive to Page wall time',
        mutationServerMs: 'sum of real resolve handler durations; excludes page reads and UI callbacks',
        maxMutationServerMs: 'slowest bounded resolve request; includes connection acquisition and database work, excludes cloud/network',
      firstReadyMs: 'first confirmation-ready setData callback', allSavedMs: 'first explicit confirmation through last successful command receipt',
      summaryReads: 'actual financeUpdates.summary requests', fullProjectionRefreshes: 'actual reconciliation.refreshProjectedEvents calls without a bounded event scope',
      bankCandidateRebuilds: 'actual bank-channel-candidates.synchronize calls', updateCountRebuilds: 'actual reconciliation.recalculateUpdateCounts calls',
      relationBuilds: 'actual relation-resolver.buildRelations calls', sqlCount: 'database round trips including BEGIN/COMMIT/ROLLBACK',
      bytes: 'UTF-8 JSON bytes; actual setData bridge patches after chunking' } }, samples: [] }
  for (const source of sources) {
    const domain = domainMeter(source.directory)
    try {
      for (const count of counts) for (let run = 1; run <= (count === 1000 ? largeRuns : runs); run++) {
        const lab = await isolatedMysql()
        let harness
        try {
          report.environment.mysql = (await lab.owner.query('SELECT VERSION() AS version'))[0][0].version
          const observers = [createObserver(await lab.role('api', grants.api)), createObserver(await lab.role('import', grants.importer))]
          const c = await setup({ apiPool: observers[0].pool, importPool: observers[1].pool, count, sourceRoot: source.directory })
          harness = pageHarness(source, c, observers)
          const { page } = harness
          page.onLoad({ fresh: '1' })
          await page.applyUpdateView(await c.summary())
          await harness.settle()
          assert.equal(page.data.pageError || '', '')
          harness.begin(count); domain.begin()
          if (source.label === 'baseline') {
            for (let index = 0; index < count; index++) {
              const issue = page.businessData().issues.find(issue => issue.status === 'open' && issue.issueType === 'same_event' &&
                (issue.primaryReasonCode === 'bank_channel_same_event_candidate' || (issue.reasonCodes || []).includes('bank_channel_same_event_candidate')))
              assert.ok(issue, '基线真实Page必须显示下一组银行候选，不能绕过页面直接提交')
              harness.click(); await page.openIssue({ currentTarget: { dataset: { id: issue.issueId } } })
              await harness.settle()
              assert.equal(page.data.currentIssue && page.data.currentIssue.canConfirmSame, true)
              harness.click(true); page.confirmSame(); await page._draftSession.flush(); await harness.settle()
              assert.equal(page._draftSession.status.conflicts, 0)
              assert.equal(page._draftSession.status.pending, 0)
            }
          } else {
            harness.click(); await page.openPairingReview(); await harness.settle()
            assert.equal(page.data.pairingSelectedCount, count); assert.equal(page.data.pairingCanConfirm, true)
            harness.click(true); await page.confirmPairings(); await harness.settle()
            assert.equal(page.data.pairingSaved, true, page.data.pairingError)
            assert.equal(page._draftSession.pairingTask('suggested:all').savedCount, count)
          }
          const measured = { source: source.label, run, ...harness.finish(), ...domain.end() }
          assert.equal(measured.savedPairs, count)
          assert.equal(measured.failedRequests, 0, '失败读取不能计为更快')
          assert.notEqual(measured.firstFeedbackMs, null); assert.notEqual(measured.firstContentMs, null); assert.notEqual(measured.firstReadyMs, null)
          assert.ok(measured.maxResponseBytes <= 64 * 1024); assert.ok(measured.maxSetDataBytes <= 64 * 1024)
          if (source.label === 'current') {
            assert.equal(measured.explicitConfirmations, 1); assert.equal(measured.interactionClicks, 2)
            assert.equal(measured.actions['reviewIssues.resolvePairings'], Math.ceil(count / 100)); assert.equal(measured.summaryReads, 1)
            assert.equal(measured.updateCountRebuilds, Math.ceil(count / 100))
          } else {
            assert.equal(measured.explicitConfirmations, count); assert.equal(measured.actions['reviewIssues.resolve'], count)
            assert.equal(measured.summaryReads, count)
          }
          const [[evidence]] = await lab.owner.execute('SELECT COUNT(*) AS count, COUNT(DISTINCT event_id) AS events FROM catledger_event_evidence WHERE uid=? AND update_id=?', [c.uid, c.updateId])
          assert.equal(Number(evidence.count), count * 2); assert.equal(Number(evidence.events), count)
          const [[transactions]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [c.uid])
          assert.equal(Number(transactions.count), 0, '配对完成仍只改草稿，不可提前正式入账')
          report.samples.push(measured); t.diagnostic(JSON.stringify(measured))
          if (process.env.CATLEDGER_PAIRING_PERF_OUTPUT) fs.writeFileSync(process.env.CATLEDGER_PAIRING_PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
        } finally {
          domain.end()
          if (harness) {
            if (harness.page._draftSession) await harness.page._draftSession.pause()
            harness.page.onUnload(); await harness.settle()
          }
          await lab.close()
        }
      }
      const info = sourceInfo.find(info => info.label === source.label)
      assert.equal(sourceDigest(source.directory), info.measuredSourcesSha256, '测量期间实现发生变化，需固定代码后重测')
      info.verifiedUnchanged = true
      if (process.env.CATLEDGER_PAIRING_PERF_OUTPUT) fs.writeFileSync(process.env.CATLEDGER_PAIRING_PERF_OUTPUT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    } finally { domain.close() }
  }
  sources.forEach((source, index) => assert.equal(sourceDigest(source.directory), sourceInfo[index].measuredSourcesSha256, '测量期间实现发生变化，需固定代码后重测'))
  t.diagnostic(JSON.stringify({ environment: report.environment }))
})
