const api = require('../../../services/catledger-import')
const router = require('../../../services/import-local-router')
const cache = require('../../../services/read-cache')
const config = require('../../../config/cloudbase')
const fileStore = require('./import-local-files')
const resume = require('./import-local-resume')
const sessionFactory = require('./import-local-session')
const { sha256 } = require('../domain/import-review/portable-digest')
let generation = 0, owner = null
const pendingCleanup = new Set()
const CLEANUP_KEY = 'catledger_local_review_cleanup_v3'
const ROOT = () => wx.env.USER_DATA_PATH + '/catledger-import-local-v3'
const currentScope = () => { const app=getApp();return app.hasLoginApproval()&&app.globalData.uid?config.envId+':'+app.globalData.uid:null }
const clock = options => typeof options.now === 'function' ? options.now : Date.now
const UPDATE_ID = /^[0-9a-f-]{36}$/
const resumeGate = value => Boolean(value && value.resume && typeof value.resume === 'object')
function persist(key,value){wx.setStorageSync(key,value);if(JSON.stringify(wx.getStorageSync(key))!==JSON.stringify(value))throw Object.assign(new Error('本机保存未完成，请检查存储空间'),{code:'DRAFT_STORAGE_FAILED'})}
function removeUpdateFolder(folder, updateId, keepAbandon = true) {
  try { wx.getFileSystemManager().rmdirSync(ROOT() + '/' + folder + '/' + updateId, true) } catch (error) {
    if (error.code !== 'ENOENT' && !/no such file|not exist/i.test(error.errMsg || error.message || '')) throw error
  }
  for (const key of wx.getStorageInfoSync().keys) {
    const fields = key.split(':')
    if (!key.startsWith('catledger_local_v3:') || fields.length < 5) continue
    if (sha256(fields.slice(1, -2).join(':')) !== folder || fields[3] !== updateId) continue
    if (keepAbandon && key.endsWith(':abandon')) continue
    wx.removeStorageSync(key)
  }
}
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
function pendingPostFlight(records) {
  let value = null
  for (const record of records || []) for (const change of record.changes || []) {
    if (change.kind === 'ui' && change.key === 'postFlight') value = change.value
  }
  return Boolean(value)
}
function completedReceipt(records) {
  return (records || []).flatMap(row => row.changes || []).filter(row => row.kind === 'receipt' &&
    row.value && row.value.receipt && row.value.receipt.status === 'posted').at(-1)?.value.receipt || null
}
function localGate(updateId, state, extra = {}) {
  return { isLocal: true, resume: Object.assign({ source: 'local', updateId, state }, extra) }
}
function dependencies(updateId, options = {}){
  const scope=bindOwner(),epoch=generation,session=cache.getSession(),prefix='catledger_local_v3:'+scope+':'+updateId+':'
  const alive=()=>scope===currentScope()&&epoch===generation&&session===cache.getSession()
  const guard=()=>{if(!alive())throw Object.assign(new Error('登录状态已改变，原草稿已停止'),{code:'SESSION_CHANGED'})}
  const files=fileStore.create({fs:wx.getFileSystemManager(),root:ROOT(),scope,updateId,alive,now:clock(options)})
  const callNetwork=async(action,data)=>{guard();const result=await api.callNetwork(action,data);guard();return result}
  const cleanup=cleaned=>{router.unbind(updateId);if(!cleaned)persist(prefix+'cleanup',true)}
  return{scope,prefix,files,alive,guard,callNetwork,cleanup,requestId:api.createRequestId,
    saveReceipt:receipt=>{guard();persist(prefix+'receipt',receipt)},
    queueAbandon:(payload,old)=>{guard();if(payload)persist(prefix+'abandon',payload);else if(wx.getStorageSync(prefix+'abandon')?.requestId===old.requestId)wx.removeStorageSync(prefix+'abandon')}}
}
function clearLocal(updateId, options = {}) {
  const scope = options.scope || currentScope()
  if (!scope) return false
  try { removeUpdateFolder(sha256(scope), updateId, options.keepAbandon !== false); return true } catch (_) { return false }
}
function cleanupIdle(scope, now = Date.now(), limit = 20, excludeId = null) {
  if (!scope) return 0
  const folder = sha256(scope), base = ROOT() + '/' + folder
  let names
  try { names = wx.getFileSystemManager().readdirSync(base).filter(name => UPDATE_ID.test(name)).slice(0, limit) } catch (_) { return 0 }
  let cleaned = 0
  for (const updateId of names) {
    if (updateId === excludeId || router.session(updateId)) continue
    const files = fileStore.create({ fs: wx.getFileSystemManager(), root: ROOT(), scope, updateId, now: () => now })
    const activity = files.activity()
    const state = resume.localActivityState(activity && activity.lastActiveAt, now)
    if (state.state !== 'expired') continue
    let frozen = false
    try { const restored = files.restore(); frozen = pendingPostFlight(restored?.records) || Boolean(completedReceipt(restored?.records)) } catch (_) { continue }
    if (frozen) continue
    try { removeUpdateFolder(folder, updateId); cleaned += 1 } catch (_) {}
  }
  return cleaned
}
function restore(updateId, options = {}){
  bindOwner()
  const current=router.session(updateId);if(current){try{current.touch?.()}catch(_){};current.attached=true;return current}
  cleanupIdle(currentScope(), clock(options)(), 20, updateId)
  const deps=dependencies(updateId, options),receipt=wx.getStorageSync(deps.prefix+'receipt')
  if(receipt){const cleaned=deps.files.clear();if(cleaned)wx.removeStorageSync(deps.prefix+'cleanup');return{view:receipt,isLocal:true,completed:true}}
  if(wx.getStorageSync(deps.prefix+'abandon'))return{view:{update:{updateId,status:'abandoned'}},isLocal:true,completed:true,offlineAbandon:true}
  const activity = deps.files.activity()
  const activityState = resume.localActivityState(activity && activity.lastActiveAt, clock(options)())
  let restored = null
  if (activityState.state === 'expired') {
    try { restored = deps.files.restore() } catch (_) { restored = null }
    if (restored) {
      const confirmed = completedReceipt(restored.records)
      if (confirmed) { try { deps.saveReceipt(confirmed) } catch (_) {} deps.files.clear(); return { view: confirmed, isLocal: true, completed: true } }
      if (pendingPostFlight(restored.records)) {
        // An unknown posting result outranks the local TTL: keep the frozen
        // request until the user verifies it, even after 24h of inactivity.
        if (!options.force) return localGate(updateId, 'post_pending', { lastActiveAt: restored.lastActiveAt,
          canContinue: true, title: '上次入账结果待核实', message: '本机草稿已超过 24 小时，但入账结果尚未核实；原请求继续保留，请先核实结果。' })
      } else {
        deps.files.clear()
        return localGate(updateId, 'expired', { lastActiveAt: activity && activity.lastActiveAt || null,
          canContinue: false, title: '上次导入已超过 24 小时', message: '超过 24 小时未活动的本机草稿已清理。请放弃上次导入后重新选择账单。' })
      }
    } else {
      deps.files.clear()
      return localGate(updateId, 'expired', { lastActiveAt: activity && activity.lastActiveAt || null,
        canContinue: false, title: '上次导入已超过 24 小时', message: '超过 24 小时未活动的本机草稿已清理。请放弃上次导入后重新选择账单。' })
    }
  } else {
    restored = deps.files.restore()
  }
  if(!restored)return null
  const confirmed=completedReceipt(restored.records)
  if(confirmed){try{deps.saveReceipt(confirmed);deps.files.clear()}catch(_){}return{view:confirmed,isLocal:true,completed:true}}
  const frozen = pendingPostFlight(restored.records)
  const version = frozen ? null : resume.versionState(restored.facts)
  const lastActiveAt = Number(restored.lastActiveAt || (activity && activity.lastActiveAt)) || null
  if (version) {
    return localGate(updateId, version.state, Object.assign({}, version, {
      lastActiveAt, activity: activityState.state, canContinue: version.canContinue,
      title: version.state === 'semantic' ? '整理规则已更新' : '解析规则已更新',
      message: version.state === 'semantic'
        ? '已保存的原文行需要按新规则重新整理并生成新的核对草稿；本机已保存的选择会保留，无法对应的事项需要重新确认。'
        : version.originalMissing
          ? '解析规则已更新，旧草稿无法继续；云端原件已清理，请重新上传原账单并重新解析。'
          : '解析规则已更新，旧草稿无法继续；请重新上传原账单并重新解析。'
    }))
  }
  if (activityState.state === 'idle' && !options.force) {
    if (frozen) return localGate(updateId, 'post_pending', { lastActiveAt, activity: 'idle', canContinue: true,
      title: '上次入账结果待核实', message: '本机草稿已超过 12 小时，且入账结果尚未核实；原请求继续保留，请先核实结果。' })
    return localGate(updateId, 'idle', { lastActiveAt, activity: 'idle', canContinue: true,
      title: '上次导入已超过 12 小时', message: '本机仍保留完整草稿和已保存的选择，但没有自动打开。继续查看不会重新上传或入账。' })
  }
  try { deps.files.touch({ lastActiveAt: clock(options)() }) } catch (_) {}
  const session=sessionFactory.create({...deps,restored});session.activity=restored.activity||activity;router.bind(session);return session
}
async function refreshLease(updateId, session, options = {}) {
  const deps = dependencies(updateId, options)
  const at = clock(options)()
  const prepared = await deps.callNetwork('financeUpdates.prepareSnapshot', {
    requestId: api.createRequestId(), updateId, version: session.view.update.version })
  deps.guard()
  deps.files.touch({ lastActiveAt: at, serverTouchedAt: at })
  if (session.activity) session.activity = Object.assign({}, session.activity, { lastActiveAt: at, serverTouchedAt: at })
  try { session.touch?.() } catch (_) {}
  return prepared
}
async function ensureResume(updateId, options = {}) {
  const local = restore(updateId, options)
  if (!local || resumeGate(local) || local.attached) return local
  const activity = local.activity
  const touchedAt = activity && Number(activity.serverTouchedAt)
  const due = !Number.isFinite(touchedAt) || clock(options)() - touchedAt >= resume.SERVER_AUTO_RESUME_MS
  if (!due || local.view.update.status !== 'review') return local
  try {
    await refreshLease(updateId, local, options)
    return local
  } catch (error) {
    if (error.code === 'NOT_FOUND' || error.code === 'CONFLICT') {
      try { local.close?.() } catch (_) {}
      router.unbind(updateId)
      if (error.code === 'NOT_FOUND') return localGate(updateId, 'server_expired', { canContinue: false,
        title: '云端整理数据已过期', message: '云端临时整理数据已不能继续，本机旧快照也不能再用于入账；请放弃上次导入后重新选择账单。' })
      return localGate(updateId, 'server_changed', { canContinue: true, requiresReorganize: true,
        title: '服务端草稿已更新', message: '服务端整理草稿已有新版本，需要重新下载并整理；本机已保存的选择会尽量保留，无法对应的事项需要重新确认。' })
    }
    // Offline or a transient network failure must not lock an already complete
    // local draft; posting will still revalidate the server state.
    return local
  }
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
async function prepare(view,onProgress,migration,onStage=()=>{},options={}){
  const stage=(name,detail)=>{try{onStage(name,detail||{})}catch(_){}}
  if(view.update.status!=='review')return view
  if(!options.skipLocalRestore){
    const existing=await ensureResume(view.update.updateId,options)
    if(existing&&resumeGate(existing))throw Object.assign(new Error(existing.resume.message||'请先确认上次导入'),{code:existing.resume.state==='reparse'?'LOCAL_REPARSE_REQUIRED':'LOCAL_RESUME_REQUIRED',resume:existing.resume})
    if(existing)return existing.view
  }
  await settleAbandoned()
  const deps=dependencies(view.update.updateId,options)
  const legacy=migration||await settleLegacy(view)
  if(legacy.view.update.status!=='review')return legacy.view
  const key=deps.prefix+'prepare'
  let request=wx.getStorageSync(key)
  if(!request||options.force&&!request.force){request={requestId:api.createRequestId(),updateId:view.update.updateId,version:view.update.version,...(options.force?{force:true}:{})};persist(key,request)}
  stage('snapshot_request')
  const prepared=await deps.callNetwork('financeUpdates.prepareSnapshot',request)
  stage('snapshot_ready',{bytes:prepared.snapshot&&prepared.snapshot.bytes,chunks:prepared.snapshot&&prepared.snapshot.chunkCount})
  stage('download_start')
  const facts=await deps.files.download(prepared.snapshot,deps.callNetwork,onProgress,prepared.inline);deps.guard()
  stage('download_done',{bytes:prepared.snapshot&&prepared.snapshot.bytes})
  const session=sessionFactory.create({...deps,restored:{facts,header:prepared.snapshot,records:[]}})
  if(legacy.ui){const drafts=legacy.ui.drafts||{};for(const draft of Object.values(drafts))if(draft.mode==='ignore_future'){draft.mode='ignore';draft.localConfirmed=false;draft.dirty=true}session.saveDrafts(drafts,2);for(const [id,draft]of Object.entries(legacy.ui.pairingDrafts||{}))session.savePairingDraft(id,{...draft,needsRecheck:true})}
  if(options.adoptRecords&&options.adoptRecords.length)session.adopt(options.adoptRecords)
  try{deps.files.touch({lastActiveAt:clock(options)(),serverTouchedAt:clock(options)()})}catch(_){}
  router.bind(session);wx.removeStorageSync(key)
  if(legacy.key)wx.removeStorageSync(legacy.key)
  require('../../../services/import-draft-session').rememberLast(view.update.updateId)
  return session.view
}
function localDecisions(updateId, options = {}) {
  bindOwner()
  const deps = dependencies(updateId, options)
  const restored = deps.files.restore()
  if (!restored) return null
  return { records: restored.records, facts: restored.facts, postFlight: pendingPostFlight(restored.records),
    lastActiveAt: restored.lastActiveAt }
}
// Deferred server cancellation is retried only during preparation/startup, never
// from a local review read or edit. Local deletion is not a server cancellation.
async function settleAbandoned(){const scope=bindOwner(),keys=wx.getStorageInfoSync().keys.filter(key=>key.startsWith('catledger_local_v3:'+scope+':')&&key.endsWith(':abandon'))
  for(const key of keys){const payload=wx.getStorageSync(key);if(!payload)continue;const deps=dependencies(payload.updateId);try{await deps.callNetwork('financeUpdates.abandon',payload);deps.guard();wx.removeStorageSync(key)}catch(_){}}
}
module.exports={restore,ensureResume,prepare,settleLegacy,settleAbandoned,clearLocal,cleanupIdle,localDecisions,refreshLease}
