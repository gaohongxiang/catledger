const model = require('./model')
const PAGE_SIZE = 40

function emptyLists() {
  return { accountMappings: [], reviewGroups: [], reviewedEvents: [], categoryCards: [],
    categoryWaitingEvents: [], categorizedEvents: [], noCategoryEvents: [], excludedReviewGroups: [],
    duplicateReviewEvents: [], fundsFlowGroups: [], finalSummary: {}, reviewPage: { index: 0, pages: 1, count: 0 } }
}

// 展示层只传模板使用的字段；证据、成员全集与操作版本保留在业务视图。
function record(event) {
  const view = model.eventView(event), result = {}
  ;['eventId', 'displayTitle', 'displayMeta', 'displayDay', 'displayMonth', 'displayDetailMeta',
    'amountText', 'directionClass', 'needsCategory', 'reviewIssueId', 'categoryName', 'natureLabel',
    'accountText', 'duplicateCount', 'auditNote'].forEach(key => { if (view[key] !== undefined) result[key] = view[key] })
  return result
}

function card(issue) {
  return { issueId: issue.issueId, label: issue.label, decisionText: issue.decisionText || '',
    batchDecision: issue.batchDecision, subjectCount: issue.subjectCount, natureLabel: issue.natureLabel || '',
    hiddenSubjectCount: issue.hiddenSubjectCount, subjects: (issue.subjects || []).map(record) }
}

function windowRows(rows, index) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  index = Math.max(0, Math.min(index, pages - 1))
  return { rows: rows.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), page: { index, pages, count: rows.length } }
}

function reviewLists(state, business, data, index) {
  const patch = emptyLists()
  let rows = [], kind = ''
  if (data.activeReviewTab === 'category') {
    if (data.activeCategoryStatus === 'completed') { kind = 'categorizedEvents'; rows = state.categorizedEvents }
    else if (data.activeCategoryStatus === 'none') { kind = 'noCategoryEvents'; rows = state.noCategoryEvents }
    else {
      kind = 'category'
      rows = model.categoryIssueCards(state.categoryDecisionIssues, data.categoryQuery).map(issue => ({ issue }))
        .concat(state.categoryWaitingEvents.map(event => ({ event })))
    }
  } else if (data.activeReviewStatus === 'completed') { kind = 'reviewedEvents'; rows = state.reviewedEvents }
  else if (data.activeReviewStatus === 'duplicate') {
    kind = 'duplicateReviewEvents'
    rows = state.duplicateCandidates.map(event => Object.assign({}, event, {
      duplicateCount: Number(event.duplicateEvidenceCount), auditNote: '已保留一笔，点开对照主记录与重复来源。' }))
    patch.duplicateReviewLoaded = true
  } else if (data.activeReviewStatus === 'excluded') {
    kind = 'excluded'
    rows = (business.events || []).filter(event => event.status === 'excluded')
  } else {
    kind = 'review'
    rows = model.reviewIssueRows(state.hydratedIssues.filter(issue => issue.issueType !== 'category_assignment' && issue.subjectCount > 0))
  }
  const window = windowRows(rows, index)
  patch.reviewPage = window.page
  if (kind === 'review') patch.reviewGroups = model.reviewIssueGroups(window.rows).map(group => ({
    issueType: group.issueType, issues: group.issues.map(card) }))
  else if (kind === 'category') {
    patch.categoryCards = window.rows.filter(row => row.issue).map(row => card(row.issue))
    patch.categoryWaitingEvents = window.rows.filter(row => row.event).map(row => record(row.event))
  } else if (kind === 'excluded') {
    const expanded = (data.excludedReviewGroups || []).filter(group => group.expanded).map(group => group.key)
    patch.excludedReviewGroups = model.excludedEventGroups(window.rows, expanded).map(group => Object.assign({}, group, {
      events: group.expanded ? group.events.map(record) : [] }))
  } else patch[kind] = window.rows.map(record)
  return patch
}

function detailWindow(sheet, index) {
  if (!sheet) return null
  const window = windowRows(sheet.mode === 'accounts' ? sheet.accounts : sheet.records, index || 0)
  return Object.assign({}, sheet, { accounts: sheet.mode === 'accounts' ? window.rows : [],
    records: sheet.mode === 'accounts' ? [] : window.rows.map(record), page: window.page })
}

function accountMapping(mapping) {
  const { subjectEventIds, candidateEventIds, subjects, subject, ...visible } = mapping
  return visible
}

module.exports = { accountMapping, emptyLists, reviewLists, detailWindow, PAGE_SIZE }
