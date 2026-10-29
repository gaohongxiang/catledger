// 交易草稿纯模型。入口/问题类型不决定字段，目录只保存稳定 ID。
const detail = require('./detail-fields')
const bankAccounts = require('./bank-suggestion')
const refundView = require('./refund-state')
const has = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const MOVEMENTS = ['internal_transfer', 'borrow', 'repayment']
const ASSETS = ['cash', 'bank', 'wallet', 'other_asset'], DEBTS = ['credit', 'other_liability']
const NATURES = ['expense', 'income', 'refund', 'internal_transfer', 'repayment', 'borrow', 'fee', 'unknown']
  .map(value => ({ value, label: detail.natureLabel({ economicNature: value }) }))
// 分期本金行可以改判经济性质：默认“还款”只登记来源；支出、费用、收入会形成实际流水；
// 暂不确定保留来源但不入账。退款、内部转账和借款需要原消费关系或第二个账户，不由本金行直接改判。
const PRINCIPAL_NATURES = ['repayment', 'expense', 'fee', 'income', 'unknown']
// 性质切换列表只解释“换成这个模式后是什么”，不重复字段说明；实际保留/失效仍由第 5 节的切换规则决定。
const NATURE_HINTS = Object.freeze({ expense: '日常消费、付款', income: '工资、收款', refund: '退回原消费',
  internal_transfer: '自己账户之间', repayment: '信用卡、贷款', borrow: '借款到账', fee: '手续费、服务费', unknown: '先留待核对' })
const categoryKind = nature => nature === 'income' ? 'income' : ['expense', 'fee'].includes(nature) ? 'expense' : ''
// 与 cloudfunctions semantic-plan-upgrade 的 flowDirection 重算规则同源：
// 转账类不计收支（中性墨色），收入退款为流入（绿），其余含“暂不确定”为流出（红）。
const flowClass = nature => ['repayment', 'borrow', 'internal_transfer'].includes(nature) ? ''
  : ['income', 'refund'].includes(nature) ? 'row-income' : 'row-expense'
const repaymentChannelOf = row => row.repaymentChannel || row.editorFacts?.repaymentChannel || null
const repaymentTargetKey = row => row.sourceDirection === 'income' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId'
const repaymentPayerKey = row => row.sourceDirection === 'income' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
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
// 处理方式用三句人话，不再用“补记／清偿”这类账务术语：
// 现在记一笔支出、以前记过所以只冲抵、或者拿不准先留待核对。
const treatmentLabel = value => value === 'expense' ? '没记过，记一笔' : value === 'accrued' ? '记过，只冲抵' : '待核对'
// 只有填了大于零的金额才需要问“这笔费用记过没有”；留空是未知，填 0 是没有这一项。
const positive = value => { const current = minor(value); return current != null && current !== '0' }
function create(row) {
  const source = row.primaryEvidence || {}, facts = row.editorFacts || {}, loan = { ...(row.loanRepayment || {}), ...(row.editorFacts?.incompleteRepayment || {}) }
  const channel = repaymentChannelOf(row)
  const ownership = row.repaymentOwnership || facts.ownership || {}
  const parts = facts.incompleteComposition ? facts.incompleteComposition.parts : row.paymentResolution ? row.paymentResolution.allocations : facts.composition === 'repayment' ? row.repaymentAllocations || []
    : (row.paymentComponents || []).map((part, componentIndex) => ({ ...part, componentIndex }))
      .filter(part => part.componentKind === 'financial').map(part => ({ ...part,
        ...((row.paymentResolution && row.paymentResolution.allocations || []).find(value => value.componentIndex === part.componentIndex) ||
          (row.paymentAccounts || []).find(value => value.componentIndex === part.componentIndex) || {}) }))
  const draft = { economicNature: ownership.owner === 'other' ? 'repayment'
      : detail.principalOf(row) ? (PRINCIPAL_NATURES.includes(row.economicNature) ? row.economicNature : 'repayment') : row.economicNature,
    ledgerAccountId: row.ledgerAccountId || '', counterpartyLedgerAccountId: detail.principalOf(row) ? '' : row.counterpartyLedgerAccountId || '',
    amountInput: yuan(row.amountMinor), date: String(row.localAt || '').slice(0, 10), time: String(row.localAt || '').slice(11, 19),
    counterparty: (has(row, 'counterparty') ? row.counterparty : source.counterparty || '').slice(0, 200),
    note: (has(row, 'note') ? row.note : source.note || '').slice(0, 200), categoryId: row.categoryId || '',
    owner: ownership.owner || 'self', otherTreatment: ownership.treatment || '',
    // 明细是可选的：已有还款决定或分项金额时才展开；否则整笔记为还款本金。
    repaymentDetails: Boolean(loan.mode) || ['principalMinor', 'interestMinor', 'feeMinor'].some(key => has(loan, key)),
    loanMode: loan.mode === 'associate' ? 'associate' : 'defer', loanId: loan.loanId || '', loanVersion: loan.loanVersion || 0,
    principalInput: yuan(loan.principalMinor), interestInput: yuan(loan.interestMinor), feeInput: yuan(loan.feeMinor),
    // 没有保存过的处理方式默认“没记过，记一笔”：填了金额就能直接往下走，以前记过再改。
    // 已保存的空值表示用户明确选了“待核对”，不能拿默认值覆盖。
    interestTreatment: has(loan, 'interestTreatment') ? loan.interestTreatment || '' : 'expense',
    feeTreatment: has(loan, 'feeTreatment') ? loan.feeTreatment || '' : 'expense',
    interestCategoryId: loan.interestCategoryId || '', feeCategoryId: loan.feeCategoryId || '',
    chargeAllocations: (loan.chargeAllocations || []).map(part => ({ ...part, amountInput: yuan(part.amountMinor) })),
    composition: facts.composition || 'single', parts: parts.map(part => ({ ...part, accountId: part.accountId || '', amountInput: yuan(part.amountMinor) })),
    evidenceNote: facts.incompleteComposition?.evidenceNote || row.paymentResolution?.evidenceNote || facts.evidenceNote || '',
    periodInput: String(row.installment?.periodNumber || ''), totalTermsInput: String(row.installment?.totalTerms || ''),
    // 计划归属：空表示用户没有改动；只在用户主动选择时才进入 sourceCorrection。
    planLabel: '',
    refund: null, dirty: {}, dormant: {}, acknowledgedChanges: [] }
  if (channel) Object.assign(draft, { economicNature: 'repayment', amountInput: yuan(channel.totalMinor),
    [repaymentTargetKey(row)]: channel.targetAccountId, owner: 'self', composition: 'single', parts: [], repaymentDetails: false,
    repaymentChannelConfirmed: channel.confirmed !== false })
  // 端点组一定有账户行：服务端可能声明了多账户组成却还没给任何分配（未完成组成），
  // 旧版本删到 0 条的草稿也是这个形态。留一条空行，端点组就不会只剩标题。
  if (draft.composition !== 'single' && !draft.parts.length) draft.parts = [{ accountId: '', amountInput: '' }]
  return draft
}
function change(row, draft, key, value) {
  const channel = repaymentChannelOf(row)
  if (key === 'repaymentChannelConfirmed' && (!channel || channel.confirmed !== false || typeof value !== 'boolean')) return draft
  if (channel && ![repaymentPayerKey(row), 'counterparty', 'note', 'acknowledgedChanges', 'repaymentChannelConfirmed'].includes(key)) return draft
  const next = { ...draft, dirty: { ...draft.dirty, [key]: true }, dormant: { ...draft.dormant } }
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
      next.counterpartyLedgerAccountId = ''
    } else if (!MOVEMENTS.includes(draft.economicNature) && MOVEMENTS.includes(value)) {
      next.counterpartyLedgerAccountId = next.dormant.counterpartyLedgerAccountId || ''
    }
    next.refund = null
  }
  if (key === 'owner') {
    if (value === 'other') {
      const labels = detail.accountLabels({ ...row, economicNature: 'repayment', editorComposition: draft.composition })
      next.dormant.selfAccounts = { ledgerAccountId: draft.ledgerAccountId, counterpartyLedgerAccountId: draft.counterpartyLedgerAccountId,
        composition: draft.composition, parts: draft.parts }
      next.ledgerAccountId = draft.composition === 'payment' ? '' : labels.reverse ? draft.counterpartyLedgerAccountId : draft.ledgerAccountId
      next.counterpartyLedgerAccountId = ''
      next.composition = 'single'; next.parts = []
    } else if (next.dormant.selfAccounts) Object.assign(next, next.dormant.selfAccounts)
    else if (row.sourceDirection === 'income' && draft.composition === 'single') {
      next.ledgerAccountId = ''; next.counterpartyLedgerAccountId = draft.ledgerAccountId
    }
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
  return next
}
function accountFields(row, draft, catalog) {
  const channel = repaymentChannelOf(row)
  const other = draft.economicNature === 'repayment' && draft.owner === 'other'
  const projected = { ...row, economicNature: other ? 'expense' : draft.economicNature,
    ledgerAccountId: draft.ledgerAccountId, counterpartyLedgerAccountId: draft.counterpartyLedgerAccountId, editorComposition: draft.composition }
  return detail.accountFields(projected).map(field => {
    let allowedTypes = null
    if (other || field.label === '付款账户' && draft.economicNature === 'repayment' || field.label === '到账账户') allowedTypes = ASSETS
    // 还款的收款端统一是负债账户：信用卡和贷款都从同一入口选，是否有关联计划由还款构成决定。
    if (field.label === '还入账户' || field.label === '借款负债账户') allowedTypes = DEBTS
    if (detail.principalOf(row)) allowedTypes = ['credit']
    const account = catalog.find(item => item.accountId === field.accountId)
    const readonly = Boolean(channel && field.label === '还入账户')
    return { ...field, target: readonly ? '' : field.key === 'account' ? 'reviewAccount' : 'reviewCounterparty', allowedTypes, readonly,
      name: account ? account.name : field.accountId ? '账户名称待读取' : '',
      invalid: Boolean(account && (account.archivedAt || account.unavailable || allowedTypes && !allowedTypes.includes(account.type))) }
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
  return { role: 'charge', required: !selected, selected: Boolean(selected),
    plans: attribution.plans.map(item => ({ planName: item.planName,
      amountText: item.amountMinor == null || item.amountMinor === '' ? '' : '¥' + yuan(item.amountMinor),
      selected: item.planName === selected })) }
}

// 资金路径是「端点组」的列表：付款端、还入端，每组一个标题加一份账户清单。
// composition 退成内部存储，只表示哪一组展开成多账户；界面上不再有单账户/组合支付/多个还入的三选一，
// 两端用同一套「组标题 + 缩进账户行」表达，加账户就是往当前组里追加一行。
// 一次只允许一端是多账户：两端同时多会产生 N×M 的配对，而一笔账只能拆成 N 笔单向交易。
// principalOf 之外的字段顺序、target 命名都沿用 accountFields，事件绑定不需要另开一套。
function fundsEndpointsOf(draft, fields, accounts, { channel, principal, other }) {
  const side = draft.composition === 'payment' ? 'payer' : draft.composition === 'repayment' ? 'payee' : ''
  // 只有一个账户时不构成分摊：那一端按单账户显示，另一端也照常可以拆。
  const splitSide = side && draft.parts.length > 1 ? side : ''
  const nameOf = part => (accounts.find(account => account.accountId === part.accountId) || {}).name ||
    part.label || part.name || '原账户已不可用'
  // 组合支付只对支出和还款开放，多个还入只对还款开放；来源组合、分期本金、代还固定单账户。
  const openPayer = !channel && !principal && !other && ['expense', 'repayment'].includes(draft.economicNature)
  const openPayee = !channel && !principal && !other && draft.economicNature === 'repayment'
  const group = (key, field, open) => {
    const multi = side === key
    if (!field && !multi) return null
    const list = multi
      ? draft.parts.map((part, index) => ({ index, target: 'editorPart' + index, accountId: part.accountId || '',
        name: part.accountId ? nameOf(part) : '', amountInput: part.amountInput || '', removable: true, readonly: false, invalid: false }))
      : [{ index: 0, target: field.target, accountId: field.accountId || '', name: field.name, amountInput: '',
        removable: false, readonly: Boolean(field.readonly), invalid: Boolean(field.invalid) }]
    return { key, label: field ? field.label : key === 'payer' ? '付款账户' : '还入账户', multi, accounts: list,
      // 真正在分摊才有金额列：只剩一个账户时总额必然全走它，金额和删除都不必出现。
      split: multi && list.length > 1,
      required: !multi && !list[0].accountId, open,
      // 另一端已经真的拆开时这一端的加号保留位置但不可点，避免两端同时多账户。
      addable: open && (multi ? list.length < 20 : !splitSide) }
  }
  return [group('payer', fields.find(field => field.key === 'account'), openPayer),
    group('payee', fields.find(field => field.key === 'counterparty'), openPayee)].filter(Boolean)
}

function derive(row, draft, catalogs = {}) {
  const errors = [], missing = [], fieldErrors = {}, accounts = catalogs.accounts || [], categories = catalogs.categories || []
  const invalid = (field, message) => {
    errors.push(message)
    if (!(fieldErrors[field] || '').includes(message)) fieldErrors[field] = [fieldErrors[field], message].filter(Boolean).join('；')
  }
  const facts = row.editorFacts, channel = repaymentChannelOf(row), supported = Boolean(facts && facts.version === 1 && !facts.readonly)
  const refundConflict = Boolean((row.reasonCodes || []).includes('refund_source_conflict'))
  // 可退金额不足或原关联失效：候选照常给，但状态行要先说清为什么这笔还是待核对，
  // 不能继续挂着“已关联原消费”或“待关联”。
  const refundBlocked = Boolean((row.reasonCodes || []).includes('refund_amount_exceeded')) ? 'amount'
    : Boolean((row.reasonCodes || []).includes('refund_relation_invalid')) ? 'invalid' : ''
  const originalRefund = row.detailFacts && row.detailFacts.refund || null
  const other = draft.economicNature === 'repayment' && draft.owner === 'other'
  const effectiveNature = other ? draft.otherTreatment === 'expense' ? 'expense' : 'unknown' : draft.economicNature
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
  if (effectiveNature === 'unknown') missing.push('交易性质')
  const fields = accountFields(row, draft, accounts)
  const payee = fields[1] && accounts.find(item => item.accountId === fields[1].accountId)
  const creditPayee = Boolean(payee && payee.type === 'credit')
  // 只有收款端确实是贷款账户时才谈“关联计划”；信用卡和未确定账户都不显示这一组。
  // 信用卡和其他负债都能持有分期/贷款计划，计划目录再按收款账户过滤。
  const loanPayee = Boolean(payee && DEBTS.includes(payee.type))
  const routeFields = draft.composition === 'single' ? fields : fields.filter(field => draft.composition === 'payment' ? field.key === 'counterparty' : field.key === 'account')
  // 建议沿用原银行/尾号规则，只投影到当前草稿的真实付款、还入端，不自动选账户。
  const suggestion = !other && draft.composition === 'single' && routeFields.length === 2
    ? bankAccounts.suggest([{ ...row, economicNature: draft.economicNature,
      ledgerAccountId: routeFields[0].accountId, counterpartyLedgerAccountId: routeFields[1].accountId }], accounts)
    : null
  const suggestionField = suggestion && routeFields[suggestion.side === 'from' ? 0 : 1]
  const bankSuggestion = suggestion && (!suggestionField.allowedTypes || suggestionField.allowedTypes.includes(suggestion.type)) && { ...suggestion, target: suggestionField.target,
    key: [suggestion.key, suggestionField.target, ...routeFields.map(field => field.accountId || ''), draft.economicNature].join('|'),
    candidates: suggestion.candidates.filter(account => (!account.currency || account.currency === (row.currency || 'CNY')) &&
      (!suggestionField.allowedTypes || suggestionField.allowedTypes.includes(account.type))) }
  for (const field of routeFields) {
    if (!field.accountId) missing.push(field.label)
    if (field.invalid) invalid('funds', field.label + '的账户不可用或类型不符')
  }
  if (fields.length === 2 && fields[0].accountId && fields[0].accountId === fields[1].accountId) invalid('funds', '两个资金账户必须不同')
  const output = {}, original = create(row)
  if (channel) {
    const fixed = ['economicNature', 'amountInput', 'date', 'time', repaymentTargetKey(row), 'owner', 'otherTreatment',
      'composition', 'parts', 'repaymentDetails', 'loanMode', 'loanId', 'loanVersion', 'principalInput', 'interestInput', 'feeInput',
      'interestTreatment', 'feeTreatment', 'interestCategoryId', 'feeCategoryId', 'chargeAllocations', 'categoryId', 'refund', 'evidenceNote', 'periodInput', 'totalTermsInput']
    if (fixed.some(key => JSON.stringify(draft[key]) !== JSON.stringify(original[key]))) invalid('repaymentChannel', '这组还款的金额、时间和还入账户来自来源；请先修改同笔判断，再分别核对原记录')
  }
  const put = (key, value, before) => { if (value !== before) output[key] = value }
  if (draft.dirty.economicNature || effectiveNature !== row.economicNature || (row.reasonCodes || []).includes('row_transaction_type_unknown') && effectiveNature !== 'unknown') output.economicNature = effectiveNature
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
  const category = categoryKind(effectiveNature) ? draft.categoryId || null : null
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
  if (!channel && !principal && row.repaymentOwnership && draft.economicNature !== 'repayment' && draft.dirty.economicNature) decisions.ownership = null
  if (!channel && draft.economicNature === 'repayment' && !principal && (draft.owner !== original.owner || draft.dirty.owner || draft.dirty.otherTreatment ||
    draft.dirty.economicNature || !row.repaymentOwnership && effectiveNature === 'repayment')) {
    decisions.ownership = { owner: draft.owner, ...(other ? { treatment: draft.otherTreatment } : {}) }
    if (other && !['expense', 'pending'].includes(draft.otherTreatment)) { delete decisions.ownership; missing.push('代还处理方式') }
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
  if (!channel && draft.economicNature === 'repayment' && !principal && !other && draft.composition === 'single' && draft.repaymentDetails) {
    const loanMode = draft.loanMode
    // 与服务端 settle 同一条规则：关联了计划，或收款端本来就是贷款账户，这次才落贷款付款记录。
    const persistsLoanPayment = loanMode === 'associate' || payee && payee.type === 'other_liability'
    const chargeAllocations = loanMode === 'associate' ? draft.chargeAllocations.map(part => {
      const value = minor(part.amountInput == null ? yuan(part.amountMinor) : part.amountInput)
      if (value == null || value === '0') invalid('repayment', '费用清偿金额需为大于零的有效金额')
      return { chargeId: part.chargeId, component: part.component, amountMinor: value }
    }) : []
    for (const key of ['principal', 'interest', 'fee']) if (draft[key + 'Input'].trim() && minor(draft[key + 'Input']) == null) invalid('repayment', '本息费金额格式不正确')
    const values = ['principal', 'interest', 'fee'].map(key => minor(draft[key + 'Input']))
    if (amount != null && values.filter(value => value != null).reduce((sum, value) => sum + BigInt(value), 0n) > BigInt(amount)) invalid('repayment', '已填本息费不能超过付款总额')
    // 未知分项、未选处理方式都只是“待核对”；明确填 0 才算没有这一项。
    const treatmentIncomplete = ['interest', 'fee'].some(key => {
      const value = minor(draft[key + 'Input'])
      if (value == null || value === '0') return false
      const treatment = draft[key + 'Treatment']
      if (treatment === 'expense') return !draft[key + 'CategoryId']
      if (treatment !== 'accrued') return true
      // 不落付款记录时（信用卡未关联计划），已记费用只计入转账；要冲抵的必须有收费项。
      if (!persistsLoanPayment) return false
      const allocated = chargeAllocations.filter(part => part.component === key && part.amountMinor != null)
        .reduce((sum, part) => sum + BigInt(part.amountMinor), 0n)
      return loanMode !== 'associate' || !draft.loanId || allocated !== BigInt(value)
    })
    const incompleteLoan = values.some(value => value == null) || amount == null || fields.some(field => !field.accountId) ||
      loanMode === 'associate' && !draft.loanId || treatmentIncomplete
    if (values.every(value => value != null) && amount != null && values.reduce((sum, value) => sum + BigInt(value), 0n) !== BigInt(amount)) invalid('repayment', '本金、利息和费用合计必须等于付款总额')
    if (incompleteLoan) {
      decisions.repayment = { mode: 'review', draft: { principalMinor: values[0], interestMinor: values[1], feeMinor: values[2],
        mode: loanMode, loanId: loanMode === 'associate' ? draft.loanId || null : null, loanVersion: loanMode === 'associate' ? draft.loanVersion || null : null,
        interestTreatment: draft.interestTreatment || null, feeTreatment: draft.feeTreatment || null,
        interestCategoryId: draft.interestTreatment === 'expense' ? draft.interestCategoryId || null : null,
        feeCategoryId: draft.feeTreatment === 'expense' ? draft.feeCategoryId || null : null, chargeAllocations } }; missing.push('还款本息费')
    } else {
      const treatments = {}
      for (const key of ['interest', 'fee']) {
        const value = minor(draft[key + 'Input'])
        // 0 是明确没有；未知已在上面的不完整分支，不会走到确认。
        const treatment = value === '0' ? 'expense' : draft[key + 'Treatment']
        treatments[key + 'Treatment'] = treatment
        treatments[key + 'CategoryId'] = treatment === 'expense' && value !== '0' ? draft[key + 'CategoryId'] || null : null
        if (treatment === 'expense' && value !== '0' && !draft[key + 'CategoryId']) invalid('repayment', '请选择利息／费用的支出分类')
      }
      decisions.repayment = { confirmed: true, mode: loanMode, assetAccountId: fields[0]?.accountId,
        liabilityAccountId: fields[1]?.accountId, principalMinor: values[0], interestMinor: values[1], feeMinor: values[2],
        chargeAllocations,
        ...(loanMode === 'associate' ? { loanId: draft.loanId, loanVersion: draft.loanVersion } : {}), ...treatments }
      for (const key of ['interest', 'fee']) {
        const index = key === 'interest' ? 1 : 2
        const allocated = chargeAllocations.filter(part => part.component === key && part.amountMinor != null).reduce((sum, part) => sum + BigInt(part.amountMinor), 0n)
        if (allocated > BigInt(values[index])) invalid('repayment', '费用清偿分配超出对应分项')
        // 会落付款记录时就要逐项冲抵收费项；信用卡未关联计划时只是一次转账，不要求收费项。
        if (draft[key + 'Treatment'] === 'accrued' && persistsLoanPayment && allocated !== BigInt(values[index])) invalid('repayment', '选「记过，只冲抵」时要选全对应的收费项')
      }
    }
  } else if (!channel && draft.economicNature === 'repayment' && !principal && !other && draft.composition === 'single' &&
      !draft.repaymentDetails && loanPayee && draft.loanMode === 'associate') {
    // 不展开明细也能关联计划：整笔都记为本金，利息和手续费此时是 0。
    const assetAccountId = fields[0]?.accountId, liabilityAccountId = fields[1]?.accountId
    if (amount == null) missing.push('还款金额')
    if (!draft.loanId || !draft.loanVersion) missing.push('贷款计划')
    if (!assetAccountId || !liabilityAccountId) missing.push('还款账户')
    decisions.repayment = assetAccountId && liabilityAccountId && amount != null && draft.loanId && draft.loanVersion
      ? { confirmed: true, mode: 'associate', assetAccountId, liabilityAccountId, principalMinor: amount,
        interestMinor: '0', feeMinor: '0', chargeAllocations: [], loanId: draft.loanId, loanVersion: draft.loanVersion }
      : { mode: 'review', draft: { principalMinor: amount, interestMinor: null, feeMinor: null,
        mode: 'associate', loanId: draft.loanId || null, loanVersion: draft.loanVersion || null,
        interestTreatment: null, feeTreatment: null, interestCategoryId: null, feeCategoryId: null, chargeAllocations: [] } }
  } else if (!channel && row.loanRepayment && (draft.dirty.repaymentDetails || draft.dirty.economicNature || draft.dirty.owner || draft.dirty.composition)) decisions.repayment = null
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
  const changed = Boolean(sourceCorrection) || Object.keys(output).length || Object.keys(decisions).length || Boolean(composition)
  const targetName = routeFields.find(field => field.label === '还入账户')?.name || channel?.targetAccountName || '此账户'
  const options = (principal ? NATURES.filter(item => PRINCIPAL_NATURES.includes(item.value))
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
  const natureLabel = principal
    ? draft.economicNature === 'repayment' ? detail.natureLabel({ ...row, economicNature: 'repayment' }) : detail.natureLabel({ economicNature: draft.economicNature })
    : installmentRole ? detail.natureLabel({ ...row, economicNature: 'repayment' }) : detail.natureLabel({ economicNature: draft.economicNature })
  const evidence = row.primaryEvidence || {}, evidenceTitle = String(evidence.item || '').trim()
  const counterparty = String(draft.counterparty || '').trim()
  return { supported, chargeRows: draft.chargeAllocations.map((part, index) => ({ ...part, index, amountInput: part.amountInput == null ? yuan(part.amountMinor) : part.amountInput })), readonlyReason: facts?.lockedReason || (!facts ? '需更新导入服务后才能编辑' : ''),
    natureOptions: options, natureIndex: Math.max(0, options.findIndex(item => item.value === draft.economicNature)),
    natureLabel, natureEditable: supported && !channel && (!installmentRole || principal),
    natureFixedHint: installmentRole && !principal ? '由分期来源确定' : channel ? '由还款渠道确定' : '',
    directionClass: flowClass(effectiveNature),
    // 性质未确定时给性质行一层强调底色，提示这里还没选；定了性质就回到普通表面。
    naturePending: !effectiveNature || effectiveNature === 'unknown',
    routeFields, bankSuggestion,
    // 端点组是资金路径唯一的渲染模型：组标题、账户清单、加号可用性都在这里定，模板不再判 composition。
    fundsEndpoints: fundsEndpointsOf(draft, fields, accounts, { channel: Boolean(channel), principal, other }),
    // 真的拆成多还入才提示“多个还入账户”的约束；只有一行时它读起来自相矛盾。
    splitRepayment: draft.composition === 'repayment' && draft.parts.length > 1,
    // 标题只说清这一块是什么：结构切换已经不在界面上，不再需要“资金结构”这个中间态。
    routeTitle: principal ? '分期所属账户' : fields.length > 1 ? '资金路径' : '资金账户',
    repaymentChannel: channel ? { repaymentText: yuan(channel.repaymentMinor), feeText: yuan(channel.feeMinor), totalText: yuan(channel.totalMinor),
      confirmed: channel.confirmed !== false,
      // 还款事实（正文）与需要用户做的动作（细节行）分开：长句折行后末句会被当成注释，
      // 这里把“勾选后保存”单独成行，并与未勾选时的保存按钮一致。
      ...(channel.confirmed === false ? { confirmationText: '确认还入「' + targetName + '」，' +
        (String(channel.feeMinor) === '0' ? '无手续费' : '差额 ¥' + yuan(channel.feeMinor) + ' 为手续费'),
        confirmationAction: '勾选后才能正式入账；不勾选时按钮只保存草稿，这 ¥' + yuan(channel.feeMinor) + ' 既不计手续费也不入账' } : {}) } : null,
    title: draft.economicNature === 'repayment' && !principal ? '确认还款' : '核对交易',
    // 摘要卡只放账单事实：标题优先用账单对方，没有时回到账单条目，再没有才显示占位。
    summaryTitle: counterparty || evidenceTitle || '未提供交易对方',
    summaryTitlePlaceholder: !counterparty && !evidenceTitle,
    summaryTime: [draft.date, draft.time.slice(0, 5)].filter(Boolean).join(' '),
    source: Boolean(row.installment),
    attribution: attributionOf(row, draft, catalogs),
    needsCompositionNote: draft.composition === 'payment' || draft.composition === 'single' && original.composition !== 'single',
    loanFields: ['principal','interest','fee'].map((key, index) => ({ key: key + 'Input', label: ['本金','利息','费用'][index], value: draft[key + 'Input'] })),
    interestTreatmentLabel: treatmentLabel(draft.interestTreatment), feeTreatmentLabel: treatmentLabel(draft.feeTreatment),
    interestPositive: positive(draft.interestInput), feePositive: positive(draft.feeInput), creditPayee, loanPayee,
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
    interestCategoryName: categories.find(item => item.categoryId === draft.interestCategoryId)?.name || '',
    feeCategoryName: categories.find(item => item.categoryId === draft.feeCategoryId)?.name || '',
    accountFields: fields, categoryKind: categoryKind(effectiveNature), categoryName: selectedCategory?.name || row.categoryId === category && row.categoryName || '',
    showOwnership: draft.economicNature === 'repayment' && !principal, other, showLoan: !channel && draft.economicNature === 'repayment' && !principal && !other && draft.composition === 'single',
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
      ...(Object.keys(decisions).length ? { decisions } : {}), ...(sourceCorrection ? { sourceCorrection } : {}), acknowledgedChanges: draft.acknowledgedChanges } }
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
    draft = change(row, draft, 'owner', ownership.owner)
    if (ownership.treatment) draft.otherTreatment = ownership.treatment
  }
  if (payload.composition) {
    draft.composition = payload.composition.kind
    draft.parts = (payload.composition.parts || []).map(part => ({ ...part, accountId: part.accountId || '', amountInput: yuan(part.amountMinor) }))
    draft.evidenceNote = payload.composition.evidenceNote || ''
  }
  for (const key of ['ledgerAccountId','counterpartyLedgerAccountId','categoryId','counterparty','note']) if (has(fields, key)) draft[key] = fields[key] == null ? '' : fields[key]
  if (has(fields, 'amountMinor')) draft.amountInput = yuan(fields.amountMinor)
  if (has(fields, 'occurredLocalAt')) {
    draft.date = String(fields.occurredLocalAt || '').slice(0, 10)
    draft.time = String(fields.occurredLocalAt || '').slice(11, 19)
  }
  if (has(decisions, 'repayment')) {
    const repayment = decisions.repayment
    // 有还款决定就展开明细；null 表示用户收起并同意解除。
    draft.repaymentDetails = Boolean(repayment)
    // {mode:'review'} 只表示“仍是待核对”，没有 draft 时沿用行上已经填好的明细。
    const value = repayment && (repayment.draft || (repayment.mode === 'review' ? null : repayment))
    if (value) {
      if (['defer','associate'].includes(value.mode)) draft.loanMode = value.mode
      draft.loanId = value.loanId || ''; draft.loanVersion = value.loanVersion || 0
      for (const key of ['principal','interest','fee']) draft[key + 'Input'] = yuan(value[key + 'Minor'])
      for (const key of ['interestTreatment','feeTreatment','interestCategoryId','feeCategoryId']) draft[key] = value[key] || ''
      draft.chargeAllocations = (value.chargeAllocations || []).map(part => ({ ...part, amountInput: yuan(part.amountMinor) }))
    }
  }
  if (decisions.refund) draft.refund = { ...decisions.refund }
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
module.exports = { create, restore, change, derive, accountFields, NATURES, ASSETS, DEBTS, categoryKind, minor, yuan }
