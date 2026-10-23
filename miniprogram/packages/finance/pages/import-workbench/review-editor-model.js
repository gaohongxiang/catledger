// 交易草稿纯模型。入口/问题类型不决定字段，目录只保存稳定 ID。
const detail = require('./detail-fields')
const bankAccounts = require('./bank-suggestion')
const has = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const MOVEMENTS = ['internal_transfer', 'borrow', 'repayment']
const ASSETS = ['cash', 'bank', 'wallet', 'other_asset'], DEBTS = ['credit', 'other_liability']
const NATURES = ['expense', 'income', 'refund', 'internal_transfer', 'repayment', 'borrow', 'fee', 'unknown']
  .map(value => ({ value, label: detail.natureLabel({ economicNature: value }) }))
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
function create(row) {
  const source = row.primaryEvidence || {}, facts = row.editorFacts || {}, loan = { ...(row.loanRepayment || {}), ...(row.editorFacts?.incompleteRepayment || {}) }
  const channel = repaymentChannelOf(row)
  const ownership = row.repaymentOwnership || facts.ownership || {}
  const parts = facts.incompleteComposition ? facts.incompleteComposition.parts : row.paymentResolution ? row.paymentResolution.allocations : facts.composition === 'repayment' ? row.repaymentAllocations || []
    : (row.paymentComponents || []).map((part, componentIndex) => ({ ...part, componentIndex }))
      .filter(part => part.componentKind === 'financial').map(part => ({ ...part,
        ...((row.paymentResolution && row.paymentResolution.allocations || []).find(value => value.componentIndex === part.componentIndex) ||
          (row.paymentAccounts || []).find(value => value.componentIndex === part.componentIndex) || {}) }))
  const draft = { economicNature: detail.principalOf(row) || ownership.owner === 'other' ? 'repayment' : row.economicNature,
    ledgerAccountId: row.ledgerAccountId || '', counterpartyLedgerAccountId: detail.principalOf(row) ? '' : row.counterpartyLedgerAccountId || '',
    amountInput: yuan(row.amountMinor), date: String(row.localAt || '').slice(0, 10), time: String(row.localAt || '').slice(11, 19),
    counterparty: (has(row, 'counterparty') ? row.counterparty : source.counterparty || '').slice(0, 200),
    note: (has(row, 'note') ? row.note : source.note || '').slice(0, 200), categoryId: row.categoryId || '',
    owner: ownership.owner || 'self', otherTreatment: ownership.treatment || '',
    repaymentMode: loan.mode && loan.mode !== 'ordinary' ? 'loan' : 'ordinary',
    loanMode: loan.mode === 'associate' ? 'associate' : 'defer', loanId: loan.loanId || '', loanVersion: loan.loanVersion || 0,
    principalInput: yuan(loan.principalMinor), interestInput: yuan(loan.interestMinor), feeInput: yuan(loan.feeMinor),
    interestTreatment: loan.interestTreatment || 'expense', feeTreatment: loan.feeTreatment || 'expense',
    interestCategoryId: loan.interestCategoryId || '', feeCategoryId: loan.feeCategoryId || '',
    chargeAllocations: (loan.chargeAllocations || []).map(part => ({ ...part, amountInput: yuan(part.amountMinor) })),
    composition: facts.composition || 'single', parts: parts.map(part => ({ ...part, accountId: part.accountId || '', amountInput: yuan(part.amountMinor) })),
    evidenceNote: facts.incompleteComposition?.evidenceNote || row.paymentResolution?.evidenceNote || facts.evidenceNote || '',
    periodInput: String(row.installment?.periodNumber || ''), totalTermsInput: String(row.installment?.totalTerms || ''),
    // 计划归属：空表示用户没有改动；只在用户主动选择时才进入 sourceCorrection。
    planLabel: '',
    refund: null, dirty: {}, dormant: {}, acknowledgedChanges: [] }
  if (channel) Object.assign(draft, { economicNature: 'repayment', amountInput: yuan(channel.totalMinor),
    [repaymentTargetKey(row)]: channel.targetAccountId, owner: 'self', composition: 'single', parts: [], repaymentMode: 'ordinary',
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
    if (!NATURES.some(item => item.value === value) || detail.principalOf(row)) return draft
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
  const loan = draft.economicNature === 'repayment' && !other && draft.composition === 'single' && draft.repaymentMode === 'loan'
  return detail.accountFields(projected).map(field => {
    let allowedTypes = null
    if (other || field.label === '付款账户' && draft.economicNature === 'repayment' || field.label === '到账账户') allowedTypes = ASSETS
    if (field.label === '还入账户' || field.label === '借款负债账户') allowedTypes = loan ? ['other_liability'] : DEBTS
    if (detail.principalOf(row)) allowedTypes = ['credit']
    const account = catalog.find(item => item.accountId === field.accountId)
    const readonly = Boolean(channel && field.label === '还入账户')
    return { ...field, target: readonly ? '' : field.key === 'account' ? 'reviewAccount' : 'reviewCounterparty', allowedTypes, readonly,
      name: account ? account.name : field.accountId ? '账户名称待读取' : '',
      invalid: Boolean(account && (account.archivedAt || account.unavailable || allowedTypes && !allowedTypes.includes(account.type))) }
  })
}
// 分期归属区。费用行得到的是「这笔利息属于哪个计划」的单选；本金行得到的是本组上下文，
// 列出本期次还没指定归属的利息，点一笔就带着本计划去打开那一笔。
// 候选计划与分组上下文都由服务端随事件下发，客户端不自己推断，避免两处口径不一致。
function attributionOf(row, draft, catalogs) {
  const attribution = row.installmentAttribution
  if (!attribution) return null
  const periodLabel = '第' + attribution.periodNumber + '期' + (attribution.totalTerms ? '／共' + attribution.totalTerms + '期' : '')
  if (attribution.role === 'principal') {
    // 只列同一期次的利息。分组键与服务端同源（整理阶段已写进 installment.groupKey），
    // 不带这个限定就会把其它期次甚至其它计划的未归属利息也列到本卡里。
    const groupKey = String(row.installmentKey || attribution.groupKey || '')
    const pending = ((catalogs || {}).siblings || []).filter(item => item.eventId !== row.eventId && item.rowRoleKey &&
      item.rowRoleKey !== 'principal' && !String(item.installmentPlanLabel || '').trim() &&
      Boolean(groupKey) && String(item.installmentKey || '') === groupKey)
    if (!pending.length) return null
    return { role: 'principal', required: false, planLabel: row.installment && row.installment.planName || '',
      periodLabel: periodLabel, hint: '本期次还有 ' + pending.length + ' 笔利息没指定归属，逐笔把它归到本计划。',
      pending: pending.map(item => ({ eventId: item.eventId, roleLabel: item.rowRole || '分期费用',
        title: item.rowTitle || item.displayTitle || '分期费用', amountText: item.amountText || '' })) }
  }
  if (!(attribution.plans || []).length) return null
  const selected = draft.dirty.planLabel ? draft.planLabel : row.installment && row.installment.planLabel || ''
  return { role: 'charge', required: !selected, periodLabel: periodLabel,
    hint: '本期次有 ' + attribution.plans.length + ' 个分期计划，账单没写明这笔利息属于哪一个，请选它归属的计划。',
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
  const other = draft.economicNature === 'repayment' && draft.owner === 'other'
  const effectiveNature = other ? draft.otherTreatment === 'expense' ? 'expense' : 'unknown' : draft.economicNature
  const principal = detail.principalOf(row)
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
      'composition', 'parts', 'repaymentMode', 'loanMode', 'loanId', 'loanVersion', 'principalInput', 'interestInput', 'feeInput',
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
  if (!channel && row.repaymentOwnership && draft.economicNature !== 'repayment' && draft.dirty.economicNature) decisions.ownership = null
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
  if (!channel && draft.economicNature === 'repayment' && !principal && !other && draft.composition === 'single' && draft.repaymentMode === 'loan') {
    const chargeAllocations = draft.loanMode === 'associate' ? draft.chargeAllocations.map(part => {
      const value = minor(part.amountInput == null ? yuan(part.amountMinor) : part.amountInput)
      if (value == null || value === '0') invalid('repayment', '费用清偿金额需为大于零的有效金额')
      return { chargeId: part.chargeId, component: part.component, amountMinor: value }
    }) : []
    for (const key of ['principal', 'interest', 'fee']) if (draft[key + 'Input'].trim() && minor(draft[key + 'Input']) == null) invalid('repayment', '本息费金额格式不正确')
    const values = ['principal', 'interest', 'fee'].map(key => minor(draft[key + 'Input']))
    if (amount != null && values.filter(value => value != null).reduce((sum, value) => sum + BigInt(value), 0n) > BigInt(amount)) invalid('repayment', '已填本息费不能超过付款总额')
    const incompleteLoan = values.some(value => value == null) || amount == null || fields.some(field => !field.accountId) ||
      draft.loanMode === 'associate' && !draft.loanId ||
      ['interest','fee'].some(key => draft[key + 'Treatment'] === 'expense' && minor(draft[key + 'Input']) !== '0' && !draft[key + 'CategoryId'])
    if (values.every(value => value != null) && amount != null && values.reduce((sum, value) => sum + BigInt(value), 0n) !== BigInt(amount)) invalid('repayment', '本金、利息和费用合计必须等于付款总额')
    if (incompleteLoan) {
      decisions.repayment = { mode: 'review', draft: { principalMinor: values[0], interestMinor: values[1], feeMinor: values[2],
        mode: draft.loanMode, loanId: draft.loanMode === 'associate' ? draft.loanId || null : null, loanVersion: draft.loanMode === 'associate' ? draft.loanVersion || null : null,
        interestTreatment: draft.interestTreatment, feeTreatment: draft.feeTreatment,
        interestCategoryId: draft.interestTreatment === 'expense' ? draft.interestCategoryId || null : null,
        feeCategoryId: draft.feeTreatment === 'expense' ? draft.feeCategoryId || null : null, chargeAllocations } }; missing.push('还款本息费')
    } else if (amount == null || values.reduce((sum, value) => sum + BigInt(value), 0n) !== BigInt(amount)) invalid('repayment', '本金、利息和费用合计必须等于付款总额')
    else {
      decisions.repayment = { confirmed: true, mode: draft.loanMode, assetAccountId: fields[0]?.accountId,
        liabilityAccountId: fields[1]?.accountId, principalMinor: values[0], interestMinor: values[1], feeMinor: values[2],
        chargeAllocations,
        ...(draft.loanMode === 'associate' ? { loanId: draft.loanId, loanVersion: draft.loanVersion } : {}) }
      for (const key of ['interest', 'fee']) {
        decisions.repayment[key + 'Treatment'] = draft[key + 'Treatment']
        decisions.repayment[key + 'CategoryId'] = draft[key + 'Treatment'] === 'expense' ? draft[key + 'CategoryId'] || null : null
        if (draft[key + 'Treatment'] === 'expense' && minor(draft[key + 'Input']) !== '0' && !draft[key + 'CategoryId']) invalid('repayment', '请选择利息／费用的支出分类')
      }
      if (draft.loanMode === 'associate' && !draft.loanId) invalid('repayment', '请选择关联贷款')
      for (const key of ['interest', 'fee']) {
        const allocated = chargeAllocations.filter(part => part.component === key && part.amountMinor != null).reduce((sum, part) => sum + BigInt(part.amountMinor), 0n)
        if (allocated > BigInt(minor(draft[key + 'Input']))) invalid('repayment', '费用清偿分配超出对应分项')
        if (draft[key + 'Treatment'] === 'accrued' && allocated !== BigInt(minor(draft[key + 'Input']))) invalid('repayment', '清偿已记费用须完整选择对应收费项')
      }
    }
  } else if (!channel && row.loanRepayment && (draft.dirty.repaymentMode || draft.dirty.economicNature || draft.dirty.owner || draft.dirty.composition)) decisions.repayment = null
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
  const options = (principal || channel ? NATURES.filter(item => item.value === 'repayment') : NATURES.filter(item => {
    if (draft.composition === 'repayment') return item.value === 'repayment'
    if (draft.composition === 'payment') return ['expense', 'repayment'].includes(item.value)
    return true
  })).map(item => ({ ...item, label: detail.natureLabel(principal || item.value === row.economicNature
    ? { ...row, economicNature: item.value } : { economicNature: item.value }) }))
  return { supported, chargeRows: draft.chargeAllocations.map((part, index) => ({ ...part, index, amountInput: part.amountInput == null ? yuan(part.amountMinor) : part.amountInput })), readonlyReason: facts?.lockedReason || (!facts ? '需更新导入服务后才能编辑' : ''),
    natureOptions: options, natureIndex: Math.max(0, options.findIndex(item => item.value === draft.economicNature)),
    natureLabel: options.find(item => item.value === draft.economicNature)?.label || detail.natureLabel({}),
    directionClass: flowClass(effectiveNature),
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
    summaryParty: draft.counterparty,
    summaryTime: [draft.date, draft.time.slice(0, 5)].filter(Boolean).join(' '),
    source: Boolean(row.installment),
    attribution: attributionOf(row, draft, catalogs),
    needsCompositionNote: draft.composition === 'payment' || draft.composition === 'single' && original.composition !== 'single',
    loanFields: ['principal','interest','fee'].map((key, index) => ({ key: key + 'Input', label: ['本金','利息','费用'][index], value: draft[key + 'Input'] })),
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
    // 同订单的原消费已关闭/失败却出现退款成功时，来源本身互相矛盾；
    // 这种退款不能当普通退款去挑原消费，必须从矛盾事项核对原文。
    refundConflict: Boolean((row.reasonCodes || []).includes('refund_source_conflict')),
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
    draft.repaymentMode = repayment ? 'loan' : 'ordinary'
    if (repayment) {
      const value = repayment.draft || repayment
      draft.loanMode = value.mode; draft.loanId = value.loanId || ''; draft.loanVersion = value.loanVersion || 0
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
