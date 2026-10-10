// 单笔编辑能力和纯字段转换。只产生 next，不写凭据、不创建计划、不开放客户端状态字段。
const { importError } = require('../errors')
const { applyFields } = require('./policy')
const { FIELD_MASK } = require('../manual-field-mask')
const { has, MOVEMENTS, overrides } = require('../editor-fields')
const composition = require('./editor-composition')
const NATURES = new Set(['unknown', 'income', 'expense', 'fee', 'internal_transfer', 'borrow', 'repayment', 'refund'])
const BASIC = ['economicNature', 'ledgerAccountId', 'counterpartyLedgerAccountId', 'categoryId', 'amountMinor',
  'occurredLocalAt', 'timezoneOffsetMinutes', 'counterparty', 'note']
const kind = nature => nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''
const fail = () => { throw importError('VALIDATION_ERROR') }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail()
}
function capability(event) {
  const source = event.fieldSources || {}, installment = source.installment, editor = overrides(event)
  const principal = Boolean(installment && installment.creditStatement && installment.component === 'principal')
  const readonly = !['ready', 'needs_action'].includes(event.status) || event.economicNature === 'balance_adjustment'
  const protectedReasons = new Set(['row_status_unknown','transaction_status_unknown','source_profile_unknown','identity_conflict','identity_review_required','account_mapping_conflict','core_fields_conflict','row_semantic_conflict','source_group_conflict','bank_channel_same_event_candidate','same_event_candidate','refund_source_conflict','blocking_issue_open'])
  return { version: 1, readonly, blockingReasons: [...new Set((event.reasonCodes || []).concat(source.semanticBlockers || []).filter(code => protectedReasons.has(code)))], recordRole: principal ? 'installment_source' : 'transaction',
    natures: principal ? ['repayment'] : [...NATURES], repayment: source.loanRepayment || null,
    ownership: source.repaymentOwnership || null, composition: principal ? 'single' : composition.sourceKind(event),
    incompleteComposition: editor.incompleteComposition || null, evidenceNote: editor.evidenceNote || '',
    sourceCorrection: editor.sourceCorrection || null, incompleteRepayment: editor.incompleteRepayment || null,
    text: { ...has(editor, 'counterparty') && { counterparty: editor.counterparty }, ...has(editor, 'note') && { note: editor.note } },
    timezoneOffsetMinutes: event.timezoneOffsetMinutes,
    lockedReason: readonly ? '该记录不支持导入草稿修改，请从正式账目或账户维护入口处理' : '' }
}
function validateTime(value, offset) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.000)?$/.test(value) ||
    !Number.isInteger(offset) || offset < -840 || offset > 840) fail()
  const normalized = value.replace(' ', 'T').slice(0, 19), date = new Date(normalized + 'Z')
  if (Number(normalized.slice(0, 4)) < 1000) fail()
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== normalized) fail()
}
function prepare(event, data) {
  object(data, ['requestId', 'updateId', 'updateVersion', 'eventId', 'eventVersion', 'editorVersion', 'fields',
    'composition', 'decisions', 'sourceCorrection', 'expectedRelations', 'acknowledgedChanges'])
  if (data.editorVersion !== 1 || capability(event).readonly || event.currency !== 'CNY') fail()
  const fields = data.fields || {}, decisions = data.decisions || {}, acknowledgements = data.acknowledgedChanges || []
  object(fields, BASIC); object(decisions, ['ownership', 'repayment', 'refund'])
  if (!Array.isArray(acknowledgements) || acknowledgements.some(key => !['composition', 'repayment', 'refund'].includes(key))) fail()
  const before = event.fieldSources || {}, patch = { ...fields }, editor = { ...overrides(event), version: 1 }
  const nature = has(fields, 'economicNature') ? fields.economicNature : event.economicNature
  if (!NATURES.has(nature)) fail()
  if (has(fields, 'amountMinor') && fields.amountMinor !== null && (typeof fields.amountMinor !== 'string' ||
    !/^(0|[1-9]\d{0,18})$/.test(fields.amountMinor) || BigInt(fields.amountMinor) > 9223372036854775807n)) fail()
  if (has(fields, 'occurredLocalAt') && fields.occurredLocalAt !== null) {
    if (fields.timezoneOffsetMinutes !== event.timezoneOffsetMinutes) fail()
    validateTime(fields.occurredLocalAt, fields.timezoneOffsetMinutes)
  }
  else if (has(fields, 'timezoneOffsetMinutes')) fail()
  for (const key of ['counterparty', 'note']) if (has(fields, key)) {
    if (typeof fields[key] !== 'string' || Array.from(fields[key]).length > 200) fail()
    editor[key] = fields[key]; delete patch[key]
  }
  const clearTime = has(fields, 'occurredLocalAt') && fields.occurredLocalAt === null
  const clearAmount = has(fields, 'amountMinor') && fields.amountMinor === null
  if (clearTime) delete patch.occurredLocalAt
  if (clearAmount) delete patch.amountMinor
  if (has(fields, 'economicNature')) patch.flowDirection = ['income', 'refund'].includes(nature) ? 'inflow'
    : MOVEMENTS.has(nature) ? 'neutral' : ['expense', 'fee'].includes(nature) ? 'outflow' : event.flowDirection
  if (!MOVEMENTS.has(nature) && nature !== 'unknown') patch.counterpartyLedgerAccountId = null
  if (kind(nature) !== kind(event.economicNature) && !has(fields, 'categoryId')) patch.categoryId = null
  if (!kind(nature)) patch.categoryId = null
  // 新归属决定经专用验证后替代旧归属；不借用 legacy 的“缺哪端”字段白名单。
  const changingOwnership = has(decisions, 'ownership') || has(fields, 'economicNature') && nature !== 'repayment'
  const base = changingOwnership ? { ...event, fieldSources: { ...before, repaymentOwnership: null } } : event
  let next = Object.keys(patch).length ? applyFields(base, patch) : { ...base }
  next.fieldSources = { ...base.fieldSources, editorOverrides: editor }
  if (clearAmount) { next.amountMinor = null; next.manualFieldMask |= FIELD_MASK.amountMinor }
  if (clearTime) { next.localAt = next.localDate = next.utcAt = null; next.manualFieldMask |= FIELD_MASK.occurredLocalAt }
  for (const key of ['counterparty', 'note']) if (has(fields, key)) next.manualFieldMask |= FIELD_MASK[key]
  const principal = capability(event).recordRole === 'installment_source'
  if (principal && (nature !== 'repayment' || next.counterpartyLedgerAccountId || data.composition || Object.keys(decisions).length)) fail()
  if (has(data, 'sourceCorrection')) {
    if (!before.installment || before.installment.creditStatement !== true) fail()
    object(data.sourceCorrection, ['periodNumber', 'totalTerms'])
    const correction = { ...(editor.sourceCorrection || {}), ...data.sourceCorrection }
    for (const value of Object.values(correction)) if (value !== null && (!Number.isInteger(value) || value < 1 || value > 600)) fail()
    const terms = has(correction, 'totalTerms') ? correction.totalTerms : before.installment.totalTerms
    const period = has(correction, 'periodNumber') ? correction.periodNumber : before.installment.periodNumber
    if (period && terms && period > terms) fail()
    editor.sourceCorrection = correction; next.manualFieldMask |= FIELD_MASK.sourceCorrection
  }
  if (data.composition) next = composition.apply(next, data.composition, acknowledgements)
  if (changingOwnership) {
    next.fieldSources.editorOverrides.ownershipCleared = true
    if (decisions.ownership != null) {
      next = require('../repayment-ownership').applyEditorDecision(next, decisions.ownership)
      delete next.fieldSources.editorOverrides.ownershipCleared
    }
  }
  if (has(decisions, 'repayment')) {
    if (before.loanRepayment && decisions.repayment === null && !acknowledgements.includes('repayment')) fail()
    if (decisions.repayment !== null && !['repayment','internal_transfer'].includes(next.economicNature)) fail()
    delete next.fieldSources.editorOverrides.incompleteRepayment
    if (decisions.repayment && decisions.repayment.mode === 'review' && decisions.repayment.draft) {
      const draft = decisions.repayment.draft
      object(draft, ['mode','principalMinor','interestMinor','feeMinor','interestTreatment','feeTreatment','interestCategoryId','feeCategoryId','loanId','loanVersion','chargeAllocations'])
      if (!['defer','associate'].includes(draft.mode)) fail()
      let sum = 0n
      for (const field of ['principal','interest','fee']) {
        const value = draft[field + 'Minor']
        if (value != null && (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)) fail()
        if (value != null) sum += BigInt(value)
      }
      if (next.amountMinor != null && sum > BigInt(next.amountMinor)) fail()
      for (const field of ['interest','fee']) if (!['expense','accrued'].includes(draft[field + 'Treatment'])) fail()
      for (const key of ['loanId','interestCategoryId','feeCategoryId']) if (draft[key] != null) require('../validation').validateUuid(draft[key])
      if (draft.loanVersion != null && (!Number.isSafeInteger(draft.loanVersion) || draft.loanVersion < 1)) fail()
      next.fieldSources.editorOverrides.incompleteRepayment = { ...draft, chargeAllocations: require('../loan-charge-payments').normalizeCoverage(draft.chargeAllocations) }
    }
    next.fieldSources.loanRepayment = decisions.repayment === null ? null : decisions.repayment.mode === 'review'
      ? { mode: 'review' } : require('../explicit-repayment').booking.normalize(decisions.repayment, next.amountMinor)
    if (next.fieldSources.loanRepayment && next.fieldSources.loanRepayment.mode !== 'review') require('../explicit-repayment').inputForEvent(next)
  } else if (before.loanRepayment && !MOVEMENTS.has(next.economicNature)) fail()
  if (has(decisions, 'refund')) {
    object(decisions.refund, ['mode', 'kind', 'id', 'version'])
    if (!['link', 'pending', 'unlinked'].includes(decisions.refund.mode) || next.economicNature !== 'refund') fail()
  }
  if (next.ledgerAccountId && next.ledgerAccountId === next.counterpartyLedgerAccountId) fail()
  // 只清除派生缺项；来源、身份、同笔等硬阻断交由原验证器和专用决定维护。
  const derived = new Set(['blocking_issue_open','ledger_account_required','economic_nature_required','core_fields_missing',
    'category_required','postability_direction_conflict','transfer_account_required','repayment_account_required','borrow_account_required',
    'repayment_ownership_required','repayment_other_treatment_required','repayment_ownership_invalid','loan_repayment_required','editor_composition_incomplete'])
  next.reasonCodes = (next.reasonCodes || []).filter(reason => !derived.has(reason) && !reason.startsWith('repayment_allocation_'))
  return next
}
module.exports = { capability, prepare, validateTime, kind }
