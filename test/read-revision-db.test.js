const test = require('node:test')
const assert = require('node:assert/strict')
const {randomUUID} = require('node:crypto')
const {isolatedMysql} = require('../scripts/isolated-mysql')
const {localServices,call,prepareSyntheticUpdate} = require('./helpers/local-services')
const {createObserver} = require('../scripts/performance-observer')
const grants = require('../scripts/runtime-role-grants')
const hasDb = Boolean(process.env.CATLEDGER_TEST_DB_HOST)
const deferred = () => {let resolve;return {promise:new Promise(r=>{resolve=r}),resolve:()=>resolve()}}

test('修订与数据来自同一快照，未变化不执行聚合，大版本字符串及跨用户隔离', {skip:!hasDb}, async()=>{
  const db=await isolatedMysql()
  try {
    const observer=createObserver(db.owner), svc=localServices({apiPool:observer.pool,importPool:db.owner})
    const user=await call(svc.api,'bootstrap')
    const created=await call(svc.api,'accounts.createBatch',{requestId:randomUUID(),accounts:[{name:'合成旧名称',type:'bank'}]})
    const base=await call(svc.api,'catalog.get'), account=base.accounts[0]
    assert.equal(base.readVersion,1);assert.equal(base.uid,user.uid);assert.equal(typeof base.dataRevision,'string')
    observer.reset()
    const unchanged=await svc.api({action:'dashboard.get',data:{month:'2026-09'},knownRevision:base.dataRevision})
    assert.equal(unchanged.data.unchanged,true)
    assert.deepEqual(Object.keys(unchanged.data).sort(),['dataRevision','readVersion','uid','unchanged'])
    assert.equal(observer.snapshot().summaryCount,0);assert.equal(observer.snapshot().sqlCount,4)
    const gotIdentity=deferred(), resume=deferred();let hold=true
    const pausedPool={async getConnection(){const c=await db.owner.getConnection();return new Proxy(c,{get(target,key){if(key==='execute')return async(sql,values)=>{
      const result=await c.execute(sql,values)
      if(hold&&sql.includes('AS dataRevision')&&sql.includes('catledger_user_identities')){hold=false;gotIdentity.resolve();await resume.promise}
      return result
    };return typeof target[key]==='function'?target[key].bind(target):target[key]}})}}
    const paused=localServices({apiPool:pausedPool,importPool:db.owner})
    const reading=call(paused.api,'catalog.get');await gotIdentity.promise
    await call(svc.api,'accounts.update',{requestId:randomUUID(),accountId:account.accountId,version:account.version,name:'合成新名称'})
    resume.resolve();const old=await reading
    assert.equal(old.dataRevision,base.dataRevision);assert.equal(old.accounts[0].name,'合成旧名称')
    const fresh=await call(svc.api,'catalog.get');assert.notEqual(fresh.dataRevision,base.dataRevision);assert.equal(fresh.accounts[0].name,'合成新名称')
    const other=localServices({apiPool:db.owner,importPool:db.owner,subject:'synthetic-read-other'});await call(other.api,'bootstrap')
    assert.equal((await call(other.api,'catalog.get')).accounts.length,0)
    assert.equal((await svc.api({action:'reads.validate',data:{uid:user.uid}})).error.code,'INVALID_REQUEST')
    for(const value of [1,'01','-1','18446744073709551616'])assert.equal((await svc.api({action:'catalog.get',data:{},knownRevision:value})).error.code,'VALIDATION_ERROR')
    await db.owner.execute('UPDATE catledger_users SET data_revision=? WHERE uid=?',['9007199254740993',user.uid])
    const profile={requestId:randomUUID(),nickname:'合成名称',previousNickname:''}
    await call(svc.api,'profile.update',profile);const revision=(await call(svc.api,'reads.validate')).dataRevision
    assert.equal(revision,'9007199254740994');await call(svc.api,'profile.update',profile)
    assert.equal((await call(svc.api,'reads.validate')).dataRevision,revision)
    assert.ok(created)
  } finally {await db.close()}
})

test('两支写事务回滚与重放只推进一次；导入清理及post重放不重复推进修订', {skip:!hasDb}, async()=>{
  const db=await isolatedMysql()
  try {
    const apiPool=await db.role('api',grants.api), importPool=await db.role('import',grants.importer)
    const svc=localServices({apiPool,importPool}), user=await call(svc.api,'bootstrap')
    const revision=async()=> (await call(svc.api,'reads.validate')).dataRevision
    const before=await revision()
    await assert.rejects(call(svc.api,'transactions.create',{requestId:randomUUID(),type:'bad'}))
    assert.equal(await revision(),before)
    const account=await call(svc.api,'accounts.create',{requestId:randomUUID(),type:'wallet',name:'合成映射账户',openingDisplayBalanceMinor:'10000',occurredLocalAt:'2026-09-01T09:00:00',timezoneOffsetMinutes:-480})
    const update=await prepareSyntheticUpdate(svc,3,'SYNTHETIC-READ-REVISION'), updateId=update.updateId
    const issues=await call(svc.import,'reviewIssues.list',{protocolVersion:2,updateId,group:'accounts'}), issue=issues.items[0]
    const mapped=await call(svc.import,'reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId,updateVersion:update.appliedVersion,decisions:[{issueId:issue.issueId,issueVersion:issue.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:account.accountId}}]})
    const request={requestId:randomUUID(),updateId,version:mapped.appliedVersion}
    const result=await call(svc.import,'financeUpdates.post',request), after=await revision()
    assert.deepEqual(await call(svc.import,'financeUpdates.post',request),result)
    assert.equal(await revision(),after)
    const impact=await call(svc.import,'financeUpdates.undoImpact',{updateId})
    const undo={requestId:randomUUID(),updateId,version:result.appliedVersion,previewToken:impact.previewToken}
    await call(svc.import,'financeUpdates.undo',undo);const undone=await revision()
    assert.ok(BigInt(undone)>BigInt(after));await call(svc.import,'financeUpdates.undo',undo);assert.equal(await revision(),undone)
    assert.equal((await call(svc.api,'accounts.list')).accounts.find(x=>x.accountId===account.accountId).bookBalanceMinor,'10000')
    assert.equal((await call(svc.api,'bootstrap')).dataRevision,undone)
    assert.equal(user.uid,(await call(svc.api,'reads.validate')).uid)
  } finally {await db.close()}
})
