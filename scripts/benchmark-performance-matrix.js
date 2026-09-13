// 固定环境手工验收入口；耗时阈值不放入共享 CI。每轮独立新库，分别使用 API/import 最小权限账号。
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { isolatedMysql } = require('./isolated-mysql')
const grants = require('./runtime-role-grants')
const { syntheticView, clientMetrics, databaseMetrics } = require('./benchmark-import')
const { BUDGET } = require('../cloudfunctions/catledger-import/src/performance-contract')
function sourceDigest() {
  const hash = require('node:crypto').createHash('sha256'), fs = require('node:fs')
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0')
    .filter(file => /^(cloudfunctions|shared|miniprogram|scripts|test)\//.test(file) && /\.(js|json|wxml|wxss)$/.test(file)).sort()
  for (const file of files) hash.update(file + '\0').update(fs.readFileSync(file)).update('\0')
  return hash.digest('hex')
}
function emit(value) { process.stdout.write(JSON.stringify(value) + '\n') }
function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  return { samples: values, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
}
async function main() {
  const args = process.argv.slice(2)
  const selectedRows = args.includes('--rows') ? Number(args[args.indexOf('--rows') + 1]) : null
  const runs = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3
  if ((selectedRows !== null && ![1000, 5000, 24990].includes(selectedRows)) || !Number.isSafeInteger(runs) || runs < 1 || runs > 10) throw new Error('Invalid matrix selection')
  emit({ kind: 'environment', source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceFilesSha256: sourceDigest(),
    workingTreeChanged: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), node: process.version,
    platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0].model, mysql: '8.4', runsPerSize: runs, files: 5,
    heapLimitBytes: require('node:v8').getHeapStatistics().heap_size_limit,
    isolation: 'fresh schema per run, separate API/import roles, loopback network, no cloud/device timing',
    memory: 'heap before/after each action, not peak; GC only before each run when --expose-gc is enabled' })
  for (const rows of selectedRows ? [selectedRows] : [1000, 5000, 24990]) {
    const samples = []
    for (let run = 1; run <= runs; run++) {
      if (global.gc) global.gc()
      emit({ kind: 'client', rows, run, samples: await clientMetrics(syntheticView(rows)) })
      const db = await isolatedMysql()
      try {
        const seedPool = await db.role('api', grants.api), pool = await db.role('import', grants.importer)
        await databaseMetrics(rows / 5, { pool, seedPool, sample(sample) {
          samples.push({ ...sample, run }); emit({ ...sample, run })
          const limit = ['prepareUpdate', 'organize', 'resolveAccounts', 'post'].includes(sample.stage) ? BUDGET.receipt
            : ['getCold', 'getWarm'].includes(sample.stage) ? BUDGET.summary : BUDGET.page
          if (sample.responseBytes > limit) throw new Error('response budget exceeded: ' + sample.stage)
          if (rows === 24990 && ['prepareUpdate', 'resolveAccounts', 'post'].includes(sample.stage) && sample.ms > 20000) throw new Error('20s action budget exceeded: ' + sample.stage)
          if (rows === 24990 && sample.stage === 'post' && sample.userLockHoldMs > 10000) throw new Error('10s user lock budget exceeded')
        } })
      } finally { await db.close() }
    }
    for (const stage of ['prepareUpdate', 'organize', 'getCold', 'getWarm', 'resolveAccounts', 'firstEventPage', 'post']) {
      const action = samples.filter(sample => sample.stage === stage)
      const result = { kind: 'distribution', rows, stage, count: action.length }
      for (const key of ['ms', 'sqlCount', 'sqlMs', 'responseBytes', 'userLockHoldMs', 'heapBefore', 'heapAfter', 'rssAfter', 'externalAfter', 'processMaxRssKiB']) result[key] = distribution(action.map(sample => sample[key]))
      emit(result)
    }
  }
}
if (require.main === module) main().catch(error => { process.stderr.write('Performance matrix failed: ' + (error.publicCode || error.code || error.message) + '\n'); process.exitCode = 1 })
module.exports = { distribution, sourceDigest }
