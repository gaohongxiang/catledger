// 单笔编辑能力和纯字段转换。只产生 next，不写凭据、不创建计划、不开放客户端状态字段。
const { importError } = require('../errors')
const { applyFields } = require('./policy')
const { FIELD_MASK } = require('../manual-field-mask')
const { has, MOVEMENTS, overrides } = require('../editor-fields')
const composition = require('./editor-composition')
const NATURES = new Set(['unknown', 'income', 'expense', 'fee', 'internal_transfer', 'borrow', 'repayment', 'refund'])
// 信用卡分期本金行可改判的经济性质。还款只登记来源；支出、费用、收入形成实际流水；
// 暂不确定保留来源但不入账。退款、内部转账和借款需要原消费关系或第二个账户，不在本金行开放。
const PRINCIPAL_NATURES = new Set(['repayment', 'expense', 'fee', 'income', 'unknown'])
const BASIC = ['economicNature', 'ledgerAccountId', 'counterpartyLedgerAccountId', 'categoryId', 'amountMinor',
  'occurredLocalAt', 'timezoneOffsetMinutes', 'counterparty', 'note', 'installmentPlan']
const kind = nature => nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''
const fail = () => { throw importError('VALIDATION_ERROR') }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail()
}
function capability(event) {
  const source = event.fieldSources || {}, installment = source.installment, editor = overrides(event)
  const registration = require('../installment-business').isRegistration(event)
  const principal = Boolean(installment && installment.creditStatement && installment.component === 'principal')
  const readonly = !['ready', 'needs_action'].includes(event.status) || event.economicNature === 'balance_adjustment'
  const protectedReasons = new Set(['row_status_unknown','transaction_status_unknown','source_profile_unknown','identity_conflict','identity_review_required','account_mapping_conflict','core_fields_conflict','row_semantic_conflict','source_group_conflict','bank_channel_same_event_candidate','same_event_candidate','refund_source_conflict','blocking_issue_open'])
  return { version: 1, readonly, blockingReasons: [...new Set((event.reasonCodes || []).concat(source.semanticBlockers || []).filter(code => protectedReasons.has(code)))], recordRole: registration ? 'installment_registration' : principal ? 'installment_source' : 'transaction',
    natures: registration ? ['unknown'] : principal ? [...PRINCIPAL_NATURES] : source.repaymentChannelResolution ? ['repayment'] : [...NATURES], repayment: source.loanRepayment || null,
    ...(source.repaymentChannelResolution ? { repaymentChannel: require('../repayment-channel').publicResolution(event) } : {}),
    ownership: source.repaymentOwnership || null, accountOwnership: require('../account-ownership').read(event),
    composition: principal ? 'single' : composition.sourceKind(event),
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
  object(fields, BASIC); object(decisions, ['ownership', 'accountOwnership', 'repayment', 'refund', 'repaymentChannel'])
  if (has(decisions, 'ownership') && has(decisions, 'accountOwnership')) fail()
  if (!Array.isArray(acknowledgements) || acknowledgements.some(key => !['composition', 'repayment', 'refund'].includes(key))) fail()
  const before = event.fieldSources || {}, patch = { ...fields }, editor = { ...overrides(event), version: 1 }
  if (has(decisions, 'repaymentChannel')) {
    object(decisions.repaymentChannel, ['confirmed'])
    if (!before.repaymentChannelResolution || decisions.repaymentChannel.confirmed !== true) fail()
  }
  const nature = has(fields, 'economicNature') ? fields.economicNature : event.economicNature
  if (!NATURES.has(nature)) fail()
  if (require('../installment-business').isRegistration(event) && (fields.categoryId || fields.counterpartyLedgerAccountId)) fail()
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
  const changingOwnership = has(decisions, 'ownership') || has(decisions, 'accountOwnership') ||
    has(fields, 'economicNature') && nature !== require('../account-ownership').read(event).businessNature
  const clearOwnership = has(decisions, 'ownership') || decisions.accountOwnership === null ||
    has(fields, 'economicNature') && nature !== require('../account-ownership').read(event).businessNature
  const base = clearOwnership ? { ...event, fieldSources: { ...before, repaymentOwnership: null, accountOwnership: null } } : event
  let next = Object.keys(patch).length ? applyFields(base, patch) : { ...base }
  // applyFields 只把单键决定写进 fieldSources；普通字段保存仍以来源事实为底。
  // 「这笔分期」的决定是这里唯一需要保留的新键，不能随编辑覆盖一起丢掉。
  const appliedPlan = next.fieldSources && next.fieldSources.installmentPlan
  next.fieldSources = { ...base.fieldSources, ...(appliedPlan ? { installmentPlan: appliedPlan } : {}), editorOverrides: editor }
  if (has(fields, 'installmentPlan')) {
    // 放款行和独立登记都能建立或归入计划。
    // 计划挂在用户为本行选定的负债账户上，只跟踪不记账，不生成任何交易。
    if (!require('../installment-business').isPlanSource(event)) fail()
    const decision = next.fieldSources.installmentPlan
    if (!decision || !next.ledgerAccountId) fail()
    next.fieldSources = { ...next.fieldSources, installmentPlan: { ...decision, accountId: next.ledgerAccountId } }
  }
  if (clearAmount) { next.amountMinor = null; next.manualFieldMask |= FIELD_MASK.amountMinor }
  if (clearTime) { next.localAt = next.localDate = next.utcAt = null; next.manualFieldMask |= FIELD_MASK.occurredLocalAt }
  for (const key of ['counterparty', 'note']) if (has(fields, key)) next.manualFieldMask |= FIELD_MASK[key]
  const principal = capability(event).recordRole === 'installment_source'
  if (require('../installment-business').isRegistration(event) && (nature !== 'unknown' || next.counterpartyLedgerAccountId ||
      next.categoryId || data.composition || Object.keys(decisions).length || has(data, 'sourceCorrection'))) fail()
  if (principal && (!PRINCIPAL_NATURES.has(nature) || next.counterpartyLedgerAccountId || data.composition || Object.keys(decisions).length)) fail()
  if (has(data, 'sourceCorrection')) {
    if (!before.installment || before.installment.creditStatement !== true) fail()
    object(data.sourceCorrection, ['periodNumber', 'totalTerms', 'planLabel'])
    const correction = { ...(editor.sourceCorrection || {}), ...data.sourceCorrection }
    for (const [key, value] of Object.entries(correction)) {
      // planLabel 的显式 null 要在外层 null 分支之前处理：外层 continue 会把 null 键原样
      // 留在 correction 里，而“保留 null”是 periodNumber 的语义（清期次、重挂归属），
      // 不是 planLabel 的——planLabel 必须删键表示清除。
      if (key === 'planLabel' && value === null) { delete correction.planLabel; continue }
      if (value === null) continue
      if (key === 'planLabel') {
        // 计划归属只能取自本期次已识别到的本金计划，不接受客户端自造的字符串。
        const candidates = before.installmentAttribution && before.installmentAttribution.plans || []
        if (typeof value !== 'string' || value.length > 120 || !candidates.some(item => item.planName === value)) fail()
        continue
      }
      if (!Number.isInteger(value) || value < 1 || value > 600) fail()
    }
    const terms = has(correction, 'totalTerms') ? correction.totalTerms : before.installment.totalTerms
    const period = has(correction, 'periodNumber') ? correction.periodNumber : before.installment.periodNumber
    if (period && terms && period > terms) fail()
    // 清除后 correction 可能变空：人工确认整体消失，必须连 sourceCorrection 键一起删，
    // 否则残留空对象会让下游把“存在 sourceCorrection”当成“仍有人工指定”。
    if (Object.keys(correction).length) editor.sourceCorrection = correction
    else delete editor.sourceCorrection
    next.manualFieldMask |= FIELD_MASK.sourceCorrection
  }
  if (data.composition) next = composition.apply(next, data.composition, acknowledgements)
  if (changingOwnership) {
    next.fieldSources.editorOverrides.ownershipCleared = true
    if (decisions.ownership != null) {
      next = require('../repayment-ownership').applyEditorDecision(next, decisions.ownership)
      delete next.fieldSources.editorOverrides.ownershipCleared
    }
    if (decisions.accountOwnership != null) {
      next = require('../account-ownership').apply(next, decisions.accountOwnership)
      delete next.fieldSources.editorOverrides.ownershipCleared
    }
  }
  // 归属决定可能把还款派生为收支；同次选定的分类按最终性质核验，不能按旧性质丢弃。
  if (has(fields, 'categoryId') && kind(next.economicNature) && next.status !== 'excluded') {
    next = applyFields(next, { categoryId: fields.categoryId })
  }
  if (has(decisions, 'repayment')) {
    // 普通还款只按全额转账。兼容旧草稿的显式解除，不再接受本息拆分或计划关联。
    if (decisions.repayment !== null) fail()
    if ((before.loanRepayment || editor.incompleteRepayment) && !acknowledgements.includes('repayment')) fail()
    next.fieldSources.loanRepayment = null
    delete next.fieldSources.editorOverrides.incompleteRepayment
  } else if (before.loanRepayment && !MOVEMENTS.has(next.economicNature)) fail()
  if (has(decisions, 'refund')) {
    object(decisions.refund, ['mode', 'kind', 'id', 'version'])
    if (!['link', 'pending', 'unlinked'].includes(decisions.refund.mode) || next.economicNature !== 'refund') fail()
  }
  if (next.ledgerAccountId && next.ledgerAccountId === next.counterpartyLedgerAccountId) fail()
  if (before.repaymentChannelResolution && (!require('../repayment-channel').relationValid(next) ||
      has(data, 'sourceCorrection') || has(data, 'composition') || Object.keys(decisions).some(key => key !== 'repaymentChannel'))) fail()
  // 只清除派生缺项；来源、身份、同笔等硬阻断交由原验证器和专用决定维护。
  const derived = new Set(['blocking_issue_open','ledger_account_required','economic_nature_required','core_fields_missing',
    'category_required','postability_direction_conflict','transfer_account_required','repayment_account_required','borrow_account_required',
    'repayment_ownership_required','repayment_other_treatment_required','repayment_ownership_invalid','loan_repayment_required','editor_composition_incomplete',
    'installment_attribution_required', 'account_source_required', 'account_destination_required',
    'account_ownership_invalid', 'account_ownership_recheck_required', 'account_ownership_business_required',
    'external_no_ledger_effect_required'])
  next.reasonCodes = (next.reasonCodes || []).filter(reason => !derived.has(reason) && !reason.startsWith('repayment_allocation_'))
  // 本金行的字段冲突正是这次改建的性质、对端和分配。改到合法组合、来源也没有其他硬阻断时，
  // 这条冲突已经由用户的选择解决，不能继续把整批卡在“交易信息冲突待核对”。
  if (principal && PRINCIPAL_NATURES.has(next.economicNature) && !next.counterpartyLedgerAccountId &&
      !next.fieldSources.loanRepayment && !next.fieldSources.paymentResolution && !next.fieldSources.repaymentChannelResolution &&
      !(next.fieldSources.repaymentAllocations || []).length && !(next.fieldSources.semanticBlockers || []).length) {
    next.reasonCodes = next.reasonCodes.filter(reason => reason !== 'core_fields_conflict')
  }
  return next
}
module.exports = { capability, prepare, validateTime, kind }
