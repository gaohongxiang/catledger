// 展示已知事实和待补项，不猜交易性质、不创建账目或贷款计划。
const NATURE_LABELS = Object.freeze({ income: '收入', expense: '支出', refund: '退款',
  internal_transfer: '内部转账', borrow: '借款', repayment: '还款', fee: '利息／手续费',
  balance_adjustment: '余额调整', unknown: '性质待确认' })
const destinationNatures = ['internal_transfer', 'borrow', 'repayment']
const categoryNatures = ['income', 'expense', 'fee']
const hasValue = value => value !== undefined && value !== null && value !== ''
function money(value) {
  if (!hasValue(value) || !/^-?\d+$/.test(String(value))) return ''
  const raw = String(value), negative = raw.startsWith('-'), digits = (negative ? raw.slice(1) : raw).padStart(3, '0')
  return (negative ? '-¥' : '¥') + digits.slice(0, -2) + '.' + digits.slice(-2)
}
function installmentOf(row) { return row.installment || row.fieldSources && row.fieldSources.installment || null }
// 现金分期放款行：账单两行合成的一笔借款。期数和计划名只是来源事实，
// 计划本身在贷款管理里登记，这里不预建也不会自动创建。
function disbursementOf(row) {
  const value = row.disbursement || row.fieldSources && row.fieldSources.disbursement || null
  return value && value.role !== 'offset' ? value : null
}
function registrationOf(row) {
  return Boolean(disbursementOf(row)?.role === 'registration' || row.editorFacts?.recordRole === 'installment_registration')
}
function principalOf(row) {
  const item = installmentOf(row)
  return Boolean(item && item.creditStatement === true && item.component === 'principal')
}
// 交易性质名称的唯一入口：列表各页签、详情和编辑器都按当前事实取名，不能被计划标题或旧展示值覆盖。
function natureLabel(row) {
  // 放款对行不是“性质待确认”：它已经识别为同一笔现金分期的卡内记账行，只是不重复入账。
  const pair = row.disbursement || row.fieldSources && row.fieldSources.disbursement
  if (pair && pair.role === 'offset') return '分期放款对行'
  if (registrationOf(row)) return '分期登记'
  if (pair && pair.role === 'disbursement' && row.economicNature === 'borrow') return '现金分期借款'
  const installment = installmentOf(row)
  if (installment && installment.creditStatement) {
    const label = { principal: '分期出账', interest: '分期利息', fee: '分期手续费' }[installment.component]
    // 本金默认是“分期出账”；用户明确改判成支出、收入、费用或待确认后，按经济性质显示。
    if (label && (installment.component !== 'principal' || !row.economicNature || row.economicNature === 'repayment')) return label
  }
  return NATURE_LABELS[row.economicNature] || NATURE_LABELS.unknown
}
function fundsAccountLabels(nature) {
  return { from: nature === 'borrow' ? '借款负债账户' : nature === 'repayment' ? '付款账户' : '转出账户',
    to: nature === 'borrow' ? '到账账户' : nature === 'repayment' ? '还入账户' : '转入账户' }
}
function accountLabels(row) {
  if (principalOf(row) || registrationOf(row)) return { from: '所属信用卡', to: '', hasDestination: false }
  const nature = row.economicNature, dual = destinationNatures.includes(nature)
  const { from, to } = fundsAccountLabels(nature)
  // 普通双端事件的 ledgerAccountId 是原账单账户；入账时 income 来源会反向。
  // 组合支付/合并还款有自己的规范分配，不套用普通来源方向。
  // 草稿态（editorComposition 存在）一律不算 allocated：编辑器里把某一端拆成多账户只是同一笔的
  // 分配方式，不会改变两端谁收谁付。早先按「已分配」关掉 reverse，会让点开加号的那一端标题
  // 从「还入账户」翻成「付款账户」，原账户也跟着换到另一行。
  const allocated = row.editorComposition ? false : row.paymentResolution || (row.repaymentAllocations || []).length ||
    row.fieldSources && (row.fieldSources.paymentResolution || (row.fieldSources.repaymentAllocations || []).length)
  const reverse = dual && !allocated && row.sourceDirection === 'income'
  return { from: dual ? (reverse ? to : from) : ['income', 'refund'].includes(nature) ? '收款账户'
      : nature === 'fee' ? '付款账户'
      : nature === 'balance_adjustment' ? '调整账户' : nature === 'expense' ? '付款账户' : '账单所属账户',
    to: reverse ? from : to, hasDestination: dual, reverse }
}
function accountFields(row) {
  const labels = accountLabels(row)
  const fields = [{ key: 'account', label: labels.from, accountId: row.ledgerAccountId }]
  if (labels.hasDestination) fields.push({ key: 'counterparty', label: labels.to, accountId: row.counterpartyLedgerAccountId })
  return labels.reverse ? fields.reverse() : fields
}
function accountText(id, catalog) {
  if (!id) return ''
  const item = (catalog || []).find(account => account.accountId === id)
  return item ? item.archivedAt || item.archived || item.unavailable ? '账户已不可用，请核对' : item.name : '账户名称待读取'
}
function categoryText(row, catalog) {
  if (row.categoryName) return row.categoryName
  const item = (catalog || []).find(category => category.categoryId === row.categoryId)
  if (!item) return row.categoryId ? '分类名称待读取' : ''
  const parent = (catalog || []).find(category => category.categoryId === item.parentId)
  return [item.parentName || parent && parent.name, item.name].filter(Boolean).join(' / ')
}
function fieldsFor(row = {}, catalogs = {}, options = {}) {
  const fields = [], skip = new Set(options.omit || [])
  const add = (key, label, value, optional, missingText) => {
    const text = hasValue(value) ? String(value) : missingText || (optional ? '未填写（选填）' : '待补充')
    if (!skip.has(key)) fields.push({ key, label, value: text.length > 160 ? text.slice(0, 160) + '…（完整内容见原始账单）' : text,
      missing: !hasValue(value), optional: Boolean(optional) })
  }
  const source = row.primaryEvidence || {}, extra = row.fieldSources || {}
  const facts = row.detailFacts || {}
  catalogs = { ...catalogs, accounts: (facts.accounts || []).concat(catalogs.accounts || []) }
  const installment = installmentOf(row), principal = principalOf(row), labels = accountLabels(row)
  const disbursement = disbursementOf(row), registration = registrationOf(row)
  const allocation = row.paymentResolution || extra.paymentResolution
  const repayments = row.repaymentAllocations || extra.repaymentAllocations || []
  const historical = ['posted', 'corrected'].includes(row.status)
  const loan = historical ? row.loanRepayment || extra.loanRepayment : null
  add('nature', '交易性质', natureLabel(row), false)
  add('amount', registration ? '分期本金' : principal ? '本期本金' : '交易金额', money(row.amountMinor), false)
  add('time', registration ? '账单日期' : '交易时间', row.localAt && String(row.localAt).replace(/\.\d+$/, ''), false)
  add('party', '交易对方', Object.prototype.hasOwnProperty.call(row, 'counterparty') ? row.counterparty : source.counterparty, true)
  if (allocation && Array.isArray(allocation.allocations)) {
    allocation.allocations.forEach((part, index) => add('payment-' + index, '付款账户 ' + (index + 1),
      [accountText(part.accountId, catalogs.accounts), money(part.amountMinor)].filter(Boolean).join(' · '), false))
    if (labels.hasDestination && !repayments.length) add('counterparty', labels.to,
      accountText(row.counterpartyLedgerAccountId, catalogs.accounts), false)
  } else if (repayments.length) add('account', labels.from, accountText(row.ledgerAccountId, catalogs.accounts), false)
  else accountFields(row).forEach(field => add(field.key, field.label, accountText(field.accountId, catalogs.accounts), false))
  if (repayments.length) repayments.forEach((part, index) => add('repayment-' + index, '还入账户 ' + (index + 1),
    [accountText(part.accountId, catalogs.accounts), money(part.amountMinor)].filter(Boolean).join(' · '), false))
  if (!registration && categoryNatures.includes(row.economicNature)) add('category', '交易分类', categoryText(row, catalogs.categories), true, '待分类（可稍后补）')
  if (row.economicNature === 'refund') {
    const refund = facts.refund
    const original = refund && refund.originals && refund.originals[0]
    const text = original && [original.note, original.localAt, money(original.amountMinor)].filter(Boolean).join(' · ')
    add('refund', '原消费关系', refund && ({ confirmed: text || '已关联原消费', pending: '待关联原消费',
      ambiguous: '关系冲突，需重新核对', unlinked: '待关联原消费' }[refund.status]), false, '关联信息待读取')
    add('category', '退款分类', original && original.categoryName, true, '随原消费，关联后确定')
  }
  if (row.economicNature === 'repayment' && !principal) {
    const ownership = row.repaymentOwnership || extra.repaymentOwnership
    if (ownership || row.repaymentOwnershipRequired) add('ownership', '还款归属', ownership &&
      (ownership.owner === 'self' ? '自己的账户' : ownership.owner === 'other' ? '代他人还款' : ''), false)
    if (loan && ['defer', 'associate'].includes(loan.mode)) {
      add('principal', '偿还本金', money(loan.principalMinor), false)
      add('interest', '本次利息', money(loan.interestMinor), false)
      add('fee', '本次费用', money(loan.feeMinor), false)
      for (const key of ['interest', 'fee']) add(key + '-treatment', key === 'interest' ? '利息怎么记' : '费用怎么记',
        { expense: '没记过，记一笔', accrued: '记过，只冲抵，不重复支出' }[loan[key + 'Treatment']], false)
    }
  }
  if (installment) {
    add('period', '分期期次', installment.periodNumber ? '第 ' + installment.periodNumber + ' 期' +
      (installment.totalTerms ? ' / 共 ' + installment.totalTerms + ' 期' : ' / 总期数待补充') : '', false)
    add('plan', '分期计划', installment.loanName || row.loanName || '', true,
      installment.loanId || row.loanId ? '已关联计划，名称待读取' : '入账后关联或新建计划')
    if (principal) add('effect', '记账影响', '仅保留分期来源，不记实际还款', false)
  } else if (disbursement) {
    add('disbursement', '现金分期', [disbursement.planLabel,
      disbursement.totalTerms ? '共 ' + disbursement.totalTerms + ' 期' : ''].filter(Boolean).join(' · '), true, '分期期数待核对')
    // 同笔的另一行是这张卡上的卡内记账，不产生资金流，只作为这笔借款的第二条来源。
    if (disbursement.partner) add('disbursement-pair', '同笔的另一行', [disbursement.partner.item,
      disbursement.partner.localDate, money(disbursement.partner.amountMinor)].filter(Boolean).join(' · ') +
      '（卡内记账，不重复入账）', true)
    const decision = row.installmentPlanDecision || extra.installmentPlan
    add('plan', '分期计划', decision && ['link', 'create'].includes(decision.action) ? decision.planLabel : '', false,
      decision?.action === 'skip' ? registration ? '先不关联，保留待核对' : '先不关联；当前尚无入账后补关联入口'
        : registration ? '请选择已有计划或新建计划' : '尚未关联计划')
    add('effect', '记账影响', registration ? '只登记分期计划，不生成资金流水'
      : row.economicNature === 'borrow' ? '确认收款账户后按借款记一笔，卡内记账行不重复入账' : '按当前选择的性质处理，分期计划只用于跟踪还款', false)
  } else if (historical && (loan || row.loanId)) {
    add('plan', '关联贷款', facts.loan && facts.loan.name || '', true,
      loan && loan.mode === 'associate' && loan.loanId ? '已关联贷款，名称待读取' : '尚未关联（可入账后补充）')
  }
  add('status', '账单状态', source.status, true, '账单未提供')
  add('note', '备注', Object.prototype.hasOwnProperty.call(row, 'note') ? row.note : source.note, true)
  return fields
}
function referencedIds(row = {}) {
  const extra = row.fieldSources || {}, payment = row.paymentResolution || extra.paymentResolution || {}
  return [...new Set([row.ledgerAccountId, row.counterpartyLedgerAccountId]
    .concat((payment.allocations || []).map(item => item.accountId),
      (row.repaymentAllocations || extra.repaymentAllocations || []).map(item => item.accountId)).filter(Boolean))]
}
module.exports = { fieldsFor, natureLabel, accountLabels, accountFields, fundsAccountLabels, principalOf, installmentOf, registrationOf,
  disbursementOf, money, referencedIds }
