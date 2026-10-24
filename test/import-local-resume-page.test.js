const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { facts, packed, filesystem } = require('./helpers/local-review')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const { workbenchSummary } = require('../cloudfunctions/catledger-import/src/workbench-summary')
const fileStore = require('../miniprogram/packages/finance/services/import-local-files')
const base = path.resolve(__dirname, '../miniprogram')
const env = require('../miniprogram/config/cloudbase').envId
const SCOPE = env + ':1234567890'
const HOUR = 60 * 60 * 1000
async function until(check, label = 'the expected page state was reached') {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await flush()
  assert.ok(check(), label)
}
function pageRuntime(lab, options = {}) {
  return runtime(options.data || { summary: options.summary || { update: {} }, events: [], issues: [] }, {
    ...options.runtime, realLocalManager: true, realDraftManager: true, realImportApi: options.realImportApi === true, initialView: false,
    pageOptions: options.pageOptions || {},
    beforePage(h) { if (options.intercept) h.intercept = options.intercept },
    wx: { env: { USER_DATA_PATH: lab.root }, getFileSystemManager: () => lab.fs }
  })
}
async function localSnapshot(lab, { count = 2, mutate, activeAt = Date.now() } = {}) {
  const value = await facts({ count, mapped: false })
  if (mutate) mutate(value)
  const wire = packed(value)
  const store = fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE,
    updateId: value.update.updateId })
  await store.download(wire.header, wire.call)
  store.touch({ lastActiveAt: activeAt, serverTouchedAt: Date.now() })
  return { value, wire, store }
}

async function damagedPage(t) {
  const lab=filesystem();t.after(lab.cleanup)
  const original=await localSnapshot(lab)
  original.store.save([{kind:'ui',key:'postFlight',value:{payload:{requestId:'lost-request',updateId:original.value.update.updateId}}}])
  const delta=original.store.directory+'/'+original.value.snapshotId+'/decisions/delta-1.json'
  fs.writeFileSync(delta,'damaged journal')
  const h=pageRuntime(lab,{summary:{update:original.value.update},pageOptions:{updateId:original.value.update.updateId}})
  t.after(()=>h.page.onUnload())
  await until(()=>h.page.data.resumeNotice?.state==='recovery_failed')
  const fresh=JSON.parse(JSON.stringify(original.value))
  fresh.snapshotId=require('node:crypto').randomUUID();fresh.update.version++
  const wire=packed(fresh)
  return {h,lab,delta,original,fresh,wire}
}

test('真实 Page：损坏草稿联网核实失败不循环，重试通过服务端栅栏后重建且保留损坏原件',async t=>{
  const {h,delta,original,fresh,wire}=await damagedPage(t)
  assert.equal(h.page.data.resumeNotice.canAbandon,true)
  assert.equal(h.page.data.resumeNotice.continueLabel,'联网核实并恢复')
  let offline=true,version=original.value.update.version
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary'){
      if(offline)throw Error('offline')
      return {update:{...original.value.update,version}}
    }
    if(action==='financeUpdates.prepareSnapshot'){
      assert.equal(input.force,true);version=fresh.update.version
      return {update:fresh.update,snapshot:wire.header}
    }
    if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
  }
  await h.page.continueBlockedResume()
  await flush();await flush()
  assert.equal(h.calls.length,1,'失败后不应自动循环重试')
  assert.equal(h.page.data.phase,'resume');assert.equal(h.page.data.busy,false)
  assert.match(h.page.data.errorMessage,/核实未完成/)
  assert.equal(fs.existsSync(delta),true)
  offline=false
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'review');assert.equal(h.page.data.resumeNotice,null)
  assert.equal(h.page._draftSession.state.postFlight,null)
  assert.equal(h.page._draftSession.view.update.version,fresh.update.version)
  assert.equal(fs.existsSync(delta),true,'恢复成功前后均不覆写损坏原件')
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

test('真实 Page：重建回执丢失重用原请求，本机保存失败不删除原件，随后可恢复',async t=>{
  const {h,lab,delta,original,fresh,wire}=await damagedPage(t)
  let version=original.value.update.version,lost=true,failStorage=false
  const ids=[]
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...original.value.update,version}}
    if(action==='financeUpdates.prepareSnapshot'){
      ids.push(input.requestId);version=fresh.update.version
      if(lost){lost=false;throw Error('response lost')}
      return {update:fresh.update,snapshot:wire.header}
    }
    if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
  }
  await h.page.continueBlockedResume()
  assert.equal(fs.existsSync(delta),true)
  failStorage=true
  lab.fault.fn=(name)=>{if(failStorage&&name==='write')throw Error('disk full')}
  await h.page.continueBlockedResume()
  assert.match(h.page.data.errorMessage,/本机仍无法保存/)
  assert.equal(fs.existsSync(delta),true)
  failStorage=false
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'review')
  assert.equal(ids.length,3);assert.equal(new Set(ids).size,1)
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

test('真实 Page：旧入账先完成则重建冲突转为显示正式结果，不再次提交',async t=>{
  const {h,delta,original}=await damagedPage(t)
  let posted=false
  h.intercept=action=>{
    if(action==='financeUpdates.summary')return {update:{...original.value.update,status:posted?'posted':'review'}}
    if(action==='financeUpdates.prepareSnapshot'){
      posted=true;throw Object.assign(Error('conflict'),{code:'CONFLICT'})
    }
  }
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.update.status,'posted')
  assert.equal(h.page.data.resumeNotice,null)
  assert.equal(fs.existsSync(delta),false,'服务端确定入账且回执保存后才清理')
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'||call.action==='financeUpdates.abandon'),false)
})

test('真实 Page：恢复中离开再返回，迟到下载不能替换当前会话或覆盖新选择',async t=>{
  const {h,lab,original,fresh,wire}=await damagedPage(t)
  await until(()=>!h.page._pendingInitialLoad?.attempt)
  let releaseFirst,firstManifest=true,version=original.value.update.version
  const requests=[]
  h.intercept=async(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...original.value.update,version}}
    if(action==='financeUpdates.prepareSnapshot'){
      requests.push(input.requestId);version=fresh.update.version
      return{update:fresh.update,snapshot:wire.header}
    }
    if(action==='financeUpdates.snapshotManifest'&&firstManifest){
      firstManifest=false
      await new Promise(resolve=>{releaseFirst=resolve})
    }
    if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
  }
  const firstRecovery=h.page.continueBlockedResume()
  t.after(()=>{if(releaseFirst)releaseFirst()})
  await until(()=>Boolean(releaseFirst),'第一次下载应停在清单响应')
  h.page.onHide();await h.page.onShow()
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'review')
  const visible=h.page._draftSession
  visible.saveDrafts({before:{note:'迟到响应前已保存'}},2)
  releaseFirst();await firstRecovery
  const routed=h.load(path.join(base,'services/import-local-router.js')).session(original.value.update.updateId)
  assert.equal(routed,visible,'旧恢复不能重新绑定另一份可写会话')
  assert.equal(h.page._draftSession,visible)
  visible.saveDrafts({...visible.state.drafts,after:{note:'迟到响应后已保存'}},2)
  routed.saveDrafts({...routed.state.drafts,other:{note:'通过当前会话继续保存'}},2)
  const restored=fileStore.create({...lab,root:lab.root+'/catledger-import-local-v3',scope:SCOPE,
    updateId:original.value.update.updateId}).restore()
  assert.deepEqual(restored.records.flatMap(record=>record.changes).filter(change=>change.kind==='draft').map(change=>change.key),
    ['before','after','other'],'两个入口的保存不能使用分叉 revision 覆写彼此')
  assert.equal(requests.length,2);assert.equal(new Set(requests).size,1,'回来继续应重放原恢复请求')
  h.page.onHide();await h.page.onShow()
  h.page._draftSession.saveDrafts({...h.page._draftSession.state.drafts,returned:{note:'恢复成功后正常返回仍可编辑'}},2)
  assert.equal(h.page._draftSession.state.drafts.returned.note,'恢复成功后正常返回仍可编辑')
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

test('真实 Page：已确认入账后恢复键清理失败仍显示结果，保留可再次读取的正式回执',async t=>{
  const {h,delta,original}=await damagedPage(t)
  let posted=false
  h.intercept=action=>{
    if(action==='financeUpdates.summary')return{update:{...original.value.update,status:posted?'posted':'review'}}
    if(action==='financeUpdates.prepareSnapshot')throw Error('response lost')
  }
  await h.page.continueBlockedResume()
  const recoveryKey=[...h.storage.keys()].find(key=>key.endsWith(':recovery'))
  assert.ok(recoveryKey);assert.equal(fs.existsSync(delta),true)
  const remove=h.wx.removeStorageSync
  let removalAttempts=0
  h.wx.removeStorageSync=key=>{
    if(key===recoveryKey){removalAttempts++;throw Error('storage unavailable')}
    return remove(key)
  }
  posted=true
  await h.page.continueBlockedResume()
  assert.equal(removalAttempts,1)
  assert.equal(h.page.data.phase,'done');assert.equal(h.page.data.update.status,'posted')
  assert.equal(h.page.data.resumeNotice,null);assert.equal(h.page.data.busy,false)
  assert.doesNotMatch(h.page.data.errorMessage,/核实未完成|原文件已保留/)
  assert.equal(fs.existsSync(delta),false,'正式回执已保存才可清理原文件')
  assert.ok(h.storage.get(recoveryKey),'清理失败的恢复键仍保留')
  const restored=h.load(path.join(base,'packages/finance/services/import-local-manager.js')).restore(original.value.update.updateId)
  assert.equal(restored.completed,true);assert.equal(restored.view.update.status,'posted')
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'||call.action==='financeUpdates.abandon'),false)
})

test('真实 Page：永久损坏可核实后重新开始，终止响应丢失前保留原件',async t=>{
  const {h,delta,original}=await damagedPage(t)
  let abandoned=false,lost=true
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...original.value.update,status:abandoned?'abandoned':'review'}}
    if(action==='financeUpdates.abandon'){
      assert.equal(input.version,original.value.update.version)
      abandoned=true
      if(lost){lost=false;throw Error('response lost')}
      return{...original.value.update,status:'abandoned'}
    }
  }
  await h.page.abandonRestoringUpdate()
  assert.equal(h.page.data.phase,'resume');assert.equal(fs.existsSync(delta),true)
  await h.page.abandonRestoringUpdate()
  assert.equal(h.page.data.phase,'idle');assert.equal(h.page.data.resumeNotice,null)
  assert.equal(fs.existsSync(delta),false)
  assert.equal(h.calls.filter(call=>call.action==='financeUpdates.abandon').length,1)
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

async function frozenPage(t,{legacy=false,expired=false}={}) {
  const lab=filesystem();t.after(lab.cleanup)
  const original=await localSnapshot(lab)
  const value=require('../miniprogram/packages/finance/services/import-local-model').create(original.value).finalState()
  const protocol=require('../miniprogram/packages/finance/domain/import-review/local-review-protocol')
  const flight={action:'financeUpdates.post',...(legacy?{}:{phase:'submitted'}),value,
    payload:{protocolVersion:3,requestId:'11111111-1111-4111-8111-111111111111',
      uploadId:'22222222-2222-4222-8222-222222222222',updateId:value.updateId,
      version:value.baseVersion,snapshotId:value.snapshotId,payloadDigest:protocol.split(JSON.stringify(value),'decisions').digest}}
  original.store.save([{kind:'draft',key:'saved-choice',value:{note:'保留的选择'}},{kind:'ui',key:'postFlight',value:flight}])
  if(expired)original.store.touch({lastActiveAt:Date.now()-25*HOUR})
  const h=pageRuntime(lab,{summary:{update:original.value.update},pageOptions:{updateId:value.updateId}})
  t.after(()=>h.page.onUnload())
  await until(()=>expired?h.page.data.resumeNotice?.state==='post_pending':h.page.data.phase==='review')
  const pendingError=code=>Object.assign(Error(code),{code})
  h.intercept=action=>{
    if(action==='imports.commandResult')throw pendingError('OPERATION_UNCONFIRMED')
    if(action==='financeUpdates.stageDecisions')throw pendingError('CONFLICT')
  }
  const assertPreserved=()=>{
    assert.equal(fs.existsSync(original.store.directory),true)
    const records=original.store.restore().records.flatMap(record=>record.changes)
    assert.deepEqual(records.find(change=>change.key==='postFlight').value,flight)
    assert.equal(records.find(change=>change.key==='saved-choice').value.note,'保留的选择')
  }
  return{h,original,flight,pendingError,assertPreserved}
}

test('真实 Page：完整冻结请求遇到旧版本冲突显示恢复卡，主按钮仍核实原请求',async t=>{
  const {h,original,flight,assertPreserved}=await frozenPage(t)
  const view=h.page._draftSession.view
  await h.page.postUpdate()
  assert.equal(h.page.data.phase,'resume')
  assert.equal(h.page.data.resumeNotice.state,'post_pending')
  assert.equal(h.page.data.resumeNotice.continueLabel,'继续核实入账结果')
  assert.equal(h.page.data.resumeNotice.abandonLabel,'核实并重新开始')
  assert.equal(h.page.data.resumeNotice.canAbandon,true)
  assertPreserved()
  assert.throws(()=>h.page._draftSession.saveDrafts({changed:{note:'不能提前编辑'}},2),error=>error.code==='OPERATION_UNCONFIRMED')
  const receipt={...view,action:'financeUpdates.post',updateId:flight.payload.updateId,status:'posted',update:{...view.update,status:'posted'}}
  h.intercept=action=>action==='imports.commandResult'||action==='financeUpdates.summary'?receipt:undefined
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'done');assert.equal(h.page.data.resumeNotice,null)
  assert.equal(fs.existsSync(original.store.directory),false)
  const queries=h.calls.filter(call=>call.action==='imports.commandResult')
  assert.equal(queries.length,2);assert.ok(queries.every(call=>call.input.requestId===flight.payload.requestId))
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'||call.action==='financeUpdates.abandon'),false)
})

test('真实 Page：冻结请求核实重启时原入账先完成，显示正式结果且不再次提交',async t=>{
  const {h,original,pendingError,assertPreserved}=await frozenPage(t)
  await h.page.postUpdate();assertPreserved()
  let posted=false
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...original.value.update,version:original.value.update.version+1,status:posted?'posted':'review'}}
    if(action==='financeUpdates.abandon'){
      assert.equal(input.version,original.value.update.version+1)
      posted=true;throw pendingError('CONFLICT')
    }
  }
  await h.page.abandonRestoringUpdate()
  assert.equal(h.page.data.phase,'done');assert.equal(h.page.data.update.status,'posted')
  assert.equal(h.page.data.resumeNotice,null);assert.equal(fs.existsSync(original.store.directory),false)
  assert.equal(h.calls.filter(call=>call.action==='financeUpdates.abandon').length,1)
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

test('真实 Page：超过 24 小时的旧冻结请求可核实重启，断网与终止响应丢失保留材料',async t=>{
  const {h,original,flight,pendingError,assertPreserved}=await frozenPage(t,{legacy:true,expired:true})
  assert.equal(h.page.data.resumeNotice.canAbandon,true)
  assert.equal(h.page.data.resumeNotice.abandonLabel,'核实并重新开始')
  assert.equal(h.calls.length,0,'TTL 门禁本身不自动联网')
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.resumeNotice.state,'post_pending');assertPreserved()
  const oldSession=h.page._draftSession
  const callsBefore=h.calls.length
  h.intercept=()=>{throw Error('offline')}
  await h.page.abandonRestoringUpdate();await flush();await flush()
  assert.equal(h.calls.length,callsBefore+1,'网络失败后不能自动循环')
  assert.equal(h.page.data.phase,'resume');assert.equal(h.page.data.busy,false)
  assert.match(h.page.data.errorMessage,/核实未完成/);assertPreserved()
  h.intercept=action=>{
    if(action==='imports.commandResult')throw pendingError('OPERATION_UNCONFIRMED')
    if(action==='financeUpdates.stageDecisions')throw pendingError('CONFLICT')
  }
  await h.page.continueBlockedResume()
  assert.notEqual(h.page._draftSession,oldSession,'安全核实关闭的会话不能被重新用于原请求重试')
  assert.equal(h.page._draftSession.state.postFlight.payload.requestId,flight.payload.requestId)
  assert.equal(h.page.data.resumeNotice.state,'post_pending');assertPreserved()
  let abandoned=false
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...original.value.update,version:original.value.update.version+1,status:abandoned?'abandoned':'review'}}
    if(action==='financeUpdates.abandon'){
      assert.equal(input.version,original.value.update.version+1)
      abandoned=true;throw Error('response lost')
    }
  }
  await h.page.abandonRestoringUpdate()
  assert.equal(h.page.data.phase,'resume');assertPreserved()
  await h.page.abandonRestoringUpdate()
  assert.equal(h.page.data.phase,'idle');assert.equal(h.page.data.resumeNotice,null)
  assert.equal(fs.existsSync(original.store.directory),false)
  assert.equal(h.calls.filter(call=>call.action==='financeUpdates.abandon').length,1)
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

test('真实 Page：当前规则提交前拒绝可重新下载继续，不调用已禁用的旧整理入口',async t=>{
  const lab=filesystem();t.after(lab.cleanup)
  const {value,store}=await localSnapshot(lab)
  store.save([{kind:'draft',key:'saved-choice',value:{note:'保留的选择'}},
    {kind:'ui',key:'postRejection',value:{code:'CONFLICT'}}])
  const fresh=JSON.parse(JSON.stringify(value))
  fresh.snapshotId=require('node:crypto').randomUUID();fresh.update.version+=2
  const wire=packed(fresh)
  const h=pageRuntime(lab,{summary:{update:value.update},pageOptions:{updateId:value.update.updateId}})
  t.after(()=>h.page.onUnload())
  await until(()=>h.page.data.resumeNotice?.state==='server_changed')
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...value.update,version:fresh.update.version-1,requiresReorganization:false}}
    if(action==='financeUpdates.organize')throw Object.assign(Error('legacy route disabled'),{code:'LOCAL_REVIEW_REQUIRED'})
    if(action==='financeUpdates.prepareSnapshot'){assert.equal(input.force,true);return{update:fresh.update,snapshot:wire.header}}
    if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
  }
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'review')
  assert.equal(h.page._draftSession.state.postRejection,null)
  assert.equal(h.page._draftSession.state.drafts['saved-choice'].note,'保留的选择')
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.organize'),false)
})

test('真实 Page：重建请求断网保留原身份，明确冲突后可按新版本重试且保留选择',async t=>{
  const lab=filesystem();t.after(lab.cleanup)
  const {value,store}=await localSnapshot(lab)
  store.save([{kind:'draft',key:'saved-choice',value:{note:'保留的选择'}},
    {kind:'ui',key:'postRejection',value:{code:'CONFLICT'}}])
  const fresh=JSON.parse(JSON.stringify(value))
  fresh.snapshotId=require('node:crypto').randomUUID();fresh.update.version+=4
  const wire=packed(fresh),requests=[]
  let version=value.update.version+1
  const h=pageRuntime(lab,{summary:{update:value.update},pageOptions:{updateId:value.update.updateId}})
  t.after(()=>h.page.onUnload())
  await until(()=>h.page.data.resumeNotice?.state==='server_changed')
  h.intercept=(action,input)=>{
    if(action==='financeUpdates.summary')return{update:{...value.update,version,requiresReorganization:false}}
    if(action==='financeUpdates.prepareSnapshot'){
      requests.push({...input})
      if(requests.length===1)throw Error('response lost')
      if(requests.length===2)throw Object.assign(Error('version changed'),{code:'CONFLICT'})
      return{update:fresh.update,snapshot:wire.header}
    }
    if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
  }
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'error')
  version++
  await h.page.loadUpdate(value.update.updateId,true)
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'error')
  assert.deepEqual(requests[1],requests[0],'未知结果必须复用原身份与版本')
  version++
  await h.page.loadUpdate(value.update.updateId,true)
  await h.page.continueBlockedResume()
  assert.equal(h.page.data.phase,'review')
  assert.notEqual(requests[2].requestId,requests[0].requestId)
  assert.equal(requests[2].version,version)
  assert.equal(h.page._draftSession.state.drafts['saved-choice'].note,'保留的选择')
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.post'),false)
})

test('真实 Page：本机 12 小时门禁明确提示，继续后打开账户页并刷新活动时间', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const activeAt = Date.now() - 13 * HOUR
  const { value, store } = await localSnapshot(lab, { activeAt })
  const h = pageRuntime(lab, { summary: { update: value.update }, realImportApi: true, pageOptions: { updateId: value.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), '12h gate should render')
  assert.match(h.page.data.resumeNotice.title, /上次导入还没完成/)
  assert.match(h.page.data.resumeNotice.summary, /第 [23] 步/)
  assert.match(h.page.data.resumeNotice.summary, /待核对/)
  assert.match(h.page.data.resumeNotice.message, /保留到/)
  assert.equal(h.page.data.resumeNotice.canContinue, true)
  assert.equal(h.page.data.restoreUpdateId, value.update.updateId)
  assert.equal(h.page.data.phase, 'resume')
  assert.equal(h.calls.length, 0, '门禁本身不应该访问网络')

  await h.page.continueBlockedResume()
  await until(() => h.page.data.phase === 'review', '继续后应进入核对页')
  await h.page.setStep({ currentStep: 2 })
  await until(() => h.page.data.accountMappings.length > 0, '继续后账户页应可渲染')
  assert.ok(h.page.data.accountMappingsIncluded.length, '账户页不能白屏')
  assert.equal(h.page.data.resumeNotice, null)
  assert.ok(store.activity().lastActiveAt > activeAt)
  t.diagnostic('真实 Page 12h 门禁：继续后账户页非空')
})

test('真实 Page：24 小时已清理门禁无继续入口，放弃后回到选文件', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const activeAt = Date.now() - 25 * HOUR
  const { value, store } = await localSnapshot(lab, { activeAt })
  const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), '24h gate should render')
  assert.match(h.page.data.resumeNotice.title, /24 小时/)
  assert.equal(h.page.data.resumeNotice.canContinue, false)
  assert.equal(fs.existsSync(store.directory), false)
  const markup = fs.readFileSync(path.join(base, 'packages/finance/pages/import-workbench/index.wxml'), 'utf8')
  assert.match(markup, /data-ui="resume-gate"/)
  assert.match(markup, /bindtap="continueBlockedResume"/)
  assert.match(markup, /bindtap="abandonRestoringUpdate"/)
  assert.match(markup, /abandon-spinner/)
  assert.match(markup, /放弃中/)

  h.intercept = action => action === 'financeUpdates.summary'
    ? { ...h.summary, update: { ...h.summary.update, status: 'abandoned' } } : undefined
  await h.page.abandonRestoringUpdate()
  await until(() => h.page.data.phase === 'idle', '放弃后应回到第一步')
  assert.equal(h.page.data.resumeNotice, null)
  assert.equal(h.page.data.update, null)
})

test('真实 Page：解析规则变化要求重新上传，原件已清理时提示更明确', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  for (const missing of [false, true]) {
    const { value } = await localSnapshot(lab, { activeAt: Date.now(), mutate: factsValue => {
      factsValue.sources[0].parserVersion = 'legacy-parser-v0'
      if (missing) factsValue.sources[0].contentDeletedAt = '2026-10-18 00:00:00.000'
    } })
    const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId } })
    await until(() => Boolean(h.page.data.resumeNotice), 'parse gate should render')
    assert.match(h.page.data.resumeNotice.title, /解析规则已更新/)
    assert.equal(h.page.data.resumeNotice.canContinue, false)
    assert.equal(h.page.data.resumeNotice.originalMissing, missing)
    assert.match(h.page.data.resumeNotice.message, /重新上传/)
    if (missing) assert.match(h.page.data.resumeNotice.message, /原件已清理/)
    assert.equal(h.calls.length, 0)
    h.page.onUnload()
  }
})

test('真实 Page：语义规则变化提示重新整理并保留待继续入口', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const { value } = await localSnapshot(lab, { activeAt: Date.now(), mutate: factsValue => {
    factsValue.ruleVersion = 'organizer-plan-v0'
  } })
  const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), 'semantic gate should render')
  assert.match(h.page.data.resumeNotice.title, /整理规则已更新/)
  assert.equal(h.page.data.resumeNotice.canContinue, true)
  assert.equal(h.page.data.resumeNotice.state, 'semantic')
  assert.match(h.page.data.resumeNotice.continueLabel, /重新整理/)
  assert.equal(h.calls.length, 0)
})


test('真实 Page：语义规则变化继续时先 organize，再强制新快照并迁移已保存决定', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const oldValue = await facts({ count: 2, mapped: false })
  oldValue.ruleVersion = 'organizer-plan-v0'
  const oldWire = packed(oldValue)
  const store = fileStore.create({ ...lab, root: lab.root + '/catledger-import-local-v3', scope: SCOPE, updateId: oldValue.update.updateId })
  await store.download(oldWire.header, oldWire.call)
  store.touch({ lastActiveAt: Date.now(), serverTouchedAt: Date.now() })
  store.save([{ kind: 'draft', key: 'legacy', value: { note: '保留的旧选择' } }])
  const nextValue = await facts({ count: 2, mapped: false })
  nextValue.update.updateId = oldValue.update.updateId
  nextValue.update.version = 4
  const nextWire = packed(nextValue)
  const h = pageRuntime(lab, { summary: { update: { ...oldValue.update, reviewMode: 'local_v3' } },
    pageOptions: { updateId: oldValue.update.updateId } })
  t.after(() => h.page.onUnload())
  await until(() => Boolean(h.page.data.resumeNotice), 'semantic gate should render')
  assert.equal(h.page.data.resumeNotice.state, 'semantic')
  h.intercept = (action, input) => {
    if (action === 'financeUpdates.summary') return { ...h.summary, update: { ...h.summary.update, status: 'review',
      reviewMode: 'local_v3', requiresReorganization: true, version: 2, ageMs: 0 } }
    if (action === 'financeUpdates.organize') return { update: { ...h.summary.update, status: 'review',
      reviewMode: 'local_v3', requiresReorganization: false, version: 3, ageMs: 0 } }
    if (action === 'financeUpdates.prepareSnapshot') return { update: { ...h.summary.update, status: 'review',
      reviewMode: 'local_v3', requiresReorganization: false, version: 4, ageMs: 0 }, snapshot: nextWire.header }
    if (action.startsWith('financeUpdates.snapshot')) return nextWire.call(action, input)
  }
  await h.page.continueBlockedResume()
  await until(() => h.page.data.phase === 'review', 'semantic continue should open review')
  assert.ok(h.calls.some(call => call.action === 'financeUpdates.organize'))
  const prepared = h.calls.find(call => call.action === 'financeUpdates.prepareSnapshot')
  assert.equal(prepared.input.force, true)
  assert.equal(h.page._draftSession.state.drafts.legacy.note, '保留的旧选择')
  assert.equal(h.page.data.resumeNotice, null)
})


test('真实 Page：本机新鲜但服务端租约超过 24h 时只在恢复边界续期，随后照常打开', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const { value, store } = await localSnapshot(lab, { activeAt: Date.now() })
  store.touch({ serverTouchedAt: Date.now() - 25 * HOUR })
  const h = pageRuntime(lab, { summary: { update: value.update }, pageOptions: { updateId: value.update.updateId },
    intercept: (action) => action === 'financeUpdates.prepareSnapshot' ? { update: { ...value.update, ageMs: 0 } } : undefined })
  t.after(() => h.page.onUnload())
  await until(() => h.page.data.phase === 'review', 'lease refresh should still open the local session')
  const prepared = h.calls.find(call => call.action === 'financeUpdates.prepareSnapshot')
  assert.ok(prepared)
  assert.equal(prepared.input.updateId, value.update.updateId)
  assert.equal(prepared.input.force, undefined)
  assert.ok(store.activity().serverTouchedAt > Date.now() - 1000)
})

test('真实 Page：服务端 24 小时不自动打开，继续后可恢复；48 小时不可继续', async t => {
  for (const [ageMs, state, canContinue, title] of [
    [25 * HOUR, 'idle', true, /24 小时/],
    [49 * HOUR, 'expired', false, /48 小时/]
  ]) {
    const data = fixture(2)
    data.summary.update = { ...data.summary.update, status: 'review', reviewMode: 'local_v3', ageMs }
    const h = runtime(data, { initialView: false, pageOptions: { updateId: data.summary.update.updateId } })
    const page = h.page
    await until(() => Boolean(page.data.resumeNotice), 'server gate should render')
    assert.match(page.data.resumeNotice.title, title)
    assert.equal(page.data.resumeNotice.source, 'server')
    assert.equal(page.data.resumeNotice.state, state)
    assert.equal(page.data.resumeNotice.canContinue, canContinue)
    if (canContinue) {
      await page.continueBlockedResume()
      await until(() => page.data.phase === 'review', 'manual server resume should open')
      assert.equal(page.data.resumeNotice, null)
    }
    page.onUnload()
  }
})

function accountFixture() {
  const data = fixture(2)
  data.issues = data.events.map((event, index) => ({ issueId: 'resume-account-' + index, issueType: 'account_mapping',
    status: 'open', version: 1, blocking: true, memberCount: 1, subject: event,
    accountContext: { recognized: true, sourceType: 'wechat', label: '合成钱包', currency: 'CNY' } }))
  data.summary.workbench = workbenchSummary(data.events, [], [{ issueType: 'account_mapping', status: 'open', count: 2 }], 0, 0)
  return data
}

test('账户页滚动恢复在真实 Page 上记录并恢复位置，不因后台刷新丢失账户列表', async t => {
  const data = accountFixture()
  const scrolls = []
  const h = runtime(data, { wx: { pageScrollTo: options => scrolls.push(options.scrollTop) } })
  const page = h.page
  await page.setStep({ currentStep: 2 })
  await until(() => page.data.accountMappings.length > 0, '账户页应有内容')
  page.onPageScroll({ scrollTop: 486 })
  assert.equal(page._pageScrollTop, 486)
  page._accountScrollTarget = 486
  page.restoreAccountScroll()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(scrolls.includes(486), '应恢复账户页滚动位置')
  page.applyUpdateView({ ...h.summary, viewVersion: 'v2' }, true)
  await flush()
  assert.ok(page.data.accountMappingsIncluded.length, '后台刷新后账户页不能变成 0/0 白屏')
  page._accountScrollTarget = 486
  page.restoreAccountScroll()
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(scrolls.includes(486))
  page.onUnload()
})
