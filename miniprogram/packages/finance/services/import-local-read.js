const { sha256, byteLength } = require('../domain/import-review/portable-digest')
const { accountIds, repaymentExpense } = require('../domain/import-review/workbench-summary')
const editor = require('../domain/import-review/review/editor-policy')
const excluded = require('../domain/import-review/excluded-event-groups')
const chronological = (a,b) => Number(!a.localAt) - Number(!b.localAt) || String(a.localAt || '').localeCompare(String(b.localAt || '')) || String(a.eventId || a.issueId || a.memberId || a.pairKey).localeCompare(String(b.eventId || b.issueId || b.memberId || b.pairKey))
const historical = event => event.status === 'excluded' && event.reasonCodes.some(code => ['already_posted','linked_existing_transaction'].includes(code))
const active = event => ['ready','needs_action','posted'].includes(event.status)
const error = (code, message) => { throw Object.assign(new Error(message || code), { code }) }
function create(model) {
  const facts = model.facts
  const version = () => facts.snapshotId + ':' + model.revision
  const update = () => ({ ...facts.update, version: facts.update.version, reviewMode: 'local_v3' })
  const envelope = () => ({ protocolVersion: 2, viewVersion: version(), update: update() })
  const summaryIndex = require('./import-local-summary').create(model)
  function summary() {
    if (model.summaryCache) return model.summaryCache
    const aggregated = summaryIndex.summary()
    const pairingSuggestedCount = model.suggestedCount
    model.summaryCache = { ...envelope(), ...aggregated, workbench:{...aggregated.workbench,pairingSuggestedCount},
      sources:facts.summary.sources,posting:null,
      freshness:{ requiresAccountGroupRefresh:false },localReview:true }
    return model.summaryCache
  }
  function page(action, data, rows, key, mapper = row => row) {
    const { cursor,viewVersion,pageSize,...filter } = data
    const scope = sha256(JSON.stringify([action,filter,version()])).slice(0,20)
    let offset = 0
    if (cursor) {
      const bits=String(cursor).split(':')
      if(bits.length!==3||bits[0]!=='local'||bits[1]!==scope||!/^\d+$/.test(bits[2]))error('STALE_VIEW','本地记录已变化，请重新打开')
      offset=Number(bits[2])
    }
    const size=Math.max(1,Math.min(100,pageSize||20)),items=[]
    for (const row of rows.slice(offset,offset+size)) {
      const item=mapper(row)
      if(byteLength(JSON.stringify(items.concat(item)))>48*1024) { if(!items.length)error('PAGINATION_REQUIRED','单项详情较大，请打开原始凭据');break }
      items.push(item)
    }
    return {...envelope(),items,total:rows.length,nextCursor:offset+items.length<rows.length?'local:'+scope+':'+(offset+items.length):null}
  }
  function issueView(issue) {
    const ids=issue.subjectEventIds.filter(id=>model.events.has(id)),subject=ids.length?model.publicRow(ids[0]):null
    return {...issue,subject,memberCount:ids.length,localAt:subject?.localAt,sortLocalAt:subject?.localAt,
      accountContext:issue.accountContext?{...issue.accountContext,
        canExternal: require('../domain/import-review/account-issue-grouping').canUseExternal(model.events, model.members.get(issue.issueId) || [])}:null}
  }
  function obsoletePaymentTarget(issue) {
    if (issue.issueType !== 'account_mapping' || issue.status !== 'resolved' ||
        issue.accountContext?.fundsSide !== 'payment_target' || issue.accountContext.accountId ||
        (issue.reasonCodes || []).some(code => ['account_mapping_excluded','source_account_ignored_default'].includes(code))) return false
    const members = (model.members.get(issue.issueId) || []).filter(member => member.memberRole !== 'candidate')
    // 人工把还款改成支出后，整组都不再需要目标账户时不重新询问。
    // 必须检查完整成员；代表记录已改性质而其他成员仍在还款时仍要确认。
    return members.length > 0 && members.every(member => member.objectType === 'event' && member.memberRole === 'payment_target' &&
      model.events.has(member.objectId) && model.events.get(member.objectId).economicNature !== 'repayment')
  }
  function issuePageValue(issue) { const { subjectEventIds, ...visible } = issue; return { ...visible, subjectEventIds: [] } }
  function eventMatches(event,data) {
    if(model.hiddenOffset(event))return false
    const open=model.eventIssues(event.eventId).filter(issue=>issue.status==='open'),review=model.invalid.has(event.eventId)||open.some(issue=>issue.blocking&&issue.issueType!=='category_assignment')||event.status==='needs_action'&&!open.some(issue=>issue.issueType==='category_assignment')
    const category=require('../domain/import-review/workbench-summary').categoryRequired(event),needed=category&&(!event.categoryId||event.economicNature==='unknown')
    if(data.eventId&&event.eventId!==data.eventId||data.economicNature&&event.economicNature!==data.economicNature||data.accountId&&!accountIds(event).includes(data.accountId))return false
    if(data.issueId&&!model.issues.get(data.issueId)?.subjectEventIds.includes(event.eventId))return false
    if(data.status==='duplicate') { if(!historical(event)&&!(model.byEvent.get(event.eventId)||[]).some(row=>['duplicate','supporting'].includes(row.evidenceRole)))return false }
    else if(data.status&&event.status!==data.status)return false
    if(data.status==='excluded'&&historical(event))return false
    const view=data.view
    if(view==='active'&&!active(event)||view==='review_pending'&&(!active(event)||!review)||view==='review_completed'&&(!active(event)||review)||
      view==='category_pending'&&(!active(event)||!needed)||view==='category_completed'&&(!active(event)||!category||needed)||view==='category_none'&&(!active(event)||category)||
      view==='expense'&&(!active(event)||!['expense','fee'].includes(event.economicNature)&&repaymentExpense(event)<=0n)||view==='posted'&&event.status!=='posted')return false
    if(data.query){const shown=model.publicRow(event.eventId),query=String(data.query).trim().toLowerCase();if(![shown.localAt,shown.counterparty,shown.note,shown.categoryName,shown.primaryEvidence?.item,shown.primaryEvidence?.counterparty].some(value=>String(value||'').toLowerCase().includes(query)))return false}
    return true
  }
  function detailFacts(event) {
    const fields=event.fieldSources, original=[]
    for(const relation of model.relations.values())if(relation.sourceEventId===event.eventId&&relation.status==='confirmed'&&relation.relationType==='refund_of'){
      const target=model.publicRow(relation.targetEventId);if(target)original.push({eventId:target.eventId,localAt:target.localAt,amountMinor:target.amountMinor,categoryName:target.categoryName})
    }
    for(const link of model.links)if(link.eventId===event.eventId&&link.role==='refund_original'){
      const target=(model.supplemental||facts).history.find(row=>row.transactionId===link.transactionId);if(target)original.push({...target})
    }
    return { version:1,accounts:accountIds(event).map(id=>model.accounts.get(id)).filter(Boolean),
      categories:[event.categoryId,fields.loanRepayment?.interestCategoryId,fields.loanRepayment?.feeCategoryId,fields.repaymentChannelResolution?.feeCategoryId].map(id=>model.categories.get(id)).filter(Boolean),
      refund:event.economicNature==='refund'?{status:original.length>1?'ambiguous':original.length?'confirmed':fields.refundRelation?.status==='pending'?'pending':'unlinked',originals:original}:null,
      loan:(model.supplemental||facts).loans.find(row=>row.loanId===fields.loanRepayment?.loanId)||null }
  }
  function expectations(event) {
    const result=[]
    for(const relation of model.relations.values())if(relation.sourceEventId===event.eventId&&relation.status==='confirmed'&&relation.relationType==='refund_of'){
      result.push({kind:'event',id:relation.targetEventId,version:model.events.get(relation.targetEventId)?.version},{kind:'refund_relation',id:relation.relationId,version:Number(relation.version)})
    }
    for(const link of model.links)if(link.eventId===event.eventId&&link.role==='refund_original')result.push({kind:'transaction',id:link.transactionId,version:Number(link.transactionVersion)})
    const loanId=event.fieldSources.loanRepayment?.loanId||event.fieldSources.editorOverrides?.incompleteRepayment?.loanId
    const loan=(model.supplemental||facts).loans.find(row=>row.loanId===loanId)
    if(loan)result.push({kind:'loan',id:loanId,version:Number(loan.version)})
    return result
  }
  function pairRange(data) {
    const degrees=new Map()
    for(const pair of model.pairs.values())for(const event of [pair.bank,pair.platform])degrees.set(event.eventId,(degrees.get(event.eventId)||0)+1)
    return [...model.pairs.values()].map(pair=>({...pair,unique:degrees.get(pair.bank.eventId)===1&&degrees.get(pair.platform.eventId)===1}))
      .filter(pair=>(data.mode==='ambiguous'?!pair.unique||data.issueId:pair.unique)&&(!data.issueId||model.issues.get(data.issueId)?.subjectEventIds.includes(pair.bank.eventId)&&model.issues.get(data.issueId)?.subjectEventIds.includes(pair.platform.eventId)))
      .sort((a,b)=>chronological({localAt:a.bank.localAt,pairKey:a.pairKey},{localAt:b.bank.localAt,pairKey:b.pairKey}))
  }
  function previewPair(pair){const view=event=>({...model.publicRow(event.eventId),sourceType:event.sourceType,counterparty:event.relationEvidence.rows[0]?.counterparty||'',item:event.relationEvidence.rows[0]?.item||''});return{pairKey:pair.pairKey,bank:view(pair.bank),platform:view(pair.platform),economicNature:pair.platform.economicNature,...pair.pairKind==='repayment'?{pairKind:'repayment',repayment:pair.repayment,reason:'repayment_channel_amounts_require_confirmation'}:{reason:'same_account_amount_currency_direction_minute_channel'}}}
  function read(action,data={}) {
    if(data.viewVersion!=null&&data.viewVersion!==version())error('STALE_VIEW','本地记录已变化，请重新打开')
    if(action==='financeUpdates.summary')return summary()
    if(action==='economicEvents.list'){
      let rows=[...model.events.values()].filter(event=>eventMatches(event,data)).sort(chronological)
      if(data.view==='excluded_groups'||data.excludedGroupId){const groups=new Map();rows=rows.filter(event=>event.status==='excluded'&&!historical(event));for(const event of rows){const shown=model.publicRow(event.eventId),group=excluded.groupFor({...event,sourceType:shown.primaryEvidence?.sourceType,paymentMethod:shown.primaryEvidence?.paymentMethod});if(!groups.has(group.groupId))groups.set(group.groupId,{...group,localAt:event.localAt,sortLocalAt:event.localAt,count:0,ids:[]});groups.get(group.groupId).count++;groups.get(group.groupId).ids.push(event.eventId)}
        if(data.excludedGroupId)rows=rows.filter(event=>(groups.get(data.excludedGroupId)?.ids||[]).includes(event.eventId))
        else return page(action,data,[...groups.values()],'groupId',({ids,...group})=>group)
      }
      return page(action,data,rows,'eventId',event=>model.publicRow(event.eventId))
    }
    if(action==='reviewIssues.list'){
      const rows=[...model.issues.values()].filter(issue=>(!data.status||issue.status===data.status)&&(!data.issueType||issue.issueType===data.issueType)&&
        (!data.group||data.group==='accounts'&&issue.issueType==='account_mapping'&&['open','resolved'].includes(issue.status)&&!obsoletePaymentTarget(issue)||data.group==='category'&&issue.issueType==='category_assignment'||data.group==='review'&&!['account_mapping','category_assignment'].includes(issue.issueType)&&issue.blocking))
        .map(issueView).filter(issue=>!data.query||issue.subjectEventIds.some(id=>model.events.has(id)&&eventMatches(model.events.get(id),{query:data.query}))).sort(chronological)
      return page(action,data,rows,'issueId',issuePageValue)
    }
    if(action==='reviewIssues.members'||action==='reviewIssues.get'){
      const issue=model.issues.get(data.issueId);if(!issue)error('NOT_FOUND')
      const rows=(model.members.get(issue.issueId)||[]).filter(row=>!data.memberKind||row.objectType===data.memberKind).map(row=>{
        const event=row.objectType==='event'?model.publicRow(row.objectId):null,relation=model.relations.get(row.objectId)
        return {...row,objectVersion:event?.version||Number(row.objectVersion),event,localAt:event?.localAt,relation:relation?{...relation,targetEvent:model.publicRow(relation.targetEventId)}:null,
          transaction:(model.supplemental||facts).history.find(item=>item.transactionId===row.objectId)||null}
      }).sort(chronological)
      const result=page(action,data,rows,'memberId')
      if(action!=='reviewIssues.get')return{...result,issueId:issue.issueId,issueVersion:issue.version}
      return {...result,issue:issuePageValue(issueView(issue)),subject:issueView(issue).subject,members:result.items}
    }
    if(action==='financeUpdates.options'){
      const dataFacts=model.supplemental||facts,key=data.kind==='loans'?'loanId':data.kind==='categories'?'categoryId':'accountId'
      summary()
      let rows=data.kind==='categories'?[...model.categories.values()]:data.kind==='loans'?dataFacts.loans:data.kind==='accountDrafts'||data.kind==='new_accounts'?[...model.drafts.values()]:data.kind==='affected_accounts'?[...summaryIndex.accountCounts.keys()].map(id=>model.accounts.get(id)).filter(Boolean):[...model.accounts.values()].filter(row=>!model.drafts.has(row.accountId))
      rows=rows.filter(row=>!row.archivedAt&&(!data.categoryKind||row.kind===data.categoryKind)&&(!data.id||row[key]===data.id)&&(!data.ids||data.ids.includes(row[key]))&&(!data.query||[row.name,row.parentName].join(' ').includes(data.query))).sort((a,b)=>a[key].localeCompare(b[key]))
      // 目录项会直接进入页面数据；必须像服务端 JSON 响应一样返回副本，
      // 否则页面按路径 setData 会改写模型内的账户/分类对象。
      return page(action,data,rows.map(row=>JSON.parse(JSON.stringify(row))),key)
    }
    if(action==='economicEvents.evidence')return {...page(action,data,model.evidenceFor(data.eventId),'evidenceId',link=>{const row=model.rows.get(link.rowId),source=facts.sources.find(item=>item.batchId===row.batchId);return{...link,sourceType:row.sourceType,rowNumber:row.rowNumber,fileName:source?.fileName,detailRequired:true}}),eventId:data.eventId}
    if(action==='economicEvents.detail'){
      const event=model.events.get(data.eventId);if(!event)error('NOT_FOUND')
      let text
      if(data.evidenceId){const row=model.evidenceFor(data.eventId).find(link=>link.evidenceId===data.evidenceId);if(!row)error('NOT_FOUND');text=JSON.stringify(facts.raw.find(item=>item.rowId===row.rowId)?.fields||[])}
      else text=JSON.stringify({...model.publicRow(event.eventId),detailFacts:detailFacts(event),editorFacts:{...editor.capability(event),expectedRelations:expectations(event)}})
      const scope=sha256([version(),data.eventId,data.evidenceId||''].join(':')).slice(0,20),bits=data.cursor?data.cursor.split(':'):null,offset=bits?Number(bits[2]):0
      if(bits&&(bits[0]!=='detail'||bits[1]!==scope||!Number.isSafeInteger(offset)||offset<0))error('STALE_VIEW')
      return {...envelope(),eventId:event.eventId,...data.evidenceId?{evidenceId:data.evidenceId}:{},format:'json-text',part:text.slice(offset,offset+2048),nextCursor:offset+2048<text.length?'detail:'+scope+':'+(offset+2048):null}
    }
    if(action==='economicEvents.refundCandidates'){
      const stored=model.events.get(data.eventId);if(!stored||stored.version!==data.eventVersion)error('CONFLICT')
      const event={...editor.prepare(stored,{editorVersion:1,fields:data.fields||{}}),economicNature:'refund',flowDirection:'inflow'},kind=data.kind||'event'
      // 两个范围都来自随快照下载的本机事实，这里不再回服务器查询。
      const found=model.refundCandidates(event,kind,{scope:data.scope==='all'?'all':'matched'})
      const rows=found.filter(row=>!data.query||[row.note,row.merchant,row.item].some(value=>String(value||'').includes(data.query))).sort((a,b)=>a.id.localeCompare(b.id))
      const complete=found.historyComplete!==false
      // 退款优先在本批找原消费：本批候选按事件时间倒序，历史只作备用。
      const ordered=kind==='event'?[...rows].sort((a,b)=>String(b.utcAt||'').localeCompare(String(a.utcAt||''))||a.id.localeCompare(b.id)):rows
      return {...page(action,data,ordered,'id'),historyComplete:kind==='event'||complete,
        closedOriginal:found.closedOriginal||null,
        serverReviewPending:kind==='transaction'&&!complete}
    }
    if(action==='reviewIssues.pairings'){
      const selected=pairRange(data),scope={mode:data.mode||'suggested',issueId:data.issueId||null,version:version()},scopeToken=JSON.stringify(scope)
      const result=page(action,data,selected,'pairKey',previewPair),available=new Set(selected.map(pair=>pair.pairKey))
      return {...result,scopeToken,suggestedTotal:summary().workbench.pairingSuggestedCount,scopeSourceCount:selected.reduce((sum,pair)=>sum+pair.bank.relationEvidence.rows.length+pair.platform.relationEvidence.rows.length,0),scopeNatureCounts:Object.fromEntries(['expense','refund','repayment'].map(nature=>[nature,selected.filter(pair=>pair.platform.economicNature===nature).length])),
        ...data.recheckPairKeys?{returnedKeys:data.recheckPairKeys.filter(key=>available.has(key)),missingKeys:data.recheckPairKeys.filter(key=>!available.has(key))}:{} }
    }
    if(action==='economicEvents.duplicateReview'){
      const event=model.events.get(data.eventId);if(!event)error('NOT_FOUND')
      if(historical(event))return{...envelope(),kind:'historical',eventVersion:event.version,canReopen:!event.reasonCodes.includes('already_posted'),canSplit:false,records:[],count:1,reason:''}
      const keys=new Set(event.fieldSources.bankChannelDistinctPairs||[])
      if(keys.size&&!event.fieldSources.mergeOrigins){const clean=[...model.events.values()].map(row=>model.hydrate({...row,fieldSources:{...row.fieldSources,bankChannelDistinctPairs:undefined}}));const pairs=require('../domain/import-review/bank-channel-matching').bankChannelEdges(clean).filter(pair=>keys.has(pair.pairKey));const pair=pairs[data.pairIndex||0];return{...envelope(),kind:'distinct',eventVersion:event.version,canMerge:Boolean(pair),canSplit:false,count:pairs.length,pairIndex:data.pairIndex||0,reason:pair?'':'原配对事实已变化',pairs:pair?[{pairKey:pair.pairKey,otherEventId:pair.bank.eventId===event.eventId?pair.platform.eventId:pair.bank.eventId,otherEventVersion:pair.bank.eventId===event.eventId?pair.platform.version:pair.bank.version,records:[previewPair(pair).bank,previewPair(pair).platform],...pair.pairKind==='repayment'?{pairKind:'repayment',repayment:pair.repayment}:{}}]:[],records:[]}}
      const origins=model.splitOrigins(event.eventId),records=origins.map(origin=>{const row=model.rows.get(origin.rowIds[0]);return{sourceType:row.sourceType,localAt:origin.event.localAt,amountMinor:origin.event.amountMinor,currency:origin.event.currency,title:row.counterparty||row.item||'原始记录',evidenceCount:origin.rowIds.length}})
      return{...envelope(),kind:'same',eventVersion:event.version,canSplit:origins.length>1&&active(event),reason:origins.length>1?'':'相同来源身份不能拆分',count:origins.length,records}
    }
    if(action==='loans.chargePlan'){
      const dataFacts=model.supplemental||facts,contract=dataFacts.contracts.find(row=>row.loanId===data.loanId)
      const result=page(action,data,dataFacts.charges.filter(row=>row.contractId===contract?.contractId),'chargeId')
      const loan=dataFacts.loans.find(row=>row.loanId===data.loanId)
      return{...result,contract:contract||null,loan,loanVersion:Number(loan?.version)}
    }
    if(action==='loans.planCandidates'){
      const dataFacts=model.supplemental||facts,plan=require('../domain/import-review/installment-plan-fingerprint')
      const accountId=String(data.accountId||'').trim(),totalTerms=data.totalTerms == null ? null : Number(data.totalTerms)
      if(!accountId||totalTerms != null && (!Number.isInteger(totalTerms)||totalTerms<1||totalTerms>600))error('VALIDATION_ERROR','请先选择所属账户并检查总期数')
      // 旧快照没有计划种类和期数，列不出可区分的候选；宁可明确报错，也不能让用户以为没有可归入的计划。
      if(dataFacts.loans.length&&!dataFacts.loans.some(row=>row.kind!==undefined))error('LOCAL_REVIEW_REQUIRED','本机草稿缺少计划信息，请刷新后再归入已有计划')
      const fingerprint=plan.fingerprint({accountId,totalTerms,planLabel:data.planLabel,
        principalMinor:data.principalMinor==null?null:String(data.principalMinor),startMonth:data.startMonth})
      const setupOf=value=>{if(value==null)return null;if(typeof value==='object')return value;try{return JSON.parse(value)}catch(_){return null}}
      const items=dataFacts.loans.filter(row=>String(row.accountId||'')===accountId&&row.kind==='installment'&&!row.archivedAt).slice(0,50)
        .map(row=>{
          const setup=setupOf(row.installmentSetup)
          return{loanId:row.loanId,name:row.name,scheduleTerms:Number(row.scheduleTerms),
            startMonth:String(row.startDate||row.baselineDate||'').slice(0,7)||null,
            originalPrincipalMinor:setup&&setup.originalPrincipalMinor!=null?String(setup.originalPrincipalMinor):null,
            remainingPrincipalMinor:row.baselinePrincipalMinor==null?null:String(row.baselinePrincipalMinor),
            matched:plan.matches(fingerprint,row)}
        })
      return{...envelope(),items,nextCursor:null}
    }
    error('LOCAL_REVIEW_REQUIRED','完整草稿核对期间，此操作需要在本机完成')
  }
  return { read,summary,version,pairRange }
}
module.exports={create}
