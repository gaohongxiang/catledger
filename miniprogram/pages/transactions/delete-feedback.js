const readCache = require('../../services/read-cache')

const confirmation = '永久删除所选账目，不可恢复。余额和统计将更新。'
const refreshMessage = '已删除，列表待刷新'

function revision(app) {
  const marker = app.globalData.transactionDeleteRefresh
  return marker && marker.session === readCache.getSession() ? marker.revision : 0
}
function markDeleted(app) {
  app.globalData.transactionDeleteRefresh = { session: readCache.getSession(), revision: revision(app) + 1 }
}
function needsRefresh(page, app, appliedRevision = page._deleteRefreshRevision) {
  const current = revision(app)
  return current > 0 && appliedRevision !== current
}
function failureMessage(error) {
  const messages = {
    REFUNDED_TRANSACTION_LOCKED: '原消费还有关联退款，请到明细同时选择原消费和对应退款后删除。',
    TRANSACTION_GROUP_LOCKED: '账目属于同一来源的组合付款或还款分配，请到明细选中完整分配组后删除。',
    LOAN_TRANSACTION_LOCKED: '账目关联贷款、分期付款或费用，请从“全部贷款与还款”进入对应详情处理。',
    LOAN_BASELINE_LOCKED: '账目关联贷款本金基准，请从“全部贷款与还款”进入对应贷款详情处理。',
    INSUFFICIENT_CASH_BALANCE: '删除后现金余额不足，请先到该账户明细核对收支。',
    CONFLICT: '账目已被修改，请刷新后重新选择。此次未删除任何账目。'
  }
  return messages[error.code] || error.message || '删除未完成，请重试'
}

module.exports = { confirmation, refreshMessage, revision, markDeleted, needsRefresh, failureMessage }
