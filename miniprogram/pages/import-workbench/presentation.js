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
    'accountText', 'duplicateCount', 'auditNote', 'detailRequired'].forEach(key => { if (view[key] !== undefined) result[key] = view[key] })
  for (const key of ['displayTitle', 'displayMeta', 'displayDetailMeta', 'accountText']) if (typeof result[key] === 'string' && result[key].length > 160) {
    result[key] = result[key].slice(0, 160) + '…'; result.detailRequired = true
  }
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
      duplicateCount: Number(event.duplicateEvidenceCount || 0) + (model.isHistoricalDuplicate(event) ? 1 : 0),
      auditNote: model.isHistoricalDuplicate(event) ? '已与历史账目对应，本次不重复入账。' : '已保留一笔，点开对照主记录与重复来源。' }))
    patch.duplicateReviewLoaded = true
  } else if (data.activeReviewStatus === 'excluded') {
    kind = 'excluded'
    rows = (business.events || []).filter(event => event.status === 'excluded' && !model.isHistoricalDuplicate(event))
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

function evidencePartFields(part, page) {
  if (!page || page.index !== 0 || page.hasNext) return []
  try {
    const fields = JSON.parse(part)
    if (!Array.isArray(fields) || !fields.every(field => field && typeof field.name === 'string' && Object.prototype.hasOwnProperty.call(field, 'value'))) return []
    return fields.map((field, index) => ({ key: index, name: field.name, value: String(field.value == null ? '' : field.value) }))
  } catch (_) { return [] }
}

const ERROR_MESSAGES = Object.freeze({
  CONFLICT: '整理状态已经变化，请刷新后重试',
  CSV_COLUMN_LIMIT_EXCEEDED: '账单列结构异常，请重新从支付平台导出',
  CSV_RECORD_LIMIT_EXCEEDED: '单个账单超过 5000 条，请缩短导出时间范围',
  FILE_ENCODING_INVALID: '文件编码无法识别，请重新导出',
  FILE_FORMAT_UNSUPPORTED: '尚未识别这份表格的账单结构，文件没有入账',
  BANK_MAPPING_REQUIRED: '请确认银行账单的列和收支方向',
  BANK_ROWS_INVALID: '部分行无法识别，请检查日期、金额、收支和币种列；仅支持人民币，公式需先转为数值',
  FILE_SIZE_INVALID: '每个文件需大于 0 且不超过 5 MB',
  IDENTITY_CONFLICT: '来源记录身份冲突，需要在问题卡片中确认',
  INITIALIZATION_REQUIRED: '账本还没有初始化，请重新登录后再试',
  UNRESOLVED_IMPORT: '仍有阻塞问题，暂时不能整批入账',
  UNSUPPORTED_ACTION: '导入服务版本过旧，请更新云函数后重试'
})

function publicError(error, fallback) {
  return ERROR_MESSAGES[error && error.code] || error && error.message || fallback
}

const errorText = error => error.code === 'UNSUPPORTED_ACTION' ? '导入服务版本过旧，请更新云函数后重试'
  : error.code === 'STALE_VIEW' ? '整理结果已变化，请刷新本页' : error.message || '读取未完成，请重试'
function direction(event) { const value = event && event.currentTarget.dataset.direction; return value === 'first' ? value : Number(value || 0) }

module.exports = { errorText, direction, ERROR_MESSAGES, publicError, accountMapping, emptyLists, reviewLists, detailWindow, record, card, evidencePartFields, PAGE_SIZE }
