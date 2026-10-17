const test=require('node:test')
const assert=require('node:assert/strict')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {facts,packed,filesystem}=require('./helpers/local-review')
const {runtime}=require('./helpers/paged-workbench')
const base=path.resolve(__dirname,'../miniprogram')

test('换号清理失败会阻止恢复，重试补清后 B 无法读取 A 的草稿',async t=>{
  const lab=filesystem();t.after(lab.cleanup)
  const value=await facts(),wire=packed(value),env=require('../miniprogram/config/cloudbase').envId
  const store=require('../miniprogram/packages/finance/services/import-local-files').create({
    ...lab,root:lab.root+'/catledger-import-local-v3',scope:env+':1234567890',updateId:value.update.updateId})
  await store.download(wire.header,wire.call)
  const h=runtime({summary:{update:value.update},events:[],issues:[]},{realLocalManager:true,realDraftManager:true,
    initialView:false,pageOptions:{fresh:'1'},wx:{env:{USER_DATA_PATH:lab.root},getFileSystemManager:()=>lab.fs}})
  t.after(()=>h.page.onUnload())
  const manager=h.load(path.join(base,'packages/finance/services/import-local-manager.js'))
  const old=manager.restore(value.update.updateId)
  assert.ok(old)
  lab.fault.fn=name=>{if(name==='remove')throw Error('synthetic disk busy')}
  h.app.globalData.uid='9876543210'
  assert.throws(()=>manager.restore(value.update.updateId),{code:'DRAFT_STORAGE_FAILED'})
  assert.throws(()=>old.call('financeUpdates.setReview',{eventId:value.events[0].eventId,editorVersion:1,fields:{note:'late'}}))
  lab.fault.fn=null
  const oldPointer='catledger_local_v3:'+env+':1234567890:'+value.update.updateId+':prepare'
  h.storage.set(oldPointer,{requestId:randomUUID()})
  const remove=h.wx.removeStorageSync
  h.wx.removeStorageSync=key=>{if(key===oldPointer)throw Error('synthetic storage busy');remove(key)}
  assert.throws(()=>manager.restore(value.update.updateId),{code:'DRAFT_STORAGE_FAILED'})
  assert.equal(store.restore(),null)
  h.wx.removeStorageSync=remove
  assert.equal(manager.restore(value.update.updateId),null)
  assert.equal(store.restore(),null)
  assert.equal(h.storage.has(oldPointer),false)
  assert.deepEqual([...h.storage.get('catledger_local_review_cleanup_v3')],[])
})

test('下载中断的新协议批次不能退回旧编辑入口，原请求重试完整下载后才能编辑',async t=>{
  const lab=filesystem();t.after(lab.cleanup)
  const value=await facts(),wire=packed(value),view={update:value.update}
  let interrupted=true
  const h=runtime({summary:view,events:[],issues:[]},{realLocalManager:true,realDraftManager:true,
    initialView:false,pageOptions:{fresh:'1'},wx:{env:{USER_DATA_PATH:lab.root},getFileSystemManager:()=>lab.fs},
    beforePage(h){h.intercept=async(action,input)=>{
      if(action==='financeUpdates.prepareSnapshot')return{update:value.update,snapshot:wire.header}
      if(action==='financeUpdates.snapshotChunk'&&interrupted)throw Error('synthetic interrupted download')
      if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
    }}})
  t.after(()=>h.page.onUnload())
  const manager=h.load(path.join(base,'packages/finance/services/import-local-manager.js'))
  const drafts=h.load(path.join(base,'services/import-draft-session.js'))
  await assert.rejects(manager.prepare(view),/interrupted/)
  assert.equal(manager.restore(value.update.updateId),null)
  assert.throws(()=>drafts.open(view),{code:'SNAPSHOT_INCOMPLETE'})
  interrupted=false
  const restored=await manager.prepare(view)
  assert.equal(drafts.open(restored).isLocal,true)
  const requests=h.calls.filter(row=>row.action==='financeUpdates.prepareSnapshot').map(row=>row.input.requestId)
  assert.equal(requests.length,2);assert.equal(requests[0],requests[1])
})

test('旧草稿迁移先核实两个原请求，再整理和下载；失败保留旧内容',async t=>{
  for(const failed of [false,true])await t.test(failed?'核实失败保留':'原回执和编辑输入迁移',async sub=>{
    const lab=filesystem();sub.after(lab.cleanup)
    const value=await facts({count:3}),summary=require('../miniprogram/packages/finance/services/import-local-read').create(require('../miniprogram/packages/finance/services/import-local-model').create(value)).summary()
    summary.update={...summary.update,reviewMode:'server',version:2}
    const env=require('../miniprogram/config/cloudbase').envId,legacyKey='catledger_import_draft_v1:'+env+':'+value.update.updateId
    const oldRequest=randomUUID(),editorRequest=randomUUID(),pendingKey='catledger_pending_ledger_v1:'+env+':1234567890'
    const old={schema:2,updateId:value.update.updateId,entries:[{kind:'review',issueId:'old',status:'queued'}],drafts:{unsent:{mode:'ignore_future',localConfirmed:true,dirty:false,revision:1}},
      flight:{ids:['old'],action:'reviewIssues.resolve',payload:{requestId:oldRequest,updateId:value.update.updateId,updateVersion:1,decision:'confirm_distinct'},reconcile:true}}
    let wire
    const h=runtime({summary,events:value.events,issues:value.issues},{realLocalManager:true,realDraftManager:true,
      initialView:false,pageOptions:{fresh:'1'},wx:{env:{USER_DATA_PATH:lab.root},getFileSystemManager:()=>lab.fs},
      beforePage(h){
        h.storage.set(legacyKey,structuredClone(old))
        h.storage.set(pendingKey,{schema:1,target:'import',action:'financeUpdates.setReview',payload:{requestId:editorRequest,updateId:value.update.updateId,eventId:value.events[0].eventId,editorVersion:1,fields:{note:'原编辑'}}})
        h.intercept=async(action,input)=>{
          if(action==='imports.commandResult'){
            if(failed)throw Object.assign(Error('network'),{code:'CLOUD_CALL_FAILED'})
            assert.ok([oldRequest,editorRequest].includes(input.requestId))
            h.summary={...h.summary,update:{...h.summary.update,version:3}}
            return{action:input.commandAction,requestId:input.requestId,update:h.summary.update}
          }
          if(action==='financeUpdates.organize')return{update:h.summary.update}
          if(action==='financeUpdates.prepareSnapshot'){
            value.update.version=input.version+1;wire=packed(value)
            return{snapshot:wire.header,update:value.update}
          }
          if(action.startsWith('financeUpdates.snapshot'))return wire.call(action,input)
        }
      }})
    sub.after(()=>h.page.onUnload())
    await h.page.loadUpdate(value.update.updateId)
    const commands=h.calls.map(row=>row.action)
    if(failed){
      assert.equal(h.page.data.phase,'error');assert.ok(h.storage.has(legacyKey));assert.ok(h.storage.has(pendingKey))
      assert.equal(commands.includes('financeUpdates.organize'),false);assert.equal(commands.includes('financeUpdates.prepareSnapshot'),false)
      assert.equal(h.storage.get(legacyKey).flight.payload.requestId,oldRequest)
    }else{
      const verified=h.calls.filter(row=>row.action==='imports.commandResult').map(row=>row.input.requestId)
      assert.deepEqual(verified,[editorRequest,oldRequest])
      assert.ok(commands.lastIndexOf('imports.commandResult')<commands.indexOf('financeUpdates.organize'))
      assert.ok(commands.indexOf('financeUpdates.organize')<commands.indexOf('financeUpdates.prepareSnapshot'))
      assert.equal(h.storage.has(legacyKey),false);assert.equal(h.storage.has(pendingKey),false)
      const session=h.load(path.join(base,'services/import-local-router.js')).session(value.update.updateId)
      assert.ok(session,h.page.data.errorMessage)
      assert.equal(session.state.drafts.unsent.mode,'ignore');assert.equal(session.state.drafts.unsent.localConfirmed,false)
    }
  })
})
