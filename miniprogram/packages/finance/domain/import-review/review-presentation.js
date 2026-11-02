const repaymentOwnership = require('./repayment-ownership')
const accountGroups = require('./payment-account-groups')
const { buildPaymentMethodKey } = require('./identity')
const { paymentAccountDetails } = require('./payment-account')
const { evaluatePostability } = require('./organizer-model')
const parseJson = (value, fallback) => { if (value == null) return fallback; if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch (_) { return fallback } }
function transferOwnershipPending(event) {
  if (event.economicNature !== 'internal_transfer' || event.fieldSources?.fundsProjection?.kind !== 'bank_transfer') return false
  const value = require('./account-ownership').read(event)
  return value.source.kind === 'unknown' || value.destination.kind === 'unknown'
}
function publicEvent(row) {
  const fieldSources = parseJson(row.fieldSources, {})
  const reasonCodes = parseJson(row.reasonCodes, [])
  const installment = fieldSources.installment && { ...fieldSources.installment,
    ...(fieldSources.editorOverrides?.version === 1 ? fieldSources.editorOverrides.sourceCorrection || {} : {}) }
  // 旧批次只缺分类时按当前规则展示，保留原始版本供写操作校验。
  const status = row.status === 'needs_action' &&
    ['income', 'expense', 'fee'].includes(row.economicNature) && reasonCodes.includes('category_required') && !reasonCodes.includes('blocking_issue_open')
    ? evaluatePostability({ ...row, reasonCodes, fieldSources }).status : row.status
  return {
    eventId: row.eventId,
    status,
    version: Number(row.version),
    flowDirection: row.flowDirection,
    economicNature: row.economicNature,
    ...(transferOwnershipPending({ ...row, fieldSources }) ? { transferOwnershipPending: true } : {}),
    ledgerAccountId: row.ledgerAccountId || null,
    counterpartyLedgerAccountId: row.counterpartyLedgerAccountId || null,
    localAt: row.localAt,
    amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
    currency: row.currency,
    categoryId: row.categoryId || null,
    categoryName: row.categoryName ? [row.parentCategoryName, row.categoryName].filter(Boolean).join(' / ') : '',
    reasonCodes,
    ...Object.fromEntries(Object.entries(require('./editor-fields').overrides({ fieldSources })).filter(([key]) => ['counterparty', 'note'].includes(key))),
    ...((fieldSources.bankChannelDistinctPairs || []).length && !fieldSources.mergeOrigins && !fieldSources.bankChannelResolution ? { pairingDecision: 'distinct' } : {}),
    loanRepayment: fieldSources.loanRepayment || null,
    ...(fieldSources.repaymentChannelResolution ? { repaymentChannel: require('./repayment-channel').publicResolution({ fieldSources }) } : {}),
    ...(fieldSources.installment && fieldSources.installment.creditStatement === true ? { installment: {
      creditStatement: true, factKind: 'billing', component: fieldSources.installment.component,
      periodNumber: installment.periodNumber, totalTerms: installment.totalTerms || null,
      originKind: fieldSources.installment.originKind || 'unconfirmed',
      // 计划名由服务端从本金摘要派生下发，客户端不再自行截断摘要，避免两处规则漂移。
      planName: require('./installment-plan').planNameFromItem(row.item),
      planLabel: String(installment.planLabel || '').trim(),
      // 分组键由整理阶段落库下发；旧批次没有这个字段时由客户端按同一口径回退计算。
      groupKey: String(installment.groupKey || '').trim()
    } } : {}),
    ...(fieldSources.installmentAttribution ? { installmentAttribution: fieldSources.installmentAttribution } : {}),
    // 现金分期放款对：放款行按借款入账，期数和计划名只是这笔借款的来源事实，
    // 计划本身在贷款管理里登记，导入不创建贷款记录。两行都下发角色：对行据此在
    // 已排除里显示“分期放款对行”，不再落到“性质待确认”；放款行带上同笔的另一行，
    // 详情里两行并列，用户看到的是同一笔而不是两件事。
    // 核对阶段对「这笔分期」的决定：归入已有计划、新建计划或先不挂。
    // 放款行用它预填并回显；对行据此把排除原因写成“已并入某计划”。
    // 单独命名，避免与分期行展示用的计划名 installmentPlan 混淆。
    ...(fieldSources.installmentPlan ? { installmentPlanDecision: fieldSources.installmentPlan } : {}),
    ...(fieldSources.disbursement ? { disbursement: {
      role: fieldSources.disbursement.role || 'disbursement',
      totalTerms: fieldSources.disbursement.totalTerms || null,
      planLabel: String(fieldSources.disbursement.planLabel || '').trim(),
      ...(fieldSources.disbursement.partner ? { partner: fieldSources.disbursement.partner } : {})
    } } : {}),
    sourceDirection: row.sourceDirection || null,
    accountOrder: fieldSources.fundsProjection?.accountOrder || null,
    ...(fieldSources.accountOwnership || fieldSources.repaymentOwnership ? {
      accountOwnership: require('./account-ownership').read({ ...row, fieldSources })
    } : {}),
    fundsProjection: fieldSources.fundsProjection || null,
    ...(repaymentOwnership.bankRepayment({ fieldSources }) || repaymentOwnership.decisionFor({ fieldSources }) ? {
      repaymentOwnership: fieldSources.repaymentOwnership || null,
      repaymentOwnershipRequired: repaymentOwnership.requiresDecision({ fieldSources, counterpartyLedgerAccountId: row.counterpartyLedgerAccountId })
    } : {}),
    repaymentAllocations: fieldSources.repaymentAllocations || [],
    paymentComponents: fieldSources.paymentComponents || [],
    paymentResolution: fieldSources.paymentResolution || null,
    paymentAccounts: fieldSources.paymentAccounts || null,
    evidenceCount: Number(row.evidenceCount),
    duplicateEvidenceCount: Number(row.duplicateEvidenceCount || 0),
    // 合成前有几条来源：同笔合并之后主事件只留一条 primary，单看证据条数会丢掉
    // “这笔是多来源合成”的事实；详情据此决定是否给修改同笔判断的入口。
    ...((fieldSources.mergeOrigins || []).length > 1 ? { pairCount: fieldSources.mergeOrigins.length } : {}),
    primaryEvidence: row.primaryRowId ? {
      rowId: row.primaryRowId,
      sourceType: row.sourceType,
      fileName: row.fileName,
      rowNumber: Number(row.rowNumber),
      counterparty: row.counterparty || '',
      item: row.item || '',
      note: row.sourceNote || '',
      paymentMethod: row.paymentMethod || '',
      status: row.sourceStatus || ''
    } : null
  }
}

function safeIssueSummary(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .replace(/\d(?:[ -]*\d){7,}/gu, function (digits) { return '****' + digits.replace(/\D/g, '').slice(-4) })
    .trim()
    .slice(0, 96)
}

function publicIssue(row) {
  const subjectFieldSources = parseJson(row.subjectFieldSources, {})
  const fundsProjection = subjectFieldSources.fundsProjection || null
  const subjectDetails = row.subjectEventId
    ? paymentAccountDetails(row.subjectSourceType, row.subjectPaymentMethod)
    : null
  const ledgerAccountReference = subjectFieldSources.ledgerAccountReference || null
  const domainSubject = { economicNature: row.subjectEconomicNature, sourceDirection: row.subjectSourceDirection, currency: row.subjectCurrency,
    ledgerAccountId: row.subjectLedgerAccountId, counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId,
    fieldSources: subjectFieldSources }
  const ownership = require('./account-ownership').read(domainSubject)
  const subjectAccount = ledgerAccountReference
    ? {
        ...ledgerAccountReference,
        fundsSide: 'ordinary',
        accountId: row.subjectLedgerAccountId || null
      }
    : subjectDetails ? {
        sourceType: row.subjectSourceType || '',
        paymentMethodKey: buildPaymentMethodKey(row.subjectSourceType, row.subjectPaymentMethod),
        label: subjectDetails.displayName,
        recognized: subjectDetails.recognized,
        fundsSide: 'ordinary',
        accountId: row.subjectLedgerAccountId || null
      } : null
  const mappingSide = row.subjectMemberRole === 'mapping_from'
    ? 'from'
    : row.subjectMemberRole === 'mapping_to' ? 'to' : ''
  const mappingReference = row.issueType === 'account_mapping' && fundsProjection && mappingSide
    ? fundsProjection[mappingSide]
    : null
  const mappingAccount = mappingReference ? {
    ...mappingReference,
    fundsSide: mappingSide,
    accountId: mappingSide === 'from'
      ? row.subjectLedgerAccountId || null
      : row.subjectCounterpartyLedgerAccountId || null
  } : null
  const projectedAccount = row.issueType === 'transfer_accounts' && fundsProjection
    ? !row.subjectLedgerAccountId ? fundsProjection.from
      : !row.subjectCounterpartyLedgerAccountId ? fundsProjection.to : null
    : null
  const groupedReference = (subjectFieldSources.paymentAccountReferences || []).find((ref) => ref.memberRole === row.subjectMemberRole)
  const groupedAccount = groupedReference ? { ...groupedReference, fundsSide: groupedReference.memberRole,
    accountId: accountGroups.mappedAccount({ fieldSources: subjectFieldSources, counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId }, groupedReference) } : null
  const mergedAccount = subjectFieldSources.bankChannelAccountContexts && subjectFieldSources.bankChannelAccountContexts[row.issueId]
  const account = mergedAccount ? { ...mergedAccount, accountId: row.subjectLedgerAccountId || null }
    : groupedAccount || mappingAccount || projectedAccount || subjectAccount
  if (account && row.issueType === 'account_mapping') {
    const side = require('./account-reference-decision').sideFor(domainSubject, row.subjectMemberRole || 'subject')
    if (side && subjectFieldSources.accountOwnership) {
      account.accountId = ownership[side].accountId
      account.mappingAction = ownership[side].kind === 'external' ? 'external' : account.accountId ? 'account' : null
    }
    const pending = require('./account-ownership-recheck').decision(domainSubject, row.subjectMemberRole || 'subject', account)
    if (pending) { account.accountId = null; account.mappingAction = pending.kind === 'external' ? 'external' : null }
  }
  let reasonCodes = parseJson(row.reasonCodes, [])
  // 旧账户决定只写在操作记录中；按当前事项取出决定，不能用代表事件的
  // excluded 状态推断整个账户组都被用户排除。只投影原因，不公开操作原文。
  if (row.issueType === 'account_mapping' && row.status === 'resolved') {
    const action = parseJson(row.resolvedDecision, {}) || {}
    const decision = (Array.isArray(action.decisions) ? action.decisions : [action])
      .find(item => item && item.issueId === row.issueId)
    if (decision && ['exclude_events', 'apply_fields'].includes(decision.decision)) {
      reasonCodes = reasonCodes.filter(code => !['account_mapping_excluded', 'source_account_ignored_default'].includes(code))
      if (decision.decision === 'exclude_events') reasonCodes = [...reasonCodes, 'account_mapping_excluded']
    }
  }
  return {
    issueId: row.issueId,
    issueType: row.issueType,
    status: row.status,
    version: Number(row.version),
    blocking: row.issueType !== 'category_assignment' && Boolean(row.blocking),
    primaryReasonCode: row.primaryReasonCode,
    memberCount: Number(row.memberCount),
    candidateCount: Number(row.candidateCount),
    subjectEventIds: [...new Set(parseJson(row.subjectEventIds, []))],
    reasonCodes,
    subject: row.subjectEventId ? {
      eventId: row.subjectEventId,
      status: row.subjectEventStatus,
      flowDirection: row.subjectFlowDirection,
      economicNature: row.subjectEconomicNature,
      sourceDirection: row.subjectSourceDirection || null,
      accountOrder: fundsProjection?.accountOrder || null,
      ...(transferOwnershipPending(domainSubject) ? { transferOwnershipPending: true } : {}),
      ledgerAccountId: row.subjectLedgerAccountId || null,
      counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId || null,
      ...(subjectFieldSources.accountOwnership || subjectFieldSources.repaymentOwnership ? { accountOwnership: require('./account-ownership').read({ economicNature: row.subjectEconomicNature,
        sourceDirection: row.subjectSourceDirection, ledgerAccountId: row.subjectLedgerAccountId,
        counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId, fieldSources: subjectFieldSources }) } : {}),
      fundsProjection,
      ...(repaymentOwnership.bankRepayment({ fieldSources: subjectFieldSources }) ? {
        repaymentOwnership: subjectFieldSources.repaymentOwnership || null,
        repaymentOwnershipRequired: repaymentOwnership.requiresDecision({ fieldSources: subjectFieldSources, counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId })
      } : {}),
      repaymentAllocations: subjectFieldSources.repaymentAllocations || [],
      paymentComponents: subjectFieldSources.paymentComponents || [],
      paymentResolution: subjectFieldSources.paymentResolution || null,
      paymentAccounts: subjectFieldSources.paymentAccounts || null,
      localAt: row.subjectLocalAt,
      amountMinor: row.subjectAmountMinor == null ? null : String(row.subjectAmountMinor),
      currency: row.subjectCurrency,
      primaryEvidence: {
        sourceType: row.subjectSourceType || '',
        fileName: safeIssueSummary(row.subjectFileName),
        counterparty: safeIssueSummary(row.subjectCounterparty),
        item: safeIssueSummary(row.subjectItem),
        note: '',
        paymentMethod: safeIssueSummary(row.subjectPaymentMethod),
        status: safeIssueSummary(row.subjectRawStatus)
      }
    } : null,
    accountContext: account ? {
      label: account.label,
      recognized: Boolean(account.paymentMethodKey) && account.recognized !== false,
      sourceType: account.sourceType || '',
      paymentMethodKey: account.paymentMethodKey || null,
      bindingKey: account.bindingKey || null, binding: account.binding || null,
      mappingAction: account.mappingAction || (account.accountId ? 'account' : null),
      canExternal: row.canExternal === true,
      fundsSide: account.fundsSide || '',
      ...require('./account-type-policy').rules({ ...account,
        ...(Array.isArray(row.allowedAccountTypes) ? { allowedAccountTypes: row.allowedAccountTypes } : {}) },
      { event: domainSubject, memberRole: row.subjectMemberRole || 'subject' }),
      currency: row.subjectCurrency || account.currency || 'CNY',
      accountId: account.accountId || null,
      unresolvedReason: account.unresolvedReason || '',
      item: safeIssueSummary(row.subjectItem),
      counterparty: safeIssueSummary(row.subjectCounterparty),
      defaultIgnored: reasonCodes.includes('source_account_ignored_default')
    } : null
  }
}

module.exports = { publicEvent, publicIssue }
