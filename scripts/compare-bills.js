const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { analyzeBills } = require('./bill-analysis')
const { compareAnalysisSnapshots } = require('../cloudfunctions/catledger-import/src/analysis-snapshot')

const root = path.resolve(__dirname, '..')
const prefix = 'cloudfunctions/catledger-import'
async function main() {
  const args = process.argv.slice(2)
  const files = []
  let baseline = '3e83a9e2', reportPath
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--file' && args[i + 1]) files.push(path.resolve(args[i + 1]))
    else if (args[i] === '--baseline-ref' && args[i + 1]) baseline = args[i + 1]
    else if (args[i] === '--report' && args[i + 1]) reportPath = path.resolve(args[i + 1])
    else throw new Error('ARGUMENT_INVALID')
  }
  if (!files.length || !reportPath || !/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('ARGUMENT_INVALID')
  // 私有分析报告显式写到仓库外，避免差分证据误入版本控制。
  if (!path.relative(root, reportPath).startsWith('..' + path.sep)) throw new Error('REPORT_MUST_BE_OUTSIDE_REPOSITORY')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catledger-shadow-'))
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', sha, `${prefix}/src`], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    for (const name of names) {
      const target = path.join(directory, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, execFileSync('git', ['show', `${sha}:${name}`], { cwd: root }))
    }
    fs.symlinkSync(path.join(root, prefix, 'node_modules'), path.join(directory, prefix, 'node_modules'), 'dir')
    const inputs = files.map((file) => ({ content: fs.readFileSync(file), extension: path.extname(file).slice(1).toLowerCase() }))
    const before = await analyzeBills(path.join(directory, prefix, 'src'), inputs)
    const after = await analyzeBills(path.join(root, prefix, 'src'), inputs)
    const diff = compareAnalysisSnapshots(before.snapshot, after.snapshot)
    fs.writeFileSync(reportPath, JSON.stringify({ baseline: sha, ...diff,
      comparisonComplete: before.complete && after.complete,
      profiles: after.profiles, diagnostics: { before: before.diagnostics, after: after.diagnostics },
      counts: { before: before.counts, after: after.counts } }, null, 2), { flag: 'wx', mode: 0o600 })
    process.stdout.write(JSON.stringify({ inputs: files.length, differences: diff.changes.length,
      diagnostics: after.diagnostics.length, comparisonComplete: before.complete && after.complete }) + '\n')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
main().catch(() => { process.stderr.write('账单差分未完成；请核对参数、依赖及仓库外的新报告路径。原始错误与账单内容不会输出。\n'); process.exitCode = 1 })
