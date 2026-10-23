const model = require('./model')
const PAGE_SIZE = 50

function emptyLists() {
  return { accountMappings: [], reviewGroups: [], reviewedEvents: [], categoryCards: [],
    categoryWaitingEvents: [], categorizedEvents: [], noCategoryEvents: [], excludedReviewGroups: [],
    duplicateReviewEvents: [], fundsFlowGroups: [], finalSummary: {}, reviewPage: { index: 0, pages: 1, count: 0 } }
}

// 展示层只传模板使用的字段；证据、成员全集与操作版本保留在业务视图。
function record(event) {
  const view = model.eventView(event), result = {}
  ;['eventId', 'displayTitle', 'displayMeta', 'displayDate', 'displayDetailMeta',
    'amountText', 'directionClass', 'needsCategory', 'reviewIssueId', 'categoryName', 'natureLabel',
    'accountText', 'duplicateCount', 'auditNote', 'detailRequired', 'pairingDecision',
    'amountMinor', 'rowTitle', 'rowMeta', 'rowSource', 'rowRole', 'rowRoleKey', 'installmentRole',
    'installmentPeriod', 'installmentPlan', 'installmentKey', 'installmentNote', 'installmentPlanLabel',
    'installmentAttribution'].forEach(key => { if (view[key] !== undefined) result[key] = view[key] })
  if (event.status === 'excluded') {
    result.exclusionReasonText = model.exclusionReasonText(event)
    result.sourceStatus = String(event.primaryEvidence && event.primaryEvidence.status || '').trim()
  }
  for (const key of ['displayTitle', 'displayMeta', 'displayDetailMeta', 'accountText']) if (typeof result[key] === 'string' && result[key].length > 160) {
    result[key] = result[key].slice(0, 160) + '…'; result.detailRequired = true
  }
  return result
}

function listRecord(event) {
  const result = record(event)
  delete result.accountText
  // 列表只传单行摘要，五十项同时展示也不突破原生单次更新预算；完整字段留在详情。
  for (const key of ['displayTitle', 'displayMeta', 'displayDetailMeta', 'categoryName', 'sourceStatus']) {
    if (typeof result[key] === 'string' && result[key].length > 80) {
      result[key] = result[key].slice(0, 80) + '…'; result.detailRequired = true
    }
  }
  return result
}

function card(issue) {
  return { issueId: issue.issueId, label: issue.label, decisionText: issue.decisionText || '',
    batchDecision: issue.batchDecision, subjectCount: issue.subjectCount, natureLabel: issue.natureLabel || '',
    hiddenSubjectCount: issue.hiddenSubjectCount, subjects: (issue.subjects || []).map(listRecord) }
}

// 卡片只传实际渲染的摘要，避免增加多项提示后五十笔超过原生更新预算。
function pendingPreview(row) {
  const result = {}
  for (const key of ['eventId', 'displayDate', 'amountText', 'directionClass', 'pairingDecision', 'natureLabel', 'detailRequired',
    'rowRole', 'rowRoleKey', 'installmentRole', 'installmentPeriod', 'installmentPlan', 'installmentKey',
    'installmentPlanLabel', 'installmentAttribution']) {
    if (row[key] !== undefined) result[key] = row[key]
  }
  for (const [key, value] of [['displayTitle', row.displayTitle], ['displayDetailMeta', row.displayDetailMeta || row.displayMeta],
    ['rowTitle', row.rowTitle], ['rowMeta', row.rowMeta]]) {
    if (typeof value !== 'string') continue
    result[key] = value.length > 40 ? value.slice(0, 40) + '…' : value
    if (value.length > 40) result.detailRequired = true
  }
  // 判不出归属的费用行在列表上就要看出“还没指定”，否则用户不知道该点哪一行。
  result.installmentPending = Boolean(result.rowRoleKey) && result.rowRoleKey !== 'principal' && !String(result.installmentPlanLabel || '').trim()
  return result
}

const BEFORE_NATURE_STEPS = new Set(['source_conflict', 'status', 'source', 'amount', 'identity',
  'account_conflict', 'fields', 'basic', 'same_event'])
const BEFORE_NATURE_ISSUES = new Set(['same_event', 'identity_conflict', 'field_conflict'])
const BEFORE_NATURE_REASONS = new Set(['refund_source_conflict', 'row_status_unknown', 'transaction_status_unknown',
  'source_profile_unknown', 'row_amount_invalid', 'identity_conflict', 'identity_review_required', 'account_mapping_conflict',
  'core_fields_conflict', 'row_semantic_conflict', 'postability_direction_conflict', 'source_group_conflict', 'core_fields_missing',
  'same_event_candidate', 'bank_channel_same_event_candidate', 'historical_duplicate_candidate'])

function cardNatureLabel(rows) {
  // 同一分期计划的本息卡由本金代表性质；仅费用或混合交易则保留实际成员的性质。
  const principal = rows.length && rows.every(row => row.rowRoleKey) && rows.find(row => row.rowRoleKey === 'principal')
  if (principal) return principal.natureLabel
  const labels = [...new Set(rows.map(row => row.natureLabel || '性质待确认'))]
  return labels.length === 1 ? labels[0] : labels.length ? '多种性质' : '性质待确认'
}

// 基础核验和同笔判断在前，性质居中，具体字段在后；只插入性质，不重排服务端待办。
// 顺序由服务端当前视图给出。旧服务端只展示真实的当前问题，不预测后续步骤。
function pendingReviewCard(view, attention, issue) {
  const natureLabel = cardNatureLabel(view.subjects || [])
  const unknown = ['性质待确认', '待确认', '暂不确定'].includes(natureLabel)
  const valid = attention && attention.version === 'review-attention-v1' &&
    (attention.issueId || '') === (view.issueId || '') && Array.isArray(attention.steps) && attention.steps.length > 0 &&
    attention.steps.length <= 20 && attention.steps.every(item => item && typeof item.key === 'string' &&
      typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 48)
  const fallback = unknown && ['确认交易类型', '待核对交易'].includes(view.label) ? '性质待确认' : view.label || '交易信息待核对'
  const seen = new Set()
  const steps = (valid ? attention.steps : [{ key: 'review', label: fallback }])
    .filter(item => !seen.has(item.label) && seen.add(item.label))
  if (unknown && !seen.has('性质待确认')) steps.push({ key: 'nature', label: '性质待确认' })
  const joinSteps = items => items.map(item => item.label).join(' · ')
  // 判重前的必要账户若在同笔事项前，仍随它留在性质前；普通账户字段放在性质后。
  const natureIndex = valid ? steps.reduce((index, item, position) => BEFORE_NATURE_STEPS.has(item.key) ? position + 1 : index, 0)
    : issue && (BEFORE_NATURE_ISSUES.has(issue.issueType) || BEFORE_NATURE_REASONS.has(issue.primaryReasonCode)) ? steps.length : 0
  const label = unknown ? joinSteps(steps)
    : [joinSteps(steps.slice(0, natureIndex)), natureLabel, joinSteps(steps.slice(natureIndex))].filter(Boolean).join('｜')
  const { groupCount, ...rest } = view
  const scopeCount = groupCount || view.subjectCount || 1
  const subjects = (view.subjects || []).map(pendingPreview)
  return Object.assign({}, rest, {
    natureLabel, scopeCount,
    // 卡片不再渲染补充说明；完整原文和问题说明仍留在业务详情。
    decisionText: '', subjects: subjects,
    // 组数标记只给真正连成一张卡的行（同笔候选）；独立卡片各自是一笔交易，标“同组”反而误读。
    label: label + (scopeCount > 1 && view.groupKey ? '（同组 ' + scopeCount + ' 笔）' : ''),
    batchDecision: view.issueId ? '处理' : '查看详情'
  })
}

function pendingCard(event, category) {
  const issue = event.pendingIssue
  const view = issue ? model.issueView(Object.assign({}, issue, { subject: event })) : {}
  const count = issue ? Math.max(1, Number(issue.memberCount || 1) - Number(issue.candidateCount || 0)) : 1
  const subject = listRecord(event)
  const result = {
    eventId: event.eventId, issueId: issue && issue.issueId || '',
    label: view.label || (category ? '待分类 · 先核对交易' : '待核对交易'),
    decisionText: view.decisionText || '',
    batchDecision: issue ? (category ? '分类' : '处理') : category ? '去核对' : '查看详情',
    // 只有“同笔候选”这类事项的成员才是一组待判断的记录，才该连成一张卡；分类页签同理。
    // 账户确认等事项的成员是几十笔各自独立的交易，拿事项 id 当分组键会把它们粘成一片，
    // 每笔的边界就看不出来了——它们是同一个问题，不是同一笔钱。
    groupKey: issue && (issue.issueType === 'same_event' || issue.issueType === 'category_assignment') ? issue.issueId : '',
    groupCount: count,
    groupPos: '',
    subjectCount: 1, hiddenSubjectCount: 0,
    natureLabel: subject.natureLabel, subjects: [subject]
  }
  return category ? result : pendingReviewCard(result, event.reviewAttention, issue)
}

// 同组问题的事件行在列表中相邻时连成一张卡：首行带组数标记，其余行只留动作。
function linkGroupRows(cards) {
  ;(cards || []).forEach(function (card, index) {
    const samePrev = Boolean(card.groupKey) && index > 0 && cards[index - 1].groupKey === card.groupKey
    const sameNext = Boolean(card.groupKey) && index < cards.length - 1 && cards[index + 1].groupKey === card.groupKey
    card.groupPos = samePrev && sameNext ? 'middle' : samePrev ? 'last' : sameNext ? 'first' : ''
    // 核对组数也放在左侧，只有当前可见连续组的首行展示；分类卡片保持原样。
    if (samePrev && card.scopeCount > 1) card.label = card.label.replace(/（同组 \d+ 笔）$/, '')
  })
  return cards
}

// 待核对里的分期组：一个本金计划一张卡（与已核对的一计划一卡同一口径），本金行是卡片的入口。
// 归属没定的利息不属于任何计划，因此不单独占一张卡，而是作为“本期次待指定”的行挂在每张计划卡里：
// 用户看到的是“这张卡是哪个计划、本期次还有哪几笔利息要挑给它”，点一下就带着这张卡的计划打开那一笔。
// 全部指定完，整组一起离开待核对，在已核对里按计划合并回一计划一卡。
// 拆分范围限定在同一个待核对事项内：事项决定这组行要一起被处理，卡片只是它的呈现。
function splitInstallmentCards(cards) {
  const groups = new Map()
  ;(cards || []).forEach(function (card, index) {
    // 按期次分组，不限定在同一事项内：老批次里本金和利息各是一条单笔事项，
    // 按事项分组会让同一计划的本息永远合不到一张卡——用户看到的就是“本金一张、利息一张”。
    const key = (card.subjects[0] || {}).installmentKey
    if (!key) return
    const groupKey = key
    if (!groups.has(groupKey)) groups.set(groupKey, { index: index, cards: [], rows: [] })
    const group = groups.get(groupKey)
    group.cards.push(card)
    group.rows.push(card.subjects[0])
  })
  const split = new Map()
  const dropped = new Set()
  groups.forEach(function (group) {
    if (!group.rows.some(row => row.rowRoleKey)) return
    // 计划名：本金行取自己的计划，费用行取已确认的归属。归属未定的费用没有计划，只能当候选。
    const planOf = row => String(row.rowRoleKey === 'principal' ? row.installmentPlan || '' : row.installmentPlanLabel || '').trim()
    const buckets = new Map()
    const pending = []
    group.rows.forEach(function (row) {
      const plan = planOf(row)
      if (row.rowRoleKey && !plan) return pending.push(row)
      if (!plan) return
      if (!buckets.has(plan)) buckets.set(plan, [])
      buckets.get(plan).push(row)
    })
    // 一个计划也要并成一张卡：本金是入口，本期次的费用挂在同一张卡里，一个计划的本息一眼看完。
    // 只有连计划行都没有时才保持原状（费用行自己找不到可挂的本金卡）。
    if (!buckets.size) return
    const plans = []
    buckets.forEach(function (rows, plan) { plans.push({ plan: plan, rows: rows }) })
    plans.sort(function (left, right) {
      return Number(!left.rows.some(row => row.rowRoleKey === 'principal')) - Number(!right.rows.some(row => row.rowRoleKey === 'principal')) ||
        left.plan.localeCompare(right.plan)
    })
    plans.forEach(function (item) {
      const rows = item.rows.slice().sort(function (left, right) {
        return Number(right.rowRoleKey === 'principal') - Number(left.rowRoleKey === 'principal') ||
          String(left.displayDate || '').localeCompare(String(right.displayDate || '')) ||
          String(left.eventId).localeCompare(String(right.eventId))
      })
      // 卡的基底取本金所在的那张：卡头点击打开的是本金的待办；没有本金行时才落到首张。
      // 卡头沿用性质与当前待办；计划名已在本金标题中展示，不能覆盖性质。
      const base = group.cards[Math.max(0, group.rows.indexOf(rows[0]))]
      const card = Object.assign({}, base, {
        eventId: rows[0].eventId,
        installmentKey: rows[0].installmentKey,
        installmentPlan: item.plan,
        subjects: rows,
        scopeCount: rows.length,
        groupCount: rows.length,
        ...(pending.length ? { installmentPendingRows: pending.map(row => ({
          eventId: row.eventId, plan: item.plan, title: row.rowTitle || row.displayTitle || '分期费用',
          amountText: row.amountText, displayDate: row.displayDate || '' })) } : {})
      })
      const list = split.get(group.index) || []
      list.push(card)
      split.set(group.index, list)
    })
    // 原始卡片不再单独出现：本金与已归利息已经进了各自的计划卡，归属未定的费用挂在卡内。
    group.cards.forEach(function (card) { dropped.add(card) })
  })
  if (!split.size) return cards
  const result = []
  ;(cards || []).forEach(function (card, index) {
    const splitCards = split.get(index)
    if (splitCards) result.push.apply(result, splitCards)
    else if (!dropped.has(card)) result.push(card)
  })
  return result
}

function excludedGroups(events, expanded) {
  return model.excludedEventGroups(events, expanded).map(group => Object.assign({}, group, {
    events: group.expanded ? group.events.map(listRecord) : [] }))
}

// 把渲染用金额（¥x.xx）还原成最小货币单位字符串；记录本身带 amountMinor 时优先用原值，避免四舍五入。
function minorOf(record) {
  if (/^\d+$/.test(String(record.amountMinor == null ? '' : record.amountMinor))) return String(record.amountMinor)
  const cleaned = String(record.amountText || '').replace(/[^\d.]/g, '')
  if (!cleaned) return '0'
  const parts = cleaned.split('.')
  return (parts[0].replace(/^0+(?=\d)/u, '') + (parts[1] || '').padEnd(2, '0')).replace(/^0+(?=\d)/u, '')
}

// 分期卡片：一个分期计划的一期一张卡，卡内是本期的本金／利息／手续费。
function installmentCard(id, plan, rows, options) {
  options = options || {}
  let totalMinor = '0'
  rows.forEach(function (row) { totalMinor = model.addMinor(totalMinor, minorOf(row)) })
  const complete = options.complete !== false
  return {
    eventId: (rows.find(row => row.rowRoleKey === 'principal') || rows[0]).eventId,
    cardId: 'installment:' + id,
    isInstallmentCard: true,
    installmentKey: id,
    installmentPlan: plan,
    installmentPeriod: rows[0].installmentPeriod || '',
    natureLabel: cardNatureLabel(rows),
    directionClass: rows[0].directionClass || '',
    needsCategory: rows.some(function (row) { return row.needsCategory }),
    periodComplete: complete,
    // 归属未定的卡片不给合计：数字加总只会误导，等用户确认计划后再显示。
    amountText: complete && !options.noTotal ? model.amountText(totalMinor) : '',
    planNote: options.note || (complete && !options.noTotal && !rows.some(row => row.rowRoleKey === 'principal') ? '所属计划：' + plan : ''),
    rows: rows.map(function (row) { return Object.assign({}, row, { isInstallmentRow: true }) })
  }
}

// 把一个期次组拆成「一计划一卡」。计划名只能从本金摘要取：账单原文的利息行只有期次，
// 不带计划名，所以利息归属按「人工确认 → 摘要包含计划名 → 本期次唯一本金」的顺序判定，
// 判不出来就单独成卡说明原因，不按金额或顺序猜。
function installmentCards(group, whole) {
  const first = group.rows[0]
  const firstPlan = first.installmentPlan || first.rowTitle || first.displayTitle
  if (!whole) return [installmentCard(group.key, firstPlan, group.rows, { complete: false })]
  const plans = []
  group.rows.forEach(function (row) {
    if (row.rowRoleKey !== 'principal') return
    const plan = row.installmentPlan || row.rowTitle || row.displayTitle
    if (plan && !plans.includes(plan)) plans.push(plan)
  })
  const buckets = new Map()
  const assign = function (plan, row) {
    if (!buckets.has(plan)) buckets.set(plan, [])
    buckets.get(plan).push(row)
  }
  const ambiguous = []
  const orphan = []
  group.rows.forEach(function (row) {
    const title = row.rowTitle || row.displayTitle
    if (row.rowRoleKey === 'principal') return assign(row.installmentPlan || title, row)
    const confirmed = String(row.installmentPlanLabel || '').trim()
    if (confirmed) return assign(confirmed, row)
    const named = model.planFromTitle(title, plans)
    if (named) return assign(named, row)
    if (plans.length === 1) return assign(plans[0], row)
    if (plans.length > 1) return ambiguous.push(row)
    orphan.push(row)
  })
  const cards = []
  buckets.forEach(function (rows, plan) { cards.push(installmentCard(group.key + '|' + plan, plan, rows, {})) })
  if (ambiguous.length) {
    cards.push(installmentCard(group.key + '|?', '利息待归属', ambiguous,
      { noTotal: true, note: '本期次有 ' + plans.length + ' 个分期计划，账单未标明这笔费用属于哪一个。' }))
  }
  if (orphan.length) {
    cards.push(installmentCard(group.key + '|!', '利息待归属', orphan,
      { noTotal: true, note: '本期次没有识别到分期本金行，无法判断这笔费用的归属。' }))
  }
  return cards
}

// 已核对列表：同一账户、同一期次、同一分期计划的行合成一张卡，卡内分行并给出本期合计。
// 跨页不完整（本页未含该期全部行，或贴着还有上一／下一页的边界）时保持整组一张卡并明确提示，
// 不按不完整的本金数推断归属，也不给合计。
function buildReviewedCards(events, options) {
  options = options || {}
  const fullEvents = options.fullEvents && options.fullEvents.length ? options.fullEvents : events
  const pageEdges = options.pageEdges || null
  const records = events.map(listRecord)
  const groups = new Map()
  records.forEach(function (record, index) {
    const key = record.installmentKey
    if (!key) return
    if (!groups.has(key)) groups.set(key, { key: key, rows: [], minIndex: index, maxIndex: index })
    const group = groups.get(key)
    group.rows.push(record)
    group.minIndex = Math.min(group.minIndex, index)
    group.maxIndex = Math.max(group.maxIndex, index)
  })
  if (!groups.size) return records
  const fullCounts = new Map()
  fullEvents.map(listRecord).forEach(function (record) {
    if (record.installmentKey) fullCounts.set(record.installmentKey, (fullCounts.get(record.installmentKey) || 0) + 1)
  })
  const isWhole = function (group) {
    if (group.rows.length !== (fullCounts.get(group.key) || group.rows.length)) return false
    if (!pageEdges) return true
    const atStart = group.minIndex === 0 && pageEdges.hasPrevious
    const atEnd = group.maxIndex === records.length - 1 && pageEdges.hasNext
    return !(atStart || atEnd)
  }
  const cards = []
  const emitted = new Set()
  records.forEach(function (record) {
    if (!record.installmentKey) { cards.push(record); return }
    const group = groups.get(record.installmentKey)
    if (emitted.has(group.key)) return
    emitted.add(group.key)
    cards.push.apply(cards, installmentCards(group, isWhole(group)))
  })
  return cards
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
    rows = (business.events || []).filter(event => event.status === 'excluded' && !model.isHistoricalDuplicate(event)).sort(model.compareEvents)
  } else {
    kind = 'review'
    rows = model.reviewIssueRows(state.hydratedIssues.filter(issue => issue.issueType !== 'category_assignment' && issue.subjectCount > 0))
  }
  const window = windowRows(rows, index)
  patch.reviewPage = window.page
  if (kind === 'review') patch.reviewGroups = model.reviewIssueGroups(window.rows).map(group => ({
    key: group.key, issueType: group.issueType, issues: group.issues.map(issue => pendingReviewCard(card(issue), null, issue)) }))
  else if (kind === 'category') {
    patch.categoryCards = window.rows.filter(row => row.issue).map(row => card(row.issue))
    patch.categoryWaitingEvents = window.rows.filter(row => row.event).map(row => listRecord(row.event))
  } else if (kind === 'excluded') {
    const expanded = (data.excludedReviewGroups || []).filter(group => group.expanded).map(group => group.key)
    patch.excludedReviewGroups = excludedGroups(window.rows, expanded)
  } else if (kind === 'reviewedEvents') patch.reviewedEvents = buildReviewedCards(window.rows, { fullEvents: rows })
  else patch[kind] = window.rows.map(listRecord)
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
    const displayFields = model.evidenceFields(fields)
    return fields.map((field, index) => ({ key: index, name: field.name, value: displayFields[index].value }))
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

// 原文标题只留一行：账单名太长时省略中间，扩展名和末尾片段必须留住，
// 否则“微信支付8月账单…xlsx”和“微信支付9月账单…xlsx”在界面上分不出来。
function textWidth(text) { let width = 0; for (const char of text) width += /[\u0000-\u00ff]/.test(char) ? 1 : 2; return width }
function clipText(text, limit) {
  const chars = [...text]
  let width = 0, cut = 0
  while (cut < chars.length && width + textWidth(chars[cut]) <= limit) { width += textWidth(chars[cut]); cut++ }
  return cut < chars.length ? chars.slice(0, cut).join('').trimEnd() : text
}
function shortFileName(name, limit = 30) {
  const text = String(name || '').trim()
  if (!text || textWidth(text) <= limit) return text
  const match = text.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/)
  const base = match ? match[1] : text, extension = match ? match[2] : ''
  // 扩展名占掉预算时仍要显示，否则看不出是哪种账单文件。
  const room = Math.max(limit - textWidth(extension) - 1, 6)
  const head = clipText(base, Math.ceil(room * 0.6))
  const tail = clipText([...base].reverse().join(''), Math.floor(room * 0.4)).split('').reverse().join('')
  return head + '…' + tail + extension
}
// 来源卡片标题：编号、账单文件、行号合成一行；文件名只在过长时缩短。
function sourceCaption(label, fileName, rowNumber, limit) {
  const row = rowNumber == null || rowNumber === '' ? '' : ' · 第 ' + rowNumber + ' 行'
  return [label, shortFileName(fileName, limit) + row].filter(Boolean).join(' · ')
}

// 同笔合并把多条来源并进一个事件后只留一条 primary；“证据数>1”不足以判断
// 是否由多笔合成，pairCount 记录合成前的来源数，必须一起算。
function mergedSourceCount(row) {
  return Math.max(Number(row && row.pairCount) || 0, Number(row && row.evidenceCount) || 0,
    Number(row && row.duplicateEvidenceCount) || 0)
}
// 能否修改同笔判断：重复页签的记录、已判为不同的、或由多来源合成的都可以。
function canChangeJudgment(row, duplicate) {
  return Boolean(duplicate || row && (row.pairingDecision || mergedSourceCount(row) > 1))
}

function moneyText(minor) {
  if (minor == null || !/^\d+$/u.test(String(minor))) return ''
  const text = String(minor).padStart(3, '0')
  return '¥' + text.slice(0, -2) + '.' + text.slice(-2)
}
function dayText(localAt) { return String(localAt || '').slice(0, 16) }
// 候选备注里常混着原文串（列名、单号、JSON 片段），卡片只取人读得懂的商户和商品，
// 其余内容仍可在原文里查看。
function merchantOf(note) {
  const text = String(note || '').trim()
  if (!text) return ''
  const embedded = text.match(/[[{].*[\]}]\s*$/u)
  // 只有整段都是 JSON 时才按 JSON 取字段；前缀是正文的原文串保留正文。
  if (!embedded || embedded.index !== 0) return text.replace(/\s*[[{][\s\S]*[\]}]\s*$/u, '').trim() || text
  const json = embedded[0]
  const pieces = [...json.matchAll(/"(item|item_raw|counterparty|counterparty_raw|note|商品|交易对方|备注)"\s*:\s*"((?:[^"\\]|\\.)*)"/gu)]
    .map(match => {
      try { return JSON.parse('"' + match[2] + '"') } catch (_) { return match[2] }
    })
    .map(value => String(value || '').trim()).filter(Boolean)
  if (pieces.length) return pieces.find(value => !/^[[{]/u.test(value)) || ''
  // 没有可识别的键时，去掉花括号、引号和 JSON 标点，只留能读的文字。
  return json.replace(/^[\[{]+|[\]}]+$/gu, '').replace(/"[^"]*"\s*:\s*/gu, '').replace(/["{}\[\],]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
}
const REFUND_KIND_LABEL = Object.freeze({
  exact_reference: '订单号一致',
  explicit_refund_evidence: '原单写明已退金额',
  item_evidence: '商品名一致',
  merchant_evidence: '同一商户'
})
// 退款原消费候选卡：商家、时间渠道、原消费与已退可退、为什么匹配上都分开显示，
// 让用户不用翻原文就能判断这一笔退的是哪一次消费。
function refundCandidateView(item) {
  const candidate = item || {}
  const remaining = candidate.remainingMinor, amount = candidate.amountMinor
  const used = remaining == null || amount == null ? null : BigInt(String(amount)) - BigInt(String(remaining))
  const itemText = merchantOf(candidate.item)
  return {
    id: candidate.id,
    version: candidate.version,
    kind: candidate.kind,
    sourceTypeLabel: { wechat: '微信', alipay: '支付宝', bank: '银行' }[candidate.sourceType] || '',
    // 商户优先；只有商户缺失时才退回商品名，避免“美团平台商户”被商品单号顶掉。
    title: merchantOf(candidate.merchant) || itemText || merchantOf(candidate.note) || '未命名原消费',
    item: itemText && itemText !== (merchantOf(candidate.merchant) || merchantOf(candidate.note)) ? itemText : '',
    localAtText: dayText(candidate.localAt),
    amountText: moneyText(amount),
    remainingText: moneyText(remaining),
    refundedText: used == null ? '' : moneyText(used),
    matchLabel: REFUND_KIND_LABEL[candidate.matchKind] || '',
    matchText: candidate.matchReason || ''
  }
}

module.exports = { errorText, direction, ERROR_MESSAGES, publicError, accountMapping, emptyLists, reviewLists, buildReviewedCards, detailWindow, record, listRecord, card, pendingCard, linkGroupRows, splitInstallmentCards, excludedGroups, evidencePartFields, PAGE_SIZE, shortFileName, sourceCaption, refundCandidateView, merchantOf, mergedSourceCount, canChangeJudgment }
