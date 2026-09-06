const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].filter((file) => fs.existsSync(path.join(root, file)))
for (const file of files) {
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' })
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
assert.equal(config.compileType, 'miniprogram')
assert.ok(fs.existsSync(path.join(root, config.miniprogramRoot, 'app.json')))
for (const name of ['catledger-api', 'catledger-import']) {
  const directory = path.join(root, config.cloudfunctionRoot, name)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(directory, manifest.main)))
}

// 检查实际 CommonJS 依赖图：函数包独立部署，领域层禁止循环引用。
const runtime = files.filter((file) => /^cloudfunctions\/[^/]+\/(?:src\/.*|index)\.js$/.test(file))
const graph = new Map(runtime.map((file) => [file, []]))
for (const file of runtime) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  for (const [, specifier] of text.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    if (!specifier.startsWith('.')) continue
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    const target = [base, `${base}.js`, `${base}/index.js`, `${base}.json`]
      .find((candidate) => fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile())
    assert.ok(target, `本地依赖不存在: ${file} -> ${specifier}`)
    assert.equal(target.split('/')[1], file.split('/')[1], `跨部署包依赖: ${file} -> ${target}`)
    if (graph.has(target)) graph.get(file).push(target)
  }
}
const visited = new Set()
function visit(file, stack = []) {
  assert.ok(!stack.includes(file), `循环依赖: ${[...stack, file].join(' -> ')}`)
  if (visited.has(file)) return
  for (const target of graph.get(file)) visit(target, [...stack, file])
  visited.add(file)
}
for (const file of runtime) visit(file)
for (const name of ['economic-nature', 'economic-event-builder', 'organizer-planner', 'relation-resolver', 'refund-relation-policy']) {
  const contents = fs.readFileSync(path.join(root, 'cloudfunctions/catledger-import/src', `${name}.js`), 'utf8')
  assert.ok(!/\braw(?:Status|TransactionType)\b|['"](?:wechat|alipay)['"]/.test(contents), `${name} 不得重新解释平台 token`)
}
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' })
process.stdout.write(`检查通过：${files.length} 个仓库文件，${runtime.length} 个运行时模块；语法、配置、部署边界与依赖图。\n`)
