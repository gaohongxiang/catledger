// 显式写入协调器。普通 callApi 读取、缓存命中和导出均不会触发同步。
const api=require('./catledger-api'),pending=require('./pending-ledger-write'),cache=require('./read-cache'),config=require('../config/cloudbase')
const observer=require('./read-observer')
const SYNC_TAGS=['loans','transactions','accounts','accountDirectory','categories','categoryDirectory']
const MAX_REUSE_MS=30000
function createChargeSync(options) {
  const flights=new Map(),completed=new Map(),now=options.now||Date.now
  let completedScope=null
  function isVerified(result) {
    if(!result||!result.complete||!result.verification)return false
    const check=result.verification,token=options.token&&options.token(),at=now()
    return token!=null&&token===check.token&&options.scope()===check.scope&&options.foreground()&&at>=check.startedAt&&
      (check.expiresAt===null||at<check.expiresAt)
  }
  function run(settings={}) {
    const scope=options.scope()
    if(!scope)return Promise.resolve({complete:false,message:'登录后可同步费用',batches:0})
    if(completedScope!==scope){completed.clear();completedScope=scope}
    const selection=settings.contractId?{contractId:settings.contractId,confirmed:true}:{},key=settings.contractId||''
    const previous=flights.get(scope)
    if(previous) {
      if(previous.key!==key)return previous.work.then(()=>run(settings))
      previous.callers.push(settings.active||(()=>true))
      return previous.work
    }
    const callers=[settings.active||(()=>true)]
    const active=()=>options.scope()===scope&&options.foreground()&&callers.some(current=>current())
    const work=(async()=>{
      let batches=0,createdCount=0,verification=null
      try {
        if(options.ready)await options.ready()
        if(!active())return {complete:false,message:'费用同步未完成，返回后可继续',batches,createdCount}
        let packet=options.pending.pending()
        if(packet&&(packet.target!=='api'||packet.action!=='loans.syncCharges'))return {complete:false,message:'费用同步未完成：请先核实上次账务操作',batches}
        const saved=completed.get(key),token=options.token&&options.token(),at=now()
        if(!settings.force&&!packet&&saved&&token!==null&&token===saved.token&&at>=saved.startedAt&&at<saved.expiresAt) {
          observer.record('chargeCheck',{action:'loans.dueCharges',source:'memory',hit:true,ms:0})
          return {complete:true,message:'',cutoff:saved.cutoff,dataRevision:saved.dataRevision,verification:saved.verification,batches:0,createdCount:0,reused:true}
        }
        completed.delete(key)
        async function check() {
          const startedAt=now()
          const due=await options.call('loans.dueCharges',selection,{force:true})
          observer.record('chargeCheck',{action:'loans.dueCharges',source:'network',hit:false,ms:Math.max(0,now()-startedAt)})
          if(!active())throw Object.assign(new Error('返回后可继续'),{code:'READ_CANCELLED'})
          if(!Number.isInteger(due.count)||due.count<0)throw new Error('费用范围未能核实')
          if(due.count===0) {
            const currentToken=options.token&&options.token(due.dataRevision)
            const duration=Number.isFinite(due.recheckAfterMs)?Math.min(MAX_REUSE_MS,due.recheckAfterMs):0
            verification={scope,token:currentToken,startedAt,expiresAt:Number.isFinite(due.recheckAfterMs)?startedAt+duration:null}
            if(currentToken!=null&&duration>0&&now()>=startedAt&&now()<startedAt+duration) {
              completed.set(key,{token:currentToken,startedAt,expiresAt:startedAt+duration,cutoff:due.cutoff,dataRevision:due.dataRevision,verification})
              while(completed.size>8)completed.delete(completed.keys().next().value)
            }
          }
          return due
        }
        for(let index=0;index<3;index++) {
          if(!active())return {complete:false,message:'费用同步未完成，返回后可继续',batches,createdCount}
          if(!packet) {
            const due=await check()
            if(due.count===0)return {complete:true,message:'',cutoff:due.cutoff,dataRevision:due.dataRevision,verification,batches,createdCount}
          }
          const startedAt=now()
          const outcome=await options.pending.send('api','loans.syncCharges',packet?packet.payload:{...selection,limit:40},{exact:true})
          observer.record('chargeSync',{action:'loans.syncCharges',ms:Math.max(0,now()-startedAt),count:Number(outcome.result.createdCount||0),ok:true})
          batches++;createdCount+=Number(outcome.result.createdCount||0);packet=null
          // 可能刚恢复的是另一授权范围的原请求；重新读取本次范围，不能误报全局完成。
        }
        if(!active())return {complete:false,message:'费用同步未完成，返回后可继续',batches,createdCount}
        const due=await check()
        return {complete:due.count===0,message:due.count===0?'':'费用同步未完成，已保存本次批次，可继续补齐',cutoff:due.cutoff,dataRevision:due.dataRevision,verification,batches,createdCount}
      }catch(error){return {complete:false,message:'费用同步未完成：'+(error.message||'请重试'),batches,createdCount}}
    })()
    const flight={work,key,callers}
    flights.set(scope,flight)
    work.finally(()=>{if(flights.get(scope)===flight)flights.delete(scope)})
    return work
  }
  return {run,isVerified}
}
const current=createChargeSync({
  scope:()=>{const app=getApp(),uid=app.globalData.uid;return app.hasLoginApproval()&&uid?config.envId+':'+uid+':'+cache.getSession():null},
  foreground:()=>getApp().globalData.chargeSyncForeground!==false,
  call:api.callApi,pending,now:cache.now,ready:()=>cache.waitForValidation(),token:revision=>cache.consistencyToken(SYNC_TAGS,revision)
})
async function beforePage(page,isCurrent,settings={}) {
  const result=await current.run({...settings,active:isCurrent})
  if(!isCurrent())throw Object.assign(new Error('页面已离开'),{code:'READ_CANCELLED'})
  page.setData({chargeSyncMessage:result.message,chargeSyncComplete:result.complete})
  return result
}
module.exports={createChargeSync,run:current.run,isVerified:current.isVerified,beforePage,MAX_REUSE_MS}
