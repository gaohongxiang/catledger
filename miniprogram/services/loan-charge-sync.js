// 显式写入协调器。普通 callApi 读取、缓存命中和导出均不会触发同步。
const api=require('./catledger-api'),pending=require('./pending-ledger-write'),cache=require('./read-cache'),config=require('../config/cloudbase')
function createChargeSync(options) {
  const flights=new Map()
  function run(settings={}) {
    const scope=options.scope()
    if(!scope)return Promise.resolve({complete:false,message:'登录后可同步费用',batches:0})
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
      let batches=0,createdCount=0
      try {
        let packet=options.pending.pending()
        if(packet&&(packet.target!=='api'||packet.action!=='loans.syncCharges'))return {complete:false,message:'费用同步未完成：请先核实上次账务操作',batches}
        for(let index=0;index<3;index++) {
          if(!active())return {complete:false,message:'费用同步未完成，返回后可继续',batches,createdCount}
          if(!packet) {
            const due=await options.call('loans.dueCharges',selection,{force:true})
            if(!active())return {complete:false,message:'费用同步未完成，返回后可继续',batches,createdCount}
            if(!Number.isInteger(due.count))throw new Error('费用范围未能核实')
            if(due.count===0)return {complete:true,message:'',cutoff:due.cutoff,batches,createdCount}
          }
          const outcome=await options.pending.send('api','loans.syncCharges',packet?packet.payload:{...selection,limit:40},{exact:true})
          batches++;createdCount+=Number(outcome.result.createdCount||0);packet=null
          // 可能刚恢复的是另一授权范围的原请求；重新读取本次范围，不能误报全局完成。
        }
        if(!active())return {complete:false,message:'费用同步未完成，返回后可继续',batches,createdCount}
        const due=await options.call('loans.dueCharges',selection,{force:true})
        return {complete:due.count===0,message:due.count===0?'':'费用同步未完成，已保存本次批次，可继续补齐',cutoff:due.cutoff,batches,createdCount}
      }catch(error){return {complete:false,message:'费用同步未完成：'+(error.message||'请重试'),batches,createdCount}}
    })()
    const flight={work,key,callers}
    flights.set(scope,flight)
    work.finally(()=>{if(flights.get(scope)===flight)flights.delete(scope)})
    return work
  }
  return {run}
}
const current=createChargeSync({
  scope:()=>{const app=getApp(),uid=app.globalData.uid;return app.hasLoginApproval()&&uid?config.envId+':'+uid+':'+cache.getSession():null},
  foreground:()=>getApp().globalData.chargeSyncForeground!==false,
  call:api.callApi,pending
})
async function beforePage(page,isCurrent,settings={}) {
  const result=await current.run({...settings,active:isCurrent})
  if(!isCurrent())throw Object.assign(new Error('页面已离开'),{code:'READ_CANCELLED'})
  page.setData({chargeSyncMessage:result.message,chargeSyncComplete:result.complete})
  return result
}
module.exports={createChargeSync,run:current.run,beforePage}
