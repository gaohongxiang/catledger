const { MONEY_EFFECT, getRowSemantic } = require('./row-semantic-resolver')

// 兼容旧调用点；来源字符串判断已经收口到 profiles/*。
const SOURCE_ACTION_VERSION = 'source-action-v3'

function classifySourceAction(row) {
  const semantic = getRowSemantic(row || {})
  return {
    kind: semantic.legacy.kind,
    normalizedTransactionType: semantic.legacy.transactionType,
    rule: semantic.legacy.rule,
    ruleVersion: SOURCE_ACTION_VERSION,
    sourceAction: semantic.sourceAction,
    semanticPolicyVersion: semantic.policyVersion || null
  }
}

function classifyAlipayAction(row) {
  return classifySourceAction({ ...(row || {}), sourceType: 'alipay' })
}

function classifyWechatAction(row) {
  return classifySourceAction({ ...(row || {}), sourceType: 'wechat' })
}

function isNonFinancialSourceRecord(row) {
  return getRowSemantic(row || {}).moneyEffect === MONEY_EFFECT.NON_FINANCIAL
}

module.exports = {
  SOURCE_ACTION_VERSION,
  classifyAlipayAction,
  classifySourceAction,
  classifyWechatAction,
  isNonFinancialSourceRecord
}
