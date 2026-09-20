// READ-0: local synthetic MySQL + actual page logic. No cloud or real ledger access.
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('./isolated-mysql')
const { createObserver } = require('./performance-observer')
const { inspectSelect } = require('./performance-query-plans')
const { localServices, call, prepareSyntheticUpdate } = require('../test/helpers/local-services')
const { runtime } = require('../test/helpers/read-runtime')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function clientSamples() {
  const samples = [], h = runtime(), observer = h.load('services/read-observer')
  h.intercept = () => wait(40)
  let revision = '1'
  h.respond = (action) => {
    if (action === 'loans.get') return { ok: true, data: { uid: h.uid, readVersion: 1, dataRevision: revision, unchanged: false,
      loan: { loanId: 'synthetic-loan', name: '合成贷款', accountId: 'account-a', version: 1, kind: 'borrowing', status: 'active', baselinePrincipalMinor: '10000', remainingPrincipalMinor: '10000', baselineDate: '2026-09-01' } } }
  }
  async function measure(scenario, operation) {
    observer.enable(true)
    const calls = h.calls.length, start = performance.now()
    await operation()
    const metrics = observer.snapshot()
    samples.push({ scenario, elapsedMs: performance.now() - start, requests: h.calls.length - calls,
      snapshotMs: metrics.filter(x => x.event === 'snapshot').map(x => x.ms),
      latestDataMs: metrics.filter(x => x.event === 'fresh').map(x => x.ms),
      setDataBytes: metrics.filter(x => x.event === 'setData').reduce((s,x) => s+x.bytes,0),
      maxSetDataBytes: Math.max(0,...metrics.filter(x => x.event === 'setData').map(x => x.bytes)), metrics,
      interactiveMs: null, visibleFrameMs: null })
  }
  const home = h.page('index'), list = h.page('transactions'), loan = h.page('loan-detail')
  loan._loanId = 'synthetic-loan'
  await measure('cold-home', async () => { await h.api.identifyWechatAccount(); await home.loadDashboard() })
  await measure('same-session-home', () => home.loadDashboard())
  await measure('background-home', async () => {
    if (h.api.revalidateForeground) await h.api.revalidateForeground()
    else h.cache.invalidate(['accounts','transactions','categories','profile'])
    await home.loadDashboard()
  })
  await loan.load()
  await measure('loan-return', () => loan.load())
  await measure('write-return', async () => { await h.api.callApi('transactions.create', { requestId: 'synthetic-write' }); revision = '2'; await home.loadDashboard() })
  // A larger deterministic page, so the bridge cost of page 10 is measurable.
  const oldRespond = h.respond
  h.respond = (action, data) => action !== 'transactions.list' ? oldRespond(action, data) : { ok: true, data: {
    uid: h.uid, readVersion: 1, dataRevision: revision, unchanged: false, source: null,
    transactions: Array.from({ length: 30 }, (_,i) => ({ transactionId: 'synthetic-' + (Number(data.cursor || 0)+i), type: 'expense', origin: 'manual', version: 1, amountMinor: '100', occurredLocalAt: '2026-09-01T12:00:00', sourceAccount: { accountId: 'account-a', name: '合成账户' } })),
    ...(data.cursor ? {} : { summary: { incomeMinor: '0', expenseMinor: '1000', netIncomeMinor: '-1000' } }), nextCursor: String(Number(data.cursor || 0)+30)
  } }
  await list.prepareAndLoad()
  for (let page = 2; page <= 10; page++) await measure('transactions-page-' + page, () => list.loadTransactions(true))
  await measure('weak-network-home', async () => {
    h.cache.invalidate(['accounts','transactions'])
    h.respond = action => action === 'dashboard.get' ? { ok: false, error: { code: 'SERVICE_TEMPORARY_UNAVAILABLE', message: '合成弱网失败' } } : undefined
    await home.loadDashboard()
    if (!home.data.hasDashboard || !home.data.errorMessage) throw new Error('Failure lost existing home or did not report stale data')
  })
  return samples
}

async function seed(db, services, count) {
  const identity = await call(services.api, 'bootstrap'), accounts = []
  for (let i=0;i<4;i++) accounts.push(await call(services.api, 'accounts.createBatch', { requestId: randomUUID(), accounts: [{ name: '合成账户'+i, type: i===3?'other_liability':'bank' }] }))
  const catalog = await call(services.api, 'catalog.get'), ids = catalog.accounts.map(a=>a.accountId)
  const category = catalog.categories.find(c=>c.kind==='expense').id
  for (let offset=0;offset<count;offset+=500) {
    const rows = Array.from({length:Math.min(500,count-offset)},(_,j)=>{
      const i=offset+j, type=i%13===0?'transfer':i%11===0?'income':'expense', date='2026-09-'+String(i%28+1).padStart(2,'0')
      return [identity.uid, '10000000-0000-4000-8000-'+String(i).padStart(12,'0'), type, type==='income'?null:ids[i%3], type==='expense'?null:ids[(i+1)%3], type==='expense'?category:null,
        100+i%1000,date,date+' 12:00:00',-480,date+' 04:00:00','合成读取负载','manual',i%37===0?date+' 13:00:00':null]
    })
    await db.owner.query('INSERT INTO catledger_transactions (uid,transaction_id,type,source_account_id,destination_account_id,category_id,amount_minor,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin,deleted_at) VALUES ?', [rows])
  }
  // Related refund/loan/import facts use real handlers; zero scale remains an empty ledger.
  if(count) {
    const expense=await call(services.api,'transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:ids[0],categoryId:category,amountMinor:'1000',occurredLocalAt:'2026-09-01T12:00:00',timezoneOffsetMinutes:-480})
    await call(services.api,'transactions.create',{requestId:randomUUID(),type:'refund',destinationAccountId:ids[0],originalTransactionId:expense.transactionId,amountMinor:'100',occurredLocalAt:'2026-09-02T12:00:00',timezoneOffsetMinutes:-480})
    const liability=catalog.accounts.find(a=>a.type==='other_liability')
    await call(services.api,'loans.create',{requestId:randomUUID(),name:'合成贷款',kind:'borrowing',accountId:liability.accountId,baselinePrincipalMinor:'10000',baselineDate:'2026-09-01'})
    await prepareSyntheticUpdate(services, 2, 'SYNTHETIC-READ')
  }
  return identity.uid
}
async function databaseSamples() {
  const results=[]
  for (const count of [0,1000,10000,50000]) {
    const db=await isolatedMysql(), observer=createObserver(db.owner)
    try {
      const services=localServices({apiPool:observer.pool,importPool:db.owner}), uid=await seed(db,services,count)
      for(let sample=0;sample<3;sample++) {
        let page
        for(const action of ['bootstrap','catalog.get','dashboard.get','statistics.get','transactions.list','transactions.page2']) {
          observer.reset()
          const started=performance.now(), name=action==='transactions.page2'?'transactions.list':action
          const data=['bootstrap','catalog.get'].includes(action)?{}:{month:'2026-09',pageSize:30,...(action==='transactions.page2'&&page.nextCursor?{cursor:page.nextCursor}:{})}
          const value=await call(services.api,name,data), handlerMs=performance.now()-started
          if(action==='transactions.list')page=value
          const serializationStart=performance.now(), serialized=JSON.stringify(value), serializationMs=performance.now()-serializationStart
          const metrics=observer.snapshot()
          results.push({rows:count,sample,action,handlerMs,serializationMs,responseBytes:Buffer.byteLength(serialized),...metrics,
            mappingAndOtherMs: Math.max(0,handlerMs-metrics.sqlMs-metrics.connectionMs)})
        }
      }
      const {listAccountsForUser}=require('../cloudfunctions/catledger-api/src/account-service')
      results.push({rows:count,action:'account-plan',plans:await inspectSelect(db.owner,c=>listAccountsForUser(c,uid))})
    } finally {await db.close()}
  }
  return results
}
async function main(){
  const result={sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).length>0,
    environment:{node:process.version,os:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,mysql:'8.4 isolated container',network:'loopback TCP; client VM adds 40ms per attempt',samples:3},
    limits:'Local instrumentation and VM data-bridge proxies only; cold function initialization, radio/network and visible/interactive frame require device acceptance. Three samples are not p95.',
    server:process.argv.includes('--client-only')?[]:await databaseSamples(),client:await clientSamples()}
  const output=process.argv.find(x=>x.startsWith('--output='))
  if(output)fs.writeFileSync(output.slice(9),JSON.stringify(result,null,2)+'\n')
  else process.stdout.write(JSON.stringify(result)+'\n')
}
if(require.main===module) main().catch(error=>{process.stderr.write('Read benchmark failed: '+(error.publicCode||error.code||error.name)+'\n');process.exitCode=1})
module.exports={clientSamples,databaseSamples}
