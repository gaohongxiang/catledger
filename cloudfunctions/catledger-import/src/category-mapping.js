const { CATEGORY_ALIAS_VERSION, canonicalName, categoryMemory } = require('./category-memory')
const { CATEGORY_RULE_VERSION, categoryRule } = require('./category-rules')

function buildCategoryEvidence(sourceType, row) {
  const memory = categoryMemory(sourceType, row)
  const rule = categoryRule(sourceType, row)
  return { ...memory, ruleVersion: CATEGORY_RULE_VERSION,
    deterministicSystemKey: rule.detail ? rule.detail.systemKey : rule.sourceKey,
    rule }
}

function suggestedCategory(row, indexes) {
  // 原文不改写；旧批次也用当前规则重新计算，不能继续消费旧的宽泛类型顺序。
  const evidence = buildCategoryEvidence(row.sourceType, row)
  const mapped = key => {
    const id = key && indexes.mappings.get(`${row.sourceType}:${key}`)
    const category = indexes.byId.get(id)
    return category && category.kind === row.direction ? id : null
  }
  const system = key => key && indexes.bySystemKey.get(`${row.direction}:${key}`) || null
  const exact = mapped(evidence.pairKey)
  if (exact) return exact
  if (evidence.rule.detail) {
    const { systemKey, parentSystemKey } = evidence.rule.detail
    return system(systemKey) || system(parentSystemKey)
  }
  for (const key of [evidence.legacyItemKey, evidence.merchantKey, evidence.legacyMerchantKey]) {
    const id = mapped(key)
    if (id) return id
  }
  return system(evidence.rule.sourceKey)
}

module.exports = { CATEGORY_ALIAS_VERSION, buildCategoryEvidence, canonicalName, suggestedCategory }
