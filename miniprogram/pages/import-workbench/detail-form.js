const model = require('./model')
const detail = require('./detail-fields')
const { setChangedData } = require('../../services/view-patch')
const GENERIC = new Set(['shared_fields', 'field_conflict'])
const CATEGORY = new Set(['income', 'expense', 'fee'])
const transfer = nature => ['internal_transfer', 'repayment', 'borrow'].includes(nature)
const available = account => account && account.accountId && !account.isPlaceholder && !account.archived && !account.archivedAt && !account.unavailable
function subject(data) {
  const row = data.currentIssue && data.currentIssue.subject || (data.issueEvents || [])[0] || {}
  const facts = data.issueFacts
  return facts && facts.eventId === row.eventId ? { ...row, detailFacts: facts.detailFacts,
    sourceDirection: facts.sourceDirection || row.sourceDirection } : row
}
function selected(data, property, index) { return (data[property] || [])[index] || {} }
function generic(data) {
  const issue = data.currentIssue
  return Boolean(issue && GENERIC.has(issue.issueType) && !issue.evidenceReviewOnly && !issue.paymentNeedsReview)
}
function validateDraft(data) {
  const base = model.buildIssueFieldsDraft(data)
  if (!base.valid || !generic(data)) return base
  const issue = data.currentIssue, row = subject(data), fields = { ...base.fields }
  const nature = fields.economicNature
  if (nature === 'balance_adjustment') return { valid: false, fields: {}, reason: '余额调整请从账户维护入口处理，不能当作普通导入交易' }
  if (transfer(nature) && !issue.installmentPrincipal) {
    const target = selected(data, 'counterpartyAccountChoices', data.issueDraft.counterpartyAccountIndex)
    if (!available(target) || target.accountId === fields.ledgerAccountId) {
      return { valid: false, fields: {}, reason: '请选择两个不同且可用的资金账户' }
    }
    fields.counterpartyLedgerAccountId = target.accountId
  } else if (!issue.installmentPrincipal && row.counterpartyLedgerAccountId) fields.counterpartyLedgerAccountId = null
  if (CATEGORY.has(nature)) {
    const category = selected(data, 'issueCategories', data.issueDraft.categoryIndex)
    if (category.categoryId && (category.isPlaceholder || category.unavailable || category.archivedAt ||
      category.kind && category.kind !== (nature === 'income' ? 'income' : 'expense'))) {
      return { valid: false, fields: {}, reason: '分类已不可用或与交易性质不符，请重新选择' }
    }
    const priorKind = row.economicNature === 'income' ? 'income' : ['expense', 'fee'].includes(row.economicNature) ? 'expense' : ''
    const nextKind = nature === 'income' ? 'income' : 'expense'
    if (data.issueDraft.categoryChanged) fields.categoryId = category.categoryId || null
    else if (priorKind !== nextKind && row.categoryId) fields.categoryId = null
  } else if (row.categoryId) fields.categoryId = null
  return { ...base, fields }
}
function projected(data) {
  const original = subject(data), row = { ...original }
  if (data.currentIssue && data.currentIssue.paymentNeedsReview && !data.currentIssue.paymentAccountsOnly) {
    row.economicNature = ['unknown', 'expense', 'repayment'][data.paymentNatureIndex] || 'unknown'
    return row
  }
  if (!generic(data)) return row
  const draft = data.issueDraft || {}, option = selected(data, 'natureOptions', draft.natureIndex)
  row.economicNature = option.value || 'unknown'
  row.ledgerAccountId = selected(data, 'accountChoices', draft.accountIndex).accountId || null
  row.counterpartyLedgerAccountId = selected(data, 'counterpartyAccountChoices', draft.counterpartyAccountIndex).accountId || null
  row.categoryId = selected(data, 'issueCategories', draft.categoryIndex).categoryId || null
  // 已有分类名称不能遮住本次草稿选择或性质切换。
  delete row.categoryName
  return row
}
function refreshIssueFieldsDraft() {
  const data = this.data, issue = data.currentIssue
  const state = validateDraft(data)
  if (!issue) {
    setChangedData(this, { issueFieldsCanSave: false, issueFieldsReason: state.reason || '', issueDetail: null })
    return state
  }
  const row = projected(data), labels = detail.accountLabels(row), fundsLabels = detail.fundsAccountLabels(row.economicNature), omit = ['nature']
  if (generic(data)) {
    omit.push('account', 'counterparty')
    if (CATEGORY.has(row.economicNature)) omit.push('category')
  }
  else if (!issue.evidenceReviewOnly) {
    if (issue.issueType === 'account_mapping') omit.push('account')
    if (issue.issueType === 'category_assignment') omit.push('category')
    if (issue.issueType === 'transfer_accounts') omit.push('account', 'counterparty', 'ownership')
    if (issue.paymentNeedsReview) omit.push('account', 'counterparty')
  }
  const all = detail.fieldsFor(row, { accounts: (data.accounts || []).concat(data.accountDrafts || []), categories: data.categories || [] }, { omit })
  const fields = all.filter(field => !(issue.aggregateRepayment && field.key.startsWith('repayment-')) &&
    !(issue.paymentNeedsReview && field.key.startsWith('payment-')))
  const basic = Object.fromEntries(fields.filter(field => ['amount', 'time', 'party'].includes(field.key)).map(field => [field.key, field]))
  const account = selected(data, 'accountChoices', (data.issueDraft || {}).accountIndex)
  setChangedData(this, { issueFieldsCanSave: state.valid, issueFieldsReason: state.valid ? '' : state.reason,
    issueDetail: { issueId: issue.issueId, natureLabel: detail.natureLabel(row),
      summary: { amount: basic.amount && !basic.amount.missing ? basic.amount.value : '金额待补充',
        amountLabel: basic.amount && basic.amount.label || '交易金额',
        time: basic.time && !basic.time.missing ? basic.time.value : '时间待补充',
        party: basic.party && !basic.party.missing ? basic.party.value : '' },
      fields: fields.filter(field => !['amount', 'time', 'party', 'status'].includes(field.key) &&
        !(field.missing && field.key === 'note')),
      hideValidationHint: !state.valid && (state.reason === '请选择交易类型' && generic(data) && row.economicNature === 'unknown' ||
        state.reason === '请选择需要确认的账户' && Boolean(account.isPlaceholder) ||
        issue.repaymentOwnershipRequired && ['请先确认是自己的账户还是替他人还款', '请选择这笔代还款如何处理'].includes(state.reason)),
      generic: generic(data), hasDestination: generic(data) && labels.hasDestination,
      categoryEditable: generic(data) && CATEGORY.has(row.economicNature),
      accountLabel: labels.from, destinationLabel: labels.to,
      destinationFirst: Boolean(labels.reverse && !issue.fundsRoute && (generic(data) || issue.issueType === 'transfer_accounts')),
      fundsFromLabel: fundsLabels.from, fundsToLabel: fundsLabels.to,
      selectorLabel: issue.issueType === 'transfer_accounts' && issue.fundsRoute
        ? issue.missingFundsSide === 'to' ? fundsLabels.to : fundsLabels.from : labels.from } })
  return state
}
function changeIssueNature(event) {
  if (this.data.busy || this.data.issueStale || !this.data.issueDetailsReady || !generic(this.data)) return
  const data = this.data, index = Number(event.detail.value), next = (data.natureOptions || [])[index]
  if (!Number.isInteger(index) || !next || data.currentIssue.installmentPrincipal && next.value !== 'repayment') return
  const draft = data.issueDraft, before = selected(data, 'natureOptions', draft.natureIndex).value
  if (before === next.value) return
  const patch = { 'issueDraft.natureIndex': index }
  const previousCategory = selected(data, 'issueCategories', draft.categoryIndex)
  const categories = [{ categoryId: '', name: '待分类（可稍后补）', isPlaceholder: true }]
    .concat(model.categoriesForNature(data.categories || [], next.value))
  const categoryIndex = Math.max(0, categories.findIndex(item => item.categoryId && item.categoryId === previousCategory.categoryId))
  patch.issueCategories = categories
  patch['issueDraft.categoryIndex'] = categoryIndex
  patch.issueCategoryCanSave = Boolean(categories[categoryIndex].categoryId)
  // ledgerAccountId 始终沿用原账单账户。单端流入切为还款时，
  // 服务端按 sourceDirection 将该账户作为还入端；不要再次交换端点。
  if (transfer(before) && !transfer(next.value)) patch['issueDraft.counterpartyAccountIndex'] = 0
  this.setData(patch)
  return this.refreshIssueFieldsDraft()
}
module.exports = { refreshIssueFieldsDraft, changeIssueNature, validateDraft, projected }
