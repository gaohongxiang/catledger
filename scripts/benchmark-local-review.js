// Full v3 capacity verification: five synthetic sources, disk restore in a fresh
// process, all final field decisions, immutable staging and one atomic posting.
// Uses only the disposable localhost database managed by isolated-mysql.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { execFile, fork } = require('node:child_process')
const { promisify } = require('node:util')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const fileStore = require('../miniprogram/packages/finance/services/import-local-files')
const disk = { accessSync: fs.accessSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
  writeFileSync: fs.writeFileSync, renameSync: fs.renameSync,
  mkdirSync: (name, recursive) => fs.mkdirSync(name, { recursive }),
  rmdirSync: (name, recursive) => fs.rmSync(name, { recursive }) }
const bytes = value => Buffer.byteLength(JSON.stringify(value))
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
const heapMb=Number(process.env.CATLEDGER_BENCHMARK_HEAP_MB||256)
if(![256,384].includes(heapMb))throw Error('invalid benchmark heap limit')
function diskBytes(folder) { return fs.readdirSync(folder, { withFileTypes: true }).reduce((sum, row) => sum + (row.isDirectory() ? diskBytes(path.join(folder,row.name)) : fs.statSync(path.join(folder,row.name)).size), 0) }

// Keep the actual download/file decoder in a separate client process. Otherwise
// the server RSS measurement also includes client facts and restoration work.
async function downloadClient(options, header) {
  let sequence=0
  const pending=new Map()
  process.on('message',message=>{const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id)
    if(message.error)entry.reject(Object.assign(new Error(message.error),{code:message.code}));else entry.resolve(message.value)})
  const net=(action,data)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});process.send({kind:'request',id,action,data})})
  const start=performance.now()
  await fileStore.create({...options,fs:disk}).download(header,net)
  process.send({kind:'complete',stats:{stage:'clientDownload',ms:Math.round(performance.now()-start),
    heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss,maxRssKiB:process.resourceUsage().maxRSS}})
  process.disconnect()
}
function downloadInClient(options,header,net){
  return new Promise((resolve,reject)=>{
    const child=fork(__filename,['--download-client',JSON.stringify(options),JSON.stringify(header)],
      {execArgv:['--max-old-space-size='+heapMb],stdio:['ignore','inherit','inherit','ipc']})
    let stats
    child.on('message',message=>{
      if(message.kind==='complete'){stats=message.stats;return}
      if(message.kind==='request')Promise.resolve().then(()=>net(message.action,message.data)).then(
        value=>{if(child.connected)child.send({id:message.id,value})},
        error=>{if(child.connected)child.send({id:message.id,error:error.message,code:error.publicCode||error.code})})
    })
    child.on('error',reject)
    child.on('exit',code=>{if(code===0&&stats){emit(stats);resolve()}else reject(new Error('client download failed: '+code))})
  })
}

async function client(options) {
  const start = performance.now(), files = fileStore.create({ ...options, fs: disk }), restored = files.restore()
  const restoredMs = performance.now() - start, factory = require('../miniprogram/packages/finance/services/import-local-model')
  const modelStart = performance.now(), model = factory.create(restored.facts), reader = require('../miniprogram/packages/finance/services/import-local-read').create(model)
  reader.summary()
  const modelMs = performance.now() - modelStart, samples = []
  const pairStart=performance.now()
  if(options.pairCount){
    if(model.pairs.size!==options.pairCount||model.suggestedCount!==options.pairCount)throw Error('pairing fixture mismatch')
    for(const pair of [...model.pairs.values()]){files.save(model.pair({pairKey:pair.pairKey,decision:'same'}));reader.summary()}
  }
  const pairingMs=performance.now()-pairStart
  const categoryId = restored.facts.categories.find(row => row.kind === 'expense' && !row.archivedAt).categoryId
  for (const event of [...model.events.values()]) {
    const before = performance.now()
    const changes = model.edit({ eventId: event.eventId, editorVersion: 1, fields: { categoryId, note: '合成容量核对' } })
    files.save(changes); reader.summary()
    samples.push(performance.now() - before)
  }
  const final = model.finalState(), stateFile = path.join(options.root, 'final-state.json')
  fs.writeFileSync(stateFile, JSON.stringify(final))
  const page = reader.read('economicEvents.list', { updateId: options.updateId, pageSize: 40, status: 'ready' })
  if (bytes(page) > 262144 || final.decisions.events.length !== model.events.size || !reader.summary().coverage.selectedEventsReadyToPost) throw Error('client capacity verification failed')
  samples.sort((a,b)=>a-b)
  if (global.gc) global.gc()
  emit({ stage: 'clientColdRestoreAndReview', rows: model.events.size, restoreMs: Math.round(restoredMs), modelMs: Math.round(modelMs),
    pairCount:options.pairCount||0,pairingMs:Math.round(pairingMs),
    editsTotalMs: Math.round(samples.reduce((sum,n)=>sum+n,0)), editP95Ms: samples[Math.floor(samples.length*.95)],
    heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, maxRssKiB: process.resourceUsage().maxRSS,
    pageBytes: bytes(page), decisionBytes: bytes(final), diskBytes: diskBytes(files.directory), networkCallsDuringReview: 0 })
}

async function main() {
  const pairing=process.argv[2]==='--pairs',pairCount=pairing?Number(process.argv[3]):0
  const rows=pairing?pairCount*2:Number(process.argv[2]||24990)
  if (pairing?![100,1000].includes(pairCount):![1000,5000,24990].includes(rows)) throw Error('invalid benchmark size')
  emit({stage:'environment',node:process.version,platform:process.platform,arch:process.arch,heapLimitMb:heapMb})
  const { isolatedMysql } = require('./isolated-mysql'), { localServices, syntheticBill, call } = require('../test/helpers/local-services')
  const lab = await isolatedMysql(), root = fs.mkdtempSync(path.join(os.tmpdir(),'catledger-capacity-'))
  try {
    const grants = require('./runtime-role-grants'), observer = require('./performance-observer').createObserver(await lab.role('import',grants.importer))
    const subject='synthetic-capacity-'+randomUUID()
    const apiPool=await lab.role('api',grants.api),logger={warn(){},error:emit}
    let services=localServices({apiPool,importPool:observer.pool,subject,logger})
    let maxRequestBytes = 0, maxResponseBytes = 0
    async function net(action,data) {
      maxRequestBytes=Math.max(maxRequestBytes,bytes({action,data}))
      let result
      try { result=await call(services.import,action,data) } catch(error) {
        if (error.publicCode==='INTERNAL_ERROR') {
          // Same synthetic request, same idempotency key; expose only stack
          // locations/codes and never database SQL or bound values.
          try { await require('../cloudfunctions/catledger-import/src/action-registry').createActionHandlers(services.importer)[action]({provider:'wechat-mini',subjectHash:require('../cloudfunctions/catledger-import/src/handler').hashWechatSubject(subject),data}) }
          catch(detail) { emit({stage:'diagnostic',code:detail.code,name:detail.name,locations:String(detail.stack).split('\n').filter(line=>/^\s+at /.test(line))}) }
        }
        throw error
      }
      maxResponseBytes=Math.max(maxResponseBytes,bytes(result));return result
    }
    async function measure(stage,work) {
      observer.reset();const start=performance.now(),value=await work(),stats=observer.snapshot(),ms=performance.now()-start
      emit({stage,rows,ms:Math.round(ms),sqlCount:stats.sqlCount,sqlMs:Math.round(stats.sqlMs),userLockHoldMs:Math.round(stats.userLockHoldMs),
        heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss,external:process.memoryUsage().external,
        maxRssKiB:process.resourceUsage().maxRSS,topSql:stats.sqlFingerprints.slice(0,4)})
      if(stage==='atomicPost'){
        const budget=require('../shared/catledger-import.json').performanceV2.complexBenchmark
        if(ms>budget.maxActionMsAtUpper||stats.userLockHoldMs>budget.maxUserLockHoldMsAtUpper)throw Error('atomic post timing budget exceeded')
      }
      return value
    }
    let uid,update,updateId
    if(pairing){
      const prepared=await require('../test/helpers/bank-pairing').setup({apiPool,importPool:observer.pool,subject,logger,count:pairCount,bankNature:'消费'})
      services=prepared.services;uid=prepared.uid;updateId=prepared.updateId
      update={appliedVersion:(await prepared.summary()).update.version}
    }else{
      uid=(await call(services.api,'bootstrap')).uid
      await call(services.api,'accounts.create',{requestId:randomUUID(),name:'微信零钱',type:'wallet'})
      const contents=Array.from({length:5},(_,index)=>syntheticBill(rows/5,'SYNTHETIC-CAPACITY-'+index))
      const prepared=await net('imports.prepareMany',{requestId:randomUUID(),files:contents.map((content,index)=>({fileName:'合成容量'+index+'.csv',size:content.length}))})
      const batchIds=[]
      for(const [index,file]of prepared.files.entries()) { services.objects.set(file.cloudPath,contents[index]);const parsed=await measure('parse'+index,()=>net('imports.parseFile',{requestId:randomUUID(),importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480}));batchIds.push(parsed.batch.batchId) }
      update=await measure('prepareUpdate',()=>net('financeUpdates.prepare',{requestId:randomUUID(),batchIds}));updateId=update.updateId
    }
    update=await measure('organize',()=>net('financeUpdates.organize',{requestId:randomUUID(),updateId,version:update.appliedVersion}))
    const summary=await net('financeUpdates.summary',{updateId})
    if(summary.freshness.requiresAccountGroupRefresh)update=await net('reviewIssues.refreshAccountGroups',{requestId:randomUUID(),updateId,version:summary.update.version})
    const snapshot=await measure('prepareSnapshot',()=>net('financeUpdates.prepareSnapshot',{requestId:randomUUID(),updateId,version:update.appliedVersion}))
    const options={root,scope:'synthetic:'+uid,updateId,pairCount}
    await measure('downloadSnapshot',()=>downloadInClient(options,snapshot.snapshot,net))
    emit({stage:'snapshotSize',rows,...snapshot.snapshot,diskBytes:diskBytes(root)})
    const child=await promisify(execFile)(process.execPath,['--max-old-space-size='+heapMb,'--expose-gc',__filename,'--client',JSON.stringify(options)],{maxBuffer:1024*1024})
    process.stdout.write(child.stdout)
    const state=JSON.parse(fs.readFileSync(path.join(root,'final-state.json'),'utf8')),packed=protocol.split(JSON.stringify(state),'decisions'),uploadId=randomUUID()
    await measure('stageAndSeal',async()=>{for(const part of packed.parts)await net('financeUpdates.stageDecisions',{requestId:randomUUID(),updateId,snapshotId:state.snapshotId,uploadId,baseVersion:state.baseVersion,ruleVersion:state.ruleVersion,chunkCount:packed.chunkCount,index:part.index,content:part.content});return net('financeUpdates.sealDecisions',{requestId:randomUUID(),uploadId,updateId,snapshotId:state.snapshotId})})
    const request={protocolVersion:3,requestId:randomUUID(),updateId,version:state.baseVersion,snapshotId:state.snapshotId,uploadId,payloadDigest:packed.digest}
    const receipt=await measure('atomicPost',()=>net('financeUpdates.post',request))
    const expected=pairing?pairCount:rows,amount=expected*(pairing?1234:100)
    if(receipt.status!=='posted'||receipt.posting.createdTransactionCount!==expected)throw Error('atomic posting failed: '+JSON.stringify(receipt))
    const [[ledger]]=await lab.owner.execute('SELECT COUNT(*) AS count,SUM(amount_minor) AS amount FROM catledger_transactions WHERE uid=?',[uid])
    if(Number(ledger.count)!==expected||String(ledger.amount)!==String(amount))throw Error('ledger mismatch')
    const replay=await net('financeUpdates.post',request)
    require('node:assert/strict').deepEqual(replay,receipt)
    if(maxRequestBytes>65536||maxResponseBytes>262144)throw Error('wire budget exceeded')
    emit({stage:'verified',rows,pairCount,transactions:Number(ledger.count),maxRequestBytes,maxResponseBytes,finalRequestBytes:bytes(request),decisionChunks:packed.chunkCount,serverMaxRssKiB:process.resourceUsage().maxRSS})
  } finally { await lab.close(); fs.rmSync(root,{recursive:true,force:true}) }
}
if(process.argv[2]==='--download-client')downloadClient(JSON.parse(process.argv[3]),JSON.parse(process.argv[4])).catch(error=>{console.error(error);process.exitCode=1;process.disconnect()})
else if(process.argv[2]==='--client')client(JSON.parse(process.argv[3])).catch(error=>{console.error(error);process.exitCode=1})
else main().catch(error=>{console.error(error);process.exitCode=1})
