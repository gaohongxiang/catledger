// 固定合成样本的逐字段证据；只采集/比较，不更新 golden fixture。
// 每份源码单独运行 capture，避免模块缓存与 UUID/时钟注入跨检出污染。
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { measure } = require('./measure-import-review')

const digest = value => createHash('sha256').update(value).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const pointer = key => String(key).replace(/~/g, '~0').replace(/\//g, '~1')

function sourceDigest(root) {
  const hash = createHash('sha256')
  function visit(directory) {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.(?:js|json|sql)$/.test(file)) hash.update(path.relative(root, file) + '\0').update(fs.readFileSync(file)).update('\0')
    }
  }
  for (const directory of ['cloudfunctions', 'migrations', 'scripts', 'test']) visit(path.join(root, directory))
  return hash.digest('hex')
}

async function capture(root) {
  const sourceRoot = path.resolve(root), sourceFilesSha256 = sourceDigest(sourceRoot)
  const results = {}, tables = {}, sql = {}
  const metrics = await measure({ sourceRoot,
    onResult(name, value) { results[name] = clone(value) },
    onRows(name, value) { tables[name] = clone(value) },
    onSql(name, value) { (sql[name] ||= []).push(clone(value)) }
  })
  if (sourceDigest(sourceRoot) !== sourceFilesSha256) throw new Error('采集期间源码变化，不能用作等价证据')
  return { source: { sourceRoot, sourceFilesSha256, node: process.version,
    measurementSha256: digest(fs.readFileSync(path.join(__dirname, 'measure-import-review.js'))) }, metrics, results, tables, sql }
}

function fieldDiff(before, after, location = '') {
  if (Object.is(before, after)) return []
  // MySQL JSON列可能由驱动返回字符串；下钻内容，仍保留全部ID、金额、时间及业务字段。
  if (location.endsWith('_json') && typeof before === 'string' && typeof after === 'string') {
    try { return fieldDiff(JSON.parse(before), JSON.parse(after), location + '/<json>') } catch (_) { /* 比较原字符串 */ }
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
      const next = location + '/' + pointer(key)
      if (!Object.hasOwn(before, key)) return [{ path: next, kind: 'added', after: after[key] }]
      if (!Object.hasOwn(after, key)) return [{ path: next, kind: 'removed', before: before[key] }]
      return fieldDiff(before[key], after[key], next)
    })
  }
  return [{ path: location, kind: 'changed', before, after }]
}

function sqlDiff(before = [], after = []) {
  const a = before.map(value => JSON.stringify(value)), b = after.map(value => JSON.stringify(value))
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const changes = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue }
    const change = { beforeIndex: i, afterIndex: j, removed: [], added: [] }
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) break
      if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) change.added.push(after[j++])
      else change.removed.push(before[i++])
    }
    changes.push(change)
  }
  return changes
}

function compare(before, after) {
  const metrics = fieldDiff(before.metrics, after.metrics, '/metrics')
  const results = fieldDiff(before.results, after.results, '/results')
  const tables = fieldDiff(before.tables, after.tables, '/tables')
  const sql = Object.fromEntries([...new Set([...Object.keys(before.sql), ...Object.keys(after.sql)])].sort()
    .map(name => [name, sqlDiff(before.sql[name], after.sql[name])]).filter(([, changes]) => changes.length))
  const tableCounts = {}, responseCounts = {}
  for (const row of tables) { const table = row.path.split('/')[2]; tableCounts[table] = (tableCounts[table] || 0) + 1 }
  for (const row of results) { const stage = row.path.split('/')[2]; responseCounts[stage] = (responseCounts[stage] || 0) + 1 }
  return { sources: { before: before.source, after: after.source }, summary: { tableFields: tables.length, tableCounts,
    responseFields: results.length, responseCounts, sqlStages: Object.keys(sql) }, metrics, results, tables, sql }
}

if (require.main === module) (async () => {
  const [command, first, second, third] = process.argv.slice(2)
  let report, output
  if (command === 'capture' && first && second && !third) { report = await capture(first); output = second }
  else if (command === 'diff' && first && second && third) {
    report = compare(JSON.parse(fs.readFileSync(first, 'utf8')), JSON.parse(fs.readFileSync(second, 'utf8'))); output = third
  } else throw new Error('用法：capture <source-root> <output.json> 或 diff <before.json> <after.json> <output.json>')
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify(report.summary || { sourceFilesSha256: report.source.sourceFilesSha256,
    stages: report.metrics.samples.length, tables: report.metrics.graph.length }) + '\n')
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })

module.exports = { capture, compare, fieldDiff, sqlDiff }
