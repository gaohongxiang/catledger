const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { inspectSource, check } = require('../scripts/check-client-compatibility')

test('客户端已知安卓故障：正则字面量及字符类中的Unicode属性转义被拒绝', () => {
  for (const source of [String.raw`const name = /[^\p{L}\p{N}]/gu`, String.raw`const name = /\P{Script=Han}/u`,
    'const value = `name: ${input.replace(/\\p{L}/u, "")}`']) {
    assert.equal(inspectSource(source).findings.length, 1, source)
  }
  const [finding] = inspectSource(String.raw`// first line
const value = /\p{L}/u`).findings
  assert.equal(finding.line, 2)
  assert.equal(finding.column, 15)
  assert.equal(finding.code, 'UNICODE_PROPERTY_ESCAPE')
})

test('静态RegExp构造识别转义、字符串拼接、模板和显式flags', () => {
  const sources = [
    String.raw`const value = new RegExp('\\p{L}', 'u')`,
    String.raw`const value = RegExp("\\P{N}", "gu")`,
    String.raw`const value = new RegExp('\\p' + '{L}', 'g' + 'u')`,
    'const value = RegExp(`\\\\p{L}`, `u`)',
    'const value = RegExp(String.raw`\\p{L}`, "u")',
    String.raw`const value = globalThis.RegExp('\\p{L}', 'u')`,
    String.raw`const value = new RegExp(/\p{L}/, 'u')`,
    String.raw`const value = new RegExp(/\p{L}/u)`
  ]
  for (const source of sources) assert.equal(inspectSource(source).findings.length, 1, source)
})

test('注释、普通字符串、转义反斜杠和不相关新语法不误报', () => {
  const source = String.raw`
// The old /\p{L}/u must not return.
/* new RegExp('\\p{L}', 'u') */
const explanation = "new RegExp('\\\\p{L}', 'u')";
const text = '\\p{L}';
const ordinary = /[A-Za-z\u3400-\u9fa5]/u;
const escaped = /\\p\{L\}/u;
const legacy = /\p{L}/;
const custom = object.RegExp('\\p{L}', 'u');
const modern = input?.value ?? 0n;
const divided = 12 / 3 / 2;
`
  assert.deepEqual(inspectSource(source), { findings: [], dynamicRegExp: [] })
})

test('动态RegExp明确保留运行环境验证边界，不执行代码猜测值', () => {
  const result = inspectSource(String.raw`new RegExp(pattern, flags); new RegExp('\\p{L}', flags)`)
  assert.deepEqual(result.findings, [])
  assert.equal(result.dynamicRegExp.length, 2)
})

test('只检查实际小程序目录，覆盖主包分包与普通模块，不约束Node工具或云函数', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catledger-client-compatibility-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ compileType: 'miniprogram', miniprogramRoot: 'client/' }))
  for (const directory of ['client', 'client/packages/finance', 'cloudfunctions', 'scripts']) fs.mkdirSync(path.join(root, directory), { recursive: true })
  fs.writeFileSync(path.join(root, 'client/app.js'), 'App({})')
  fs.writeFileSync(path.join(root, 'scripts/check.js'), String.raw`const syntax = /\p{L}/u`)
  fs.writeFileSync(path.join(root, 'cloudfunctions/index.js'), String.raw`const syntax = /\p{L}/u`)
  const target = path.join(root, 'client/packages/finance/model.js')
  fs.writeFileSync(target, String.raw`const syntax = /\p{L}/u`)
  assert.throws(() => check(root), /client\/packages\/finance\/model\.js:1:16 UNICODE_PROPERTY_ESCAPE/)
  fs.writeFileSync(target, 'module.exports = value => value?.name ?? ""')
  assert.deepEqual(check(root), { files: 2, dynamicRegExp: [] })
})
