const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { facts, packed, filesystem } = require('./helpers/local-review')
const files = require('../miniprogram/packages/finance/services/import-local-files')
const session = require('../miniprogram/packages/finance/services/import-local-session')

test('完整下载门槛：缺块、乱序、重复、混版本、校验与中断均保留旧完整草稿', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const original = await facts({ count: 180 }), first = packed(original)
  const store = files.create({ ...lab, scope: 'test:A', updateId: original.update.updateId })
  await store.download(first.header, first.call)
  assert.ok(first.parts.length > 1)
  for (const failure of ['missing','order','duplicate','version','digest','interrupted']) {
    const candidate = packed({ ...original, snapshotId: randomUUID() })
    await assert.rejects(store.download(candidate.header, async (action, data) => {
      const result = await candidate.call(action, data)
      if (action.endsWith('Manifest')) {
        if (failure === 'missing') result.parts.pop()
        if (failure === 'order') result.parts.reverse()
        if (failure === 'duplicate') result.parts[1] = result.parts[0]
      } else if (data.index === 1) {
        if (failure === 'version') result.baseVersion++
        if (failure === 'digest') result.content += 'changed'
        if (failure === 'interrupted') throw Error('Disconnected')
      }
      return result
    }))
    assert.equal(files.create({ ...lab, scope: 'test:A', updateId: original.update.updateId }).restore().facts.snapshotId, original.snapshotId)
  }
})

test('持久决定：中断或空间不足不假报保存，冷启动只恢复完整提交，损坏明确提示', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts(), object = packed(value), options = { ...lab, scope: 'test:A', updateId: value.update.updateId }
  const store = files.create(options); await store.download(object.header, object.call)
  store.save([{ kind: 'draft', key: 'one', value: 'saved' }])
  for (const point of ['delta','writing','rename']) {
    lab.fault.fn = (op, name) => { if (point === 'rename' ? op === 'rename' : op === 'write' && name.includes(point === 'delta' ? 'delta-2' : 'commit-000000002.json.writing')) throw Error('Disk full or killed') }
    assert.throws(() => store.save([{ kind: 'draft', key: 'two', value: 'unsaved' }]), { code: 'DRAFT_STORAGE_FAILED' })
    lab.fault.fn = null
    const recovered = files.create(options).restore()
    assert.equal(recovered.records.length, 1)
    assert.equal(recovered.records[0].changes[0].value, 'saved')
  }
  store.save([{ kind: 'draft', key: 'two', value: 'saved second' }])
  assert.equal(files.create(options).restore().records.length, 2)
  fs.writeFileSync(store.directory + '/' + value.snapshotId + '/decisions/delta-2.json', 'broken')
  assert.throws(() => files.create(options).restore(), { code: 'DRAFT_CORRUPT' })
  assert.equal(fs.existsSync(store.directory + '/' + value.snapshotId + '/decisions/delta-1.json'), true)
})

test('换号与迟到下载：隔离目录，清理后旧回调不能重新生成文件', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts(), object = packed(value), options = { ...lab, scope: 'test:A', updateId: value.update.updateId }
  const store = files.create(options)
  let release, arrived
  const ready = new Promise(resolve => { arrived = resolve })
  const download = store.download(object.header, async (action, data) => {
    if (action.endsWith('Chunk')) { arrived(); await new Promise(resolve => { release = resolve }) }
    return object.call(action, data)
  })
  await ready; store.clear(); release()
  await assert.rejects(download, { code: 'SESSION_CHANGED' })
  assert.equal(fs.existsSync(store.directory), false)
  assert.equal(files.create({ ...options, scope: 'test:B' }).restore(), null)
  assert.throws(() => store.save([]), { code: 'SESSION_CHANGED' })
})

test('成功响应丢失：冻结内容与请求先保存，重启查询原回执只入账一次，成功后清理', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts(), object = packed(value), options = { ...lab, scope: 'test:A', updateId: value.update.updateId }
  let store = files.create(options); await store.download(object.header, object.call)
  let posts = 0, posted, firstPayload, savedReceipt, cleaned
  const create = () => session.create({ files: store, restored: store.restore(), requestId: randomUUID,
    saveReceipt: receipt => { savedReceipt = receipt }, cleanup: result => { cleaned = result }, queueAbandon() {},
    callNetwork: async (action, data) => {
      if (action.endsWith('stageDecisions')) return {}
      if (action.endsWith('sealDecisions')) return { digest: current.state.postFlight.payload.payloadDigest }
      if (action === 'financeUpdates.post') {
        posts++; firstPayload = structuredClone(data)
        assert.equal(files.create(options).restore().records.at(-1).changes[0].value.payload.requestId, data.requestId)
        posted = { kind: 'operation-receipt', action, requestId: data.requestId, updateId: value.update.updateId, status: 'posted', posting: { createdTransactionCount: 3 } }
        throw Error('Response lost')
      }
      if (action === 'imports.commandResult') { assert.equal(data.requestId, firstPayload.requestId); return posted }
      throw Error('Unexpected network action')
    } })
  let current = create()
  await assert.rejects(current.post(), /Response lost/)
  assert.throws(() => current.call('financeUpdates.setReview', { eventId: value.events[0].eventId, editorVersion: 1, fields: { note: 'must stay frozen' } }), { code: 'OPERATION_UNCONFIRMED' })
  await assert.rejects(current.abandon(), { code: 'OPERATION_UNCONFIRMED' })
  store = files.create(options); current = create()
  assert.deepEqual(current.state.postFlight.payload, firstPayload)
  assert.equal((await current.post()).status, 'posted'); assert.equal(posts, 1)
  assert.equal(savedReceipt.status, 'posted'); assert.equal(cleaned, true); assert.equal(fs.existsSync(store.directory), false)
})

test('确认成功后的存储/清理失败仍返回成功，保留可恢复的原请求和回执', async t => {
  for (const point of ['journal','compact','cleanup']) await t.test(point,async sub=>{
    const lab=filesystem();sub.after(lab.cleanup)
    const value=await facts(),object=packed(value),options={...lab,scope:'test:A',updateId:value.update.updateId}
    const store=files.create(options);await store.download(object.header,object.call)
    let current,confirmed,cleanupResult
    current=session.create({files:store,restored:store.restore(),requestId:randomUUID,
      saveReceipt:receipt=>{if(point==='compact')throw Error('Storage full');confirmed=receipt},
      cleanup:result=>{cleanupResult=result},queueAbandon(){},callNetwork:async(action,data)=>{
        if(action.endsWith('stageDecisions'))return{}
        if(action.endsWith('sealDecisions'))return{digest:current.state.postFlight.payload.payloadDigest}
        if(action==='financeUpdates.post'){
          if(point==='journal')lab.fault.fn=(op)=>{if(op==='write')throw Error('Disk full')}
          if(point==='cleanup')lab.fault.fn=(op)=>{if(op==='remove')throw Error('Busy')}
          return{action,requestId:data.requestId,updateId:value.update.updateId,status:'posted',posting:{createdTransactionCount:3}}
        }
        throw Error(action)
      }})
    assert.equal((await current.post()).status,'posted')
    current.clear()
    if(point==='compact'){assert.equal(cleanupResult,false);const recovered=files.create(options).restore();assert.ok(recovered.records.some(record=>record.changes.some(change=>change.kind==='receipt'&&change.value.receipt?.status==='posted')))}
    else assert.equal(confirmed.status,'posted')
    if(point==='cleanup'){assert.equal(cleanupResult,false);assert.ok(fs.existsSync(store.directory))}
    lab.fault.fn=null
  })
})

test('换号覆盖决定上传、结果查询及迟到响应，原请求不能回填文件或回执', async t=>{
  for(const boundary of ['upload','query','post'])await t.test(boundary,async sub=>{
    const lab=filesystem();sub.after(lab.cleanup)
    const value=await facts(),object=packed(value),options={...lab,scope:'test:A',updateId:value.update.updateId}
    let alive=true,current,release,arrive,saved=0
    const arrived=new Promise(resolve=>{arrive=resolve}),store=files.create({...options,alive:()=>alive})
    await store.download(object.header,object.call)
    const network=async(action,data)=>{
      if(boundary==='upload'&&action.endsWith('stageDecisions')||boundary==='query'&&action==='imports.commandResult'||boundary==='post'&&action==='financeUpdates.post'){arrive();await new Promise(resolve=>{release=resolve})}
      if(action.endsWith('stageDecisions'))return{}
      if(action.endsWith('sealDecisions'))return{digest:current.state.postFlight.payload.payloadDigest}
      return{action:'financeUpdates.post',requestId:data.requestId,updateId:value.update.updateId,status:'posted'}
    }
    current=session.create({files:store,restored:store.restore(),requestId:randomUUID,alive:()=>alive,callNetwork:network,saveReceipt(){saved++},cleanup(){},queueAbandon(){}})
    if(boundary==='query')current.state.postFlight={action:'financeUpdates.post',payload:{requestId:randomUUID(),updateId:value.update.updateId},value:current.model.finalState()}
    const posting=current.post();await arrived;alive=false;current.destroy();release()
    await assert.rejects(posting,{code:'SESSION_CHANGED'})
    assert.equal(saved,0);assert.equal(fs.existsSync(store.directory),false)
    assert.equal(files.create({...options,scope:'test:B'}).restore(),null)
  })
})
