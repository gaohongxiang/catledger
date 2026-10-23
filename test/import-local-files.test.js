const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { randomUUID } = require('node:crypto')
const { facts, packed, filesystem } = require('./helpers/local-review')
const files = require('../miniprogram/packages/finance/services/import-local-files')
const session = require('../miniprogram/packages/finance/services/import-local-session')
const postingProtocol = require('../miniprogram/packages/finance/services/import-local-posting')

test('提交前明确拒绝可重新整理，未知结果和旧版记录保持冻结', async t => {
  for (const phase of ['staging', 'submitted', 'legacy']) for (const boundary of ['stageDecisions', 'sealDecisions']) await t.test(phase + '/' + boundary, async sub => {
    const lab = filesystem(); sub.after(lab.cleanup)
    const value = await facts(), wire = packed(value), options = {...lab,scope:'test:rejection',updateId:value.update.updateId}
    const store = files.create(options); await store.download(wire.header,wire.call)
    let posts=0, queries=0, current
    current=session.create({files:store,restored:store.restore(),requestId:randomUUID,saveReceipt(){},cleanup(){},queueAbandon(){},
      callNetwork:async action=>{
        if(action==='imports.commandResult'){queries++;throw Object.assign(Error('Unknown'),{code:'OPERATION_UNCONFIRMED'})}
        if(action.endsWith(boundary))throw Object.assign(Error('Old snapshot'),{code:'CONFLICT'})
        if(action.endsWith('stageDecisions'))return{}
        if(action==='financeUpdates.post')posts++
        throw Error('Unexpected action '+action)
      }})
    if(phase!=='staging') {
      const choice=current.model.finalState(),packedChoice=require('../cloudfunctions/catledger-import/src/local-review-protocol').split(JSON.stringify(choice),'decisions')
      const flight={action:'financeUpdates.post',value:choice,payload:{requestId:randomUUID(),uploadId:randomUUID(),updateId:value.update.updateId,payloadDigest:packedChoice.digest}}
      if(phase==='submitted')flight.phase='submitted'
      store.save([{kind:'ui',key:'postFlight',value:flight}])
      current.state.postFlight=flight
    }
    await assert.rejects(current.post(),{code:phase==='staging'?'LOCAL_REORGANIZE_REQUIRED':'CONFLICT'})
    assert.equal(posts,0);assert.equal(queries,phase==='staging'?0:1)
    const recovered=postingProtocol.inspect(files.create(options).restore().records,value.update.updateId)
    assert.equal(Boolean(recovered.postFlight),phase!=='staging')
    assert.equal(Boolean(recovered.postRejection),phase==='staging')
    if(phase==='staging') {
      assert.equal(current.status.frozen,false)
      current.saveDrafts({retained:{note:'仍可保存'}},2)
      await assert.rejects(current.post(),{code:'LOCAL_REORGANIZE_REQUIRED'})
    } else assert.throws(()=>current.saveDrafts({},2),{code:'OPERATION_UNCONFIRMED'})
  })
})

test('正式提交前的持久屏障失败时不会入账，重启能沿用原请求继续', async t => {
  const lab=filesystem();t.after(lab.cleanup)
  const value=await facts(),wire=packed(value),options={...lab,scope:'test:barrier',updateId:value.update.updateId}
  let store=files.create(options);await store.download(wire.header,wire.call)
  let current,posts=0,fail=true
  const make=()=>session.create({files:store,restored:store.restore(),requestId:randomUUID,saveReceipt(){},cleanup(){},queueAbandon(){},callNetwork:async(action,data)=>{
    if(action.endsWith('stageDecisions'))return{}
    if(action.endsWith('sealDecisions')){
      if(fail)lab.fault.fn=(op,name)=>{if(op==='write'&&name.includes('delta-2'))throw Error('Full')}
      return{digest:current.state.postFlight.payload.payloadDigest}
    }
    if(action==='financeUpdates.post'){posts++;return{action,updateId:value.update.updateId,status:'posted',requestId:data.requestId}}
    throw Error(action)
  }})
  current=make();await assert.rejects(current.post(),{code:'DRAFT_STORAGE_FAILED'})
  assert.equal(posts,0)
  const id=current.state.postFlight.payload.requestId
  lab.fault.fn=null;fail=false;store=files.create(options);current=make()
  assert.equal(current.state.postFlight.phase,'staging');assert.equal(current.state.postFlight.payload.requestId,id)
  assert.equal((await current.post()).status,'posted');assert.equal(posts,1)
})

test('新快照及迁移决定同时发布，失败保留旧完整草稿，重复下载不覆盖决定', async t=>{
  const lab=filesystem();t.after(lab.cleanup)
  const value=await facts(),options={...lab,scope:'test:atomic',updateId:value.update.updateId}
  let now=1000000000000
  const store=files.create({...options,now:()=>now}),wire=packed(value)
  await store.download(wire.header,wire.call)
  store.save([{kind:'draft',key:'old',value:{note:'saved'}}])
  const candidate=packed({...value,snapshotId:randomUUID()});now++
  lab.fault.fn=(op,name)=>{if(op==='rename'&&name.includes('/complete-'))throw Error('Interrupted')}
  await assert.rejects(store.download(candidate.header,candidate.call,()=>{},null,()=>[{kind:'draft',key:'new',value:{note:'rebased'}}]),{code:'DRAFT_STORAGE_FAILED'})
  lab.fault.fn=null
  assert.equal(files.create(options).restore().facts.snapshotId,value.snapshotId)
  await store.download(candidate.header,candidate.call,()=>{},null,()=>[{kind:'draft',key:'new',value:{note:'rebased'}}])
  let recovered=files.create(options).restore()
  assert.equal(recovered.facts.snapshotId,candidate.header.objectId);assert.equal(recovered.records[0].changes[0].value.note,'rebased')
  store.save([{kind:'draft',key:'next',value:{note:'newer choice'}}])
  await store.download(candidate.header,candidate.call,()=>{},null,()=>{throw Error('Already published')})
  recovered=files.create(options).restore();assert.equal(recovered.records.length,2)
})

test('最新草稿损坏且存在提交记录时不回退旧快照，读取失败不会假报缺失', async t=>{
  const lab=filesystem();t.after(lab.cleanup)
  const value=await facts(),options={...lab,scope:'test:damage',updateId:value.update.updateId}
  let now=1000000000000
  const store=files.create({...options,now:()=>now}),first=packed(value)
  await store.download(first.header,first.call);now++
  const second=packed({...value,snapshotId:randomUUID()});await store.download(second.header,second.call)
  store.save([{kind:'ui',key:'postFlight',value:{payload:{requestId:randomUUID()}}}])
  fs.writeFileSync(store.directory+'/'+second.header.objectId+'/part-0.json','broken')
  assert.throws(()=>files.create(options).restore(),{code:'DRAFT_CORRUPT'})
  const denied={...lab.fs,accessSync(){throw Object.assign(Error('Permission denied'),{code:'EACCES'})}}
  assert.throws(()=>files.create({...options,fs:denied}).restore(),{code:'DRAFT_STORAGE_FAILED'})
})

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

test('并行下载：有界并发、进度单调，结果与串行一致', async t => {
  const serialLab = filesystem(), parallelLab = filesystem()
  t.after(serialLab.cleanup); t.after(parallelLab.cleanup)
  const value = await facts({ count: 600 }), object = packed(value)
  assert.ok(object.parts.length >= 3)
  await files.create({ ...serialLab, scope: 'test:serial', updateId: value.update.updateId })
    .download(object.header, object.call)
  let inFlight = 0, maxInFlight = 0, chunkCalls = 0
  const progress = []
  const store = files.create({ ...parallelLab, scope: 'test:parallel', updateId: value.update.updateId, chunkConcurrency: 3 })
  await store.download(object.header, async (action, data) => {
    if (action.endsWith('Chunk')) {
      chunkCalls += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
    }
    return object.call(action, data)
  }, update => progress.push(update))
  const restored = store.restore()
  const completed = progress.map(update => update.completed)
  assert.equal(chunkCalls, object.parts.length)
  assert.ok(maxInFlight > 1 && maxInFlight <= 3)
  assert.deepEqual(completed, [...completed].sort((left, right) => left - right))
  assert.equal(completed[completed.length - 1], object.parts.length)
  assert.equal(progress[progress.length - 1].stats.chunkCalls, object.parts.length)
  assert.equal(progress[progress.length - 1].stats.reused, 0)
  assert.ok(progress[progress.length - 1].stats.totalMs >= 0)
  assert.equal(restored.facts.snapshotId, value.snapshotId)
  assert.equal(restored.facts.events.length, value.events.length)
  assert.equal(restored.facts.rows.length, value.rows.length)
})

test('断点续传：已校验块不重复请求，失败后只补缺块', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts({ count: 600 }), object = packed(value)
  const calls = []
  let failOnce = true
  const store = files.create({ ...lab, scope: 'test:resume', updateId: value.update.updateId, chunkConcurrency: 1 })
  const network = async (action, data) => {
    if (action.endsWith('Chunk')) {
      calls.push(data.index)
      if (failOnce && data.index === 1) { failOnce = false; throw Error('Disconnected') }
    }
    return object.call(action, data)
  }
  await assert.rejects(store.download(object.header, network))
  assert.equal(store.restore(), null)
  const firstAttempt = calls.slice()
  assert.ok(firstAttempt.includes(0) && firstAttempt.includes(1))
  calls.length = 0
  let finalProgress = null
  await store.download(object.header, network, update => { finalProgress = update })
  assert.equal(calls.includes(0), false)
  assert.equal(calls.includes(1), true)
  assert.equal(store.restore().facts.snapshotId, value.snapshotId)
  assert.equal(finalProgress.stats.reused, 1)
  assert.ok(finalProgress.stats.chunkCalls < object.parts.length)
})

test('断点续传：损坏的本机块按摘要重新下载，不被当作有效缓存', async t => {
  const lab = filesystem(); t.after(lab.cleanup)
  const value = await facts({ count: 600 }), object = packed(value)
  const store = files.create({ ...lab, scope: 'test:corrupt-part', updateId: value.update.updateId, chunkConcurrency: 2 })
  const folder = store.directory + '/' + object.header.objectId
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(folder + '/part-0.json', 'corrupt', 'utf8')
  const calls = []
  await store.download(object.header, async (action, data) => {
    if (action.endsWith('Chunk')) calls.push(data.index)
    return object.call(action, data)
  })
  assert.equal(calls.includes(0), true)
  assert.equal(store.restore().facts.snapshotId, value.snapshotId)
})

test('单块内联：不请求分块；内联内容不符时回退分块', async t => {
  const inlineLab = filesystem(), fallbackLab = filesystem()
  t.after(inlineLab.cleanup); t.after(fallbackLab.cleanup)
  const value = await facts({ count: 3 }), object = packed(value)
  assert.equal(object.parts.length, 1)
  let inlineChunkCalls = 0, inlineFinal = null
  const inlineStore = files.create({ ...inlineLab, scope: 'test:inline', updateId: value.update.updateId })
  await inlineStore.download(object.header, async (action, data) => {
    if (action.endsWith('Chunk')) inlineChunkCalls += 1
    return object.call(action, data)
  }, update => { inlineFinal = update }, { objectId: object.header.objectId, baseVersion: object.header.baseVersion,
    index: 0, bytes: object.parts[0].bytes, digest: object.parts[0].digest, content: object.parts[0].content })
  assert.equal(inlineChunkCalls, 0)
  assert.equal(inlineFinal.stats.inline, true)
  assert.equal(inlineFinal.stats.chunkCalls, 0)
  assert.equal(inlineStore.restore().facts.snapshotId, value.snapshotId)

  let fallbackChunkCalls = 0
  const fallbackStore = files.create({ ...fallbackLab, scope: 'test:inline-fallback', updateId: value.update.updateId })
  await fallbackStore.download(object.header, async (action, data) => {
    if (action.endsWith('Chunk')) fallbackChunkCalls += 1
    return object.call(action, data)
  }, () => {}, { objectId: object.header.objectId, baseVersion: object.header.baseVersion,
    index: 0, bytes: object.parts[0].bytes, digest: object.parts[0].digest, content: 'corrupt' })
  assert.equal(fallbackChunkCalls, 1)
  assert.equal(fallbackStore.restore().facts.snapshotId, value.snapshotId)
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
        const persisted = require('../miniprogram/packages/finance/services/import-local-posting').inspect(files.create(options).restore().records, value.update.updateId)
        assert.equal(persisted.postFlight.payload.requestId, data.requestId)
        assert.equal(persisted.postFlight.phase, 'submitted')
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
