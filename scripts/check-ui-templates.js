/* 固定版本 wcc/wcsc 的离线语法检查；工具仅装在隔离目录，不加入小程序依赖。 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..', 'miniprogram')
const toolRoot = process.argv[2]
if (!toolRoot) {
  console.error('用法：node scripts/check-ui-templates.js <隔离目录/node_modules/miniprogram-compiler>')
  process.exit(2)
}
const meta = JSON.parse(fs.readFileSync(path.resolve(toolRoot, 'package.json'), 'utf8'))
if (meta.name !== 'miniprogram-compiler' || meta.version !== '0.2.3') throw new Error('请使用固定的 miniprogram-compiler@0.2.3')
const platform = { linux: 'linux', darwin: 'mac', win32: 'windows' }[process.platform]
if (!platform) throw new Error('未支持的模板检查系统：' + process.platform)
const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join('/'))
  }
}
walk(root)
const wxml = files.filter(file => file.endsWith('.wxml'))
const componentArgs = []
let declaredPages = 0
const componentStyles = []
for (const template of wxml) {
  const configPath = path.join(root, template.replace(/\.wxml$/, '.json'))
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {}
  if (config.usingComponents) {
    const names = Object.keys(config.usingComponents).sort()
    componentArgs.push(template, String(names.length), ...names)
    declaredPages++
  }
  if (config.component && files.includes(template.replace(/\.wxml$/, '.wxss'))) componentStyles.push(template.replace(/\.wxml$/, '.wxss'))
}
const wxss = files.filter(file => file.endsWith('.wxss') && !componentStyles.includes(file))
const results = []
function compile(name, args, count) {
  const executable = path.resolve(toolRoot, 'bin', platform, name + (process.platform === 'win32' ? '.exe' : ''))
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    console.error(result.error ? result.error.message : result.stderr)
    throw new Error(name + ' 编译失败')
  }
  // 编译器的非致命诊断也保留，不把兼容提示藏在成功计数里。
  if (result.stderr.trim()) console.error(result.stderr.trim())
  results.push({ compiler: name, files: count, bytes: Buffer.byteLength(result.stdout), passed: true })
}
compile('wcc', ['-d', '-cc', [declaredPages, ...componentArgs].join(' '), ...wxml, ...files.filter(file => file.endsWith('.wxs')), '-gn', '$gwx'], wxml.length)
compile('wcsc', ['-db', '-pc', String(componentStyles.length), ...componentStyles, ...wxss], componentStyles.length + wxss.length)
console.log(JSON.stringify({ tool: meta.name, version: meta.version, results, scope: '离线模板和样式编译；不等于开发者工具或真机验收' }))
