const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
execFileSync(process.execPath,[path.join(root,'scripts/import-local-rules.js')],{stdio:'pipe'})
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].filter((file) => fs.existsSync(path.join(root, file)))
for (const file of files) {
  if (file.endsWith('.json')) JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' })
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
assert.equal(config.compileType, 'miniprogram')
assert.ok(fs.existsSync(path.join(root, config.miniprogramRoot, 'app.json')))
const miniRoot = path.join(root, config.miniprogramRoot)
const app = JSON.parse(fs.readFileSync(path.join(miniRoot, 'app.json'), 'utf8'))
const packages = app.subPackages || []
const routes = [...app.pages, ...packages.flatMap(pack => pack.pages.map(page => pack.root + '/' + page))]
assert.equal(new Set(routes).size, routes.length, '小程序存在重复页面路径')
for (const route of routes) for (const extension of ['js', 'json', 'wxml', 'wxss']) {
  assert.ok(fs.existsSync(path.join(miniRoot, route + '.' + extension)), `页面文件不存在: ${route}.${extension}`)
}
for (const item of app.tabBar.list) assert.ok(app.pages.includes(item.pagePath), 'Tab 页必须位于主包')
const packageOf = filename => {
  const relative = path.relative(miniRoot, filename).split(path.sep).join('/')
  const pack = packages.find(item => relative.startsWith(item.root + '/'))
  return pack ? pack.root : ''
}
for (const file of files.filter(file => file.startsWith('miniprogram/') && file.endsWith('.js'))) {
  const filename = path.join(root, file)
  for (const [, specifier] of fs.readFileSync(filename, 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    if (!specifier.startsWith('.')) continue
    const base = path.resolve(path.dirname(filename), specifier)
    const target = [base, `${base}.js`, `${base}/index.js`, `${base}.json`]
      .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    assert.ok(target, `小程序依赖不存在: ${file} -> ${specifier}`)
    assert.ok(!packageOf(target) || packageOf(target) === packageOf(filename), `小程序跨分包依赖: ${file} -> ${specifier}`)
  }
}
for (const name of ['catledger-api', 'catledger-import']) {
  const directory = path.join(root, config.cloudfunctionRoot, name)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  assert.ok(fs.existsSync(path.join(directory, manifest.main)))
}

// 工作台只允许显式注册，重复处理者不能靠对象合并顺序决定。
const workbench = path.join(root, 'miniprogram/packages/finance/pages/import-workbench')
const pageSource = fs.readFileSync(path.join(workbench, 'index.js'), 'utf8')
const registration = pageSource.slice(pageSource.indexOf('Page({'))
assert.ok(registration.startsWith('Page({'), '导入工作台必须显式注册 Page')
assert.ok(!/enhance|Object\.assign|\.\.\./.test(registration), '页面入口禁止隐式覆盖')
const handlers = [...registration.matchAll(/^  (\w+)(?::|\()/gm)].map(match => match[1])
assert.equal(new Set(handlers).size, handlers.length, '导入工作台存在重复处理者')
for (const lifecycle of ['onLoad', 'onShow', 'onHide', 'onUnload']) assert.ok(handlers.includes(lifecycle), `缺少生命周期 ${lifecycle}`)
const checkedMarkup = new Set()
function readPageMarkup(filename) {
  if (checkedMarkup.has(filename)) return ''
  checkedMarkup.add(filename)
  assert.ok(fs.existsSync(filename), `页面模板不存在: ${path.relative(root, filename)}`)
  const source = fs.readFileSync(filename, 'utf8')
  const references = [...source.matchAll(/<(?:import|include)\b[^>]*\bsrc="([^"]+)"/g)]
  return source + references.map(([, reference]) => readPageMarkup(reference.startsWith('/')
    ? path.join(miniRoot, reference) : path.resolve(path.dirname(filename), reference))).join('\n')
}
const markup = readPageMarkup(path.join(workbench, 'index.wxml'))
for (const [, handler] of markup.matchAll(/(?:bind|catch)(?::)?[\w-]+="([A-Za-z]\w*)"/g)) {
  assert.ok(handlers.includes(handler), `导入工作台丢失 WXML 处理者 ${handler}`)
}
for (const file of ['runtime.js', 'upload-flow.js', 'account-review.js', 'transaction-review.js', 'posting-flow.js']) {
  const source = fs.readFileSync(path.join(workbench, file), 'utf8')
  const methods = [...source.slice(source.indexOf('module.exports = {')).matchAll(/^  (\w+)(?::|\()/gm)].map(match => match[1])
  assert.equal(new Set(methods).size, methods.length, `${file} 存在重复处理者`)
  assert.ok(!/require\(['"]\.\/index['"]\)/.test(source), `${file} 不得反向加载 Page`)
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
for (const file of ['finance-update-core', 'finance-update-read', 'finance-update-maintenance', 'semantic-plan-upgrade']) {
  const dependencies = graph.get(`cloudfunctions/catledger-import/src/${file}.js`)
  assert.ok(!dependencies.includes('cloudfunctions/catledger-import/src/review-issue-service.js'), `${file} 不得反向依赖核对总入口`)
}
const ruleDependencies = new Set()
function inspectRule(file) {
  if (ruleDependencies.has(file)) return
  ruleDependencies.add(file)
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  assert.ok(!/\.(?:execute|query)\s*\(|\bgetPool\b|\bexecuteIdempotentMutation\b/.test(source), `纯核对规则混入存取/事务: ${file}`)
  for (const dependency of graph.get(file) || []) inspectRule(dependency)
}
inspectRule('cloudfunctions/catledger-import/src/review/policy.js')
for (const name of ['economic-nature', 'economic-event-builder', 'organizer-planner', 'relation-resolver', 'refund-relation-policy']) {
  const contents = fs.readFileSync(path.join(root, 'cloudfunctions/catledger-import/src', `${name}.js`), 'utf8')
  assert.ok(!/\braw(?:Status|TransactionType)\b|['"](?:wechat|alipay)['"]/.test(contents), `${name} 不得重新解释平台 token`)
}
assert.equal(fs.readFileSync(path.join(root, 'cloudfunctions/catledger-api/src/repayment-booking.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'cloudfunctions/catledger-import/src/repayment-booking.js'), 'utf8'), '实际还款领域契约必须一致')
assert.equal(fs.readFileSync(path.join(root, 'cloudfunctions/catledger-api/src/category-memory.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'cloudfunctions/catledger-import/src/category-memory.js'), 'utf8'), '分类记忆契约必须一致')
assert.equal(fs.readFileSync(path.join(root, 'cloudfunctions/catledger-api/src/installment-items.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'cloudfunctions/catledger-import/src/installment-items.js'), 'utf8'), '分期来源与费用防重复规则必须一致')
for (const name of ['loan-charge-domain', 'loan-charge-store', 'loan-charge-import', 'loan-charge-payments']) assert.equal(
  fs.readFileSync(path.join(root, 'cloudfunctions/catledger-api/src', name + '.js'), 'utf8'),
  fs.readFileSync(path.join(root, 'cloudfunctions/catledger-import/src', name + '.js'), 'utf8'), name + ' 费用关系必须一致')
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' })
process.stdout.write(`检查通过：${files.length} 个仓库文件，${runtime.length} 个运行时模块；语法、配置、部署边界与依赖图。\n`)
