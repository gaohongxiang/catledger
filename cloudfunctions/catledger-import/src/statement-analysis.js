const { profileForFormat } = require('./profiles')

const ANALYSIS_VERSION = 'statement-analysis-v1'

// 仅保存版本、位置和诊断，不复制原始字段值、交易号或账户主体。
function statementAnalysis(document) {
  return {
    version: ANALYSIS_VERSION,
    profile: document.profile,
    dataRows: document.rows.length,
    unknownHeaderCount: document.diagnostics.unknownHeaders.length,
    controls: document.controls || [],
    issues: document.issues || []
  }
}

function analysisFullyObserved(analysis) {
  const saved = analysis && analysis.profile
  const current = saved && profileForFormat(saved.profileId)
  const currentVersion = current && ['profileVersion', 'adapterVersion', 'policyVersion']
    .every((key) => saved[key] === current[key])
  return Boolean(analysis && analysis.version === ANALYSIS_VERSION &&
    currentVersion && analysis.unknownHeaderCount === 0 &&
    Array.isArray(analysis.controls) && analysis.controls.every((control) => control.passed) &&
    Array.isArray(analysis.issues) && analysis.issues.length === 0)
}

module.exports = { ANALYSIS_VERSION, analysisFullyObserved, statementAnalysis }
