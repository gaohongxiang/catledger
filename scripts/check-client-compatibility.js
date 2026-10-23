// Regression gate for syntax that has failed on the supported WeChat Android runtime.
// This is not a complete engine compatibility matrix or a substitute for device testing.
const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('acorn')

function staticString(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left), right = staticString(node.right)
    if (left !== null && right !== null) return left + right
  }
  if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'MemberExpression' &&
      !node.tag.computed && node.tag.object.name === 'String' && node.tag.property.name === 'raw' &&
      !node.quasi.expressions.length) return node.quasi.quasis[0].value.raw
  return null
}

function hasUnicodePropertyEscape(pattern, flags) {
  if (!/[uv]/.test(flags)) return false
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== '\\') continue
    const escaped = pattern[++index]
    if ((escaped === 'p' || escaped === 'P') && pattern[index + 1] === '{') return true
  }
  return false
}

function isRegExpCall(node) {
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return false
  const callee = node.callee
  return callee.type === 'Identifier' && callee.name === 'RegExp' ||
    callee.type === 'MemberExpression' && !callee.computed && callee.object.name === 'globalThis' && callee.property.name === 'RegExp'
}

function inspectSource(source) {
  // Parse modern syntax without banning it wholesale. Only the known incompatible
  // regular-expression feature below is restricted for packaged client code.
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'commonjs', locations: true })
  const findings = new Map(), dynamicRegExp = []
  function report(node) {
    findings.set(node.start, { line: node.loc.start.line, column: node.loc.start.column + 1,
      code: 'UNICODE_PROPERTY_ESCAPE', message: '微信客户端不得使用 Unicode 属性转义正则（\\p{…}/\\P{…}）；请使用已验证的显式字符范围。' })
  }
  function visit(node) {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Literal' && node.regex && hasUnicodePropertyEscape(node.regex.pattern, node.regex.flags)) report(node)
    if (isRegExpCall(node) && node.arguments.length) {
      const patternNode = node.arguments[0], literal = patternNode.regex
      const pattern = literal ? literal.pattern : staticString(patternNode)
      const flags = node.arguments.length > 1 ? staticString(node.arguments[1]) : literal ? literal.flags : ''
      if (pattern === null || flags === null) dynamicRegExp.push({ line: node.loc.start.line, column: node.loc.start.column + 1 })
      else if (hasUnicodePropertyEscape(pattern, flags)) report(patternNode)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value.type === 'string') visit(value)
    }
  }
  visit(ast)
  return { findings: [...findings.values()], dynamicRegExp }
}

function clientFiles(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'))
  if (config.compileType !== 'miniprogram' || typeof config.miniprogramRoot !== 'string') {
    throw new Error('客户端兼容检查需要原生小程序目录配置')
  }
  const directory = path.resolve(root, config.miniprogramRoot)
  const relative = path.relative(root, directory)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('小程序目录必须位于仓库内的独立目录')
  }
  function walk(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules' || entry.name === '.git') return []
      const filename = path.join(folder, entry.name)
      if (entry.isDirectory()) return walk(filename)
      if (entry.isSymbolicLink()) throw new Error('客户端检查不接受符号链接: ' + path.relative(root, filename))
      return entry.isFile() && entry.name.endsWith('.js') ? [filename] : []
    })
  }
  return walk(directory).sort()
}

function check(root) {
  const files = clientFiles(root), findings = [], dynamicRegExp = []
  for (const filename of files) {
    const file = path.relative(root, filename)
    let result
    try { result = inspectSource(fs.readFileSync(filename, 'utf8')) }
    catch (error) { throw new Error(`客户端 JavaScript 解析失败: ${file}: ${error.message}`) }
    findings.push(...result.findings.map(item => ({ file, ...item })))
    dynamicRegExp.push(...result.dynamicRegExp.map(item => ({ file, ...item })))
  }
  if (findings.length) throw new Error('客户端兼容检查失败\n' + findings.map(item =>
    `${item.file}:${item.line}:${item.column} ${item.code} ${item.message}`).join('\n'))
  return { files: files.length, dynamicRegExp }
}

if (require.main === module) {
  try {
    const result = check(path.resolve(__dirname, '..'))
    process.stdout.write(`客户端兼容检查通过：${result.files} 个小程序 JS 文件；Unicode 属性转义正则门禁。${result.dynamicRegExp.length} 处动态 RegExp 未静态求值；仍须原生和真机验证。\n`)
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}

module.exports = { inspectSource, check }
