const model = require('./model')
const detail = require('./detail-fields')
const { setChangedData } = require('../../services/view-patch')

// 组面板只承担账户映射、批量分类及关系核对；普通字段由统一编辑器维护。
function refreshIssueFieldsDraft() {
  const data = this.data, issue = data.currentIssue
  const state = model.buildIssueFieldsDraft(data)
  if (!issue) {
    setChangedData(this, { issueFieldsCanSave: false, issueFieldsReason: state.reason || '', issueDetail: null })
    return state
  }
  const row = issue.subject || data.issueEvents[0] || {}
  const facts = data.issueFacts
  const subject = facts && facts.eventId === row.eventId ? { ...row, detailFacts: facts.detailFacts,
    sourceDirection: facts.sourceDirection || row.sourceDirection } : row
  const omitted = issue.issueType === 'account_mapping' ? ['account'] : issue.issueType === 'category_assignment' ? ['category'] : []
  const fields = detail.fieldsFor(subject, { accounts: data.accounts, categories: data.categories }, { omit: omitted })
  setChangedData(this, { issueFieldsCanSave: state.valid, issueFieldsReason: state.valid ? '' : state.reason,
    issueDetail: { issueId: issue.issueId, fields, natureLabel: detail.natureLabel(subject) } })
  return state
}
module.exports = { refreshIssueFieldsDraft }
