// 来源无关：经济性质只依赖已解析动作，双端关系由 Builder 完整性门禁验证。
function economicNatureForSemantic(semantic) {
  if (semantic.resolutionStatus === 'conflict') return 'unknown'
  if (['savings_in', 'savings_out', 'internal_transfer'].includes(semantic.legacy.kind)) return 'internal_transfer'
  return {
    purchase: 'expense', receipt: 'income', transfer_sent: 'expense', transfer_received: 'income',
    refund_credit: 'refund', top_up: 'internal_transfer', withdrawal: 'internal_transfer',
    repayment: 'repayment', borrow: 'borrow', fee: 'fee', yield: 'income'
  }[semantic.sourceAction] || 'unknown'
}

module.exports = { economicNatureForSemantic }
