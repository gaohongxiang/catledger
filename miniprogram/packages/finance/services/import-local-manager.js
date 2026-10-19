const api = require('../../../services/catledger-import')
const router = require('../../../services/import-local-router')
const cache = require('../../../services/read-cache')
const config = require('../../../config/cloudbase')
const fileStore = require('./import-local-files')
const sessionFactory = require('./import-local-session')
const { sha256 } = require('../domain/import-review/portable-digest')
let generation = 0, owner = null
const pendingCleanup = new Set()
const CLEANUP_KEY = 'catledger_local_review_cleanup_v3'
const ROOT = () => wx.env.USER_DATA_PATH + '/catledger-import-local-v3'
const currentScope = () => { const app=getApp();return app.hasLoginApproval()&&app.globalData.uid?config.envId+':'+app.globalData.uid:null }
function persist(key,value){wx.setStorageSync(key,value);if(JSON.stringify(wx.getStorageSync(key))!==JSON.stringify(value))throw Object.assign(new Error('本机保存未完成，请检查存储空间'),{code:'DRAFT_STORAGE_FAILED'})}
function removeScopeFolder(folder){
  try{wx.getFileSystemManager().rmdirSync(ROOT()+'/'+folder,true)}catch(error){
    if(error.code!=='ENOENT'&&!/no such file|not exist/i.test(error.errMsg||error.message||''))throw error
  }
  for(const key of wx.getStorageInfoSync().keys){
    const fields=key.split(':')
    if(key.startsWith('catledger_local_v3:')&&fields.length>=5&&sha256(fields.slice(1,-2).join(':'))===folder)wx.removeStorageSync(key)
  }
}
function clearScope(scope){
  if(!scope)return true
  const folder=sha256(scope)
  pendingCleanup.add(folder)
  try{persist(CLEANUP_KEY,[...new Set([...(wx.getStorageSync(CLEANUP_KEY)||[]),...pendingCleanup])])}catch(_){}
  try{removeScopeFolder(folder);pendingCleanup.delete(folder)}catch(_){}
  return !pendingCleanup.has(folder)
}
function finishCleanup(){
  for(const folder of wx.getStorageSync(CLEANUP_KEY)||[])if(/^[a-f0-9]{64}$/.test(folder))pendingCleanup.add(folder)
  for(const folder of pendingCleanup)try{removeScopeFolder(folder);pendingCleanup.delete(folder)}catch(_){}
  persist(CLEANUP_KEY,[...pendingCleanup])
  if(pendingCleanup.size)throw Object.assign(new Error('原用户的本机草稿尚未清理完成，请释放存储空间后重试'),{code:'DRAFT_STORAGE_FAILED'})
}
function bindOwner(){
  const scope=currentScope();if(!scope)throw Object.assign(new Error('请先联网核验登录身份，再恢复本机草稿'),{code:'LOGIN_REQUIRED'})
  const prior=wx.getStorageSync('catledger_local_review_owner_v3')
  if(owner&&owner!==scope||prior&&prior!==scope){const old=owner||prior;generation++;router.reset();clearScope(old)}
  finishCleanup()
  owner=scope;persist('catledger_local_review_owner_v3',scope)
  router.setCleanup(()=>{generation++;const cleaned=clearScope(owner);owner=null;if(cleaned)wx.removeStorageSync('catledger_local_review_owner_v3')})
  return scope
}
function dependencies(updateId){
  const scope=bindOwner(),epoch=generation,session=cache.getSession(),prefix='catledger_local_v3:'+scope+':'+updateId+':'
  const alive=()=>scope===currentScope()&&epoch===generation&&session===cache.getSession()
  const guard=()=>{if(!alive())throw Object.assign(new Error('登录状态已改变，原草稿已停止'),{code:'SESSION_CHANGED'})}
  const files=fileStore.create({fs:wx.getFileSystemManager(),root:ROOT(),scope,updateId,alive})
  const callNetwork=async(action,data)=>{guard();const result=await api.callNetwork(action,data);guard();return result}
  const cleanup=cleaned=>{router.unbind(updateId);if(!cleaned)persist(prefix+'cleanup',true)}
  return{scope,prefix,files,alive,guard,callNetwork,cleanup,requestId:api.createRequestId,
    saveReceipt:receipt=>{guard();persist(prefix+'receipt',receipt)},
    queueAbandon:(payload,old)=>{guard();if(payload)persist(prefix+'abandon',payload);else if(wx.getStorageSync(prefix+'abandon')?.requestId===old.requestId)wx.removeStorageSync(prefix+'abandon')}}
}
function restore(updateId){
  bindOwner()
  const current=router.session(updateId);if(current)return current
  const deps=dependencies(updateId),receipt=wx.getStorageSync(deps.prefix+'receipt')
  if(receipt){const cleaned=deps.files.clear();if(cleaned)wx.removeStorageSync(deps.prefix+'cleanup');return{view:receipt,isLocal:true,completed:true}}
  if(wx.getStorageSync(deps.prefix+'abandon'))return{view:{update:{updateId,status:'abandoned'}},isLocal:true,completed:true,offlineAbandon:true}
  const restored=deps.files.restore();if(!restored)return null
  const confirmed=restored.records.flatMap(row=>row.changes).filter(row=>row.kind==='receipt'&&row.value?.receipt?.status==='posted').at(-1)?.value.receipt
  if(confirmed){try{deps.saveReceipt(confirmed);deps.files.clear()}catch(_){}return{view:confirmed,isLocal:true,completed:true}}
  const session=sessionFactory.create({...deps,restored});router.bind(session);return session
}
async function migrateLegacy(view,deps){
  await require('../../../services/import-draft-session').pauseUpdate(view.update.updateId);deps.guard()
  const pending=require('../../../services/pending-ledger-write'),packet=pending.pending()
  if(packet?.target==='import'&&packet.payload.updateId===view.update.updateId){
    // The unified editor uses the shared frozen-write slot, independent of the
    // old account/pairing queue. Settle it before changing the server's mode.
    try{await pending.verify()}
    catch(error){if(error.code!=='OPERATION_UNCONFIRMED')throw error;await pending.send('import',packet.action,packet.payload,{exact:true,canSend:deps.alive})}
    deps.guard();view=await deps.callNetwork('financeUpdates.summary',{updateId:view.update.updateId})
    if(view.update.status!=='review')return{view,ui:null}
  }
  const key='catledger_import_draft_v1:'+config.envId+':'+view.update.updateId,stored=wx.getStorageSync(key)
  if(!stored)return{view,ui:null,key}
  const legacy=require('../../../services/import-draft-session').create({scope:config.envId,view,autoSync:false,
    read:()=>stored,write:(key,value)=>{deps.guard();persist(key,value)},remove:key=>{deps.guard();wx.removeStorageSync(key)},call:deps.callNetwork,requestId:api.createRequestId})
  // Verify/replay the exact old request before the server changes review mode.
  if(legacy.state.postFlight){const result=await legacy.post();deps.guard();if(result.status==='posted')return{view:result,ui:null,key}}
  if(legacy.state.entries.length||legacy.state.flight)await legacy.flush()
  deps.guard()
  return{view:await deps.callNetwork('financeUpdates.summary',{updateId:view.update.updateId}),ui:{drafts:legacy.state.drafts,pairingDrafts:legacy.state.pairingDrafts},key}
}
async function settleLegacy(view){
  if(view.update.status!=='review'||view.update.reviewMode==='local_v3')return{view,ui:null}
  return migrateLegacy(view,dependencies(view.update.updateId))
}
async function prepare(view,onProgress,migration,onStage=()=>{}){
  const stage=(name,detail)=>{try{onStage(name,detail||{})}catch(_){}}
  if(view.update.status!=='review')return view
  const existing=restore(view.update.updateId);if(existing)return existing.view
  await settleAbandoned()
  const deps=dependencies(view.update.updateId)
  const legacy=migration||await settleLegacy(view)
  if(legacy.view.update.status!=='review')return legacy.view
  const key=deps.prefix+'prepare'
  let request=wx.getStorageSync(key)
  if(!request){request={requestId:api.createRequestId(),updateId:view.update.updateId,version:view.update.version};persist(key,request)}
  stage('snapshot_request')
  const prepared=await deps.callNetwork('financeUpdates.prepareSnapshot',request)
  stage('snapshot_ready',{bytes:prepared.snapshot&&prepared.snapshot.bytes,chunks:prepared.snapshot&&prepared.snapshot.chunkCount})
  stage('download_start')
  const facts=await deps.files.download(prepared.snapshot,deps.callNetwork,onProgress,prepared.inline);deps.guard()
  stage('download_done',{bytes:prepared.snapshot&&prepared.snapshot.bytes})
  const session=sessionFactory.create({...deps,restored:{facts,header:prepared.snapshot,records:[]}})
  if(legacy.ui){const drafts=legacy.ui.drafts||{};for(const draft of Object.values(drafts))if(draft.mode==='ignore_future'){draft.mode='ignore';draft.localConfirmed=false;draft.dirty=true}session.saveDrafts(drafts,2);for(const [id,draft]of Object.entries(legacy.ui.pairingDrafts||{}))session.savePairingDraft(id,{...draft,needsRecheck:true})}
  router.bind(session);wx.removeStorageSync(key)
  if(legacy.key)wx.removeStorageSync(legacy.key)
  require('../../../services/import-draft-session').rememberLast(view.update.updateId)
  return session.view
}
// Deferred server cancellation is retried only during preparation/startup, never
// from a local review read or edit. Local deletion is not a server cancellation.
async function settleAbandoned(){const scope=bindOwner(),keys=wx.getStorageInfoSync().keys.filter(key=>key.startsWith('catledger_local_v3:'+scope+':')&&key.endsWith(':abandon'))
  for(const key of keys){const payload=wx.getStorageSync(key);if(!payload)continue;const deps=dependencies(payload.updateId);try{await deps.callNetwork('financeUpdates.abandon',payload);deps.guard();wx.removeStorageSync(key)}catch(_){}}
}
module.exports={restore,prepare,settleLegacy,settleAbandoned}
