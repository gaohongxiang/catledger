const assert = require('node:assert/strict')
const test = require('node:test')
const { profileForFormat } = require('../src/profiles')
const { buildCoverageReport } = require('../src/coverage-report')

function input(count = 1) {
  return {
    sources: [{ summary: { total: count, invalid: 0 }, analysis: {
      version: 'statement-analysis-v1', profile: { ...profileForFormat('wechat_csv') },
      dataRows: count, unknownHeaderCount: 0, controls: [], issues: []
    } }],
    rows: Array.from({ length: count }, (_, index) => ({ rowId: `row-${index}`, parseState: 'valid',
      semantic: { resolutionStatus: 'resolved', moneyEffect: 'financial' }, issues: [] })),
    events: Array.from({ length: count }, (_, index) => ({ eventId: `event-${index}`, status: 'ready', reasonCodes: [] })),
    evidence: Array.from({ length: count }, (_, index) => ({ rowId: `row-${index}`, eventId: `event-${index}`, evidenceRole: 'primary' })),
    issues: []
  }
}

test('已识别但账户尚未确认时区分整账识别与当前可入账', () => {
  const data = input()
  data.events[0].status = 'needs_action'
  data.events[0].reasonCodes = ['payment_reference_mapping_required']
  data.issues.push({ status: 'open', blocking: true, issueType: 'account_mapping' })
  const report = buildCoverageReport(data)
  assert.equal(report.statementFullyRecognized, true)
  assert.equal(report.selectedEventsReadyToPost, false)
})

test('排除未知语义不会把整份账单提升为完整识别', () => {
  const data = input()
  data.rows[0].semantic.resolutionStatus = 'unknown'
  data.events[0].status = 'excluded'
  data.events[0].reasonCodes = ['economic_nature_required']
  const report = buildCoverageReport(data)
  assert.equal(report.statementFullyRecognized, false)
  assert.equal(report.unrecognizedRows, 1)
  assert.equal(report.dispositionCounts.user_excluded, 1)
})

test('无效来源行具有独立归宿，不要求伪造资金事件', () => {
  const data = input(3)
  data.rows[2].parseState = 'invalid'
  data.events.pop()
  data.evidence.pop()
  const report = buildCoverageReport(data)
  assert.equal(report.invalidRows, 1)
  assert.equal(report.recognizedRows, 2)
  assert.equal(report.rowConservationPassed, true)
  assert.equal(report.statementFullyRecognized, false)
})

test('全部选中事件 ready 且无阻断问题时可整批入账', () => {
  const report = buildCoverageReport(input(2))
  assert.equal(report.statementFullyRecognized, true)
  assert.equal(report.selectedEventsReadyToPost, true)
  assert.equal(report.readySelectedEvents, 2)
})

test('丢失与重复 Evidence 归宿均使守恒失败', () => {
  for (const mutate of [
    (data) => data.evidence.pop(),
    (data) => data.evidence.push({ ...data.evidence[0] }),
    (data) => data.evidence.push({ rowId: 'foreign-row', eventId: 'event-0', evidenceRole: 'primary' }),
    (data) => data.rows.push({ ...data.rows[0] }),
    (data) => data.events.push({ eventId: 'orphan-event', status: 'ready', reasonCodes: [] })
  ]) {
    const data = input(2)
    mutate(data)
    const report = buildCoverageReport(data)
    assert.equal(report.rowConservationPassed, false)
    assert.equal(report.statementFullyRecognized, false)
    assert.equal(report.selectedEventsReadyToPost, false)
  }
})

test('多个重复来源行可以归到一个事件，同时保留每行归宿', () => {
  const data = input(2)
  data.events.pop()
  data.evidence[1] = { rowId: 'row-1', eventId: 'event-0', evidenceRole: 'duplicate' }
  const report = buildCoverageReport(data)
  assert.equal(report.statementFullyRecognized, true)
  assert.equal(report.dispositionCounts.duplicate, 1)
  assert.equal(report.dispositionCounts.financial, 1)
})

test('未知列、控制失败与缺少旧文件观测均不能宣称整账完整', () => {
  for (const analysis of [null,
    { ...input().sources[0].analysis, unknownHeaderCount: 1 },
    { ...input().sources[0].analysis, profile: { profileId: 'wechat_csv', policyVersion: 'stale' } },
    { ...input().sources[0].analysis, controls: [{ passed: false }] }
  ]) {
    const data = input()
    data.sources[0].analysis = analysis
    const report = buildCoverageReport(data)
    assert.equal(report.statementFullyRecognized, false)
    assert.equal(report.selectedEventsReadyToPost, true)
  }
})

test('非资金记录和明确排除已识别记录保留语义完整度', () => {
  const data = input(2)
  data.rows[0].semantic.moneyEffect = 'non_financial'
  data.events[0].status = 'excluded'
  data.events[1].status = 'excluded'
  const report = buildCoverageReport(data)
  assert.equal(report.statementFullyRecognized, true)
  assert.equal(report.dispositionCounts.non_financial, 1)
  assert.equal(report.dispositionCounts.user_excluded, 1)
  assert.equal(report.selectedEventsReadyToPost, false)
})


test('即使事件状态残留为 ready，持久化的语义阻断仍不可入账', () => {
  const data = input()
  data.events[0].fieldSources = { semanticBlockers: ['payment_components_ambiguous'] }
  assert.equal(buildCoverageReport(data).selectedEventsReadyToPost, false)
})
