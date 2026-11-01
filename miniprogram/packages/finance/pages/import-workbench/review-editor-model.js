// 交易草稿纯模型。入口/问题类型不决定字段，目录只保存稳定 ID。
const detail = require('./detail-fields')
const bankAccounts = require('./bank-suggestion')
const refundView = require('./refund-state')
const scheduleForm = require('../loan-detail/schedule-form')
const accountOwnership = require('../../domain/import-review/account-ownership')
const has = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const MOVEMENTS = ['internal_transfer', 'borrow', 'repayment']
const ASSETS = ['cash', 'bank', 'wallet', 'other_asset'], DEBTS = ['credit', 'other_liability']
const NATURES = ['expense', 'income', 'refund', 'internal_transfer', 'repayment', 'borrow', 'fee', 'unknown']
  .map(value => ({ value, label: detail.natureLabel({ economicNature: value }) }))
const PLAN_FIELDS = ['planAction', 'planLoanId', 'planName', 'planTerms', 'planPrincipalInput', 'planStartMonth',
  'planMethodIndex', 'planQuoteIndex', 'planRatePercent', 'planFirstPaymentDate']
const PLAN_FORM_FIELDS = PLAN_FIELDS.filter(key => !['planAction', 'planLoanId'].includes(key))
const LEGACY_REPAYMENT_FIELDS = new Set(['repaymentDetails', 'loanMode', 'loanId', 'loanVersion',
  'principalInput', 'interestInput', 'feeInput', 'interestTreatment', 'feeTreatment',
  'interestCategoryId', 'feeCategoryId', 'chargeAllocations'])
// 分期本金行可以改判经济性质：默认“还款”只登记来源；支出、费用、收入会形成实际流水；
// 暂不确定保留来源但不入账。退款、内部转账和借款需要原消费关系或第二个账户，不由本金行直接改判。
const PRINCIPAL_NATURES = ['repayment', 'expense', 'fee', 'income', 'unknown']
// 性质切换列表只解释“换成这个模式后是什么”，不重复字段说明；实际保留/失效仍由第 5 节的切换规则决定。
const NATURE_HINTS = Object.freeze({ expense: '日常消费、付款', income: '工资、收款', refund: '退回原消费',
  internal_transfer: '自己账户之间', repayment: '信用卡、贷款', borrow: '借款到账', fee: '手续费、服务费', unknown: '先留待核对' })
const categoryKind = nature => nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''
// 排除不是一种经济性质，而是“这一笔本次不入账”的处理决定：它不生成任何账目，
// 只把原文和证据留在本批里。所以它单独成段，排在性质列表下面，也不参与性质单选。
// 只有当前挂着开放事项时才有这个入口——排除决定必须挂在那件事项上；
// 组里不止这一笔时只说清这一笔被排除，同组其余仍留给用户逐笔判断。
function excludeAction(issue) {
  const scopeCount = Math.max(1, Number(issue.memberCount || 1) - Number(issue.candidateCount || 0))
  return { label: '不计入本次账本', scopeCount,
    hint: scopeCount > 1 ? '只排除这一笔，同组另外 ' + (scopeCount - 1) + ' 笔仍待核对；原文都保留'
      : '原文保留，本次不生成任何账目' }
}
// 与 cloudfunctions semantic-plan-upgrade 的 flowDirection 重算规则同源：
// 转账类不计收支（中性墨色），收入退款为流入（绿），其余含“暂不确定”为流出（红）。
const flowClass = nature => ['repayment', 'borrow', 'internal_transfer'].includes(nature) ? ''
  : ['income', 'refund'].includes(nature) ? 'row-income' : 'row-expense'
const repaymentChannelOf = row => row.repaymentChannel || row.editorFacts?.repaymentChannel || null
const repaymentTargetKey = row => row.sourceDirection === 'income' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId'
const repaymentPayerKey = row => row.sourceDirection === 'income' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
const OWNERSHIP_KINDS = ['ledger', 'external', 'unknown']
function ownershipKeys(row, nature) {
  const reverse = ['income', 'refund'].includes(nature) || MOVEMENTS.includes(nature) && row.sourceDirection === 'income'
  return { source: reverse ? 'counterpartyLedgerAccountId' : 'ledgerAccountId',
    destination: reverse ? 'ledgerAccountId' : 'counterpartyLedgerAccountId' }
}
// 单笔编辑器直接读取公开行（组合、还款分配等字段在顶层），还要叠加尚未保存的草稿性质
// 和组成，无法原样调用服务端的 supported(event)。这里保留同一组结构条件作为界面门禁；
// 保存与入账仍由服务端统一复核，服务端判定变化时须同步此函数。
function ownershipEditable(row, draft) {
  return draft.composition === 'single' && !repaymentChannelOf(row) && !detail.installmentOf(row) && !disbursementOf(row) &&
    !row.bankChannelResolution && !row.fieldSources?.bankChannelResolution && !row.paymentResolution &&
    !(row.paymentAccounts || []).length && !(row.repaymentAllocations || []).length &&
    !row.loanRepayment && !row.editorFacts?.incompleteRepayment && !row.editorFacts?.incompleteComposition &&
    !['borrow', 'refund'].includes(draft.economicNature) &&
    (['repayment', 'internal_transfer'].includes(draft.economicNature) || detail.ownershipOf(row).explicit && !draft.dirty.economicNature)
}
function ownershipDecision(row, draft) {
  const keys = ownershipKeys(row, draft.economicNature)
  return Object.fromEntries(['source', 'destination'].map(side => [side, {
    kind: draft[side + 'Kind'], ...(draft[side + 'Kind'] === 'ledger' ? { accountId: draft[keys[side]] || null } : {})
  }]).concat(draft.noLedgerImpact ? [['noLedgerImpact', true]] : []))
}
function ownershipPreview(row, draft) {
  const decision = ownershipDecision(row, draft)
  return accountOwnership.resolve({ ...row, economicNature: draft.economicNature,
    ledgerAccountId: draft.ledgerAccountId || null, counterpartyLedgerAccountId: draft.counterpartyLedgerAccountId || null,
    fieldSources: { ...row.fieldSources, accountOwnership: { version: accountOwnership.VERSION, confirmedBy: 'user',
      businessNature: draft.economicNature, source: decision.source.kind, destination: decision.destination.kind,
      ...(decision.noLedgerImpact ? { noLedgerImpact: true } : {}) } } })
}
function yuan(value) {
  if (value == null) return ''
  const digits = String(value).padStart(3, '0')
  return digits.slice(0, -2) + '.' + digits.slice(-2)
}
function minor(value) {
  const text = String(value).trim()
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return null
  const parts = text.split('.'), digits = (parts[0] + (parts[1] || '').padEnd(2, '0')).replace(/^0+(?=\d)/, '')
  if (digits.length > 19 || digits.length === 19 && digits > '9223372036854775807') return null
  return digits
}
// 现金分期放款行：服务端把它和同笔的卡内记账行配成一对。放款行按借款入账，
// 计划只跟踪还款进度，不改变这笔钱的记法；对行仍然排除。
function disbursementOf(row) {
  const value = row && (row.disbursement || row.fieldSources && row.fieldSources.disbursement)
  return value && ['disbursement', 'registration'].includes(value.role) ? value : null
}
function sourcePlanTerms(row) {
  const terms = Number(disbursementOf(row)?.totalTerms)
  return Number.isInteger(terms) && terms > 0 && terms <= 600 ? terms : null
}
function planAccountDraftOf(draft, catalogs) {
  const selected = catalogs.planAccountDraft
  if (selected?.accountId === draft.ledgerAccountId) return selected
  return (catalogs.accounts || []).find(account => account.accountId === draft.ledgerAccountId && account.isDraft) || null
}
function planDecisionOf(row) {
  const value = row && row.installmentPlanDecision
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
function create(row) {
  const source = row.primaryEvidence || {}, facts = row.editorFacts || {}
  const channel = repaymentChannelOf(row)
  const ownership = detail.ownershipOf(row)
  const disbursement = disbursementOf(row), planDecision = planDecisionOf(row), registration = detail.registrationOf(row)
  const parts = facts.incompleteComposition ? facts.incompleteComposition.parts : row.paymentResolution ? row.paymentResolution.allocations : facts.composition === 'repayment' ? row.repaymentAllocations || []
    : (row.paymentComponents || []).map((part, componentIndex) => ({ ...part, componentIndex }))
      .filter(part => part.componentKind === 'financial').map(part => ({ ...part,
        ...((row.paymentResolution && row.paymentResolution.allocations || []).find(value => value.componentIndex === part.componentIndex) ||
          (row.paymentAccounts || []).find(value => value.componentIndex === part.componentIndex) || {}) }))
  const draft = { economicNature: registration ? 'unknown' : ownership.explicit ? ownership.businessNature
      : detail.principalOf(row) ? (PRINCIPAL_NATURES.includes(row.economicNature) ? row.economicNature : 'repayment') : row.economicNature,
    ledgerAccountId: row.ledgerAccountId || '', counterpartyLedgerAccountId: registration || detail.principalOf(row) ? '' : row.counterpartyLedgerAccountId || '',
    amountInput: yuan(row.amountMinor), date: String(row.localAt || '').slice(0, 10), time: String(row.localAt || '').slice(11, 19),
    counterparty: (has(row, 'counterparty') ? row.counterparty : source.counterparty || '').slice(0, 200),
    note: (has(row, 'note') ? row.note : source.note || '').slice(0, 200), categoryId: registration ? '' : row.categoryId || '',
    sourceKind: ownership.source.kind, destinationKind: ownership.destination.kind, noLedgerImpact: ownership.noLedgerImpact,
    repaymentDetails: false,
    composition: facts.composition || 'single', parts: parts.map(part => ({ ...part, accountId: part.accountId || '', amountInput: yuan(part.amountMinor) })),
    evidenceNote: facts.incompleteComposition?.evidenceNote || row.paymentResolution?.evidenceNote || facts.evidenceNote || '',
    periodInput: String(row.installment?.periodNumber || ''), totalTermsInput: String(row.installment?.totalTerms || ''),
    // 计划归属：空表示用户没有改动；只在用户主动选择时才进入 sourceCorrection。
    planLabel: '',
    // 这笔分期：归入已有计划、新建计划或先不挂。没有保存过时动作留空，默认不动，
    // 照常入账；已经决定过的批次回显上次的选择和计划名。
    ...(disbursement ? {
      planAction: planDecision ? planDecision.action || '' : '',
      planLoanId: planDecision && planDecision.loanId || '',
      planName: String(planDecision && planDecision.planLabel || disbursement.planLabel || '').slice(0, 120),
      planTerms: String(planDecision && planDecision.totalTerms || disbursement.totalTerms || ''),
      planPrincipalInput: yuan(planDecision && planDecision.principalMinor || row.amountMinor),
      // 账单月和放款日不能冒充合同起始月或首次还款日；需要用户明确填写。
      planStartMonth: String(planDecision && planDecision.startMonth || ''),
      planMethodIndex: 0, planQuoteIndex: 0, planRatePercent: '', planFirstPaymentDate: ''
    } : {}),
    refund: null, dirty: {}, dormant: {}, acknowledgedChanges: [] }
  if (channel) Object.assign(draft, { economicNature: 'repayment', amountInput: yuan(channel.totalMinor),
    [repaymentTargetKey(row)]: channel.targetAccountId, composition: 'single', parts: [], repaymentDetails: false,
    repaymentChannelConfirmed: channel.confirmed !== false })
  if (ownership.explicit && ownershipEditable(row, draft)) {
    const keys = ownershipKeys(row, draft.economicNature)
    for (const side of ['source', 'destination']) draft[keys[side]] = ownership[side].kind === 'ledger' ? ownership[side].accountId || '' : ''
  }
  // 端点组一定有账户行：服务端可能声明了多账户组成却还没给任何分配（未完成组成），
  // 旧版本删到 0 条的草稿也是这个形态。留一条空行，端点组就不会只剩标题。
  if (draft.composition !== 'single' && !draft.parts.length) draft.parts = [{ accountId: '', amountInput: '' }]
  return draft
}
function change(row, draft, key, value) {
  const channel = repaymentChannelOf(row)
  // 旧控件或迟到事件不能重新写回已经退出普通还款编辑器的本息费、计划和收费项决定。
  if (LEGACY_REPAYMENT_FIELDS.has(key) || ['owner', 'otherTreatment'].includes(key)) return draft
  if (detail.registrationOf(row) && !['ledgerAccountId', 'acknowledgedChanges', ...PLAN_FIELDS].includes(key)) return draft
  if (key === 'planTerms' && sourcePlanTerms(row)) return draft
  // 计划已经创建后，重试只保存同一计划决定，不允许把界面参数改成另一份计划。
  if (draft.planAction === 'create' && draft.planLoanId && PLAN_FORM_FIELDS.includes(key)) return draft
  if (key === 'repaymentChannelConfirmed' && (!channel || channel.confirmed !== false || typeof value !== 'boolean')) return draft
  if (channel && ![repaymentPayerKey(row), 'counterparty', 'note', 'acknowledgedChanges', 'repaymentChannelConfirmed'].includes(key)) return draft
  const next = { ...draft, dirty: { ...draft.dirty, [key]: true }, dormant: { ...draft.dormant } }
  if (['sourceKind', 'destinationKind', 'noLedgerImpact'].includes(key)) {
    if (!ownershipEditable(row, draft)) return draft
    if (key === 'noLedgerImpact') {
      if (typeof value !== 'boolean' || draft.sourceKind !== 'external' || draft.destinationKind !== 'external') return draft
    } else {
      if (!OWNERSHIP_KINDS.includes(value)) return draft
      if (draft[key] === value) return detail.ownershipOf(row).pendingLegacyTreatment ? next : draft
      const side = key === 'sourceKind' ? 'source' : 'destination', field = ownershipKeys(row, draft.economicNature)[side]
      if (!['repayment', 'internal_transfer', 'unknown'].includes(draft.economicNature) &&
          side !== (draft.economicNature === 'income' ? 'destination' : 'source')) return draft
      if (draft[key] === 'ledger') next.dormant[side + 'Account'] = draft[field]
      next[field] = value === 'ledger' ? next.dormant[side + 'Account'] || '' : ''
      next.noLedgerImpact = false
    }
  }
  if (key === 'economicNature') {
    if (!NATURES.some(item => item.value === value) || detail.principalOf(row) && !PRINCIPAL_NATURES.includes(value)) return draft
    if (draft.composition === 'repayment' && value !== 'repayment' || draft.composition === 'payment' && !['expense', 'repayment'].includes(value)) return draft
    const prior = categoryKind(draft.economicNature), after = categoryKind(value)
    if (prior !== after) {
      if (prior) next.dormant[prior + 'Category'] = draft.categoryId
      next.categoryId = after ? next.dormant[after + 'Category'] || '' : ''
    }
    if (MOVEMENTS.includes(draft.economicNature) && !MOVEMENTS.includes(value)) {
      next.dormant.counterpartyLedgerAccountId = draft.counterpartyLedgerAccountId
      if (ownershipEditable(row, draft)) {
        next.dormant.movementAccounts = { ledgerAccountId: draft.ledgerAccountId, counterpartyLedgerAccountId: draft.counterpartyLedgerAccountId }
        const side = ['income', 'refund'].includes(value) ? 'destination' : ['expense', 'fee'].includes(value) ? 'source' : null
        if (side) next.ledgerAccountId = draft[ownershipKeys(row, draft.economicNature)[side]] || ''
      }
      next.counterpartyLedgerAccountId = ''
    } else if (!MOVEMENTS.includes(draft.economicNature) && MOVEMENTS.includes(value)) {
      next.counterpartyLedgerAccountId = next.dormant.counterpartyLedgerAccountId || ''
      if (next.dormant.movementAccounts) Object.assign(next, next.dormant.movementAccounts)
    }
    next.refund = null
    const keys = ownershipKeys(row, value)
    next.sourceKind = next[keys.source] ? 'ledger' : ['income', 'refund'].includes(value) ? 'external' : 'unknown'
    next.destinationKind = next[keys.destination] ? 'ledger' : ['expense', 'fee'].includes(value) ? 'external' : 'unknown'
    next.noLedgerImpact = false
  }
  if (key === 'composition') {
    if (!['single', 'payment', 'repayment'].includes(value) || value === 'repayment' && draft.economicNature !== 'repayment' ||
      value === 'payment' && !['expense','repayment'].includes(draft.economicNature) || detail.principalOf(row)) return draft
    next.dormant[draft.composition + 'Parts'] = draft.parts
    next.dormant[draft.composition + 'Accounts'] = { ledgerAccountId: draft.ledgerAccountId, counterpartyLedgerAccountId: draft.counterpartyLedgerAccountId }
    next.parts = next.dormant[value + 'Parts'] || Array.from({ length: value === 'payment' ? 2 : value === 'repayment' ? 1 : 0 }, (_, index) => ({ accountId: '', amountInput: '', componentIndex: index }))
    const reverse = draft.composition === 'single' && MOVEMENTS.includes(draft.economicNature) && row.sourceDirection === 'income'
    const from = reverse ? draft.counterpartyLedgerAccountId : draft.ledgerAccountId
    const to = reverse ? draft.ledgerAccountId : draft.counterpartyLedgerAccountId
    const nextReverse = value === 'single' && MOVEMENTS.includes(draft.economicNature) && row.sourceDirection === 'income'
    next.ledgerAccountId = nextReverse ? to : value === 'payment' || value === 'single' ? '' : from
    next.counterpartyLedgerAccountId = nextReverse ? '' : value === 'repayment' ? '' : to
    if (next.dormant[value + 'Accounts']) Object.assign(next, next.dormant[value + 'Accounts'])
  }
  next[key] = value
  if (['ledgerAccountId', 'counterpartyLedgerAccountId'].includes(key) && ownershipEditable(row, next)) {
    const keys = ownershipKeys(row, next.economicNature), side = keys.source === key ? 'source' : 'destination'
    next[side + 'Kind'] = value ? 'ledger' : 'unknown'
    next.noLedgerImpact = false
  }
  if (['sourceKind', 'destinationKind'].includes(key)) {
    const before = categoryKind(ownershipPreview(row, draft).economicNature), after = categoryKind(ownershipPreview(row, next).economicNature)
    if (before !== after) {
      if (before) next.dormant[before + 'Category'] = draft.categoryId
      next.categoryId = after ? next.dormant[after + 'Category'] || '' : ''
    }
  }
  return next
}
function accountFields(row, draft, catalog) {
  const channel = repaymentChannelOf(row)
  const ownership = ownershipEditable(row, draft), keys = ownershipKeys(row, draft.economicNature)
  const projected = { ...row, economicNature: draft.economicNature,
    ledgerAccountId: draft.ledgerAccountId, counterpartyLedgerAccountId: draft.counterpartyLedgerAccountId, editorComposition: draft.composition }
  const route = ownership ? ['source', 'destination'].map(side => ({
    key: keys[side] === 'ledgerAccountId' ? 'account' : 'counterparty', accountId: draft[keys[side]],
    label: draft.economicNature === 'internal_transfer' ? side === 'source' ? '转出账户' : '转入账户'
      : side === 'source' ? '付款账户' : draft.economicNature === 'repayment' ? '还入账户' : '收款账户'
  })) : detail.accountFields(projected)
  return route.map(field => {
    let allowedTypes = null
    if (field.label === '付款账户' && draft.economicNature === 'repayment' || field.label === '到账账户') allowedTypes = ASSETS
    // 普通还款只核对资金两端，收款端统一允许信用卡和其他负债账户。
    if (field.label === '还入账户' || field.label === '借款负债账户') allowedTypes = DEBTS
    if (detail.principalOf(row) || detail.registrationOf(row) || disbursementOf(row) && field.key === 'account') allowedTypes = ['credit']
    const account = catalog.find(item => item.accountId === field.accountId)
    const readonly = Boolean(channel && field.label === '还入账户' || disbursementOf(row) && field.key === 'account' && draft.planAction === 'create' && draft.planLoanId)
    const side = keys.source === (field.key === 'account' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId') ? 'source' : 'destination'
    return { ...field, ...(ownership ? { ownershipSide: side, ownershipKind: draft[side + 'Kind'],
      ownershipEditable: ['repayment', 'internal_transfer', 'unknown'].includes(draft.economicNature) ||
        side === (draft.economicNature === 'income' ? 'destination' : 'source') } : {}),
      target: readonly ? '' : field.key === 'account' ? 'reviewAccount' : 'reviewCounterparty', allowedTypes, readonly,
      name: account ? account.name : field.accountId ? '账户名称待读取' : '',
      invalid: Boolean(account && (account.archivedAt || account.disabledAt || account.unavailable ||
        account.currency && account.currency !== (row.currency || 'CNY') || allowedTypes && !allowedTypes.includes(account.type))) }
  })
}
// 分期归属区。费用行得到的是「这笔利息属于哪个计划」的单选；本金行得到的是本组上下文，
// 列出本期次还没指定归属的利息，勾选后保存时由本金逐笔写回归属。
// 候选计划与分组上下文都由服务端随事件下发，客户端不自己推断，避免两处口径不一致。
function attributionOf(row, draft, catalogs) {
  const attribution = row.installmentAttribution
  if (!attribution) return null
  if (attribution.role === 'principal') {
    // 本期次的全部费用行都要列出来，包括已经归属过的：那笔如果从候选里消失，用户会以为
    // 账单里根本没有第二笔利息，也就没法判断剩下的那笔该给谁。归属到别的本金时只读并写明去向。
    const groupKey = String(row.installmentKey || attribution.groupKey || '')
    const charges = ((catalogs || {}).siblings || []).filter(item => item.eventId !== row.eventId && item.rowRoleKey &&
      item.rowRoleKey !== 'principal' && Boolean(groupKey) && String(item.installmentKey || '') === groupKey)
    if (!charges.length) return null
    // 归属是“从本期利息里挑给本计划”，不是打开利息自己的编辑器：
    // 这里按退款候选的语言给出可勾选状态，选中只存在本次草稿，保存时才写回那笔利息。
    const selections = catalogs && catalogs.pendingSelections
    const clears = catalogs && catalogs.pendingClears
    // 服务端归属结论里的计划名才是这张卡的锚点；row.installment.planName 只是旧批次的展示回退。
    const cardPlan = String(attribution.planLabel || row.installment && row.installment.planName || '').trim()
    const items = charges.map(item => {
      const roleLabel = String(item.rowRole || item.installmentRole || '分期费用').trim()
      let title = String(item.displayTitle || item.rowTitle || '分期费用').trim()
      // 账单标题本身就是“利息”时退回摘要里的计划名，不再只显示一个泛称。
      if (title === roleLabel && item.rowTitle) title = String(item.rowTitle).trim()
      const planHint = String(item.rowTitle || '').trim()
      const assignedPlan = String(item.installmentPlanLabel || '').trim()
      // 已归到别的本金：列出来但不可点；已归到本卡：默认勾选，点一下取消归属。
      const mine = Boolean(assignedPlan) && assignedPlan === cardPlan
      const foreign = Boolean(assignedPlan) && !mine
      const selected = mine ? !Boolean(clears && clears.has(item.eventId)) : Boolean(selections && selections.has(item.eventId))
      return { eventId: item.eventId, title,
        // 与本卡计划相同、标题已包含或只是标题重复时不再提示；真正不同的账单计划才值得提醒。
        planHint: planHint && planHint !== title && planHint !== cardPlan && !title.includes(planHint) ? planHint : '',
        meta: [item.displayDate, item.displayTime, item.accountText || item.rowSource].filter(Boolean).join(' · '),
        amountText: item.amountText || '', assignedPlan, mine, disabled: foreign, selected }
    })
    return { role: 'principal', required: false,
      // 只统计本次勾选、保存时要写的那几笔；已归到本卡的已经在账上，不算“待保存”。
      selectedCount: items.filter(item => item.selected && !item.mine).length,
      planLabel: cardPlan, pending: items }
  }
  if (!(attribution.plans || []).length) return null
  const selected = draft.dirty.planLabel ? draft.planLabel : row.installment && row.installment.planLabel || ''
  // 本期次同组别的利息已经归到哪个计划：本机投影按全组算好（taken），计划行据此标出占用。
  // 不用当前列表里的同组行：待核对只下发当前页，已归属的那笔已经不在里面了。
  const takenByPlan = new Map((attribution.taken || []).map(item => [item.planName, item]))
  return { role: 'charge', required: !selected, selected: Boolean(selected),
    plans: attribution.plans.map(item => {
      const taken = takenByPlan.get(item.planName)
      // 说清“这个计划本期还剩另一笔利息”，别写成只描述本期的“本期已有 ¥X 利息”——
      // 那句话会被读成本期利息就是这些钱，正是用户选它之前最需要区分的事。
      const takenText = taken
        ? (taken.count > 1
          ? '本期已有 ' + taken.count + ' 笔利息，共 ¥' + yuan(taken.amountMinor)
          : '本期已有另一笔 ¥' + yuan(taken.amountMinor) + ' 利息')
        : ''
      return { planName: item.planName,
        amountText: item.amountMinor == null || item.amountMinor === '' ? '' : '¥' + yuan(item.amountMinor),
        selected: item.planName === selected, takenBy: takenText }
    }) }
}

// 「这笔分期」区块：只给现金分期放款行。候选来自 loans.planCandidates，同名同总期数的
// 计划会一起列出来，靠本金和起始月区分；只有指纹唯一命中才标“与本笔一致”。
// 客户端不按金额相似度猜，也不跨月记住上次选择。
function disbursementPlanOf(row, draft, catalogs, fieldErrors) {
  const disbursement = disbursementOf(row)
  if (!disbursement) return null
  const saved = planDecisionOf(row), registration = detail.registrationOf(row), terms = sourcePlanTerms(row)
  const candidates = (catalogs.planCandidates || []).map(item => {
    const disabled = Boolean(terms && Number(item.scheduleTerms) !== terms)
    return { loanId: item.loanId, name: item.name,
      meta: ['共' + (item.scheduleTerms || '?') + '期', item.startMonth ? item.startMonth + ' 起' : '',
        item.originalPrincipalMinor == null ? '' : '本金 ¥' + yuan(item.originalPrincipalMinor)].filter(Boolean).join(' · '),
      disabled, disabledReason: disabled ? '账单为 ' + terms + ' 期，期数不符' : '',
      matched: Boolean(item.matched) && !disabled, selected: draft.planLoanId === item.loanId }
  })
  const billLabel = String(disbursement.planLabel || '').trim()
  const accountDraft = planAccountDraftOf(draft, catalogs)
  return {
    registration,
    planLabel: billLabel || '这笔分期',
    // 计划名就是后续每期账单对上的依据；改了名，之后只能手动补挂。
    nameMismatch: Boolean(billLabel) && Boolean(String(draft.planName || '').trim()) && String(draft.planName).trim() !== billLabel,
    totalTerms: disbursement.totalTerms || null,
    principalText: row.amountMinor == null ? '' : '¥' + yuan(row.amountMinor),
    startMonth: draft.planStartMonth || '',
    accountMissing: !draft.ledgerAccountId,
    action: draft.planAction || '',
    effectText: registration ? '只关联分期计划，不生成资金流水。'
      : draft.economicNature === 'borrow' ? '确认到账账户后，这笔借款只记一次；分期计划用于跟踪还款。'
        : '记录按当前选择的性质处理，分期计划只用于跟踪还款。',
    skipText: registration ? '先不关联会保留待核对，不生成资金流水。'
      : draft.economicNature === 'borrow' ? '先只记录借款，暂不关联分期计划。' : '先按当前性质记录，暂不关联分期计划。',
    savedText: saved && saved.action === 'create' ? '已新建「' + saved.planLabel + '」'
      : saved && saved.action === 'link' ? '已归入「' + saved.planLabel + '」'
        : saved && saved.action === 'skip' ? registration ? '已选先不关联，仍待核对' : '已选先不关联计划' : '',
    loading: Boolean(catalogs.planLoading), error: catalogs.planError || '',
    candidates, matchedCount: candidates.filter(item => item.matched).length,
    selectedLoanId: draft.planLoanId || '',
    formLocked: draft.planAction === 'create' && Boolean(draft.planLoanId),
    termsReadonly: Boolean(terms),
    accountCreationText: accountDraft && draft.planAction === 'create'
      ? (draft.planLoanId ? '信用卡已创建' : '会同时创建这张信用卡') + '；放弃导入时信用卡保留。' : '',
    methods: scheduleForm.METHOD_OPTIONS, quotes: scheduleForm.QUOTE_OPTIONS,
    form: { name: draft.planName || '', terms: String(draft.planTerms || ''), principal: draft.planPrincipalInput || '',
      startMonth: draft.planStartMonth || '', methodIndex: draft.planMethodIndex || 0, quoteIndex: draft.planQuoteIndex || 0,
      methodLabel: scheduleForm.METHOD_OPTIONS[draft.planMethodIndex || 0]?.label || '',
      quoteLabel: scheduleForm.QUOTE_OPTIONS[draft.planQuoteIndex || 0]?.label || '',
      ratePercent: draft.planRatePercent || '', firstPaymentDate: draft.planFirstPaymentDate || '' },
    formError: fieldErrors && fieldErrors.plan || ''
  }
}
function planSchedule(draft) {
  const schedule = scheduleForm.payload({ terms: draft.planTerms, methodIndex: draft.planMethodIndex,
    measurementIndex: 0, quoteIndex: draft.planQuoteIndex, ratePercent: draft.planRatePercent,
    firstPaymentDate: draft.planFirstPaymentDate }, draft.planPrincipalInput)
  const first = String(draft.planFirstPaymentDate || '').trim(), date = new Date(first + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || Number(first.slice(0, 4)) < 1000 || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== first) throw Error('请选择有效的首次还款日期')
  if (!schedule || !Number.isSafeInteger(Number(schedule.ratePpm))) throw Error('请填写有效的利率或费率')
  return { ...schedule, firstPaymentDate: first }
}

// 资金路径是「端点组」的列表：付款端、还入端，每组一个标题加一份账户清单。
// composition 退成内部存储，只表示哪一组展开成多账户；界面上不再有单账户/组合支付/多个还入的三选一，
// 两端用同一套「组标题 + 缩进账户行」表达，加账户就是往当前组里追加一行。
// 一次只允许一端是多账户：两端同时多会产生 N×M 的配对，而一笔账只能拆成 N 笔单向交易。
// principalOf 之外的字段顺序、target 命名都沿用 accountFields，事件绑定不需要另开一套。
function fundsEndpointsOf(draft, fields, accounts, { channel, principal, ownership }) {
  const side = draft.composition === 'payment' ? 'payer' : draft.composition === 'repayment' ? 'payee' : ''
  // 只有一个账户时不构成分摊：那一端按单账户显示，另一端也照常可以拆。
  const splitSide = side && draft.parts.length > 1 ? side : ''
  const nameOf = part => (accounts.find(account => account.accountId === part.accountId) || {}).name ||
    part.label || part.name || '原账户已不可用'
  // 组合支付只对支出和还款开放，多个还入只对还款开放；来源组合、分期本金、代还固定单账户。
  const external = ownership && [draft.sourceKind, draft.destinationKind].includes('external')
  const openPayer = !channel && !principal && !external && ['expense', 'repayment'].includes(draft.economicNature)
  const openPayee = !channel && !principal && !external && draft.economicNature === 'repayment'
  const group = (key, field, open) => {
    const multi = side === key
    if (!field && !multi) return null
    const list = multi
      ? draft.parts.map((part, index) => ({ index, target: 'editorPart' + index, accountId: part.accountId || '',
        name: part.accountId ? nameOf(part) : '', amountInput: part.amountInput || '', removable: true, readonly: false, invalid: false }))
      : [{ index: 0, target: field.target, accountId: field.accountId || '', name: field.name, amountInput: '',
        removable: false, readonly: Boolean(field.readonly), invalid: Boolean(field.invalid) }]
    const kind = field && field.ownershipKind
    return { key, label: field ? field.label : key === 'payer' ? '付款账户' : '还入账户', multi, accounts: list,
      ...(field && field.ownershipSide ? { ownershipField: field.ownershipEditable ? field.ownershipSide + 'Kind' : '', ownershipKind: kind,
        ownershipOptions: [{ value: 'ledger', label: '账本账户' }, { value: 'external', label: '账本外账户' }, { value: 'unknown', label: '暂不确定' }] } : {}),
      // 真正在分摊才有金额列：只剩一个账户时总额必然全走它，金额和删除都不必出现。
      split: multi && list.length > 1,
      required: !multi && kind !== 'external' && !list[0].accountId, open,
      // 另一端已经真的拆开时这一端的加号保留位置但不可点，避免两端同时多账户。
      addable: open && (multi ? list.length < 20 : !splitSide) }
  }
  return [group('payer', fields.find(field => ownership ? field.ownershipSide === 'source' : field.key === 'account'), openPayer),
    group('payee', fields.find(field => ownership ? field.ownershipSide === 'destination' : field.key === 'counterparty'), openPayee)].filter(Boolean)
}

function derive(row, draft, catalogs = {}) {
  const errors = [], missing = [], fieldErrors = {}, accounts = catalogs.accounts || [], categories = catalogs.categories || []
  const invalid = (field, message) => {
    errors.push(message)
    if (!(fieldErrors[field] || '').includes(message)) fieldErrors[field] = [fieldErrors[field], message].filter(Boolean).join('；')
  }
  const facts = row.editorFacts, channel = repaymentChannelOf(row), registration = detail.registrationOf(row), supported = Boolean(facts && facts.version === 1 && !facts.readonly)
  const refundConflict = Boolean((row.reasonCodes || []).includes('refund_source_conflict'))
  // 可退金额不足或原关联失效：候选照常给，但状态行要先说清为什么这笔还是待核对，
  // 不能继续挂着“已关联原消费”或“待关联”。
  const refundBlocked = Boolean((row.reasonCodes || []).includes('refund_amount_exceeded')) ? 'amount'
    : Boolean((row.reasonCodes || []).includes('refund_relation_invalid')) ? 'invalid' : ''
  const originalRefund = row.detailFacts && row.detailFacts.refund || null
  const ownership = ownershipEditable(row, draft), ownershipState = ownership ? ownershipPreview(row, draft) : null
  const noLedgerImpact = Boolean(ownershipState && ownershipState.noLedgerImpact)
  const effectiveNature = registration ? 'unknown' : ownershipState ? ownershipState.economicNature : draft.economicNature
  const principal = detail.principalOf(row)
  // 性质在界面上只有一个值：分期来源的三种角色优先，其余行显示当前草稿的经济性质。
  // 分期角色是来源事实，不允许在性质选择里改成支出/收入；经济性质仍决定记账。
  const installment = detail.installmentOf(row)
  const installmentRole = installment && installment.creditStatement === true && ['principal', 'interest', 'fee'].includes(installment.component)
    ? installment.component : ''
  const amount = minor(draft.amountInput)
  if (!draft.amountInput.trim()) missing.push('记账金额')
  else if (amount == null) invalid('amountInput', '金额需为非负数字，最多两位小数，且不超过账本范围')
  const localAt = draft.date && draft.time ? draft.date + ' ' + draft.time : ''
  if (!localAt) missing.push('交易时间')
  else {
    const date = new Date(localAt.replace(' ', 'T') + 'Z')
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(localAt) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 19) !== localAt.replace(' ', 'T') || Number(draft.date.slice(0, 4)) < 1000) invalid('time', '请输入有效日期和时分秒')
  }
  if (effectiveNature === 'unknown' && !registration && !noLedgerImpact) missing.push('交易性质')
  const fields = accountFields(row, draft, accounts)
  const routeFields = draft.composition === 'single' ? fields : fields.filter(field => draft.composition === 'payment' ? field.key === 'counterparty' : field.key === 'account')
  // 建议沿用原银行/尾号规则，只投影到当前草稿的真实付款、还入端，不自动选账户。
  const suggestion = !(ownership && [draft.sourceKind, draft.destinationKind].includes('external')) && draft.composition === 'single' && routeFields.length === 2
    ? bankAccounts.suggest([{ ...row, economicNature: draft.economicNature,
      ledgerAccountId: routeFields[0].accountId, counterpartyLedgerAccountId: routeFields[1].accountId }], accounts)
    : null
  const suggestionField = suggestion && routeFields[suggestion.side === 'from' ? 0 : 1]
  const bankSuggestion = suggestion && (!suggestionField.allowedTypes || suggestionField.allowedTypes.includes(suggestion.type)) && { ...suggestion, target: suggestionField.target,
    key: [suggestion.key, suggestionField.target, ...routeFields.map(field => field.accountId || ''), draft.economicNature].join('|'),
    candidates: suggestion.candidates.filter(account => (!account.currency || account.currency === (row.currency || 'CNY')) &&
      (!suggestionField.allowedTypes || suggestionField.allowedTypes.includes(account.type))) }
  for (const field of routeFields) {
    if (!field.accountId && field.ownershipKind !== 'external') missing.push(field.label)
    if (field.invalid) invalid('funds', field.label + '的账户不可用或类型不符')
  }
  if (ownership && draft.sourceKind === 'external' && draft.destinationKind === 'external' && !draft.noLedgerImpact) missing.push('确认对本账本无影响')
  if (fields.length === 2 && fields[0].accountId && fields[0].accountId === fields[1].accountId) invalid('funds', '两个资金账户必须不同')
  const output = {}, original = create(row)
  // 分期登记必须有计划才能完成；现金借款的计划可暂不关联。新建参数只交给 loans.create，
  // 事件决定仍只记录计划 ID、名称、本金、期数及起始月。
  const disbursement = disbursementOf(row)
  const planDirty = Boolean(disbursement) && PLAN_FIELDS.some(key => draft.dirty[key])
  const planName = String(draft.planName || '').trim().slice(0, 120)
  const planTerms = /^\d+$/.test(String(draft.planTerms || '').trim()) ? Number(String(draft.planTerms).trim()) : null
  const planPrincipal = minor(draft.planPrincipalInput)
  const planStartMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(draft.planStartMonth || '').trim()) ? String(draft.planStartMonth).trim() : ''
  const planAccountId = draft.ledgerAccountId || ''
  const planCandidates = catalogs.planCandidates || []
  const selectedPlan = planCandidates.find(item => item.loanId === draft.planLoanId) || null
  const sourceTerms = sourcePlanTerms(row)
  let planDecision = null, planRequest = null
  if (disbursement && draft.planAction === 'link') {
    if (!planAccountId) invalid('plan', '请先选择这笔分期的所属账户')
    if (draft.planLoanId && sourceTerms && Number(selectedPlan ? selectedPlan.scheduleTerms : planTerms) !== sourceTerms) {
      invalid('plan', '账单为 ' + sourceTerms + ' 期，请选择相同期数的计划')
    }
    if (!draft.planLoanId) invalid('plan', '请选择一个分期计划')
    else planDecision = { action: 'link', loanId: draft.planLoanId,
      planLabel: selectedPlan ? selectedPlan.name : planName,
      totalTerms: selectedPlan ? selectedPlan.scheduleTerms : planTerms || disbursement.totalTerms,
      principalMinor: planPrincipal, startMonth: (selectedPlan && selectedPlan.startMonth) || planStartMonth || null,
      accountId: planAccountId }
  } else if (disbursement && draft.planAction === 'create') {
    if (!planName) invalid('plan', '请填写计划名')
    if (!Number.isInteger(planTerms) || planTerms < 1 || planTerms > 600) invalid('plan', '总期数需为 1～600 的整数')
    if (sourceTerms && planTerms !== sourceTerms) invalid('plan', '账单为 ' + sourceTerms + ' 期，计划期数不符，请重新核对')
    if (planPrincipal == null || planPrincipal === '0') invalid('plan', '本金需为大于零的金额')
    if (!planStartMonth) invalid('plan', '起始月需为 2026-03 这样的年月')
    if (!planAccountId) invalid('plan', '请先选择这笔分期的所属账户')
    let schedule
    if (!draft.planLoanId) {
      const accountDraft = planAccountDraftOf(draft, catalogs)
      let importAccountDraft = null
      if (accountDraft) {
        const snapshotId = typeof catalogs.snapshotId === 'string' ? catalogs.snapshotId.trim() : ''
        const name = String(accountDraft.name || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
        if (!snapshotId) invalid('plan', '尚未读取本批账户资料，请重新打开本次导入后再创建计划')
        if (!name || Array.from(name).length > 32 || accountDraft.type !== 'credit' || accountDraft.currency !== 'CNY') {
          invalid('plan', '本批信用卡资料不完整，请先核对账户名称和类型')
        } else if (snapshotId) importAccountDraft = { snapshotId, name, type: 'credit', currency: 'CNY' }
      }
      try { schedule = planSchedule(draft) } catch (error) { invalid('plan', error.message) }
      if (schedule && (!accountDraft || importAccountDraft)) planRequest = { name: planName, terms: planTerms, principalMinor: planPrincipal,
        startMonth: planStartMonth, accountId: planAccountId, schedule, ...(importAccountDraft ? { importAccountDraft } : {}) }
    }
    if (draft.planLoanId) planDecision = { action: 'create', loanId: draft.planLoanId, planLabel: planName,
      totalTerms: planTerms, principalMinor: planPrincipal, startMonth: planStartMonth, accountId: planAccountId }
  } else if (disbursement && draft.planAction === 'skip') {
    // 暂不关联仍须明确来源信用卡；分期登记继续待核对。
    if (!planAccountId) invalid('plan', '请先选择这笔分期的所属账户')
    planDecision = { action: 'skip', planLabel: planName, totalTerms: planTerms || disbursement.totalTerms || null,
      principalMinor: planPrincipal, startMonth: planStartMonth || null, accountId: planAccountId }
  }
  if (registration && !['link', 'create'].includes(draft.planAction)) missing.push('分期计划')
  if (planDirty && planDecision) output.installmentPlan = planDecision
  if (channel) {
    const fixed = ['economicNature', 'amountInput', 'date', 'time', repaymentTargetKey(row), 'sourceKind', 'destinationKind', 'noLedgerImpact',
      'composition', 'parts', ...LEGACY_REPAYMENT_FIELDS, 'categoryId', 'refund', 'evidenceNote', 'periodInput', 'totalTermsInput']
    if (fixed.some(key => JSON.stringify(draft[key]) !== JSON.stringify(original[key]))) invalid('repaymentChannel', '这组还款的金额、时间和还入账户来自来源；请先修改同笔判断，再分别核对原记录')
  }
  const put = (key, value, before) => { if (value !== before) output[key] = value }
  if (draft.dirty.economicNature || !ownership && effectiveNature !== row.economicNature || (row.reasonCodes || []).includes('row_transaction_type_unknown') && effectiveNature !== 'unknown') output.economicNature = ownership ? draft.economicNature : effectiveNature
  put('ledgerAccountId', draft.ledgerAccountId || null, row.ledgerAccountId || null)
  put('counterpartyLedgerAccountId', (MOVEMENTS.includes(effectiveNature) ? draft.counterpartyLedgerAccountId : '') || null, row.counterpartyLedgerAccountId || null)
  if (amount != null || draft.dirty.amountInput && !draft.amountInput.trim()) put('amountMinor', amount, row.amountMinor == null ? null : String(row.amountMinor))
  if (localAt && localAt !== String(row.localAt || '').slice(0, 19)) {
    output.occurredLocalAt = localAt; output.timezoneOffsetMinutes = facts && facts.timezoneOffsetMinutes
    if (!Number.isInteger(output.timezoneOffsetMinutes)) invalid('time', '原账单时区尚未读取，暂不能修改时间')
  }
  if (!localAt && (draft.dirty.date || draft.dirty.time)) output.occurredLocalAt = null
  for (const key of ['counterparty', 'note']) if (draft.dirty[key]) {
    if (Array.from(draft[key]).length > 200) invalid(key, '记账文本最多 200 字')
    output[key] = draft[key]
  }
  const category = !noLedgerImpact && categoryKind(effectiveNature) ? draft.categoryId || null : null
  put('categoryId', category, row.categoryId || null)
  const selectedCategory = categories.find(item => item.categoryId === category)
  if (selectedCategory && (selectedCategory.archivedAt || selectedCategory.unavailable || selectedCategory.kind !== categoryKind(effectiveNature))) invalid('categoryId', '分类不可用或与交易性质不符')
  if (row.pendingIssue && ['account_mapping','transfer_accounts'].includes(row.pendingIssue.issueType)) {
    if (draft.ledgerAccountId) output.ledgerAccountId = draft.ledgerAccountId
    if (draft.counterpartyLedgerAccountId) output.counterpartyLedgerAccountId = draft.counterpartyLedgerAccountId
  }
  const decisions = {}
  if (channel && channel.confirmed === false) {
    if (draft.repaymentChannelConfirmed === true) decisions.repaymentChannel = { confirmed: true }
    else missing.push('还入账户及手续费确认')
  }
  const ownershipChanged = ['sourceKind', 'destinationKind', 'noLedgerImpact', 'ledgerAccountId', 'counterpartyLedgerAccountId'].some(key => draft.dirty[key])
  if (ownership && (detail.ownershipOf(row).pendingLegacyTreatment || detail.ownershipOf(row).invalid) && !ownershipChanged) missing.push('确认资金两端归属')
  if (!channel && !principal && detail.ownershipOf(row).explicit && draft.dirty.economicNature) decisions.accountOwnership = null
  if (ownership) {
    // 两端只通过这一份决定提交；性质只提交用户的业务选择，收支由共享规则推导。
    delete output.ledgerAccountId
    delete output.counterpartyLedgerAccountId
    if (ownershipChanged) decisions.accountOwnership = ownershipDecision(row, draft)
    if (draft.sourceKind === 'external' && draft.destinationKind === 'external' && !draft.noLedgerImpact && ownershipChanged) {
      invalid('funds', '请确认这笔资金对本账本无影响')
    }
  }
  let composition
  if (draft.composition !== 'single') {
    let sum = 0n, partial = false
    for (const part of draft.parts) {
      if (!part.accountId || minor(part.amountInput) == null) partial = true
      if (part.amountInput && minor(part.amountInput) == null) invalid('composition', '分配金额格式不正确')
      if (draft.composition === 'repayment' && minor(part.amountInput) === '0') invalid('composition', '还入账户分配需大于零')
      if (minor(part.amountInput) != null) sum += BigInt(minor(part.amountInput))
      const account = accounts.find(item => item.accountId === part.accountId)
      const allowed = draft.composition === 'repayment' ? DEBTS : draft.economicNature === 'repayment' ? ASSETS : null
      if (account && (account.archivedAt || allowed && !allowed.includes(account.type))) invalid('composition', '分配账户不可用或类型不符')
      if (part.accountId && routeFields.some(field => field.accountId === part.accountId)) invalid('composition', '付出和收到的账户必须不同')
    }
    if (amount != null && sum > BigInt(amount)) invalid('composition', '分配金额超出总额')
    if (new Set(draft.parts.map(part => part.accountId).filter(Boolean)).size < draft.parts.filter(part => part.accountId).length) invalid('composition', '分配账户不能重复')
    const incomplete = partial || amount == null || sum !== BigInt(amount) || draft.parts.length < (draft.composition === 'payment' ? 2 : 1) ||
      draft.composition === 'payment' && (!draft.evidenceNote.trim() || effectiveNature === 'unknown' || effectiveNature === 'repayment' && !draft.counterpartyLedgerAccountId)
    if (incomplete) missing.push('资金分配')
    composition = { kind: draft.composition, parts: draft.parts.map(part => ({ accountId: part.accountId || null, amountMinor: minor(part.amountInput) })),
      evidenceNote: draft.evidenceNote, incomplete: Boolean(incomplete) }
  } else if (draft.dirty.composition || draft.composition !== original.composition) {
    // 简化成单账户是用户的正当决定：总额不变，只是不再区分各来源分摊。
    // 说明为选填，仅用于留下当时的判断依据，不阻塞保存。
    composition = { kind: 'single', evidenceNote: draft.evidenceNote }
  }
  // 旧草稿里的拆分/计划决定只在用户保存本笔时清除；读取不改写原决定或来源证据。
  const clearLegacyRepayment = Boolean(row.loanRepayment || facts?.incompleteRepayment || row.legacyRepaymentReview)
  if (clearLegacyRepayment) decisions.repayment = null
  const acknowledgedChanges = clearLegacyRepayment
    ? [...new Set([...(draft.acknowledgedChanges || []), 'repayment'])] : draft.acknowledgedChanges
  if (effectiveNature === 'refund' && draft.refund) decisions.refund = draft.refund
  if (effectiveNature === 'refund' && !draft.refund && row.detailFacts?.refund?.status !== 'confirmed' && row.detailFacts?.refund?.status !== 'pending') missing.push('退款关联')
  let sourceCorrection
  if (row.installment && (draft.dirty.periodInput || draft.dirty.totalTermsInput || draft.dirty.planLabel)) {
    sourceCorrection = { periodNumber: draft.periodInput ? Number(draft.periodInput) : null, totalTerms: draft.totalTermsInput ? Number(draft.totalTermsInput) : null,
      // 计划归属只在用户主动选择时才提交，否则每次打开编辑器都会被当成“有修改”。
      ...(draft.dirty.planLabel ? { planLabel: draft.planLabel || null } : {}) }
    for (const [key, value] of Object.entries(sourceCorrection)) {
      if (key === 'planLabel') continue
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 600)) invalid('sourceCorrection', '期次需为 1～600 的整数')
    }
    if (sourceCorrection.periodNumber && sourceCorrection.totalTerms && sourceCorrection.periodNumber > sourceCorrection.totalTerms) invalid('sourceCorrection', '本期期号不能大于总期数')
    if (sourceCorrection.periodNumber === null) missing.push('分期期号')
  }
  if (channel) for (const key of Object.keys(output)) if (![repaymentPayerKey(row), 'counterparty', 'note'].includes(key)) delete output[key]
  if (registration) for (const key of Object.keys(output)) if (!['ledgerAccountId', 'installmentPlan'].includes(key)) delete output[key]
  // 新建计划在拿到 ID 之前不产出 installmentPlan，但动作本身已经是修改，保存要先建计划。
  const changed = Boolean(sourceCorrection) || Object.keys(output).length || Object.keys(decisions).length || Boolean(composition) || planDirty
  const targetName = routeFields.find(field => field.label === '还入账户')?.name || channel?.targetAccountName || '此账户'
  const options = (registration ? [{ value: 'unknown', label: '分期登记' }] : principal ? NATURES.filter(item => PRINCIPAL_NATURES.includes(item.value))
      // 本金行的“还款”在列表里仍叫“分期出账”，与顶部当前值保持一致。
      .map(item => item.value === 'repayment' ? { ...item, label: detail.natureLabel({ ...row, economicNature: 'repayment' }) } : item)
    : channel ? NATURES.filter(item => item.value === 'repayment')
    : NATURES.filter(item => {
      if (draft.composition === 'repayment') return item.value === 'repayment'
      if (draft.composition === 'payment') return ['expense', 'repayment'].includes(item.value)
      return true
    })).map(item => ({ ...item, hint: NATURE_HINTS[item.value] || '' }))
  // 切换后的性质名取自草稿而不是原行，避免选项标签把分期角色当成经济性质显示。
  // 本金行仍是还款时保留“分期出账”这个来源角色名；改判成实际收支后显示经济性质。
  const natureLabel = registration || disbursement ? detail.natureLabel({ ...row, economicNature: draft.economicNature }) : principal
    ? draft.economicNature === 'repayment' ? detail.natureLabel({ ...row, economicNature: 'repayment' }) : detail.natureLabel({ economicNature: draft.economicNature })
    : installmentRole ? detail.natureLabel({ ...row, economicNature: 'repayment' }) : detail.natureLabel({ economicNature: draft.economicNature })
  const evidence = row.primaryEvidence || {}, evidenceTitle = String(evidence.item || '').trim()
  const counterparty = String(draft.counterparty || '').trim()
  return { supported, readonlyReason: facts?.lockedReason || (!facts ? '需更新导入服务后才能编辑' : ''),
    natureOptions: options, natureIndex: Math.max(0, options.findIndex(item => item.value === draft.economicNature)),
    natureLabel, natureEditable: supported && !registration && !channel && (!installmentRole || principal),
    natureFixedHint: registration ? '不生成资金流水' : installmentRole && !principal ? '由分期来源确定' : channel ? '由还款渠道确定' : '',
    // 还款渠道的整组已经由同笔判断定下来，排除半笔会和那条关系打架；这类行只走同笔判断。
    exclude: supported && !registration && !channel && row.pendingIssue ? excludeAction(row.pendingIssue) : null,
    directionClass: registration ? '' : flowClass(effectiveNature),
    // 性质未确定时给性质行一层强调底色，提示这里还没选；定了性质就回到普通表面。
    naturePending: !registration && (!effectiveNature || effectiveNature === 'unknown'),
    routeFields, bankSuggestion,
    // 端点组是资金路径唯一的渲染模型：组标题、账户清单、加号可用性都在这里定，模板不再判 composition。
    fundsEndpoints: fundsEndpointsOf(draft, fields, accounts, { channel: Boolean(channel), principal, ownership }),
    // 真的拆成多还入才提示“多个还入账户”的约束；只有一行时它读起来自相矛盾。
    splitRepayment: draft.composition === 'repayment' && draft.parts.length > 1,
    // 标题只说清这一块是什么：结构切换已经不在界面上，不再需要“资金结构”这个中间态。
    routeTitle: registration || principal ? '分期所属账户' : fields.length > 1 ? '资金路径' : '资金账户',
    repaymentChannel: channel ? { repaymentText: yuan(channel.repaymentMinor), feeText: yuan(channel.feeMinor), totalText: yuan(channel.totalMinor),
      confirmed: channel.confirmed !== false,
      // 还款事实（正文）与需要用户做的动作（细节行）分开：长句折行后末句会被当成注释，
      // 这里把“勾选后保存”单独成行，并与未勾选时的保存按钮一致。
      ...(channel.confirmed === false ? { confirmationText: '确认还入「' + targetName + '」，' +
        (String(channel.feeMinor) === '0' ? '无手续费' : '差额 ¥' + yuan(channel.feeMinor) + ' 为手续费'),
        confirmationAction: '勾选后才能正式入账；不勾选时按钮只保存草稿，这 ¥' + yuan(channel.feeMinor) + ' 既不计手续费也不入账' } : {}) } : null,
    title: registration ? '分期登记' : disbursement && draft.economicNature === 'borrow' ? '现金分期借款' : draft.economicNature === 'repayment' && !principal ? '确认还款' : '核对交易',
    // 摘要卡只放账单事实：标题优先用账单对方，没有时回到账单条目，再没有才显示占位。
    summaryTitle: counterparty || evidenceTitle || '未提供交易对方',
    summaryTitlePlaceholder: !counterparty && !evidenceTitle,
    summaryTime: [draft.date, draft.time.slice(0, 5)].filter(Boolean).join(' '),
    source: !registration && Boolean(row.installment), registration,
    attribution: attributionOf(row, draft, catalogs),
    disbursementPlan: disbursementPlanOf(row, draft, catalogs, fieldErrors),
    // 新建计划的请求参数只在保存时用；拿到计划 ID 前不出现在 payload 里。
    planRequest,
    needsCompositionNote: draft.composition === 'payment' || draft.composition === 'single' && original.composition !== 'single',
    refundOriginalText: (row.detailFacts?.refund?.originals || []).map(item => [item.note, item.localAt, item.amountMinor == null ? '' : '¥' + yuan(item.amountMinor)].filter(Boolean).join(' · ')).join('；'),
    refundCategory: row.detailFacts?.refund?.originals?.[0]?.categoryName || '',
    // 自动关联的退款也要能回看和更换：把已绑定的原消费当成“当前选择”，
    // 与候选卡同一形态展示；原消费被移除时照样要显式确认。
    refundLinked: (row.detailFacts?.refund?.originals || [])[0] ? {
      id: row.detailFacts.refund.originals[0].eventId || row.detailFacts.refund.originals[0].transactionId || '',
      kind: row.detailFacts.refund.originals[0].eventId ? 'event' : 'transaction',
      localAt: row.detailFacts.refund.originals[0].localAt,
      amountMinor: row.detailFacts.refund.originals[0].amountMinor,
      note: row.detailFacts.refund.originals[0].note || '',
      categoryName: row.detailFacts.refund.originals[0].categoryName || '',
      matchKind: row.detailFacts.refund.originals[0].matchKind || '',
      auto: row.detailFacts.refund.autoLinked === true
    } : null,
    accountFields: fields, categoryKind: noLedgerImpact ? '' : categoryKind(effectiveNature), categoryName: selectedCategory?.name || row.categoryId === category && row.categoryName || '',
    showOwnership: ownership, showLoan: false,
    bothExternal: ownership && draft.sourceKind === 'external' && draft.destinationKind === 'external',
    ownershipEffect: ownership ? noLedgerImpact ? '资金两端均在账本外，不生成账目。'
      : effectiveNature !== draft.economicNature ? '按' + detail.natureLabel({ economicNature: effectiveNature }) + '计入账本。' : '' : '',
    refund: effectiveNature === 'refund', principal,
    // 退款区的状态与可用动作由同一份事实派生：模板不再用嵌套三元判断“已选/已关联/待关联”，
    // 也不会出现“按钮灰着但说不出原因”。
    refundStatus: refundView.statusText(originalRefund, draft.refund, { conflict: refundConflict, blocked: refundBlocked,
      candidateCount: catalogs.refundCandidateCount, stale: Boolean(catalogs.refundStale) }),
    refundActions: {
      clear: refundView.clearAction(originalRefund, draft.refund),
      pending: refundView.pendingAction({ conflict: refundConflict,
        draftPending: draft.refund?.mode === 'pending', draftLink: draft.refund?.mode === 'link' })
    },
    // 同订单的原消费已关闭/失败却出现退款成功时，来源本身互相矛盾；
    // 这种退款不能当普通退款去挑原消费，必须从矛盾事项核对原文。
    refundConflict,
    refundBlocked,
    fieldErrors, errors: [...new Set(errors)], missing: [...new Set(missing)], changed: Boolean(changed),
    canSave: supported && Boolean(changed) && errors.length === 0,
    complete: missing.length === 0 && !(facts?.blockingReasons || []).length && !(row.reasonCodes || []).some(reason => ['row_status_unknown','identity_conflict','same_event_candidate','refund_source_conflict','core_fields_conflict'].includes(reason)),
    payload: { editorVersion: 1, fields: output, expectedRelations: facts?.expectedRelations || [], ...(composition ? { composition } : {}),
      ...(Object.keys(decisions).length ? { decisions } : {}), ...(sourceCorrection ? { sourceCorrection } : {}), acknowledgedChanges } }
}
// 结果未知时展示冻结请求的完整值；重试始终发送原 payload，而非重新派生的新请求。
function restore(row, payload) {
  let draft = create(row)
  const fields = payload.fields || {}, decisions = payload.decisions || {}
  if (decisions.repaymentChannel?.confirmed === true && repaymentChannelOf(row)) draft.repaymentChannelConfirmed = true
  if (has(fields, 'economicNature')) draft = change(row, draft, 'economicNature', fields.economicNature)
  const ownership = decisions.ownership
  if (ownership) {
    draft.economicNature = 'repayment'
    draft.destinationKind = ownership.owner === 'other' ? 'external' : 'ledger'
  }
  if (payload.composition) {
    draft.composition = payload.composition.kind
    draft.parts = (payload.composition.parts || []).map(part => ({ ...part, accountId: part.accountId || '', amountInput: yuan(part.amountMinor) }))
    draft.evidenceNote = payload.composition.evidenceNote || ''
  }
  for (const key of ['ledgerAccountId','counterpartyLedgerAccountId','categoryId','counterparty','note']) if (has(fields, key)) draft[key] = fields[key] == null ? '' : fields[key]
  if (decisions.accountOwnership) {
    const keys = ownershipKeys(row, draft.economicNature)
    for (const side of ['source', 'destination']) {
      const endpoint = decisions.accountOwnership[side]
      draft[side + 'Kind'] = endpoint.kind
      draft[keys[side]] = endpoint.kind === 'ledger' ? endpoint.accountId || '' : ''
      draft.dirty[side + 'Kind'] = true
    }
    draft.noLedgerImpact = decisions.accountOwnership.noLedgerImpact === true
  }
  if (has(fields, 'amountMinor')) draft.amountInput = yuan(fields.amountMinor)
  if (has(fields, 'occurredLocalAt')) {
    draft.date = String(fields.occurredLocalAt || '').slice(0, 10)
    draft.time = String(fields.occurredLocalAt || '').slice(11, 19)
  }
  if (has(decisions, 'repayment')) {
    const repayment = decisions.repayment
    // 只为旧冻结请求保留原值；界面不再提供拆分编辑，重试仍使用调用方保存的原 payload。
    draft.repaymentDetails = Boolean(repayment)
    const value = repayment && (repayment.draft || (repayment.mode === 'review'
      ? { ...(row.loanRepayment || {}), ...(row.editorFacts?.incompleteRepayment || {}) } : repayment))
    if (value) {
      draft.loanMode = value.mode === 'associate' ? 'associate' : 'defer'
      draft.loanId = value.loanId || ''; draft.loanVersion = value.loanVersion || 0
      for (const key of ['principal','interest','fee']) draft[key + 'Input'] = yuan(value[key + 'Minor'])
      for (const key of ['interestTreatment','feeTreatment','interestCategoryId','feeCategoryId']) draft[key] = value[key] || ''
      draft.chargeAllocations = (value.chargeAllocations || []).map(part => ({ ...part, amountInput: yuan(part.amountMinor) }))
    }
  }
  if (decisions.refund) draft.refund = { ...decisions.refund }
  // 冻结请求里的分期计划决定也要恢复，重试时原样再发一次同样的决定。
  if (has(fields, 'installmentPlan')) {
    const plan = fields.installmentPlan || {}
    draft.planAction = plan.action || ''
    draft.planLoanId = plan.loanId || ''
    for (const [key, source] of [['planName', 'planLabel'], ['planTerms', 'totalTerms'], ['planPrincipalInput', 'principalMinor'], ['planStartMonth', 'startMonth']]) {
      if (plan[source] == null) continue
      draft[key] = key === 'planPrincipalInput' ? yuan(plan[source]) : String(plan[source])
    }
    draft.dirty = { ...draft.dirty, planAction: true, planLoanId: true }
  }
  // 计划归属要连“已改动”一起恢复，否则重试前再编辑会把这个选择丢掉。
  if (payload.sourceCorrection && has(payload.sourceCorrection, 'planLabel')) {
    draft.planLabel = payload.sourceCorrection.planLabel || ''
    draft.dirty = { ...draft.dirty, planLabel: true }
  }
  if (payload.sourceCorrection) for (const [key, field] of [['periodNumber','periodInput'], ['totalTerms','totalTermsInput']]) {
    if (has(payload.sourceCorrection, key)) draft[field] = payload.sourceCorrection[key] == null ? '' : String(payload.sourceCorrection[key])
  }
  draft.acknowledgedChanges = payload.acknowledgedChanges || []
  return draft
}
module.exports = { create, restore, change, derive, accountFields, NATURES, ASSETS, DEBTS, categoryKind, minor, yuan, planSchedule }
