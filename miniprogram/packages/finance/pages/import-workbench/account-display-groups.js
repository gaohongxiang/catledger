const model = require('./model')
const types = require('../../domain/import-review/account-type-policy')
const names = require('../../domain/import-review/account-draft-policy')

const sourceLabels = { alipay: '支付宝', wechat: '微信', bank: '银行' }
const nameValid = value => Array.from(String(value || '').normalize('NFKC').trim()).length >= 1 &&
  Array.from(String(value || '').normalize('NFKC').trim()).length <= 32
// 标题就是账单里的账户名。推荐选中同名账户时，再给一个下拉框只是把标题念第二遍。
const titleKey = value => String(value || '').normalize('NFKC').replace(/\s+/g, '')
function titleMatchesChoice(label, choiceName) {
  const key = titleKey(label)
  return Boolean(key) && key === titleKey(choiceName)
}
const signature = (rows, drafts) => JSON.stringify(rows.map(row => [row.issueId, row.version, row.status,
  row.accountContext?.accountId || '', drafts.get(row.issueId)?.revision || 0]))

function countNote(group, separated = false) {
  // 旧页面没有完整组信息时，只解释各来源可能重叠，不猜全组笔数。
  if (!group) return separated ? '各来源可能包含同一笔交易' : ''
  const separate = Number(group?.separateMemberCount || 0), joined = Number(group?.memberCount || 0)
  if (!(separate > joined)) return ''
  return separated ? '各来源包含相同交易，笔数不相加' : '同一笔交易只算一次'
}

function compact(mapping) {
  const { groupIssueIds, groupSources, groupAnchorIssueId, ...visible } = mapping
  // setData 的叶路径会原位更新 Page.data。可见卡需要独立的嵌套对象，
  // 否则排序会把共用的类型选项、账户上下文或另一列表里的卡一起改写。
  return JSON.parse(JSON.stringify(visible))
}

function isExcluded(mapping) {
  if (mapping.accountSeparatedGroupId) return mapping.accountSeparatedGroupExcluded === true
  return mapping.choiceValue === 'ignore' && !mapping.needsConfirmation
}

// 只传原事项的输入；联合卡是它们的展示，不能再次作为一个账户参与分组。
function readOptions(drafts) {
  const displayGroups = [...drafts].flatMap(([groupId, draft]) => {
    const mode = draft.confirmationDisplayMode || (draft.separated ? 'separated' : '')
    const issueIds = [...new Set(draftIssueIds(draft))].sort()
    return ['separated', 'joined'].includes(mode) && issueIds.length >= 2 ? [{ groupId, issueIds, mode }] : []
  }).sort((left, right) => left.groupId.localeCompare(right.groupId))
  const rows = [...drafts].filter(([id, draft]) => !draftIssueIds(draft).length &&
    !String(id).startsWith('account-confirmation:') && !String(id).startsWith('legacy:'))
    .sort(([left], [right]) => left.localeCompare(right))
  return {
    displayGroups,
    separateIssueIds: rows.filter(([, draft]) => draft.confirmationSeparate).map(([id]) => id),
    accountSelections: rows.map(([issueId, draft]) => ({ issueId, mode: draft.mode || 'pending', accountId: draft.accountId || '',
      explicit: draft.explicitAccountSelection === true, dirty: draft.dirty === true }))
  }
}

function readSignature(drafts) {
  const options = readOptions(drafts)
  // 翻页时补齐的默认草稿不算一次改选，默认值由完整本批的读层统一计算。
  return JSON.stringify({ ...options, accountSelections: options.accountSelections.filter(row => row.explicit || row.dirty) })
}

function draftIssueIds(draft) {
  if (Array.isArray(draft?.confirmationIssueIds)) return draft.confirmationIssueIds
  if (Array.isArray(draft?.separatedMembers)) return draft.separatedMembers
  try { return JSON.parse(draft?.originSignature || '[]').map(row => row[0]).filter(id => typeof id === 'string') }
  catch (_) { return [] }
}

// 同步的只是待确认输入。真正的多个原决定仍由 confirmAccountGroups 原子保存。
function syncInput(group, drafts) {
  const joint = drafts.get(group.groupId)
  if (!joint || !joint.dirty) return []
  joint.confirmationIssueIds = group.issueIds.slice()
  const ids = []
  for (const id of group.issueIds) {
    const draft = drafts.get(id)
    if (!draft) continue
    for (const key of ['accountFacts', 'accountName', 'name', 'typeIndex', 'recommendedAccountId', 'explicitAccountSelection']) draft[key] = joint[key]
    // 已创建的共享账户改名，仍只有原创建者修改创建事实，其余来源保留显式复用。
    const reuse = joint.mode === 'create' && joint.createdAccountId && joint.creatorIssueId !== id
    draft.mode = reuse ? 'account' : joint.mode
    draft.accountId = reuse ? joint.createdAccountId : joint.accountId || ''
    draft.createdAccountId = joint.mode === 'create' && !reuse ? joint.createdAccountId || '' : ''
    draft.creatorIssueId = joint.creatorIssueId || ''
    draft.dirty = true; draft.localConfirmed = false; draft.revision = (draft.revision || 0) + 1
    ids.push(id)
  }
  return ids
}

function clearCoveredDrafts(drafts, confirmedIds, activeGroupIds) {
  for (const [key, draft] of Object.entries(drafts)) {
    const ids = draftIssueIds(draft)
    // 拆开／合回是本批显示关系；确认最后一个成员也不能把它删掉。
    if (!ids.length) continue
    const covered = ids.every(id => confirmedIds.has(id) || drafts[id]?.localConfirmed && !drafts[id]?.dirty)
    if (draft.separated || draft.confirmationDisplayMode === 'separated') {
      if (covered) { draft.dirty = false; draft.localConfirmed = false }
      continue
    }
    // A/B 旧决定已确认也不能解除合回后的待选；必须这次共同确认覆盖整组。
    if (draft.confirmationDisplayMode === 'joined') {
      if (!ids.every(id => confirmedIds.has(id))) continue
      // 共同确认后由原事项的已保存选择重建当前组；旧范围可能随后自动扩大。
      delete drafts[key]
      continue
    }
    if (activeGroupIds.has(key)) continue
    if (covered) delete drafts[key]
  }
}

function setDisplayGroup(drafts, groupId, issueIds, mode) {
  const ids = [...new Set(issueIds)].sort(), selected = new Set(ids)
  // 自动合组扩大后，新的显式拆分关系取代旧范围，不能同时留下重叠的显示组。
  for (const [id, draft] of drafts) if (id !== groupId && (draft.separated || draft.confirmationDisplayMode) &&
      draftIssueIds(draft).some(memberId => selected.has(memberId))) {
    delete draft.confirmationDisplayMode
    delete draft.separated
    delete draft.separatedMembers
    delete draft.separatedSnapshot
  }
  const joint = drafts.get(groupId) || {}
  joint.confirmationIssueIds = ids
  joint.confirmationDisplayMode = mode
  if (mode === 'separated') {
    joint.separated = true
    joint.separatedMembers = ids
  } else {
    delete joint.separated
    delete joint.separatedMembers
  }
  delete joint.separatedSnapshot
  drafts.set(groupId, joint)
  return joint
}

function initialDraft(group, rows, drafts, accountRows, typeOptions) {
  const prior = rows.map(row => drafts.get(row.issueId))
  const dirty = prior.some(draft => draft?.dirty)
  const values = new Set(prior.map(draft => draft?.mode === 'account' ? 'account:' + draft.accountId
    : draft?.mode === 'create' ? 'create:' + draft.name + ':' + draft.typeIndex : draft?.mode || 'pending'))
  const confirmedId = group.candidate === false ? group.accountId : null
  const selectedId = ['selected_account', 'manual_join'].includes(group.groupReason) ? group.selectedAccountId : null
  const creator = rows.find(row => {
    const draft = drafts.get(row.issueId)
    return draft?.mode === 'create' && draft.createdAccountId && draft.createdAccountId === (selectedId || group.accountId) &&
      (!selectedId || !draft.dirty)
  })
  const resolvedCreator = creator && drafts.get(creator.issueId)
  const preferredTypes = new Set(prior.map(draft => typeOptions[draft?.typeIndex]?.value))
  const allowed = group.allowedAccountTypes || []
  let mode = 'pending', accountId = '', name = group.label || '', recommendedAccountId = '', conflict = ''
  if (selectedId && prior.every(draft => draft?.mode === 'account' && draft.accountId === selectedId ||
      draft === resolvedCreator && draft?.createdAccountId === selectedId)) {
    mode = resolvedCreator ? 'create' : 'account'; accountId = selectedId
    if (resolvedCreator) name = resolvedCreator.name
  } else if ((dirty || group.groupReason === 'manual_join') && values.size > 1) conflict = '各来源已有不同选择，请选择共同账户或分别确认。'
  else if (confirmedId && !dirty) {
    mode = resolvedCreator ? 'create' : 'account'; accountId = confirmedId
    if (resolvedCreator) name = resolvedCreator.name
  } else if (values.size === 1 && prior[0]?.mode === 'account') {
    mode = 'account'; accountId = prior[0].accountId
    if (rows.every(row => row.recommendedAccountId === accountId)) recommendedAccountId = accountId
  } else if (prior.every(draft => draft?.mode === 'create') && !dirty) {
    if (preferredTypes.size === 1 && allowed.includes([...preferredTypes][0])) mode = 'create'
    else conflict = '各来源建议的账户类型不同，请选择共同账户或分别确认。'
  }
  else if (values.size === 1 && dirty) {
    mode = prior[0].mode; accountId = prior[0].accountId || ''; name = prior[0].name || name
  } else if (values.size > 1) conflict = '各来源的账户建议不同，请选择共同账户或分别确认。'
  const selected = accountRows.find(account => account.accountId === accountId)
  const preferred = resolvedCreator ? typeOptions[resolvedCreator.typeIndex]?.value
    : prior.length && prior.every(draft => draft?.typeIndex === prior[0]?.typeIndex) ? typeOptions[prior[0]?.typeIndex]?.value : null
  const selectedType = allowed.includes(preferred) ? preferred : allowed.length === 1 ? allowed[0] : null
  return { mode, accountId, accountFacts: selected || null, recommendedAccountId, name,
    explicitAccountSelection: mode === 'account' && (group.groupReason === 'selected_account' || prior.some(draft => draft?.explicitAccountSelection)),
    typeIndex: typeOptions.findIndex(option => option.value === selectedType), dirty,
    localConfirmed: Boolean(confirmedId && !dirty), revision: 0, conflict,
    confirmationIssueIds: group.issueIds.slice(),
    ...(resolvedCreator ? { createdAccountId: resolvedCreator.createdAccountId, creatorIssueId: creator.issueId } : {}) }
}

function fold({ mappings, groups = [], drafts, accounts, accountDrafts, typeOptions, ownershipNote }) {
  const byId = new Map(mappings.map(mapping => [mapping.issueId, mapping])), grouped = new Map(), children = new Set()
  const accountRows = accounts.concat(accountDrafts)
  for (const group of groups) {
    if (!Array.isArray(group.issueIds) || group.issueIds.length < 2 || !group.groupId || group.displayMode === 'separated') continue
    const rows = group.issueIds.map(id => byId.get(id))
    if (rows.some(row => !row || !row.inline || drafts.get(row.issueId)?.confirmationSeparate) ||
        rows.some(row => children.has(row.issueId))) continue
    const allowed = typeOptions.map(option => option.value).filter(type =>
      (group.allowedAccountTypes || []).includes(type) && rows.every(row => row.accountContext.allowedAccountTypes.includes(type)))
    const context = { label: group.label, recognized: true, expectedAccountType: null, allowedAccountTypes: allowed,
      currency: group.currency, sourceType: '', fundsSide: '' }
    const currentSignature = signature(rows, drafts)
    let draft = drafts.get(group.groupId)
    const changedSelection = ['selected_account', 'manual_join'].includes(group.groupReason) && group.selectedAccountId &&
      !(draft?.mode === 'account' && draft.accountId === group.selectedAccountId ||
        draft?.mode === 'create' && draft.createdAccountId === group.selectedAccountId)
    if (!draft || changedSelection || !draft.dirty && draft.originSignature !== currentSignature) {
      const displayMode = draft?.confirmationDisplayMode
      draft = initialDraft({ ...group, allowedAccountTypes: allowed }, rows, drafts, accountRows, typeOptions)
      if (displayMode) draft.confirmationDisplayMode = displayMode
      draft.originSignature = currentSignature
      drafts.set(group.groupId, draft)
    }
    const canExternal = group.canExternal === true && rows.every(row => row.canExternal)
    const choices = model.accountChoiceOptions(accounts, accountDrafts, { canExternal, context })
    const selected = accountRows.find(account => account.accountId === draft.accountId) ||
      (draft.accountFacts?.accountId === draft.accountId ? draft.accountFacts : null)
    const type = typeOptions[draft.typeIndex], validName = nameValid(draft.name)
    const nameConflict = draft.mode === 'create' && validName && accountRows.some(account =>
      account.accountId !== draft.createdAccountId && names.normalizeName(account.name).normalizedName === names.normalizeName(draft.name).normalizedName)
    const ready = draft.mode === 'create' ? validName && allowed.includes(type?.value) && !nameConflict
      : draft.mode === 'account' ? types.compatible(context, selected)
      : draft.mode === 'external' ? canExternal : draft.mode === 'ignore'
    const choiceValue = draft.mode === 'account' ? 'account:' + draft.accountId : draft.mode
    const choiceName = draft.mode === 'account' ? selected?.name || draft.accountName || '已选择账户'
      : choices.find(choice => choice.value === choiceValue)?.name || '请选择账户'
    const needsConfirmation = !ready || draft.dirty || (rows.some(row => row.needsConfirmation) && !draft.localConfirmed)
    const allowedOptions = typeOptions.filter(option => allowed.includes(option.value))
    const sources = group.sources || []
    // 卡片只显示一个交易总数；来源只说明来自哪里，不把分平台计数并列展示。
    const sourceTypes = new Set((group.sourceCounts || sources).map(source => source.sourceType))
    const sourceChips = [...sourceTypes].slice(0, 3).map(source => ({ label: sourceLabels[source] || '账单' }))
    const anchor = byId.get(group.anchorIssueId) || rows[0]
    const mapping = { ...anchor, issueId: group.groupId, groupId: group.groupId, groupIssueIds: group.issueIds.slice(),
      groupAnchorIssueId: group.anchorIssueId || rows[0].issueId, groupSources: sources,
      groupCandidate: group.candidate !== false, groupCanSeparate: true,
      groupReason: group.groupReason || '',
      groupHint: !needsConfirmation ? '' : group.groupReason === 'manual_join' ? group.selectedAccountId ? '已选择同一账户' : '请选择共同账户'
        : group.groupReason === 'selected_account' ? '已选择同一账户' : group.candidate !== false ? '可能同一张卡' : '',
      groupSourceCount: Number(group.sourceCount || sources.length), groupSourceChips: sourceChips,
      groupCountNote: countNote(group),
      groupConfirmationText: '这些交易使用同一账户',
      label: group.label, memberCount: group.memberCount, accountContext: context,
      status: rows.every(row => row.status === 'resolved') ? 'resolved' : 'open', paymentNeedsReview: false,
      canExternal, needsConfirmation, canConfirm: ready, dirty: draft.dirty,
      choiceMatchesTitle: !draft.dirty && titleMatchesChoice(group.label, draft.mode === 'create' ? draft.name : choiceName),
      choiceOptions: choices, choiceIndex: Math.max(0, choices.findIndex(choice => choice.value === choiceValue)), choiceValue, choiceName,
      suggestedExisting: Boolean(draft.recommendedAccountId && draft.mode === 'account' && draft.accountId === draft.recommendedAccountId),
      recommendedAccountId: draft.recommendedAccountId || '', draftName: draft.name, draftNameValid: validName,
      draftTypeIndex: draft.typeIndex, typeOptions: allowedOptions, typeLocked: allowedOptions.length <= 1,
      draftTypeOptionIndex: Math.max(0, allowedOptions.findIndex(option => option.value === type?.value)), draftTypeLabel: type?.label || '请选择类型',
      summaryText: ['ignore', 'external'].includes(draft.mode) ? choiceName : '记入：' +
        (draft.mode === 'create' ? draft.name + '（' + (type?.label || '') + '）' : choiceName) + ' · 已确认',
      ownershipNote: draft.mode === 'external' && rows.some(row => ownershipNote(row.subject)) ? '已记录归属，资金关系还要在整理页补齐。' : '',
      validationText: nameConflict ? names.NAME_CONFLICT : !allowed.length ? '各来源没有共同适用的账户类型，请分别确认。'
        : draft.mode === 'account' && !ready ? '所选账户类型或币种不符，请重新选择'
        : draft.mode === 'create' && !allowed.includes(type?.value) ? '账户类型与来源或资金角色不符，请重新选择'
        : draft.mode === 'pending' ? draft.conflict || '请选择共同账户，或分别确认。' : '' }
    grouped.set(group.groupId, mapping)
    for (const row of rows) children.add(row.issueId)
  }
  const groupByIssue = new Map()
  for (const group of grouped.values()) for (const id of group.groupIssueIds) groupByIssue.set(id, group)
  const emitted = new Set(), visible = []
  for (const row of mappings) {
    const group = groupByIssue.get(row.issueId)
    if (!group) visible.push(row)
    else if (!emitted.has(group.groupId)) { emitted.add(group.groupId); visible.push(group) }
  }
  // 一个联合选择只创建一次。不同显示卡仍不能靠同名悄悄共用新账户。
  const creates = new Map()
  for (const row of visible) if (row.inline && row.choiceValue === 'create' && row.draftNameValid) {
    const key = names.normalizeName(row.draftName).normalizedName
    if (!creates.has(key)) creates.set(key, [])
    creates.get(key).push(row)
  }
  for (const rows of creates.values()) if (rows.length > 1) for (const row of rows) if (row.needsConfirmation) {
    row.canConfirm = false; row.validationText = '多项新建账户同名，请分别命名，或新建一项后让其余项选择已有账户'
  }
  for (const row of visible) if (row.groupId && row.needsConfirmation) {
    for (const id of row.groupIssueIds) byId.get(id).needsConfirmation = true
  }
  return visible
}

module.exports = { fold, compact, isExcluded, countNote, syncInput, clearCoveredDrafts, setDisplayGroup, titleMatchesChoice, readOptions, readSignature }
