const { RESOLUTION_STATUS } = require('./semantic-types')

function stableValue(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`
}

function mergeRuleOutputs(outputs) {
  const candidates = (outputs || []).filter((output) => output && output.ruleId)
  if (candidates.length === 0) return { status: RESOLUTION_STATUS.UNKNOWN, value: null, ruleIds: [] }
  const byValue = new Map()
  candidates.forEach((candidate) => {
    const key = stableValue(candidate.value)
    if (!byValue.has(key)) byValue.set(key, { value: candidate.value, ruleIds: [] })
    byValue.get(key).ruleIds.push(candidate.ruleId)
  })
  const ruleIds = [...new Set(candidates.map((candidate) => candidate.ruleId))].sort()
  if (byValue.size === 1) {
    return { status: RESOLUTION_STATUS.RESOLVED, value: [...byValue.values()][0].value, ruleIds }
  }
  return {
    status: RESOLUTION_STATUS.CONFLICT,
    values: [...byValue.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry.value),
    ruleIds
  }
}

// 每条来源规则产生独立候选；同值合并证据，不同值必须显式冲突。
function mergeActions(candidates, fallback) {
  const result = mergeRuleOutputs(candidates.map(({ ruleId, ...value }) => ({ ruleId, value })))
  return {
    ...(result.status === RESOLUTION_STATUS.RESOLVED ? result.value : fallback),
    ruleId: result.ruleIds[0] || fallback.ruleId,
    ruleIds: result.ruleIds,
    resolutionStatus: result.status
  }
}

module.exports = { mergeRuleOutputs, mergeActions }
