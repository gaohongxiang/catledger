const protocol = require('../domain/import-review/local-review-protocol')
const { sha256 } = require('../domain/import-review/portable-digest')
const posting = require('./import-local-posting')
const modelFactory = require('./import-local-model'), readerFactory = require('./import-local-read')
const clone = modelFactory.clone
const mutations = new Set(['financeUpdates.setReview','financeUpdates.setCategory','financeUpdates.setRepayment','financeUpdates.reviseDuplicate',
  'reviewIssues.resolve','reviewIssues.resolveAccountMappings','reviewIssues.reviseAccountMapping','reviewIssues.resolvePairings'])
function create({ files, restored, callNetwork, requestId, alive = () => true, saveReceipt, cleanup, queueAbandon }) {
  const facts = restored.facts, final = Object.fromEntries(['accounts','events','pairings','reviews','duplicates'].map(kind=>[kind,new Map()]))
  const state = { schema:3,updateId:facts.update.updateId,entries:[],drafts:{},pairingDrafts:{},pairingResults:{},step:2,flight:null,postFlight:null,postRejection:null }
  const receipts = new Map(), listeners = new Set()
  let compactReceiptSaved=false
  let model, reader, closed=false, paused=false, errorMessage='', running=null, supplement=null, awaitingEdits=false
  function guard() { if(closed||!alive())throw Object.assign(new Error('登录状态已改变，草稿操作已停止'),{code:'SESSION_CHANGED'}) }
  function mutable() {guard();if(state.postFlight||paused)throw Object.assign(new Error('上次入账结果尚未核实，请继续原请求'),{code:'OPERATION_UNCONFIRMED'})}
  function applyRecord(changes) {
    for(const change of changes){
      if(final[change.kind]){if(change.value===null)final[change.kind].delete(change.key);else final[change.kind].set(change.key,clone(change.value))}
      else if(change.kind==='ui'){if(change.value===null)delete state[change.key];else state[change.key]=clone(change.value)}
      else if(change.kind==='draft'){if(change.value===null)delete state.drafts[change.key];else state.drafts[change.key]=clone(change.value)}
      else if(change.kind==='pairingDraft'){if(change.value===null)delete state.pairingDrafts[change.key];else state.pairingDrafts[change.key]=clone(change.value)}
      else if(change.kind==='receipt')receipts.set(change.key,clone(change.value))
      else if(change.kind==='postPhase')posting.applyPhase(state,change)
      else if(change.kind==='supplement')supplement=change.value
      else if(change.kind==='awaitingEdits')awaitingEdits=change.value
    }
  }
  for(const record of restored.records||[])applyRecord(record.changes)
  function rebuild() {
    model=modelFactory.create(facts)
    // Catalog changes from a definitive recheck must be visible during replay.
    if(supplement){for(const row of supplement.accounts)model.accounts.set(row.accountId,row);for(const row of supplement.categories)model.categories.set(row.categoryId,row)}
    const invalid=[]
    const attempt=(choice,work)=>{try{
      if(choice.needsRecheck)throw Object.assign(new Error('账户规则已更新，请重新确认保留的选择'),{code:'LOCAL_RECHECK_REQUIRED'})
      work()
    }catch(error){invalid.push({choice,error})}}
    const replayEditor=choice=>{
      const prior=choice.editor
      if(prior?.decisions?.repayment == null)return model.edit({eventId:choice.eventId,...prior})
      // 旧决定仍保存在日志中；预览保留账户、金额和备注，只暂停本息拆分与计划联动。
      // 必须在新界面重新保存，才能替换原决定并解除本机阻断。
      model.edit({eventId:choice.eventId,...prior,decisions:{...prior.decisions,repayment:null},
        acknowledgedChanges:[...new Set([...(prior.acknowledgedChanges||[]),'repayment'])]})
      throw Object.assign(new Error('还款现按全额转账，请重新确认账户和金额'),{code:'LOCAL_RECHECK_REQUIRED'})
    }
    for(const choice of final.duplicates.values())attempt(choice,()=>model.reviseDuplicate({...choice,eventVersion:undefined}))
    for(const choice of final.accounts.values())attempt(choice,()=>model.mapAccount(choice))
    const banks=new Set([...final.pairings.values()].filter(row=>row.decision==='same').map(row=>row.bankEventId)), memberEditors=new Map()
    for(const pair of final.pairings.values())for(const [id,value]of Object.entries(pair.memberEditors||{}))memberEditors.set(id,{eventId:id,editor:value})
    for(const choice of final.events.values())if(banks.has(choice.eventId))memberEditors.set(choice.eventId,choice)
    for(const choice of memberEditors.values())attempt(choice,()=>replayEditor(choice))
    for(const decision of ['distinct','same'])for(const choice of final.pairings.values())if(choice.decision===decision)attempt(choice,()=>model.pair({...choice,pairKey:choice.key}))
    for(const choice of final.events.values())if(!banks.has(choice.eventId))attempt(choice,()=>replayEditor(choice))
    if(supplement)model.applySupplement(supplement)
    for(const choice of final.reviews.values())attempt(choice,()=>model.review({...choice.input,issueId:choice.issueId,decision:choice.decision}))
    // Preserve invalid choices on disk and in the submission model; only their
    // effects are withheld until the user explicitly checks the affected item.
    for(const {choice,error} of invalid)for(const id of choice.eventIds||[choice.eventId,choice.bankEventId,choice.platformEventId].filter(Boolean))model.invalid.set(id,error.message)
    for(const kind of Object.keys(final))for(const [key,value]of final[kind])model.choices[kind].set(key,clone(value))
    reader=readerFactory.create(model)
  }
  rebuild()
  function emit(){for(const fn of listeners)fn()}
  function persist(changes){guard();files.save(changes);applyRecord(changes)}
  function operation(action,data){
    if(action==='financeUpdates.setReview')return model.edit(data)
    if(action==='financeUpdates.setCategory')return model.edit({eventId:data.eventId,eventVersion:data.eventVersion,editorVersion:1,fields:{categoryId:data.categoryId}})
    if(action==='financeUpdates.setRepayment')return model.edit({eventId:data.eventId,eventVersion:data.eventVersion,editorVersion:1,decisions:{repayment:data.repayment},acknowledgedChanges:['repayment']})
    if(action==='financeUpdates.reviseDuplicate')return model.reviseDuplicate(data)
    if(action==='reviewIssues.resolveAccountMappings')return data.decisions.flatMap(choice=>model.mapAccount(choice))
    if(action==='reviewIssues.reviseAccountMapping')return model.mapAccount(data)
    if(action==='reviewIssues.resolve')return model.issues.get(data.issueId)?.issueType==='account_mapping'?model.mapAccount(data):model.review(data)
    if(action==='reviewIssues.resolvePairings'){
      let scope;try{scope=JSON.parse(data.scopeToken)}catch(_){modelFactory.fail()}
      if(scope.version!==reader.version())modelFactory.fail('配对范围已变化，请重新核对')
      const range=reader.pairRange(scope),available=new Map(range.map(pair=>[pair.pairKey,pair]))
      const selected=data.selection.mode==='all_except'?range.filter(pair=>!data.selection.excludedPairKeys.includes(pair.pairKey)).map(pair=>({pairKey:pair.pairKey,decision:'same'})):data.selection.pairs
      if(selected.some(pair=>!available.has(pair.pairKey)))modelFactory.fail()
      return selected.flatMap(pair=>model.pair(pair))
    }
    modelFactory.fail()
  }
  function command(action,data) {
    mutable()
    const key=data.requestId||requestId(),digest=sha256(JSON.stringify([action,{...data,requestId:undefined}]))
    const prior=receipts.get(key)
    if(prior){if(prior.digest!==digest)throw Object.assign(new Error('同一请求的内容不能更换'),{code:'IDEMPOTENCY_CONFLICT'});return prior.receipt}
    try{
      const changes=operation(action,data),view=reader.summary()
      const receipt={protocolVersion:2,kind:'operation-receipt',receiptId:key,action,updateId:state.updateId,appliedVersion:facts.update.version,
        update:view.update,status:'review',posting:null,local:true,...data.eventId?{event:{eventId:data.eventId,version:model.events.get(data.eventId)?.version,status:model.events.get(data.eventId)?.status}}:{}}
      if(action==='reviewIssues.resolvePairings')receipt.pairing={savedCount:changes.filter(row=>row.kind==='pairings').length,totalCount:changes.filter(row=>row.kind==='pairings').length,remainingCount:0,batchSavedCount:changes.filter(row=>row.kind==='pairings').length,continuationToken:null}
      changes.push({kind:'receipt',key,value:{digest,receipt}},{kind:'awaitingEdits',value:false})
      persist(changes);errorMessage='';emit();return receipt
    }catch(error){rebuild();errorMessage=error.message;emit();throw error}
  }
  async function sendPost(){
    guard()
    if(state.postRejection)throw posting.reorganizationError()
    if(!state.postFlight){
      if(awaitingEdits||model.invalid.size)throw Object.assign(new Error('请先重新确认受影响的事项，其他选择已保留'),{code:'LOCAL_RECHECK_REQUIRED'})
      const value=model.finalState(),packed=protocol.split(JSON.stringify(value),'decisions'),id=requestId(),uploadId=requestId()
      const payload={protocolVersion:3,requestId:id,updateId:state.updateId,version:value.baseVersion,snapshotId:value.snapshotId,uploadId,payloadDigest:packed.digest}
      persist([{kind:'ui',key:'postFlight',value:{action:'financeUpdates.post',phase:posting.STAGING,payload,value}}]);emit()
    }
    const flight=state.postFlight
    let receipt=receipts.get(flight.payload.requestId)?.receipt
    if(!receipt){
      receipt=await posting.submit({flight,callNetwork,guard,persist})
      if(!posting.isReceipt(receipt,state.updateId))throw Object.assign(new Error('入账结果待核实，请继续原请求'),{code:'OPERATION_UNCONFIRMED'})
      try{persist([{kind:'receipt',key:flight.payload.requestId,value:{receipt}}])}catch(error){guard();if(receipt.status!=='posted')throw error}
    }
    if(receipt.outcome==='recheck'){
      const value=await files.download(receipt.recheck,callNetwork);guard()
      persist([{kind:'supplement',value},{kind:'ui',key:'postFlight',value:null},{kind:'awaitingEdits',value:true}])
      model.applySupplement(value);errorMessage='服务端复核发现变化，已保留其他选择，请核对标记事项';emit()
      return {...receipt,localView:reader.summary()}
    }
    // A compact confirmed receipt survives removal of every sensitive file.
    guard();state.confirmedReceipt=receipt
    const completed=posting.finish(receipt,{files,saveReceipt,cleanup})
    compactReceiptSaved=completed.saved
    if(completed.cleanupPending)errorMessage='已入账，本机清理将在恢复时重试'
    closed=true;emit()
    return receipt
  }
  // 核对时新建的计划是本机先调用接口建好的，服务端的事件里还没有这条决定；
  // 计划 ID 仅兼容旧请求；服务端按创建回执识别本批计划，并保留已使用或被修改的计划。
  function createdPlanIds() {
    const ids = new Set()
    for (const event of model.events.values()) {
      const plan = event.fieldSources && event.fieldSources.installmentPlan
      if (plan && plan.action === 'create' && plan.loanId) ids.add(plan.loanId)
    }
    return [...ids]
  }
  const session={
    isLocal:true,state,get view(){return state.confirmedReceipt||reader.summary()},get projectionRevision(){return model.revision},
    get model(){return model},get status(){return{local:true,pending:0,syncing:Boolean(running),error:errorMessage,conflicts:model.invalid.size,saved:!errorMessage,serverReviewPending:model.needsCheck.size,frozen:Boolean(state.postFlight&&!state.confirmedReceipt)}},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},accept(){},schedule(){},async flush(){guard();return reader.summary()},
    touch(){guard();try{files.touch()}catch(_){}},close(){closed=true;files.close();listeners.clear()},
    call(action,data){guard();if(action==='imports.commandResult'){const saved=receipts.get(data.requestId);if(!saved)throw Object.assign(new Error('原请求尚未保存'),{code:'OPERATION_UNCONFIRMED'});return saved.receipt}
      if(action==='financeUpdates.abandon')return session.abandon(data)
      if(action==='financeUpdates.post')return session.post()
      if(action==='financeUpdates.organize'||action==='reviewIssues.refreshAccountGroups')return reader.summary()
      return mutations.has(action)?command(action,data):reader.read(action,data)},
    hasEvent:id=>model.events.has(id),hasIssue:id=>model.issues.has(id),hasReceipt:id=>receipts.has(id),
    enqueue(entries,drafts){mutable();for(const entry of entries){const action=entry.kind==='account'?'reviewIssues.resolveAccountMappings':'reviewIssues.resolve';command(action,entry.kind==='account'?{requestId:requestId(),decisions:[{...entry.decision,issueId:entry.issueId}]}:{requestId:requestId(),issueId:entry.issueId,...entry.decision})}if(drafts)session.saveDrafts(drafts,state.step)},
    saveDrafts(drafts,step){mutable();const changes=[];for(const key of new Set(Object.keys(drafts).concat(Object.keys(state.drafts))))if(JSON.stringify(drafts[key])!==JSON.stringify(state.drafts[key]))changes.push({kind:'draft',key,value:drafts[key]||null});if(step&&step!==state.step)changes.push({kind:'ui',key:'step',value:step});if(changes.length)persist(changes)},
    savePairingDraft(key,value){mutable();persist([{kind:'pairingDraft',key,value}]);emit()},pairingTask:key=>state.pairingResults[key]||null,
    enqueuePairing(key,draft,total){mutable();if(draft.needsRecheck)modelFactory.fail();const selection=draft.mode==='suggested'?{mode:'all_except',excludedPairKeys:draft.excludedPairKeys||[]}:{mode:'include',pairs:draft.pairs};const receipt=command('reviewIssues.resolvePairings',{requestId:requestId(),scopeToken:draft.scopeToken,selection});persist([{kind:'ui',key:'pairingResults',value:{...state.pairingResults,[key]:{...receipt.pairing,status:'saved',summaryReady:true,totalCount:total}}},{kind:'pairingDraft',key,value:null}]);emit()},
    post(){if(!running)running=sendPost().catch(error=>{errorMessage=posting.needsVerification(state.postFlight)?'提交结果待核实，已保留原请求，请继续核实':error.message;emit();throw error}).finally(()=>{running=null;emit()});return running},
    async abandon(data){guard();if(state.postFlight)throw Object.assign(new Error('上次入账结果未确定，不能直接放弃；请先核实'),{code:'OPERATION_UNCONFIRMED'});const planIds=createdPlanIds(),payload={requestId:data?.requestId||requestId(),updateId:state.updateId,version:facts.update.version,...(planIds.length?{planIds}:{})};queueAbandon(payload);const cleaned=files.clear();closed=true;cleanup(cleaned);try{const receipt=await callNetwork('financeUpdates.abandon',payload);if(alive())queueAbandon(null,payload);return receipt}catch(error){return{update:{...facts.update,status:'abandoned'},offlineAbandon:true}}},
    async pause(){paused=true},resume(){guard();paused=false},async retry(){return state.postFlight?session.post():session.flush()},discardConflicts(){errorMessage='请打开标记事项重新核对，原选择仍保留';emit()},
    clear(){if(state.postFlight&&!state.confirmedReceipt)throw Object.assign(new Error('入账结果待核实，原草稿仍保留'),{code:'OPERATION_UNCONFIRMED'});const cleaned=(!state.confirmedReceipt||compactReceiptSaved)&&files.clear();closed=true;try{cleanup(cleaned)}catch(_){}},
    destroy(){closed=true;files.clear();listeners.clear()}
  }
  return session
}
module.exports={create}
