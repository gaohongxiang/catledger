const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime,fixture,flush } = require('./helpers/paged-workbench')
const { setup:pairing } = require('./helpers/pairing-workbench')
const tap=id=>({ currentTarget:{ dataset:{ id } } })
const ACTION='financeUpdates.reviseDuplicate'
function editor(kind='same') {
  const h=runtime(fixture(2)),page=h.page
  const records=['bank','wechat'].map(sourceType=>({ sourceType,title:'合成记录',localAt:'2026-09-01 12:00:00',amountMinor:'100',currency:'CNY',evidenceCount:1 }))
  h.preview=()=>({ protocolVersion:2,viewVersion:h.summary.viewVersion,update:h.summary.update,eventVersion:1,kind,
    canSplit:kind==='same',canMerge:kind==='distinct',canReopen:kind==='historical',reason:'',records,count:kind==='distinct'?2:records.length,
    pairs:[{ pairKey:'synthetic-pair',otherEventId:'synthetic-other',otherEventVersion:3,records }] })
  h.saved=()=>{
    h.summary={ ...h.summary,viewVersion:'v2',update:{ ...h.summary.update,version:2 } }
    return { protocolVersion:2,kind:'operation-receipt',action:ACTION,update:h.summary.update }
  }
  h.intercept=(action,input)=>h.command && h.command(action,input) ||
    (action==='economicEvents.duplicateReview'?h.preview():undefined)
  h.open=()=>page.openDuplicateEdit(tap(h.events[0].eventId))
  return h
}

test('逐对核对底部直接处理，无须先选择再确认；双击只提交当前一对',async()=>{
  for(const decision of ['same','distinct']) {
    const h=pairing(3),page=h.page
    await page.openAmbiguousPairingReview({ currentTarget:{ dataset:{} } })
    assert.equal(page.data.pairingRows.length,1)
    assert.equal(page.data.pairingCanDecide,true)
    assert.equal(h.calls.filter(row=>row.action==='reviewIssues.resolvePairings').length,0)
    const event={ currentTarget:{ dataset:{ decision } } }
    await Promise.all([page.decidePairing(event),page.decidePairing(event)])
    const writes=h.calls.filter(row=>row.action==='reviewIssues.resolvePairings')
    assert.equal(writes.length,1)
    assert.deepEqual(writes[0].input.selection.pairs,[{ pairKey:'pair-0',decision }])
    assert.equal(h.pairs.length,2)
    assert.equal(page.data.pairingSheet,null)
    page.onUnload()
  }
})

test('修改合并、不同笔和历史关联均只提交明确操作；保持原判断不写入',async()=>{
  for(const [kind,decision] of [['same','distinct'],['distinct','same'],['historical','reopen']]) {
    const h=editor(kind),page=h.page
    await h.open();page.closeDuplicateEdit()
    assert.equal(h.calls.filter(row=>row.action===ACTION).length,0)
    await h.open()
    assert.equal(page.data.duplicateEditSheet.canSave,true)
    h.command=action=>action===ACTION?h.saved():undefined
    await page.saveDuplicateEdit()
    const writes=h.calls.filter(row=>row.action===ACTION)
    assert.equal(writes.length,1)
    assert.equal(writes[0].input.eventId,h.events[0].eventId)
    assert.equal(writes[0].input.decision,decision)
    if(kind==='distinct')assert.equal(writes[0].input.otherEventVersion,3)
    assert.equal(page.data.duplicateEditSheet,null)
    page.onUnload()
  }
})

test('强身份重复禁拆；背景变化、关闭、隐藏、卸载及换会话隔离迟到读取',async()=>{
  const blocked=editor()
  blocked.preview=()=>({ protocolVersion:2,viewVersion:'v1',kind:'same',records:[],count:1,eventVersion:1,canSplit:false,reason:'相同来源身份' })
  await blocked.open();await blocked.page.saveDuplicateEdit()
  assert.equal(blocked.calls.filter(row=>row.action===ACTION).length,0)
  blocked.page.onUnload()
  for(const leave of ['closeDuplicateEdit','onHide','onUnload','session']) {
    const h=editor(),page=h.page
    let release
    h.command=action=>action==='economicEvents.duplicateReview'?new Promise(resolve=>{release=resolve}):undefined
    const opening=h.open();await flush()
    if(leave==='session')h.cache.reset();else page[leave]()
    const patches=h.patches.length
    release(h.preview());await opening;await page.saveDuplicateEdit()
    assert.equal(h.patches.length,patches)
    assert.equal(h.calls.filter(row=>row.action===ACTION).length,0)
    page.onUnload()
  }
  const h=editor();await h.open()
  h.page.applyUpdateView({ ...h.summary,viewVersion:'v2',update:{ ...h.summary.update,version:2 } },true)
  assert.equal(h.page.data.duplicateEditSheet.stale,true)
  await h.page.saveDuplicateEdit()
  assert.equal(h.calls.filter(row=>row.action===ACTION).length,0)
  h.page.onUnload()
})

test('未知结果重开或点击入账都恢复原请求，成功摘要失败只刷新不重写',async()=>{
  const h=editor(),page=h.page;await h.open()
  let receipt,offline=true,failSummary=false
  h.command=(action,input)=>{
    if(action===ACTION){receipt=h.saved();throw Error('synthetic lost response')}
    if(action==='imports.commandResult'){
      if(offline)throw Error('synthetic offline')
      return receipt
    }
    if(action==='financeUpdates.summary' && failSummary)throw Error('synthetic summary failure')
  }
  await page.saveDuplicateEdit()
  assert.equal(page.data.duplicateEditSheet.pending,true)
  const request=page.pendingDuplicateEdit().payload.requestId
  page.closeDuplicateEdit();await page.postUpdate()
  assert.ok(page.data.duplicateEditSheet)
  assert.equal(page.pendingDuplicateEdit().payload.requestId,request)
  assert.equal(h.calls.filter(row=>row.action==='financeUpdates.post').length,0)
  offline=false;failSummary=true
  await page.saveDuplicateEdit()
  assert.equal(page.data.duplicateEditSheet.saved,true)
  assert.match(page.data.duplicateEditSheet.error,/已修改/)
  await page.saveDuplicateEdit()
  failSummary=false;await page.refreshDuplicateEdit()
  assert.equal(page.data.duplicateEditSheet,null)
  assert.equal(h.calls.filter(row=>row.action===ACTION).length,1)
  page.onUnload()
})

test('写入中双击与离开不重复保存；版本冲突保留原记录并禁止再次提交',async()=>{
  const h=editor(),page=h.page;await h.open()
  let release
  h.command=action=>action===ACTION?new Promise(resolve=>{release=()=>resolve(h.saved())}):undefined
  const saving=page.saveDuplicateEdit();await flush();await page.saveDuplicateEdit()
  assert.equal(h.calls.filter(row=>row.action===ACTION).length,1)
  page.onHide();const patches=h.patches.length;release();await saving
  assert.equal(h.patches.length,patches);page.onUnload()
  const next=editor();await next.open()
  next.command=action=>{if(action===ACTION)throw Object.assign(Error('synthetic conflict'),{code:'CONFLICT'})}
  await next.page.saveDuplicateEdit();await next.page.saveDuplicateEdit()
  assert.equal(next.page.data.duplicateEditSheet.stale,true)
  assert.equal(next.calls.filter(row=>row.action===ACTION).length,1)
  next.page.onUnload()
})

test('修改不同笔判断翻页时更新视图，旧响应不能解除过期状态或让页面一直加载',async()=>{
  const h=editor('distinct'),page=h.page
  await h.open()
  let release
  h.command=action=>action==='economicEvents.duplicateReview'?new Promise(resolve=>{release=resolve}):undefined
  const moving=page.changeDuplicatePair({ currentTarget:{ dataset:{ direction:1 } } });await flush()
  page.applyUpdateView({ ...h.summary,viewVersion:'v2',update:{ ...h.summary.update,version:2 } },true)
  release(h.preview());await moving
  assert.equal(page.data.duplicateEditSheet.loading,false)
  assert.equal(page.data.duplicateEditSheet.stale,true)
  assert.equal(page.data.duplicateEditSheet.canSave,false)
  await page.saveDuplicateEdit()
  assert.equal(h.calls.filter(row=>row.action===ACTION).length,0)
  page.onUnload()
})
