// Incremental presentation totals. Business classification remains in the same
// workbenchSummary / row-disposition / coverage rules used by the server.
const { workbenchSummary, accountIds } = require('../domain/import-review/workbench-summary')
const { deriveRowDisposition } = require('../domain/import-review/row-disposition')
const { explainedRowIds } = require('../domain/import-review/bank-channel-matching')
const { analysisFullyObserved } = require('../domain/import-review/statement-analysis')
const { SEMANTIC_HARD_BLOCKERS } = require('../domain/import-review/semantic-policy')
const { effectiveSemanticReasons } = require('../domain/import-review/payment-resolution')
const money = amount => { const value=String(amount).padStart(3,'0');return '¥'+value.slice(0,-2)+'.'+value.slice(-2) }
const minor = text => BigInt(text.replace(/[¥.]/g,''))
function create(model) {
  const cache = new Map(), rowCache = new Map(), issueCache = new Map(), issueCounts = new Map(), accountCounts = new Map()
  const totals = new Map(), scalars = new Map(), linksByRow = new Map(), explained = new Set()
  const add = (key, amount) => scalars.set(key,(scalars.get(key)||0)+amount)
  const get = key => scalars.get(key)||0
  const { facts } = model
  for(const link of model.evidence.values()){if(!linksByRow.has(link.rowId))linksByRow.set(link.rowId,[]);linksByRow.get(link.rowId).push(link)}
  const dataRows=facts.sources.reduce((total,source)=>total+Number(source.summary?.total||0),0)
  const staticConservation=facts.rows.length===dataRows&&new Set(facts.rows.map(row=>row.rowId)).size===facts.rows.length&&
    [...model.evidence.values()].every(link=>model.rows.has(link.rowId))
  const fileObservationsPassed=facts.sources.length>0&&facts.sources.every(source=>analysisFullyObserved(source.analysis)&&source.analysis.dataRows===Number(source.summary.total))
  function applyEvent(value, direction) {
    if(!value)return
    const { event, pending, accounts, selected, ready, missingEvidence, hidden }=value
    const packet=workbenchSummary(hidden?[]:[event],hidden?[]:[pending],[],0,0)
    for(const [key,count]of Object.entries(packet.recordSummary))add('record:'+key,count*direction)
    for(const kind of ['reviewStatusTabs','categoryStatusTabs'])for(const tab of packet[kind])add(kind+':'+tab.value,tab.count*direction)
    for(const key of ['categoryEventCount','categorizedEventCount'])add(key,packet[key]*direction)
    for(const [key,count]of Object.entries(packet.finalSummary))if(typeof count==='number'&&!['affectedAccountCount','newAccountCount'].includes(key))add('final:'+key,count*direction)
    for(const key of ['expenseText','incomeText','refundText'])scalars.set(key,(scalars.get(key)||0n)+minor(packet.finalSummary[key])*BigInt(direction))
    for(const group of packet.fundsFlowGroups){add('funds:'+group.nature,group.count*direction);scalars.set('fundsMoney:'+group.nature,(scalars.get('fundsMoney:'+group.nature)||0n)+minor(group.amountText)*BigInt(direction))}
    for(const id of accounts){const count=(accountCounts.get(id)||0)+direction;if(count)accountCounts.set(id,count);else accountCounts.delete(id)}
    add('selected',Number(selected)*direction);add('ready',Number(ready)*direction);add('missingEvidence',Number(missingEvidence)*direction)
    add('excluded',Number(event.status==='excluded')*direction)
    const key=event.economicNature+':'+event.status, total=totals.get(key)||{economicNature:event.economicNature,status:event.status,count:0,amountMinor:'0'}
    total.count+=direction;total.amountMinor=String(BigInt(total.amountMinor)+BigInt(event.amountMinor||0)*BigInt(direction))
    if(total.count)totals.set(key,total);else totals.delete(key)
  }
  function refreshEvent(id) {
    applyEvent(cache.get(id),-1);cache.delete(id)
    const event=model.events.get(id);if(!event)return
    const open=model.eventIssues(id).filter(issue=>issue.status==='open'),selected=!['excluded','corrected'].includes(event.status)
    const value={event,selected,hidden:model.hiddenOffset(event),ready:selected&&['ready','posted'].includes(event.status)&&
      !effectiveSemanticReasons(event,[...(event.reasonCodes||[]),...(event.fieldSources.semanticBlockers||[])]).some(reason=>SEMANTIC_HARD_BLOCKERS.includes(reason)),
      missingEvidence:selected&&!(model.byEvent.get(id)||[]).some(row=>row.evidenceRole!=='discarded'),
      accounts:event.status==='ready'?accountIds(event):[],pending:{eventId:id,
        review:model.invalid.has(id)||open.some(issue=>issue.blocking&&issue.issueType!=='category_assignment'),category:open.some(issue=>issue.issueType==='category_assignment')}}
    cache.set(id,value);applyEvent(value,1)
  }
  function applyIssue(issue,direction){if(!issue)return;const key=issue.issueType+':'+issue.status,value=issueCounts.get(key)||{issueType:issue.issueType,status:issue.status,count:0,blockingCount:0};
    value.count+=direction;if(issue.blocking&&issue.issueType!=='category_assignment')value.blockingCount+=direction
    if(value.count)issueCounts.set(key,value);else issueCounts.delete(key)
    if(issue.status==='open'&&issue.blocking)add('openBlocking',direction)
  }
  function refreshIssue(id){applyIssue(issueCache.get(id),-1);issueCache.delete(id);const issue=model.issues.get(id);if(issue){const value={issueType:issue.issueType,status:issue.status,blocking:issue.blocking};issueCache.set(id,value);applyIssue(value,1)}}
  function applyRow(value,direction){if(!value)return;add('recognized',Number(value.recognized)*direction);add('conflict',Number(value.conflict)*direction);add('disposition:'+value.disposition,direction)
    add('unresolved',Number(!value.recognized&&value.disposition!=='invalid')*direction);add('unassigned',Number(value.disposition==='unassigned')*direction)
    add('duplicateEvidence',value.duplicate*direction);add('badLink',value.badLink*direction)
  }
  function refreshRow(id){applyRow(rowCache.get(id),-1);const row=model.rows.get(id),links=linksByRow.get(id)||[]
    const value={...deriveRowDisposition(row,links,model.events,explained),duplicate:links.filter(link=>['supporting','duplicate'].includes(link.evidenceRole)).length,
      badLink:links.filter(link=>link.evidenceRole!=='discarded'&&!model.events.has(link.eventId)).length}
    rowCache.set(id,value);applyRow(value,1)
  }
  function refresh(initial=false){
    const ids=initial?[...model.events.keys()]:[...model.dirtyEvents],rowIds=initial?[...model.rows.keys()]:[...model.dirtyRows]
    // 对行的可见性取决于主行；主行被改判时一并刷新，资金与来源守恒仍按原事件计算。
    if(!initial&&ids.length){const touched=new Set(ids),rowIds=new Set(ids.flatMap(id=>model.events.get(id)?.fieldSources.rowIds||[]))
      for(const event of model.events.values())if(!touched.has(event.eventId)&&rowIds.has(event.fieldSources.disbursement?.partnerRowId))ids.push(event.eventId)}
    for(const id of rowIds)explained.delete(id)
    const changed=ids.map(id=>model.events.get(id)).filter(Boolean)
    const affectedRows=new Set(rowIds)
    for(const event of changed)for(const link of model.byEvent.get(event.eventId)||[])affectedRows.add(link.rowId)
    for(const id of explainedRowIds(changed,[...affectedRows].map(id=>model.rows.get(id))))explained.add(id)
    for(const id of ids)refreshEvent(id)
    for(const id of initial?model.issues.keys():model.dirtyIssues)refreshIssue(id)
    for(const id of affectedRows)refreshRow(id)
    model.dirtyEvents.clear();model.dirtyRows.clear();model.dirtyIssues.clear()
  }
  refresh(true)
  function summary(){refresh()
    const counts=[...issueCounts.values()],duplicate=get('duplicateEvidence'),workbench=workbenchSummary([],[],counts,duplicate,model.drafts.size)
    for(const key of Object.keys(workbench.recordSummary))workbench.recordSummary[key]+=get('record:'+key)
    for(const kind of ['reviewStatusTabs','categoryStatusTabs'])for(const tab of workbench[kind])tab.count+=get(kind+':'+tab.value)
    for(const key of ['categoryEventCount','categorizedEventCount'])workbench[key]=get(key)
    for(const [key,value]of Object.entries(workbench.finalSummary))if(typeof value==='number'&&!['newAccountCount','affectedAccountCount'].includes(key))workbench.finalSummary[key]=get('final:'+key)
    for(const key of ['expenseText','incomeText','refundText'])workbench.finalSummary[key]=money(scalars.get(key)||0n)
    workbench.finalSummary.affectedAccountCount=accountCounts.size
    const final=workbench.finalSummary;final.categoryCoverageText=final.categoryCount?final.categorizedCount+' / '+final.categoryCount:'无需分类';final.categoryComplete=final.categoryCount===final.categorizedCount
    for(const group of workbench.fundsFlowGroups){group.count=get('funds:'+group.nature);group.amountText=money(scalars.get('fundsMoney:'+group.nature)||0n)}
    const rowConservationPassed=staticConservation&&!get('missingEvidence')&&!get('badLink')&&!get('unassigned')&&!get('conflict')
    const recognizedRows=get('recognized'),selectedEvents=get('selected'),readySelectedEvents=get('ready'),openBlockingIssues=get('openBlocking')
    const coverage={dataRows,recognizedRows,unrecognizedRows:Math.max(0,dataRows-recognizedRows),invalidRows:get('disposition:invalid'),unresolvedSemanticRows:get('unresolved'),
      conflictRows:get('conflict'),dispositionCounts:Object.fromEntries(['financial','non_financial','duplicate','needs_confirmation','user_excluded','invalid','unassigned'].map(kind=>[kind,get('disposition:'+kind)])),
      rowConservationPassed,fileObservationsPassed,selectedEvents,readySelectedEvents,pendingSelectedEvents:selectedEvents-readySelectedEvents,excludedEvents:get('excluded'),openBlockingIssues,
      statementFullyRecognized:dataRows>0&&rowConservationPassed&&fileObservationsPassed&&recognizedRows===dataRows,
      selectedEventsReadyToPost:rowConservationPassed&&selectedEvents>0&&selectedEvents===readySelectedEvents&&!openBlockingIssues&&!model.invalid.size,serverReviewPending:model.needsCheck.size}
    return{workbench,coverage,issueCounts:counts,totals:[...totals.values()]}
  }
  return{summary,accountCounts}
}
module.exports={create}
