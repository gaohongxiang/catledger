// 语义缺陷与账户绑定缺失分开，不能靠填单账户解除。组合支付的显式人工分项例外由 payment-resolution 验证，原始阻断仍保留。
const SEMANTIC_HARD_BLOCKERS = Object.freeze([
  'payment_components_ambiguous', 'row_semantic_conflict',
  'row_transaction_type_unknown', 'row_status_unknown', 'source_profile_unknown', 'row_amount_invalid'
])

function semanticBlockers(semantic) {
  return [...new Set((semantic && semantic.issues || [])
    .map((issue) => issue.code).filter((code) => SEMANTIC_HARD_BLOCKERS.includes(code)))]
}

module.exports = { SEMANTIC_HARD_BLOCKERS, semanticBlockers }
