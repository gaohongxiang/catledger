const rules = require('../domain/import-review/organizer-model')
const editor = require('../domain/import-review/review/editor-policy')
const policy = require('../domain/import-review/review/policy')
const identity = require('../domain/import-review/local-review-identity')
const matching = require('../domain/import-review/bank-channel-matching')
const accountPolicy = require('../domain/import-review/review/account-mapping-policy')
const { createMappingIndex } = require('../domain/import-review/source-funds')
const { paymentReferenceKey } = require('../domain/import-review/payment-account')
const { publicEvent } = require('../domain/import-review/review-presentation')
const historyPolicy = require('../domain/import-review/historical-match-policy')
const attribution = require('../domain/import-review/installment-plan')
const business = require('../domain/import-review/installment-business')
const draftPolicy = require('../domain/import-review/account-draft-policy')
const accountTypes = require('../domain/import-review/account-type-policy')
const accountGrouping = require('../domain/import-review/account-issue-grouping')
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => { throw Object.assign(new Error(message || '这项选择需重新核对'), { code: 'LOCAL_RECHECK_REQUIRED' }) }
const active = event => event && ['ready','needs_action'].includes(event.status)
const distinct = value => [...new Set(value)]
const sourceOf = event => event.fieldSources || {}
const KINDS = ['accounts','events','pairings','reviews','duplicates']
const editableIssues = new Set(['shared_fields','transfer_accounts','category_assignment','refund_relation'])

function create(facts) {
  const base = new Map(facts.events.map(event => [event.eventId, event]))
  const events = new Map(base), rows = new Map(facts.rows.map(row => [row.rowId, row]))
  const evidence = new Map(facts.evidence.map(row => [row.evidenceId, { ...row }]))
  const byEvent = new Map(), baseEvidence = new Map(), issueEvents = new Map(), relations = new Map(facts.relations.map(row => [row.relationId, { ...row }]))
  const issues = new Map(facts.issues.map(row => [row.issueId, clone(row)])), members = new Map(), originalMembersByIssue = new Map()
  const accounts = new Map(facts.accounts.concat(facts.accountDrafts).map(row => [row.accountId, { ...row }]))
  const drafts = new Map(facts.accountDrafts.map(row => [row.accountId, row]))
  const creationOwners = new Map()
  const categories = new Map(facts.categories.map(row => [row.categoryId, row]))
  const choices = Object.fromEntries(KINDS.map(kind => [kind, new Map()]))
  const links = facts.links.map(row => ({ ...row })), needsCheck = new Set(), invalid = new Map()
  let revision = 0, supplemental = null, summaryCache = null
  let businessRevision = -1, businessByRow = new Map(), offsetsByMain = new Map()
  function businessIndex() {
    if (businessRevision === revision) return
    const linked = new Set(links.filter(link => !link.supersededAt).map(link => link.eventId))
    const values = [...events.values()].map(event => linked.has(event.eventId) ? { ...event, hasTransaction: true } : event)
    businessByRow = business.indexByRow(values)
    offsetsByMain = new Map()
    for (const event of values) if (business.hiddenOffset(event, businessByRow)) {
      const main = businessByRow.get(business.hintOf(event).partnerRowId)
      if (!offsetsByMain.has(main.eventId)) offsetsByMain.set(main.eventId, [])
      offsetsByMain.get(main.eventId).push(event.eventId)
    }
    businessRevision = revision
  }
  function hiddenOffset(event) {
    businessIndex()
    const indexed = businessByRow.get((event.fieldSources.rowIds || [])[0]) || event
    return business.hiddenOffset(indexed, businessByRow)
  }
  function evidenceFor(id) {
    businessIndex()
    return (byEvent.get(id) || []).concat((offsetsByMain.get(id) || []).flatMap(other =>
      (byEvent.get(other) || []).filter(link => link.evidenceRole !== 'discarded')))
  }
  let coverageByEvent = new Map(facts.historyCoverage.duplicates.map(row => [row.eventId, row]))
  const historyIndex = new Map(), historySignatures = new Map()
  let historyDiscarded=[]
  function indexHistory(){
    historyIndex.clear()
    for(const row of (supplemental||facts).history)for(const key of ['outflow:'+row.sourceAccountId,'inflow:'+row.destinationAccountId,'neutral:'+row.sourceAccountId+':'+row.destinationAccountId]){
      const id=key+':'+row.amountMinor;if(!historyIndex.has(id))historyIndex.set(id,[]);historyIndex.get(id).push(row)
    }
  }
  indexHistory()
  const dirtyEvents = new Set(), dirtyIssues = new Set(), dirtyRows = new Set()
  const subjectPositions = new WeakMap()
  function removeSubject(issue, id) {
    const ids = issue.subjectEventIds
    let positions = subjectPositions.get(ids)
    if (!positions) { positions = new Map(ids.map((value, index) => [value, index])); subjectPositions.set(ids, positions) }
    const index = positions.get(id)
    if (index == null) return
    const last = ids.pop(); positions.delete(id)
    if (index < ids.length) { ids[index] = last; positions.set(last, index) }
    dirtyIssues.add(issue.issueId)
  }
  const relationIds = new Map(), relationNodes = new Map()
  function indexRelation(relation) {
    for(const id of relationNodes.get(relation.relationId)||[])relationIds.get(id)?.delete(relation.relationId)
    const ids=[relation.sourceEventId,relation.targetEventId]
    relationNodes.set(relation.relationId,ids)
    for(const id of ids){if(!relationIds.has(id))relationIds.set(id,new Set());relationIds.get(id).add(relation.relationId)}
  }
  for(const relation of relations.values())indexRelation(relation)
  const related = id => [...(relationIds.get(id)||[])].map(key=>relations.get(key))
  // Candidate buckets keep a field edit from scanning the entire import. Account
  // decisions intentionally touch the exact group's members, even across pages.
  const buckets = new Map(), eventBuckets = new Map(), bucketBanks = new Map(), eventBank = new Map()
  const pairs = new Map(), eventPairs = new Map(), suggestedPairs = new Set(), pairSignatures = new Map()
  function rowIds(id) { return (byEvent.get(id) || []).filter(row => row.evidenceRole !== 'discarded').map(row => row.rowId) }
  for (const row of evidence.values()) {
    if (!byEvent.has(row.eventId)) byEvent.set(row.eventId, [])
    byEvent.get(row.eventId).push(row)
    if (!baseEvidence.has(row.eventId)) baseEvidence.set(row.eventId, [])
    baseEvidence.get(row.eventId).push({ ...row })
  }
  for (const row of facts.members) {
    if (!members.has(row.issueId)) members.set(row.issueId, [])
    members.get(row.issueId).push({ ...row })
    if (row.objectType === 'event' && row.memberRole !== 'candidate') {
      if (!originalMembersByIssue.has(row.issueId)) originalMembersByIssue.set(row.issueId, [])
      originalMembersByIssue.get(row.issueId).push(row)
      if (!issueEvents.has(row.objectId)) issueEvents.set(row.objectId, new Set())
      issueEvents.get(row.objectId).add(row.issueId)
    }
  }
  function hydrate(event) {
    return { ...event, sourceType: rows.get(rowIds(event.eventId)[0])?.sourceType,
      relationEvidence: { rows: rowIds(event.eventId).map(id => {
        const link = (byEvent.get(event.eventId) || []).find(row => row.rowId === id)
        return { ...rows.get(id), identityKind: link.identityKind }
      }) }, ledgerAccountFacts: accounts.get(event.ledgerAccountId), counterpartyAccountFacts: accounts.get(event.counterpartyLedgerAccountId) }
  }
  function bucket(event) {
    if (!active(event)) return null
    // The repayment pair's debit includes a fee: amount is deliberately not a
    // bucket discriminator. The authoritative matcher still verifies all facts.
    return event.economicNature === 'repayment' ? 'repayment:' + String(event.localAt || '').slice(0,10)
      : [event.ledgerAccountId || '', event.amountMinor, event.currency, String(event.localAt || '').slice(0,16)].join(':')
  }
  function indexEvent(event) {
    const old = eventBuckets.get(event.eventId), key = bucket(event)
    if (old) { buckets.get(old)?.delete(event.eventId); if (eventBank.get(event.eventId)) bucketBanks.set(old,(bucketBanks.get(old)||0)-1) }
    eventBuckets.delete(event.eventId)
    const bank = rows.get(rowIds(event.eventId)[0])?.sourceType === 'bank'; eventBank.set(event.eventId,bank)
    if (key) { if (!buckets.has(key)) buckets.set(key, new Set()); buckets.get(key).add(event.eventId); eventBuckets.set(event.eventId, key); if(bank)bucketBanks.set(key,(bucketBanks.get(key)||0)+1) }
    return old
  }
  function pairSignature(event) {
    if (!event) return ''
    return JSON.stringify([active(event),event.ledgerAccountId,event.counterpartyLedgerAccountId,event.amountMinor,event.currency,event.utcAt,
      event.economicNature,event.flowDirection,event.manualFieldMask&128?event.categoryId:null,
      event.reasonCodes.filter(code=>!['blocking_issue_open','same_event_candidate','relation_ambiguous',matching.REASON].includes(code)).sort(),
      event.fieldSources.bankChannelDistinctPairs,event.fieldSources.repaymentOwnership,event.fieldSources.editorOverrides?.composition,
      Boolean(event.fieldSources.loanRepayment||event.fieldSources.paymentResolution||event.fieldSources.installment||event.fieldSources.mergeOrigins)])
  }
  function eventIssues(id) { return [...(issueEvents.get(id) || [])].map(key => issues.get(key)).filter(Boolean) }
  function addIssue(event, type, reason, key, group = [event.eventId]) {
    const issueId = key || identity.stableId('issue', facts.snapshotId, type, reason, ...group)
    let issue = issues.get(issueId)
    if (!issue) {
      issue = { issueId, issueType: type, primaryReasonCode: reason, reasonCodes: [reason], status: 'open', blocking: type !== 'category_assignment',
        version: 1, memberCount: group.length, candidateCount: 0, subjectEventIds: group, localDerived: true }
      issues.set(issueId, issue)
      members.set(issueId, group.map((id, index) => ({ memberId: identity.stableId(issueId, id), issueId,
        objectType: 'event', objectId: id, objectVersion: events.get(id)?.version || 1, memberRole: 'subject', sortOrder: index })))
      for (const id of group) { if (!issueEvents.has(id)) issueEvents.set(id, new Set()); issueEvents.get(id).add(issueId) }
    } else { issue.status = 'open'; issue.blocking = type !== 'category_assignment'; issue.version++ }
    dirtyIssues.add(issueId)
    return issue
  }
  function sourceIds(ids) { return distinct(ids.flatMap(rowIds)).sort() }
  function scope(issue, ids = issue.subjectEventIds) {
    return { key: issue.issueId, issueId: issue.issueId, issueType: issue.issueType, reasonCode: issue.primaryReasonCode,
      eventIds: [...ids], sourceIds: sourceIds(ids) }
  }
  function dependencies(ids) {
    const result = new Set(ids)
    for (const id of ids) for (const relation of related(id)) {
      result.add(relation.sourceEventId); result.add(relation.targetEventId)
    }
    for (const key of ids) for (const pairKey of eventPairs.get(key) || []) {
      const pair = pairs.get(pairKey); if (pair) { result.add(pair.bank.eventId); result.add(pair.platform.eventId) }
    }
    return result
  }
  function context(id) {
    return { relations: related(id),
      transactionLinks: links.filter(row => row.eventId === id) }
  }
  function covered(event) {
    const old = coverageByEvent.get(event.eventId)
    return old && ['amountMinor','utcAt','ledgerAccountId','counterpartyLedgerAccountId','flowDirection'].every(key => old[key] === event[key])
  }
  function refreshHistory(event) {
    const signature=JSON.stringify([active(event),event.ledgerAccountId,event.counterpartyLedgerAccountId,event.flowDirection,event.amountMinor,event.utcAt])
    if(historySignatures.get(event.eventId)===signature)return
    historySignatures.set(event.eventId,signature)
    // The original covered candidate set already includes server-only identity
    // and fee exclusions. Field changes use only the downloaded references.
    if(covered(event))return
    const prior=eventIssues(event.eventId).filter(issue=>issue.primaryReasonCode===historyPolicy.REASON)
    for(const issue of prior){issue.status='superseded';issue.blocking=false;dirtyIssues.add(issue.issueId)}
    for(const [key,choice]of choices.reviews)if(choice.reasonCode===historyPolicy.REASON&&choice.eventIds.includes(event.eventId)){
      choices.reviews.delete(key);historyDiscarded.push({kind:'reviews',key,value:null})
    }
    const key=event.flowDirection+':'+event.ledgerAccountId+(event.flowDirection==='neutral'?':'+event.counterpartyLedgerAccountId:'')+':'+event.amountMinor
    const linked=new Set(rowIds(event.eventId).map(id=>rows.get(id)?.existingTransactionId).filter(Boolean))
    const installment = event.fieldSources.installment, catalog = supplemental || facts
    if (installment) for (const contract of catalog.contracts.filter(row => row.accountId === event.ledgerAccountId && row.referenceKey === installment.referenceKey)) {
      for (const charge of catalog.charges) if (charge.contractId === contract.contractId && charge.chargeKey === `period:${installment.periodNumber}:${installment.component}` && charge.transactionId) linked.add(charge.transactionId)
    }
    const candidates=(historyIndex.get(key)||[]).filter(row=>!linked.has(row.transactionId)&&historyPolicy.matches(event,row)).map(row=>({transactionId:row.transactionId,version:Number(row.version)})).sort((a,b)=>a.transactionId.localeCompare(b.transactionId))
    if(!candidates.length)return
    const group={eventId:event.eventId,accountId:event.ledgerAccountId,otherAccountId:event.counterpartyLedgerAccountId,flowDirection:event.flowDirection,amountMinor:event.amountMinor,utcAt:event.utcAt,candidates}
    const issue=addIssue(event,'same_event',historyPolicy.REASON,identity.stableId('history',historyPolicy.groupKey(group)))
    issue.localDerived=false;issue.candidateCount=candidates.length
    members.set(issue.issueId,[{memberId:identity.stableId(issue.issueId,event.eventId),objectType:'event',objectId:event.eventId,objectVersion:event.version,memberRole:'subject'},
      ...candidates.map(row=>({memberId:identity.stableId(issue.issueId,row.transactionId),objectType:'transaction',objectId:row.transactionId,objectVersion:row.version,memberRole:'candidate'}))])
  }
  function derive(id) {
    let event = events.get(id); if (!event) {
      const old=eventBuckets.get(id);if(old){buckets.get(old)?.delete(id);if(eventBank.get(id))bucketBanks.set(old,(bucketBanks.get(old)||0)-1);eventBuckets.delete(id)}
      return
    }
    event = { ...event, fieldSources: { ...event.fieldSources }, reasonCodes: [...event.reasonCodes] }
    refreshHistory(event)
    const relevant = eventIssues(id)
    const open = relevant.filter(issue => issue.status === 'open' && issue.blocking &&
      !editableIssues.has(issue.issueType) && !issue.localDerived && issue.issueType !== 'account_mapping')
    event.reasonCodes = event.reasonCodes.filter(reason => reason !== 'blocking_issue_open')
    if (active(event)) {
      const evaluated = rules.evaluatePostability(event, { ...context(id), openBlockingIssues: open.length })
      Object.assign(event, evaluated)
    }
    for (const issue of relevant) if (issue.localDerived && issue.primaryReasonCode !== matching.REASON) {
      issue.status = 'superseded'; issue.blocking = false
    }
    // 已经在一条阻断事项里的记录，服务端 createFollowUpIssues 不会再为它补建事项（occupied 里的 '*'）。
    // 本机同理：blocking_issue_open 只表示“去那条事项处理”，拿它当分类依据会派生一条 shared_fields，
    // 卡面于是多出“交易信息待核对”，而真正的待办（利息待归属）就在旁边。
    if (active(event) && !event.reasonCodes.includes('blocking_issue_open') &&
      (event.status === 'needs_action' || rules.needsCategory(event))) {
      const classification = rules.classifyReviewIssue(event)
      // 同一个账户组可能同时含普通付款与组合成分，两者的缺账户原因码不同。
      // 已有服务端账户待办承接该事件时，不能再按原因码派生一条单笔账户组。
      const existing = relevant.find(issue => issue.status === 'open' &&
        (issue.primaryReasonCode === classification.primaryReason ||
          classification.issueType === 'account_mapping' && issue.issueType === 'account_mapping' && !issue.localDerived))
      if (!existing) addIssue(event, classification.issueType, classification.primaryReason)
    }
    const refundCoverage = event.economicNature === 'refund' && (supplemental || facts).historyCoverage.refunds.find(row => row.eventId === id)
    const refundUncovered = event.economicNature === 'refund' && (!refundCoverage?.complete || ['amountMinor','utcAt','ledgerAccountId'].some(key => refundCoverage[key] !== event[key]))
    if (active(event) && (!covered(event) || refundUncovered)) needsCheck.add(id); else needsCheck.delete(id)
    events.set(id, event); indexEvent(event)
  }
  function rebuildPairs(ids, oldKeys = []) {
    const keys = new Set([...oldKeys, ...ids.map(id => eventBuckets.get(id)).filter(Boolean)])
    const affected = new Set(ids)
    for (const key of keys) if (bucketBanks.get(key)) for(const id of buckets.get(key)||[])affected.add(id)
    for (const id of affected) for (const key of eventPairs.get(id) || []) {
      const pair = pairs.get(key)
      if (pair) { affected.add(pair.bank.eventId); affected.add(pair.platform.eventId); pairs.delete(key);suggestedPairs.delete(key) }
    }
    for (const id of affected) eventPairs.set(id, new Set())
    for (const key of keys) {
      if (!bucketBanks.get(key)) continue
      const available = [...(buckets.get(key) || [])].map(id => events.get(id)).filter(Boolean).map(hydrate)
      for (const pair of matching.bankChannelEdges(available)) {
        if (pairs.size >= 10000 && !pairs.has(pair.pairKey)) throw Object.assign(new Error('同笔候选超过当前容量，请缩小来源后重新准备'), { code: 'LOCAL_REVIEW_CAPACITY' })
        pairs.set(pair.pairKey, pair)
        for (const event of [pair.bank,pair.platform]) {
          affected.add(event.eventId)
          if (!eventPairs.has(event.eventId)) eventPairs.set(event.eventId, new Set())
          eventPairs.get(event.eventId).add(pair.pairKey)
        }
      }
    }
    for (const id of affected) {
      const event = events.get(id); if (!event) continue
      const pending = (eventPairs.get(id) || new Set()).size
      const reasonCodes = event.reasonCodes.filter(code => code !== matching.REASON)
      if (pending) reasonCodes.push(matching.REASON)
      events.set(id, { ...event, reasonCodes, fieldSources: { ...event.fieldSources, bankChannelCandidate: pending ? { version:matching.VERSION } : undefined } })
      for (const issue of eventIssues(id)) if (issue.primaryReasonCode === matching.REASON) { issue.status = 'superseded'; issue.blocking = false }
      if (pending) {
        const group = distinct([...eventPairs.get(id)].flatMap(key => { const pair = pairs.get(key); return [pair.bank.eventId,pair.platform.eventId] })).sort()
        addIssue(event, 'same_event', matching.REASON, null, group)
      }
      derive(id)
      pairSignatures.set(id,pairSignature(events.get(id)))
    }
    for(const id of affected)for(const key of eventPairs.get(id)||[]){const pair=pairs.get(key);if(eventPairs.get(pair.bank.eventId)?.size===1&&eventPairs.get(pair.platform.eventId)?.size===1)suggestedPairs.add(key);else suggestedPairs.delete(key)}
    return affected
  }
  function validateReferences(event) {
    const references = require('../domain/import-review/workbench-summary').accountIds(event)
    for (const id of references) { const value = accounts.get(id); if (!value || value.archivedAt || value.supersededAt || value.currency !== event.currency) fail('账户不可用，请重新选择') }
    if (event.fieldSources.accountOwnership && require('../domain/import-review/account-ownership').resolve(event, { accounts }).reasons
      .some(reason => ['account_ownership_invalid','account_ownership_business_required'].includes(reason))) fail('账户归属与资金方向不一致，请重新选择')
    if (!require('../domain/import-review/editor-fields').accountRolesValid(event, accounts)) {
      if (event.economicNature === 'repayment') fail('还款的还入账户需是信用卡或负债账户')
      if (event.economicNature === 'borrow') fail('借款的账户类型与资金方向不匹配')
      fail('账户类型与资金方向不一致')
    }
    if (event.categoryId) {
      const category = categories.get(event.categoryId)
      if (!category || category.archivedAt || category.kind !== editor.kind(event.economicNature)) fail('分类不可用，请重新选择')
    }
  }
  // 本批原消费的展示事实：商户和商品分开取，前端不再把整串备注当卡片标题。
  function candidateFacts(row) { const first = (byEvent.get(row.eventId) || []).find(link => link.evidenceRole === 'primary') || (byEvent.get(row.eventId) || [])[0]
    const source = first && rows.get(first.rowId)
    return { merchant: String(source?.counterparty || '').trim(), item: String(source?.item || '').trim(),
      sourceType: source?.sourceType || '',
      // 账户还没映射时 paymentMethodKey 为空，退回账单里那串支付方式原文（同一张卡文字也一致）。
      paymentMethodKey: String(source?.paymentMethodKey || source?.paymentMethod || '').normalize('NFKC').trim() } }
  // 退款与原消费是否说得通，用同一份纯规则（与服务端实现逐字节一致）判断，
  // 不再把“本批所有支出”一股脑列成候选。证据行取自本机快照的 parse 结果。
  const refundPolicy = require('../domain/import-review/refund-relation-policy')
  const evidenceMatching = require('../domain/import-review/evidence-matching')
  const MATCH_RANK = { exact_reference: 1, explicit_refund_evidence: 2, item_evidence: 3, merchant_evidence: 4 }
  // 服务端整理时已经会标“原单关闭却退款成功”，但旧草稿是在规则更新前整理的。
  // 这里用同一份纯规则在本机再算一次（幂等），避免同一笔在新旧草稿里显示成两种状态。
  {
    const conflictPolicy = require('../domain/import-review/refund-source-conflict')
    const probe = [...events.values()].map(event => ({ ...event,
      relationEvidence: relationEvidenceFor(event).relationEvidence, rows: undefined }))
    for (const { refund, originals } of conflictPolicy.findRefundSourceConflicts(probe)) {
      const current = events.get(refund.eventId)
      if (!current) continue
      current.reasonCodes = [...new Set([...(current.reasonCodes || []), 'refund_source_conflict'])]
      current.fieldSources = { ...current.fieldSources, refundSourceConflict: { version: 1,
        originalEventIds: originals.map(original => original.eventId).sort() } }
      if (current.status === 'ready') current.status = 'needs_action'
      // 旧草稿里这条还是“待关联原消费”；本机补上冲突后，事项的原因也要跟着换，
      // 否则列表标题和弹层会各说一套。
      for (const issueId of issueEvents.get(current.eventId) || []) {
        const issue = issues.get(issueId)
        if (!issue || issue.issueType !== 'refund_relation' || issue.status !== 'open') continue
        issue.primaryReasonCode = 'refund_source_conflict'
        issue.reasonCodes = [...new Set([...(issue.reasonCodes || []), 'refund_source_conflict'])]
        issue.version = Number(issue.version || 1) + 1
      }
    }
  }



  function relationEvidenceFor(event) {
    const linksOf = byEvent.get(event.eventId) || []
    const primary = linksOf.find(link => link.evidenceRole === 'primary') || linksOf[0]
    const primaryRow = primary && rows.get(primary.rowId)
    const evidenceRows = linksOf.map(link => rows.get(link.rowId)).filter(Boolean).map(row => ({ sourceType: row.sourceType,
      sourceProfileId: row.sourceProfileId || '', counterparty: row.counterparty || '', item: row.item || '',
      // 稳定引用（交易号／订单号／商户单号）决定“订单号一致”这一档，漏掉就永远匹配不上。
      sourceTransactionId: row.sourceTransactionId, sourceOrderId: row.sourceOrderId,
      sourceMerchantOrderId: row.sourceMerchantOrderId,
      direction: row.direction, currency: row.currency, utcAt: row.utcAt,
      amountMinor: row.amountMinor == null ? null : String(row.amountMinor),
      sourceAction: row.semantic && row.semantic.sourceAction, moneyEffect: row.semantic && row.semantic.moneyEffect,
      relationHints: row.semantic && row.semantic.relationHints }))
    return { sourceType: primaryRow && primaryRow.sourceType,
      display: { counterparty: primaryRow && primaryRow.counterparty || '' },
      relationEvidence: { scopedStableReferences: [...new Set(evidenceRows.flatMap(evidenceMatching.scopedStableReferences))], rows: evidenceRows } }
  }
  function refundCandidateEligible(refund, original) {
    if (!original || original.eventId === refund.eventId || !active(original)) return false
    if (!['expense', 'fee'].includes(original.economicNature)) return false
    if (sourceOf(original).paymentResolution || sourceOf(original).loanRepayment || sourceOf(original).installment) return false
    if ((original.reasonCodes || []).some(code => ['row_status_unknown', 'refund_source_conflict'].includes(code))) return false
    if (original.currency !== refund.currency || refund.amountMinor == null || original.amountMinor == null) return false
    if (BigInt(original.amountMinor) < BigInt(refund.amountMinor)) return false
    const refundTime = String(refund.utcAt || ''), originalTime = String(original.utcAt || '')
    if (!refundTime || !originalTime || originalTime > refundTime) return false
    // 本批账户可能还没映射，先用支付方式兜底：不同卡/钱包不可能是同一笔。
    const refundKey = candidateFacts(refund).paymentMethodKey, originalKey = candidateFacts(original).paymentMethodKey
    return !(refundKey && originalKey && refundKey !== originalKey)
  }
  function refundCandidates(event, kind, options = {}) {
    const scope = options && options.scope === 'all' ? 'all' : 'matched'
    // 本批原消费全部来自本机快照；已入账候选来自随快照一起下载的历史引用，
    // 两者都不需要再向服务端查询。
    // 表只有一个形状：refundCandidates 是行数组（快照编解码在服务端和本机都按表逐行展开），
    // 覆盖情况是单独的 metadata。旧快照没有这个字段时按“未覆盖”处理，暂记仍走服务端复核。
    const supplementalFacts = supplemental || facts
    const coverage = supplementalFacts.refundCandidatesCovered
    const historyComplete = Boolean(coverage && coverage.covered)
    const history = (supplementalFacts.refundCandidates || []).map(row => ({ ...row, merchant: row.merchant || '', item: row.item || '', sourceType: row.sourceType || '' }))
    const shape = row => ({ id: row.eventId, version: row.version, kind: 'event', localAt: row.localAt, utcAt: row.utcAt,
      amountMinor: row.amountMinor, currency: row.currency, note: row.fieldSources.editorOverrides?.note || '',
      ...candidateFacts(row), remainingMinor: row.amountMinor })
    const batch = kind === 'event' ? [...events.values()].filter(row => refundCandidateEligible(event, row)) : []
    const candidates = kind === 'event' ? (() => {
      // 默认只保留“能解释得通”的候选，并且只取证据最强的一档：
      // 原单写明已退金额 > 商品名一致 > 同一商户。都没有时给空态，而不是列一堆无关消费。
      const refundEvidence = relationEvidenceFor(event)
      const matched = batch.map(row => ({ row, matchKind: refundPolicy.matchKind(refundEvidence, relationEvidenceFor(row)) }))
        .filter(item => item.matchKind)
      if (!matched.length) return []
      const best = Math.min(...matched.map(item => MATCH_RANK[item.matchKind]))
      const byTime = (left, right) => String(right.row.utcAt).localeCompare(String(left.row.utcAt))
      const strong = matched.filter(item => MATCH_RANK[item.matchKind] === best).sort(byTime)
      // 用户明确要求“显示本批全部消费”时才放开到全部可用支出，并仍然排在匹配项后面。
      const rest = scope === 'all' ? batch.filter(row => !strong.some(item => item.row.eventId === row.eventId))
        .map(shape).sort((left, right) => String(right.utcAt).localeCompare(String(left.utcAt))) : []
      return strong.map(item => ({ ...shape(item.row), matchKind: item.matchKind })).concat(rest.map(row => ({ ...row, matchKind: '' })))
    })() : history
    const result = candidates.filter(row => row.utcAt && event.utcAt && row.utcAt <= event.utcAt && row.currency === event.currency).map(row => {
      let used = 0n
      if (kind === 'event') { for (const relation of related(row.id)) if (relation.relationType === 'refund_of' && relation.status === 'confirmed' &&
        relation.targetEventId === row.id && relation.sourceEventId !== event.eventId && active(events.get(relation.sourceEventId))) used += BigInt(events.get(relation.sourceEventId).amountMinor)
      } else if (kind === 'transaction') { for (const link of links) if (link.role === 'refund_original' && link.transactionId === row.id && link.eventId !== event.eventId && active(events.get(link.eventId))) used += BigInt(events.get(link.eventId).amountMinor) }
      return { ...row, remainingMinor: String(BigInt(row.remainingMinor || 0) - used) }
    }).filter(row => event.amountMinor != null && BigInt(row.remainingMinor) >= BigInt(event.amountMinor))
    // 同订单的消费已经“交易关闭/失败”时它不会进候选（没实际扣款），但用户需要知道原因，
    // 否则界面只剩“没有能退这笔的消费”，看起来像系统没找到。
    const closedOriginal = kind === 'event' ? [...events.values()].find(row => row.eventId !== event.eventId &&
      !active(row) && (row.reasonCodes || []).some(reason => ['transaction_closed', 'transaction_failed'].includes(reason)) &&
      relationEvidenceFor(row).relationEvidence.scopedStableReferences
        .some(ref => relationEvidenceFor(event).relationEvidence.scopedStableReferences.includes(ref))) : null
    // 已入账候选是否覆盖完整由下载范围决定；本批永远完整。
    return Object.assign(result, { historyComplete: kind === 'event' ? true : historyComplete,
      closedOriginal: closedOriginal ? { eventId: closedOriginal.eventId, amountMinor: closedOriginal.amountMinor,
        localAt: closedOriginal.localAt } : null })
  }
  // 与服务端 review/editor-refund 同口径：暂记是用户决定，候选数量和其他待核对项都不能
  // 替用户拒绝；只有来源冲突（原单已关闭/失败）必须走“按已退回处理”，不能暂记。
  function refundPendingState(event) {
    if (!event || event.economicNature !== 'refund') return { allowed: false, reason: 'not_refund' }
    const sourceConflict = Boolean(event.fieldSources && event.fieldSources.refundSourceConflict) ||
      (event.reasonCodes || []).includes('refund_source_conflict')
    return sourceConflict ? { allowed: false, reason: 'source_conflict' } : { allowed: true, reason: '' }
  }
  function applyRefund(current, next, data) {
    const choice = next.economicNature === 'refund' && next.status === 'excluded' &&
      require('../domain/import-review/account-ownership').read(next).noLedgerImpact === true
      ? { mode: 'unlinked' } : data.decisions?.refund
    if (choice || next.economicNature !== 'refund') {
      for (const relation of related(next.eventId)) if (relation.sourceEventId === next.eventId && relation.relationType === 'refund_of') relation.status = 'rejected'
      for (let i = links.length - 1; i >= 0; i--) if (links[i].eventId === next.eventId && links[i].role === 'refund_original') links.splice(i, 1)
      delete next.fieldSources.refundRelation
    }
    if (!choice) return
    if (choice.mode === 'link') {
      const target = refundCandidates(next, choice.kind).find(row => row.id === choice.id)
      if (!target || choice.kind === 'transaction' && target.version !== choice.version) fail('原消费或可退额度已变化，请重新选择')
      if (choice.kind === 'event') {
        const id = identity.stableId('refund', next.eventId, choice.id)
        relations.set(id, { relationId: id, relationType: 'refund_of', status: 'confirmed', sourceEventId: next.eventId,
          targetEventId: choice.id, amountMinor: next.amountMinor, currency: next.currency, version: 1, manual: true })
        indexRelation(relations.get(id))
      } else links.push({ eventId: next.eventId, transactionId: choice.id, transactionVersion: choice.version, role: 'refund_original' })
    } else if (choice.mode === 'pending') {
      const pending = refundPendingState(next)
      if (!pending.allowed) fail(pending.reason === 'source_conflict' ? '原消费已关闭或失败，请按已退回处理' : '这笔不是退款，不能暂记')
      next.fieldSources.refundRelation = { version: rules.REFUND_RELATION_STATE_VERSION, status: 'pending', confirmedBy: 'user' }
      const coverage = (supplemental || facts).historyCoverage.refunds.find(row => row.eventId === next.eventId)
      if (!coverage || !coverage.complete || ['amountMinor','utcAt','ledgerAccountId'].some(key => coverage[key] !== next[key])) needsCheck.add(next.eventId)
    }
    // 已经做出退款关系决定，就要把“退款关系待确认”类阻断从事件上摘掉，
    // 否则它作为硬阻断会一直留着，界面上点了保存还是待核对（与服务端同一口径）。
    const openSameEvent = [...issues.values()].some(issue => issue.status === 'open' && issue.issueType === 'same_event' &&
      issue.subjectEventIds.includes(next.eventId))
    next.reasonCodes = (next.reasonCodes || []).filter(reason => reason !== 'relation_ambiguous' || openSameEvent)
    next.reasonCodes = next.reasonCodes.filter(reason => !['refund_relation_required', 'refund_relation_invalid',
      'refund_relation_ambiguous', 'refund_amount_exceeded'].includes(reason))
  }
  // 分期归属是整组的事实，不是单笔的字段：本机保存了决定，就要按服务端同一口径收尾
  // （installment-plan.needsAttribution + releaseInstallmentGroup）。缺了这一步，事项永远开着，
  // 整组都挂着 blocking_issue_open——用户看到的就是“利息选好了，却还在待核对”。
  function dropMember(issue, id) {
    removeSubject(issue, id)
    const rows = members.get(issue.issueId)
    if (rows) members.set(issue.issueId, rows.filter(row => !(row.objectType === 'event' && row.objectId === id)))
  }
  function releaseInstallmentGroups(ids) {
    const released = new Set()
    for (const issueId of new Set([...ids].flatMap(id => [...(issueEvents.get(id) || [])]))) {
      const issue = issues.get(issueId)
      if (!issue || issue.status !== 'open' || issue.primaryReasonCode !== attribution.REASON_CODE) continue
      const rows = (members.get(issue.issueId) || []).filter(row => row.objectType === 'event' && row.memberRole !== 'candidate')
      // 本期次还有判不出归属的费用就继续留着；全部指定完，这条事项一起收尾。
      // 本金和已归好的费用本来就不在成员里，不需要“连坐”它们。
      if (rows.some(row => attribution.needsAttribution(events.get(row.objectId)))) continue
      for (const row of rows) released.add(row.objectId)
      // 先指定完的那几笔上一轮就退出了成员，但当时事项还开着，它们仍带着 blocking_issue_open。
      // 整组收尾时要把同一期次的行一起重新推导，否则只有本笔那几行回到已核对，先指定的停在待核对。
      const groupKey = attribution.groupKeyOf(events.get(rows[0].objectId))
      for (const event of events.values()) if (groupKey && attribution.groupKeyOf(event) === groupKey) released.add(event.eventId)
      issue.subjectEventIds = []
      issue.status = 'resolved'; issue.blocking = false; issue.version++
      dirtyIssues.add(issue.issueId)
    }
    // 收尾后本金行的组上下文已经过期，跟着撤掉，和整理阶段“没有待指定费用就不再写”保持一致。
    for (const id of released) {
      const event = events.get(id), context = sourceOf(event).installmentAttribution
      if (context && context.role === 'principal') {
        events.set(id, { ...event, fieldSources: { ...event.fieldSources, installmentAttribution: undefined } })
      }
    }
    return released
  }
  function refreshInstallmentMember(id, event) {
    // 本金行不带原因码、也不是事项成员；这里只处理“这笔费用已经指定完”的退出。
    const context = sourceOf(event).installmentAttribution
    if (!context || context.role !== 'charge' || attribution.needsAttribution(event)) return
    let dropped = false
    for (const issue of eventIssues(id)) if (issue.status === 'open' && issue.primaryReasonCode === attribution.REASON_CODE) {
      // 已经指定完的这笔不再需要在“利息待归属”里出现。
      dropMember(issue, id)
      // 事项还可能开着，因为同组别的利息没定；但这笔已经不是成员了。
      // 反向索引留着，derive 就会继续读到 blocking_issue_open——只指定一笔时，
      // 指定完的这笔停在待核对，卡面也还写着“利息待归属”，直到整组都指定完才一起放行。
      const keys = issueEvents.get(id)
      if (keys) { keys.delete(issue.issueId); if (!keys.size) issueEvents.delete(id) }
      if (!issue.subjectEventIds.length) { issue.status = 'resolved'; issue.blocking = false; issue.version++ }
      dropped = true
    }
    // 退组后要重算这一笔：否则它仍挂着按旧成员关系算出的阻断，明明归属已定却进不了已核对。
    if (dropped) derive(id)
  }
  function finish(ids) {
    const affected = dependencies([...ids])
    const oldKeys = [...affected].map(id => eventBuckets.get(id)).filter(Boolean)
    for (const id of affected) derive(id)
    // 归属变更后按整组看一眼：指定完的那笔退出事项，本期次再没有待指定的费用就把整组收尾，
    // 收尾的行要重新推导一次，否则还挂着收尾前算出的 blocking_issue_open。
    for (const id of affected) if (events.get(id)) refreshInstallmentMember(id, events.get(id))
    const released = releaseInstallmentGroups(affected)
    for (const id of released) { affected.add(id); derive(id) }
    const changed=[...affected].filter(id=>pairSignature(events.get(id))!==pairSignatures.get(id))
    if(changed.length)for (const id of rebuildPairs(changed, oldKeys)) affected.add(id)
    const touchedRelations=new Set([...affected].flatMap(id=>[...(relationIds.get(id)||[])]))
    for (const key of touchedRelations) { const relation=relations.get(key); if (relation.relationType === 'refund_of' && relation.status === 'confirmed' && (affected.has(relation.targetEventId)||affected.has(relation.sourceEventId))) {
      const refund = events.get(relation.sourceEventId), original = events.get(relation.targetEventId)
      const used=related(relation.targetEventId).filter(row=>row.relationType==='refund_of'&&row.status==='confirmed'&&row.targetEventId===relation.targetEventId&&active(events.get(row.sourceEventId)))
        .reduce((total,row)=>total+BigInt(events.get(row.sourceEventId).amountMinor||0),0n)
      if (active(refund) && (!active(original) || !['expense','fee'].includes(original.economicNature)||!original.utcAt||!refund.utcAt||original.utcAt>refund.utcAt||
        original.amountMinor==null||refund.amountMinor==null||used>BigInt(original.amountMinor))) {
        relation.status = 'proposed'; invalid.set(refund.eventId, '原消费已变化，请重新确认退款关系'); derive(refund.eventId)
      }
    } }
    for (const id of affected) {
      dirtyEvents.add(id)
      for (const issueId of issueEvents.get(id) || []) dirtyIssues.add(issueId)
      for (const row of (baseEvidence.get(id) || []).concat(byEvent.get(id) || [])) dirtyRows.add(row.rowId)
    }
    revision++; summaryCache = null
  }
  function mergeEditor(old, next) {
    return { ...old, ...next, fields: { ...old?.fields, ...next.fields }, decisions: { ...old?.decisions, ...next.decisions },
      acknowledgedChanges: distinct([...(old?.acknowledgedChanges || []), ...(next.acknowledgedChanges || [])]) }
  }
  function edit(data) {
    const current = events.get(data.eventId); if (!current) fail()
    if (data.eventVersion != null && data.eventVersion !== current.version) fail('这笔记录已变化，请重新打开')
    let next = editor.prepare(current, data)
    validateReferences(next)
    applyRefund(current, next, data)
    if (data.decisions?.repaymentChannel) {
      const value = next.fieldSources.repaymentChannelResolution
      next.fieldSources.repaymentChannelResolution = { ...value, repaymentConfirmed: true,
        feeCategoryId: [...categories.values()].find(row => row.systemKey === 'finance__service' && !row.archivedAt)?.categoryId || null }
    }
    next.version = current.version + 1; events.set(current.eventId, next)
    const remaining = new Set(next.reasonCodes || [])
    const refundCleared = !['refund_relation_required', 'refund_relation_invalid', 'refund_relation_ambiguous',
      'refund_amount_exceeded', 'refund_source_conflict'].some(reason => remaining.has(reason))
    // 字段冲突由这次修改消除时（例如分期本金改判成合法性质），成员和服务端一样立即退出。
    for (const issue of eventIssues(current.eventId)) if (issue.issueType === 'field_conflict' && !remaining.has('core_fields_conflict') ||
      editableIssues.has(issue.issueType) &&
      (issue.issueType === 'refund_relation' && refundCleared || !rules.HARD_BLOCKING_REASONS.has(issue.primaryReasonCode))) {
      removeSubject(issue, current.eventId)
      if (!issue.subjectEventIds.length) { issue.status = 'resolved'; issue.blocking = false }
    }
    const old = choices.events.get(current.eventId)
    const { requestId, updateId, updateVersion, eventVersion, eventId, ...value } = data
    const decision = { key: current.eventId, eventId: current.eventId, sourceIds: sourceIds([current.eventId]), editor: mergeEditor(old?.editor, value) }
    choices.events.set(current.eventId, decision); invalid.delete(current.eventId)
    if (current.fieldSources.mergeOrigins && ['ledgerAccountId','counterpartyLedgerAccountId','amountMinor','utcAt','economicNature','flowDirection'].some(key => current[key] !== next[key])) {
      invalid.set(current.eventId, '配对依据已变化，请拆分后重新核对')
      next.fieldSources = { ...next.fieldSources, bankChannelResolution: undefined, repaymentChannelResolution: undefined }
    }
    finish([current.eventId])
    return [{ kind: 'events', key: decision.key, value: decision },...historyDiscarded.splice(0)]
  }
  function mapAccount(input) {
    const external = input.paymentRuleAction === 'external'
    if (input.fields?.paymentRuleAction || input.paymentRuleAction && !external ||
        external && (input.decision !== 'apply_fields' || Object.keys(input.fields || {}).length)) fail('账户选择无效')
    const issue = issues.get(input.issueId); if (!issue || issue.issueType !== 'account_mapping') fail()
    const issueMembers = (members.get(issue.issueId) || []).filter(member => member.objectType === 'event' && member.memberRole !== 'candidate')
    if (external && !accountGrouping.canUseExternal(events, issueMembers)) {
      fail('此账户引用已变化，请重新核对')
    }
    const originalMembers = originalMembersByIssue.get(issue.issueId) || []
    const originalIds = distinct(originalMembers.map(member => member.objectId))
    const locallyMerged = [...choices.pairings.values()].some(pair => pair.decision === 'same' && originalIds.includes(pair.bankEventId))
    const choiceScope = locallyMerged ? { ...scope(issue), eventIds: originalIds,
      sourceIds: distinct(facts.evidence.filter(link => originalIds.includes(link.eventId) && link.evidenceRole !== 'discarded').map(link => link.rowId)).sort() } : scope(issue)
    const decision = { ...choiceScope, decision: input.decision, fields: clone(input.fields || {}),
      ...(external ? { paymentRuleAction: 'external' } : {}) }
    if (!external && input.decision === 'apply_fields' && ['mappingAccountId', 'ledgerAccountId', 'mappingAccountDraft', 'ledgerAccountDraft']
      .filter(key => Object.prototype.hasOwnProperty.call(decision.fields, key)).length !== 1) fail('新建账户与选择已有账户需明确选择一项')
    const value = decision.fields.mappingAccountDraft || decision.fields.ledgerAccountDraft
    let id = input.fields?.mappingAccountId || input.fields?.ledgerAccountId
    let account = null, owner = null
    if (value) {
      if (id) fail('新建账户与选择已有账户不能同时提交')
      owner = locallyMerged ? identity.accountCreationKey(originalMembers, base) : identity.accountCreationKey(issueMembers, events)
      // 已落盘的旧决定原样重放；新的决定保存独立创建身份，改名不改变账户ID。
      if (!value.creationKey && !(input.key && Array.isArray(input.sourceIds))) value.creationKey = owner
      const normalized = draftPolicy.validate(value)
      if (normalized.creationKey && normalized.creationKey !== owner) fail('此新建账户对应的记录已变化，请重新确认')
      id = identity.accountId(facts.snapshotId, normalized.name, normalized.type, normalized.creationKey)
      if (creationOwners.has(id) && creationOwners.get(id) !== owner) draftPolicy.conflict()
      if ([...accounts.values()].some(row => row.accountId !== id &&
          draftPolicy.normalizeName(row.name).normalizedName === normalized.normalizedName)) draftPolicy.conflict()
      const prior = accounts.get(id)
      if (prior && !drafts.has(id)) draftPolicy.conflict()
      account = { ...normalized, accountId: id, isDraft: true }
      Object.assign(value, { name: normalized.name, type: normalized.type, currency: normalized.currency })
    }
    const selected = account || accounts.get(id)
    for (const member of issueMembers) {
      const current = events.get(member.objectId); if (!current) continue
      const reference = accountGrouping.memberReference(current, member)
      if (!external && input.decision === 'apply_fields' &&
          !accountTypes.compatible(reference || { currency: current.currency }, selected, { event: current, memberRole: member.memberRole })) {
        fail('账户类型或币种与来源不符')
      }
    }
    if (account) { accounts.set(id, account); drafts.set(id, account); creationOwners.set(id, owner) }
    const index = createMappingIndex(facts.paymentMappings || [], { accounts: [...accounts.values()] }), affected = []
    const mappingPolicy = require('../domain/import-review/account-mapping-policy')
    for (const member of issueMembers) {
      const current = events.get(member.objectId); if (!current) continue
      const ref = accountGrouping.memberReference(current, member)
      if (ref) mappingPolicy.setMappingDecision(index, ref, external ? 'external' : 'account', id, current.eventId)
      const next = input.decision === 'exclude_events' ? { ...current, status: 'excluded', reasonCodes: distinct([...current.reasonCodes,'manual_exclusion','account_mapping_excluded']) }
        : accountPolicy.applyMappedAccount({ ...current, status: 'needs_action', reasonCodes: policy.resolvedReasons('account_mapping', current.reasonCodes)
          .filter(code => !['manual_exclusion','account_mapping_excluded','source_account_ignored_default'].includes(code)) },
          member.memberRole, id, mappingPolicy.indexForEvent(index, current), external ? 'external' : 'account', ref)
      if (input.decision !== 'exclude_events') validateReferences(next)
      next.version = current.version + 1; events.set(current.eventId, next); affected.push(current.eventId)
      invalid.delete(current.eventId)
    }
    issue.status = 'resolved'; issue.blocking = false; issue.version++
    issue.reasonCodes = (issue.reasonCodes || []).filter(code => !['account_mapping_excluded','source_account_ignored_default'].includes(code))
    if (input.decision === 'exclude_events') issue.reasonCodes.push('account_mapping_excluded')
    if (issue.accountContext) Object.assign(issue.accountContext, { accountId: id || null,
      mappingAction: external ? 'external' : id ? 'account' : null })
    choices.accounts.set(decision.key, decision); finish(affected)
    return [{ kind: 'accounts', key: decision.key, value: decision },...historyDiscarded.splice(0)]
  }
  function pair(input) {
    const candidate = pairs.get(input.pairKey || input.key); if (!candidate) fail('配对条件已变化，请重新核对')
    const bank = events.get(candidate.bank.eventId), platform = events.get(candidate.platform.eventId)
    const decision = { key: candidate.pairKey, sourceIds: sourceIds([bank.eventId,platform.eventId]), bankEventId: bank.eventId,
      platformEventId: platform.eventId, decision: input.decision,
      memberEditors: Object.fromEntries([bank.eventId,platform.eventId].filter(id => choices.events.has(id)).map(id => [id,clone(choices.events.get(id).editor)])),
      ...(input.repaymentConfirmed === true ? { repaymentConfirmed: true } : {}) }
    if (input.decision === 'distinct') {
      for (const current of [bank,platform]) events.set(current.eventId, { ...current, version: current.version + 1,
        fieldSources: { ...current.fieldSources, bankChannelDistinctPairs: distinct([...(current.fieldSources.bankChannelDistinctPairs || []), candidate.pairKey]) } })
    } else if (input.decision === 'same') {
      const hydrated = { ...candidate, bank: hydrate(bank), platform: hydrate(platform) }
      const bankIssues = eventIssues(bank.eventId).filter(issue => issue.issueType === 'account_mapping')
      const accountContexts = { ...platform.fieldSources.bankChannelAccountContexts }
      for (const issue of bankIssues) {
        const member = (members.get(issue.issueId) || []).find(member => member.objectId === bank.eventId && member.memberRole !== 'candidate')
        const reference = member && accountGrouping.memberReference(bank, member)
        if (reference) accountContexts[issue.issueId] = { ...reference, fundsSide: candidate.pairKind === 'repayment' ? 'to' : 'ordinary' }
      }
      const primary = candidate.pairKind === 'repayment' ? require('../domain/import-review/review/pair-primary-policy').repaymentPrimary(hydrated, 'local')
        : require('../domain/import-review/review/pair-primary-policy').ordinaryPrimary([hydrated.bank,hydrated.platform], platform.eventId, 'local', accountContexts)
      if (primary.fieldSources.repaymentChannelResolution) {
        primary.fieldSources.repaymentChannelResolution.bankAccountIssueIds = bankIssues.map(issue => issue.issueId).sort()
      }
      if (decision.repaymentConfirmed && primary.fieldSources.repaymentChannelResolution) {
        primary.fieldSources.repaymentChannelResolution.repaymentConfirmed = true
        primary.fieldSources.repaymentChannelResolution.feeCategoryId = [...categories.values()].find(row => row.systemKey === 'finance__service' && !row.archivedAt)?.categoryId || null
      }
      primary.version = platform.version + 1
      primary.reasonCodes = policy.resolvedReasons('same_event', primary.reasonCodes)
      for (const row of byEvent.get(bank.eventId) || []) { row.eventId = platform.eventId; if (row.evidenceRole !== 'discarded') row.evidenceRole = 'supporting' }
      byEvent.set(platform.eventId, (byEvent.get(platform.eventId) || []).concat(byEvent.get(bank.eventId) || [])); byEvent.delete(bank.eventId)
      for (const relation of related(bank.eventId)) {
        if (relation.sourceEventId === bank.eventId) relation.sourceEventId = platform.eventId
        if (relation.targetEventId === bank.eventId) relation.targetEventId = platform.eventId
        if (relation.sourceEventId === relation.targetEventId) relation.status = 'rejected'
        indexRelation(relation)
      }
      events.set(platform.eventId, primary); events.delete(bank.eventId)
      for (const issue of eventIssues(bank.eventId)) {
        issue.subjectEventIds = distinct(issue.subjectEventIds.map(id => id === bank.eventId ? platform.eventId : id))
        if (!issueEvents.has(platform.eventId)) issueEvents.set(platform.eventId, new Set())
        issueEvents.get(platform.eventId).add(issue.issueId)
        for (const member of members.get(issue.issueId) || []) if (member.objectId === bank.eventId) {
          member.objectId = platform.eventId
          if (candidate.pairKind === 'repayment' && issue.issueType === 'account_mapping') member.memberRole = 'mapping_to'
        }
      }
      if (choices.events.has(platform.eventId)) choices.events.get(platform.eventId).sourceIds = decision.sourceIds
    } else fail()
    choices.pairings.set(decision.key, decision); finish([bank.eventId,platform.eventId])
    const changes = [{ kind: 'pairings', key: decision.key, value: decision },...historyDiscarded.splice(0)]
    if (choices.events.has(platform.eventId)) changes.push({ kind: 'events', key: platform.eventId, value: choices.events.get(platform.eventId) })
    return changes
  }
  function review(input) {
    const issue = issues.get(input.issueId); if (!issue) fail()
    const ids = input.selection?.mode === 'include' ? input.selection.eventIds : input.selection?.mode === 'all_except'
      ? issue.subjectEventIds.filter(id => !input.selection.eventIds.includes(id)) : input.eventIds || issue.subjectEventIds
    if (ids.some(id => !issue.subjectEventIds.includes(id))) fail()
    if (input.decision === 'apply_fields') {
      const changes = []
      for (const id of ids) changes.push(...edit({ eventId: id, editorVersion: 1, fields: input.fields }))
      return changes
    }
    if (['link_refund','mark_refund_pending'].includes(input.decision)) return edit({ eventId: ids[0], editorVersion: 1,
      decisions: { refund: input.decision === 'link_refund' ? { mode: 'link', kind: 'event', id: input.targetEventId,
        version: events.get(input.targetEventId)?.version } : { mode: 'pending' } } })
    const decision = { ...scope(issue, ids), decision: input.decision, input: clone(input) }
    delete decision.input.requestId; delete decision.input.updateId; delete decision.input.updateVersion; delete decision.input.issueVersion
    if (issue.primaryReasonCode === 'historical_duplicate_candidate') decision.candidates = (members.get(issue.issueId) || [])
      .filter(row => row.objectType === 'transaction').map(row => ({ id: row.objectId, version: Number(row.objectVersion) }))
    if (input.decision === 'exclude_events' || input.decision === 'link_existing_transaction') for (const id of ids) {
      const current = events.get(id)
      events.set(id, { ...current, status: 'excluded', version: current.version + 1,
        reasonCodes: distinct([...current.reasonCodes,input.decision === 'exclude_events' ? 'manual_exclusion' : 'linked_existing_transaction']) })
    } else if (input.decision === 'confirm_distinct') for (const id of ids) {
      const event = events.get(id); events.set(id, { ...event, reasonCodes: policy.resolvedReasons(issue.issueType, event.reasonCodes), version: event.version + 1 })
    } else if (input.decision === 'confirm_same') {
      const candidate = [...pairs.values()].find(row => ids.includes(row.bank.eventId) && ids.includes(row.platform.eventId))
      if (candidate) return pair({ pairKey: candidate.pairKey, decision: 'same' })
      fail('请通过原始来源逐对核对这组记录')
    } else if (input.decision === 'discard_evidence') {
      const row = evidence.get(input.evidenceId); if (!row || !ids.includes(row.eventId)) fail()
      row.evidenceRole = 'discarded'
    } else fail()
    issue.status = ids.length === issue.subjectEventIds.length ? 'resolved' : 'open'; issue.blocking = issue.status === 'open'; issue.version++
    if (issue.status === 'open') issue.subjectEventIds = issue.subjectEventIds.filter(id => !ids.includes(id))
    const prior = choices.reviews.get(decision.key)
    if (input.decision === 'exclude_events' && prior?.decision === 'exclude_events') {
      decision.eventIds = distinct([...prior.eventIds,...decision.eventIds]); decision.sourceIds = distinct([...prior.sourceIds,...decision.sourceIds]).sort()
    }
    choices.reviews.set(decision.key, decision); for (const id of ids) invalid.delete(id); finish(ids)
    return [{ kind: 'reviews', key: decision.key, value: decision }]
  }
  // 本期次同组别的利息已经归到哪个计划。利息行的计划单选要据此标出占用，
  // 所以按全组算：待核对列表只下发当前页，已经归好的那笔早已不在里面，拿页面行算不出来。
  function installmentOccupancy(event) {
    const context = event.fieldSources && event.fieldSources.installmentAttribution
    if (!context || context.role !== 'charge' || !(context.plans || []).length) return null
    const groupKey = context.groupKey || attribution.groupKeyOf(event)
    const taken = new Map()
    for (const other of events.values()) {
      if (other.eventId === event.eventId) continue
      const otherContext = other.fieldSources && other.fieldSources.installmentAttribution
      if (!otherContext || otherContext.role !== 'charge' || (otherContext.groupKey || attribution.groupKeyOf(other)) !== groupKey) continue
      const plan = attribution.confirmedPlan(other)
      if (!plan) continue
      const entry = taken.get(plan) || { planName: plan, count: 0, amountMinor: '0' }
      entry.count += 1
      entry.amountMinor = String(BigInt(entry.amountMinor) + BigInt(other.amountMinor || 0))
      taken.set(plan, entry)
    }
    return taken.size ? [...taken.values()] : null
  }
  function publicRow(id) {
    const event = events.get(id); if (!event) return null
    const first = (byEvent.get(id) || []).find(row => row.evidenceRole === 'primary') || (byEvent.get(id) || [])[0]
    const row = first && rows.get(first.rowId), source = facts.sources.find(source => source.batchId === row?.batchId)
    const category = categories.get(event.categoryId)
    const result = publicEvent({ ...event, categoryName: category?.name, parentCategoryName: category?.parentName,
      primaryRowId: row?.rowId, sourceType: row?.sourceType, fileName: source?.fileName, rowNumber: row?.rowNumber,
      counterparty: row?.counterparty, item: row?.item, paymentMethod: row?.paymentMethod, sourceStatus: row?.rawStatus,
      sourceNote: row?.sourceNote, evidenceCount: evidenceFor(id).length,
      duplicateEvidenceCount: (byEvent.get(id) || []).filter(row => ['duplicate','supporting'].includes(row.evidenceRole)).length })
    const taken = result.installmentAttribution ? installmentOccupancy(event) : null
    if (taken) result.installmentAttribution = { ...result.installmentAttribution, taken }
    const attention = require('../domain/import-review/review-attention').reviewAttention(result, eventIssues(id))
    const reason = invalid.get(id)
    const conflict = reason && ({ account_unavailable: '账户已停用或不可用，请重新选择',
      ACCOUNT_NAME_CONFLICT: draftPolicy.NAME_CONFLICT,
      category_unavailable: '分类已停用或不可用，请重新选择',
      REFUND_AMOUNT_EXCEEDED: '可退金额已变化，请重新核对退款关系',
      LOAN_SOURCE_MISMATCH: '贷款来源已变化，请重新核对',
      LOAN_CHARGE_CONFLICT: '贷款费用已变化，请重新选择费用',
      CONFLICT: '关联对象已变化，请重新核对',
      LOCAL_RECHECK_REQUIRED: '关联信息已变化，请重新核对',
      HISTORY_REVIEW_REQUIRED: '发现新的历史候选，请重新核对',
      VALIDATION_ERROR: '当前决定与最新账本不符，请重新核对' }[reason] ||
      (/^[a-zA-Z_]+$/.test(reason) ? '账本信息已变化，请重新核对' : reason))
    if (conflict) attention.reviewAttention.steps.unshift({ key: 'local_recheck', label: conflict })
    const legacyRepaymentReview = choices.events.get(id)?.editor?.decisions?.repayment != null
    return { ...result, timezoneOffsetMinutes: event.timezoneOffsetMinutes, ...attention,
      ...(legacyRepaymentReview ? { legacyRepaymentReview: true } : {}),
      ...(needsCheck.has(id) ? { serverReviewPending: true } : {}), ...(conflict ? { localConflict: conflict } : {}) }
  }
  function splitOrigins(eventId) {
    const event = events.get(eventId); if (!event) fail()
    if (event.fieldSources.mergeOrigins?.length) return event.fieldSources.mergeOrigins.map(origin => ({ ...origin,
      event: { ...origin.event, eventId: origin.event.eventId || identity.splitEventId(facts.update.updateId, origin.rowIds), updateId: facts.update.updateId } }))
    const raw = rowIds(eventId).map(id => rows.get(id))
    let seq = 0
    const plan = require('../domain/import-review/organizer-plan-policy').buildOrganizePlan({ updateId: facts.update.updateId, rows: raw,
      paymentMappings: facts.paymentMappings || [], accounts: [...accounts.values()], idFactory: () => identity.stableId('split-plan',eventId,String(seq++)) })
    const primary = (byEvent.get(eventId) || []).find(row => row.evidenceRole === 'primary')
    return plan.events.map(item => ({ rowIds: item.fieldSources.rowIds,
      event: { ...item, eventId: item.fieldSources.rowIds.includes(primary?.rowId) ? eventId : identity.splitEventId(facts.update.updateId, item.fieldSources.rowIds) } }))
  }
  function reviseDuplicate(input) {
    const event = events.get(input.eventId); if (!event) fail()
    if (input.decision === 'same') {
      // Restore just this explicit distinct edge before testing it again.
      const other = events.get(input.otherEventId); if (!other) fail()
      for (const current of [event,other]) events.set(current.eventId, { ...current, fieldSources: { ...current.fieldSources,
        bankChannelDistinctPairs: (current.fieldSources.bankChannelDistinctPairs || []).filter(key => key !== input.pairKey) } })
      rebuildPairs([event.eventId,other.eventId]); return pair({ pairKey: input.pairKey, decision: 'same', repaymentConfirmed: input.repaymentConfirmed })
    }
    const decision = { key: event.eventId, eventId: event.eventId, sourceIds: sourceIds([event.eventId]), decision: input.decision }
    if (input.decision === 'reopen') {
      events.set(event.eventId, { ...event, status: 'needs_action', reasonCodes: event.reasonCodes.filter(code => !['linked_existing_transaction','already_posted'].includes(code)) })
      for (let i=links.length-1;i>=0;i--) if (links[i].eventId === event.eventId && links[i].role === 'historical_primary') links.splice(i,1)
      for (const [key, choice] of choices.reviews) if (choice.eventIds.includes(event.eventId) && choice.reasonCode === 'historical_duplicate_candidate') choices.reviews.delete(key)
      choices.duplicates.set(decision.key, decision); finish([event.eventId]); return [{ kind:'duplicates', key:decision.key, value:decision }]
    }
    if (input.decision !== 'distinct') fail()
    const origins = splitOrigins(event.eventId)
    if (origins.length < 2 || origins.some(origin => origin.event.existingTransactionIds?.length)) fail('同一来源身份不能拆成多笔入账')
    const changes = [], sources = byEvent.get(event.eventId) || [], ids = []
    const localPair = [...choices.pairings.values()].find(pair => pair.decision === 'same' && pair.platformEventId === event.eventId)
    if (localPair) { choices.pairings.delete(localPair.key); changes.push({ kind: 'pairings', key: localPair.key, value: null }) }
    else { choices.duplicates.set(decision.key, decision); changes.push({ kind: 'duplicates', key: decision.key, value: decision }) }
    byEvent.delete(event.eventId)
    for (const origin of origins) {
      const id = origin.event.eventId, old = origin.event
      let restored = { ...old, status: 'needs_action', version: (events.get(id)?.version || old.version || 1) + 1,
        fieldSources: { ...old.fieldSources, mergeOrigins: undefined, bankChannelResolution: undefined, repaymentChannelResolution: undefined, bankChannelCandidate: undefined,
          bankChannelAccountContexts: undefined },
        reasonCodes: policy.resolvedReasons('same_event', old.reasonCodes || []) }
      const choice = choices.events.get(id)
      if (choice) {
        try { restored = { ...editor.prepare(restored, choice.editor), version: restored.version } }
        catch (_) { choices.events.delete(id); changes.push({ kind:'events',key:id,value:null }); invalid.set(id,'拆分后原组成或关系已失效，请重新核对') }
      }
      events.set(id, restored); if (!base.has(id)) base.set(id, old)
      const grouped = sources.filter(row => origin.rowIds.includes(row.rowId))
      grouped.forEach((row,i) => { row.eventId = id; row.evidenceRole = i ? 'supporting' : 'primary' })
      byEvent.set(id,grouped); ids.push(id)
      if (choice && choices.events.has(id)) { choice.sourceIds = origin.rowIds; changes.push({kind:'events',key:id,value:choice}) }
    }
    for (const restored of require('../domain/import-review/account-ownership-review-policy').restoreAfterSplit(event, ids.map(id => events.get(id)), event.eventId)) {
      events.set(restored.eventId, restored)
    }
    // 合并时移入主记录的银行引用回到其原始来源，后续修改不能误作用于平台账户。
    const contextIssues = new Set(Object.keys(event.fieldSources.bankChannelAccountContexts || {})
      .concat(event.fieldSources.repaymentChannelResolution?.bankAccountIssueIds || []))
    for (const issueId of contextIssues) {
      const issue = issues.get(issueId); if (!issue) continue
      const group = members.get(issueId) || []
      for (const member of group) if (member.objectId === event.eventId && member.memberRole !== 'candidate') {
        const reference = accountGrouping.memberReference(event, member), key = paymentReferenceKey(reference)
        const matches = ids.flatMap(id => {
          const origin = events.get(id), roles = distinct(['subject', 'mapping_from', 'mapping_to', 'payment_target',
            ...(origin.fieldSources.paymentAccountReferences || []).map(ref => ref.memberRole)])
          return roles.filter(role => key && paymentReferenceKey(accountGrouping.memberReference(origin, { ...member, memberRole: role })) === key)
            .map(role => ({ id, role }))
        })
        const match = matches[0]
        if (!match || matches.some(other => other.id !== match.id)) {
          invalid.set(event.eventId, '拆分后的账户引用待重新核对'); continue
        }
        member.objectId = match.id; member.memberRole = match.role
      }
      issue.subjectEventIds = distinct(group.filter(member => member.objectType === 'event' && member.memberRole !== 'candidate').map(member => member.objectId))
      for (const id of ids) {
        if (issue.subjectEventIds.includes(id)) { if (!issueEvents.has(id)) issueEvents.set(id, new Set()); issueEvents.get(id).add(issueId) }
        else issueEvents.get(id)?.delete(issueId)
      }
      dirtyIssues.add(issueId)
      const choice = choices.accounts.get(issueId)
      if (choice) {
        Object.assign(choice, scope(issue))
        changes.push({ kind: 'accounts', key: issueId, value: choice })
      }
    }
    for (const relation of related(event.eventId)) relation.status = 'proposed'
    const candidates = matching.bankChannelEdges(ids.map(id => hydrate(events.get(id))))
    for (const candidate of candidates) for (const item of [candidate.bank,candidate.platform]) {
      const current = events.get(item.eventId)
      events.set(item.eventId,{...current,fieldSources:{...current.fieldSources,bankChannelDistinctPairs:distinct([...(current.fieldSources.bankChannelDistinctPairs||[]),candidate.pairKey])}})
    }
    finish(ids)
    return changes
  }
  function applySupplement(value) {
    supplemental = value
    coverageByEvent = new Map(value.historyCoverage.duplicates.map(row => [row.eventId,row]))
    for (const id of accounts.keys()) if(!drafts.has(id))accounts.delete(id)
    for (const row of value.accounts) accounts.set(row.accountId, row)
    categories.clear();for (const row of value.categories) categories.set(row.categoryId, row)
    indexHistory();historySignatures.clear()
    const currentHistory=new Set(value.issues.filter(row=>row.primaryReasonCode===historyPolicy.REASON).map(row=>row.issueId))
    for(const issue of issues.values())if(issue.primaryReasonCode===historyPolicy.REASON&&!currentHistory.has(issue.issueId)){issue.status='superseded';issue.blocking=false;dirtyIssues.add(issue.issueId)}
    for (const issue of value.issues) {
      issues.set(issue.issueId, clone(issue)); members.set(issue.issueId, value.members.filter(row => row.issueId === issue.issueId))
      for (const id of issue.subjectEventIds) { if (!issueEvents.has(id)) issueEvents.set(id,new Set()); issueEvents.get(id).add(issue.issueId) }
    }
    for (const problem of value.problems) for (const id of problem.eventIds || []) invalid.set(id, problem.reason)
    finish(distinct(value.problems.flatMap(problem => problem.eventIds || [])))
  }
  function finalState() {
    return { protocolVersion: 3, snapshotId: facts.snapshotId, updateId: facts.update.updateId,
      baseVersion: facts.update.version, ruleVersion: facts.ruleVersion,
      decisions: Object.fromEntries(KINDS.map(kind => [kind,[...choices[kind].values()]])) }
  }
  for (const event of events.values()) indexEvent(event)
  rebuildPairs([...events.keys()])
  return { facts, base, events, rows, evidence, byEvent, baseEvidence, relations, issues, members, issueEvents, accounts, drafts, categories,
    choices, links, needsCheck, invalid, sourceIds, hydrate, context, eventIssues, publicRow, refundCandidates, hiddenOffset, evidenceFor,
    dirtyEvents, dirtyIssues, dirtyRows,
    edit, mapAccount, pair, review, reviseDuplicate, splitOrigins, finish, addIssue, applySupplement, finalState,
    get pairs() { return pairs }, get revision() { return revision }, get supplemental() { return supplemental },
    get suggestedCount() { return suggestedPairs.size },
    get summaryCache() { return summaryCache }, set summaryCache(value) { summaryCache = value } }
}
module.exports = { create, clone, fail }
