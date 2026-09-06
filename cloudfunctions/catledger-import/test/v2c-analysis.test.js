const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const { analyzeBills } = require('../../../scripts/bill-analysis')
const { buildAnalysisSnapshot, compareAnalysisSnapshots } = require('../src/analysis-snapshot')
const { parseEvidenceFile } = require('../src/parsers')
const { buildSyntheticXlsx } = require('./helpers/xlsx')
const root = path.resolve(__dirname, '../../..')
const sourceRoot = path.resolve(__dirname, '../src')
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name))
const csvRows = () => fixture('wechat-pay.csv').toString().trim().split('\n').map((line) => line.split(','))

function sample() {
  return { rows: [{ rowId: 'random-row', evidenceKey: 'physical-1', sourceFormat: 'wechat_csv', parseState: 'valid',
    analysisAction: 'purchase', analysisMoneyEffect: 'financial', amountMinor: '100', currency: 'CNY' }],
  plan: { events: [{ eventId: 'random-event', economicNature: 'expense', flowDirection: 'outflow', amountMinor: '100', currency: 'CNY', utcAt: '2026-09-01', status: 'ready' }],
    evidence: [{ rowId: 'random-row', eventId: 'random-event', evidenceRole: 'primary' }], relations: [] }, versions: { plan: 'v1' } }
}

test('稳定摘要忽略随机 ID 与展示值；用户决定和规则版本独立进入摘要', () => {
  const first = sample(), second = sample()
  second.rows[0].rowId = 'different-row'
  second.rows[0].item = '不进入摘要的商品和账号'
  second.plan.events[0].eventId = 'different-event'
  second.plan.events[0].display = { item: '不同展示' }
  second.plan.evidence[0] = { rowId: 'different-row', eventId: 'different-event', evidenceRole: 'primary' }
  const left = buildAnalysisSnapshot(first)
  const right = buildAnalysisSnapshot(second)
  assert.equal(left.digest, right.digest)
  second.versions.plan = 'v2'
  assert.equal(left.contentDigest, buildAnalysisSnapshot(second).contentDigest)
  assert.notEqual(left.digest, buildAnalysisSnapshot(second).digest)
  second.decisions = [{ eventId: 'different-event', decision: 'exclude' }]
  assert.notEqual(left.contentDigest, buildAnalysisSnapshot(second).contentDigest)
})

test('摘要不允许重复证据覆盖，差分报告保留金额和缺行变化但不泄露值', () => {
  const first = sample(), second = sample()
  second.rows.push({ ...second.rows[0] })
  assert.throws(() => buildAnalysisSnapshot(second), /ANALYSIS_EVIDENCE/)
  second.rows.pop()
  second.rows[0].amountMinor = '987654321'
  const diff = compareAnalysisSnapshots(buildAnalysisSnapshot(first), buildAnalysisSnapshot(second))
  assert.deepEqual(diff.changes[0].fields, ['amountMinor'])
  assert.ok(!JSON.stringify(diff).includes('987654321'))
})

test('四种模板具有明确金标动作、金额和性质；同额独立记录不合并', async () => {
  const cases = [
    ['wechat_csv', { content: fixture('wechat-pay.csv'), extension: 'csv' }, ['1234', '1234']],
    ['wechat_xlsx', { content: await buildSyntheticXlsx(csvRows()), extension: 'xlsx' }, ['1234', '1234']],
    ['alipay_app_csv', { content: fixture('alipay-app.csv'), extension: 'csv' }, ['2680']],
    ['alipay_web_csv', { content: fixture('alipay-web.csv'), extension: 'csv' }, ['4500']]
  ]
  for (const [profile, input, amounts] of cases) {
    const analysis = await analyzeBills(sourceRoot, [input])
    assert.equal(analysis.profiles[0].sourceFormat, profile)
    assert.deepEqual(analysis.snapshot.content.rows.map((row) => row.amountMinor).sort(), amounts)
    assert.ok(analysis.snapshot.content.rows.every((row) => row.action === 'purchase' && row.moneyEffect === 'financial'))
    assert.equal(analysis.snapshot.content.events.length, amounts.length)
    assert.ok(analysis.snapshot.content.events.every((event) => event.economicNature === 'expense' && event.status === 'needs_action'))
  }
})

test('多个完整账单工作表拒绝猜选，说明工作表不妨碍唯一账单', async () => {
  const ambiguous = await buildSyntheticXlsx(csvRows(), [csvRows()])
  await assert.rejects(parseEvidenceFile({ content: ambiguous, extension: 'xlsx', timezoneOffsetMinutes: -480 }),
    (error) => error.publicCode === 'FILE_FORMAT_UNSUPPORTED')
  const unique = await buildSyntheticXlsx([['仅说明']], [csvRows()])
  const parsed = await parseEvidenceFile({ content: unique, extension: 'xlsx', timezoneOffsetMinutes: -480 })
  assert.equal(parsed.rows.length, 2)
})

test('固定 V1 源码与 V2 对四模板只读双跑；普通收支无未经解释的语义差异', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catledger-v2c-test-'))
  try {
    const xlsx = path.join(directory, 'synthetic.xlsx')
    fs.writeFileSync(xlsx, await buildSyntheticXlsx(csvRows()))
    const report = path.join(directory, 'report.json')
    const files = ['wechat-pay.csv', 'alipay-app.csv', 'alipay-web.csv'].map((name) => path.join(__dirname, 'fixtures', name)).concat(xlsx)
    execFileSync(process.execPath, ['scripts/compare-bills.js', ...files.flatMap((file) => ['--file', file]), '--report', report], { cwd: root, stdio: 'pipe' })
    const result = JSON.parse(fs.readFileSync(report))
    assert.equal(result.equal, true)
    assert.equal(result.profiles.length, 4)
    assert.deepEqual(result.diagnostics, { before: [], after: [] })
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})


test('解析失败不声称双跑完成；文件诊断和无效交易保留在稳定快照', async () => {
  const failed = await analyzeBills(sourceRoot, [{ extension: 'csv', content: Buffer.from('未知格式') }])
  assert.equal(failed.complete, false)
  assert.equal(failed.snapshot.content.files[0].parsed, false)
  const first = sample(), second = sample()
  first.files = [{ key: 'file', parsed: true, issues: [] }]
  second.files = [{ key: 'file', parsed: true, issues: ['statement_amount_mismatch'] }]
  assert.equal(compareAnalysisSnapshots(buildAnalysisSnapshot(first), buildAnalysisSnapshot(second)).equal, false)
  const content = Buffer.from(fixture('wechat-pay.csv').toString().replaceAll('12.34', 'invalid'))
  const invalid = await analyzeBills(sourceRoot, [{ extension: 'csv', content }])
  assert.equal(invalid.complete, true)
  assert.equal(invalid.snapshot.content.rows.length, 2)
  assert.ok(invalid.snapshot.content.rows.every((row) => row.parseState === 'invalid'))
})
