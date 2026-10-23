const repaymentOwnership = require('./repayment-ownership')
const accountGroups = require('./payment-account-groups')
const { buildPaymentMethodKey } = require('./identity')
const { paymentAccountDetails } = require('./payment-account')
const { evaluatePostability } = require('./organizer-model')
const parseJson = (value, fallback) => { if (value == null) return fallback; if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch (_) { return fallback } }
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
    sourceDirection: row.sourceDirection || null,
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
    .replace(/\d{8,}/gu, function (digits) { return '****' + digits.slice(-4) })
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
  const reasonCodes = parseJson(row.reasonCodes, [])
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
      ledgerAccountId: row.subjectLedgerAccountId || null,
      counterpartyLedgerAccountId: row.subjectCounterpartyLedgerAccountId || null,
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
      fundsSide: account.fundsSide || '',
      accountId: account.accountId || null,
      unresolvedReason: account.unresolvedReason || '',
      item: safeIssueSummary(row.subjectItem),
      counterparty: safeIssueSummary(row.subjectCounterparty),
      defaultIgnored: reasonCodes.includes('source_account_ignored_default')
    } : null
  }
}

module.exports = { publicEvent, publicIssue }
