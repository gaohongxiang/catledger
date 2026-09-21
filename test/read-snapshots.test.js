const test=require('node:test')
const assert=require('node:assert/strict')
const {runtime}=require('./helpers/read-runtime')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('同会话重建首页先恢复历史，失败保留并标记；未确认身份不展示',async()=>{
  const h=runtime(), page=h.page('index')
  await page.loadDashboard()
  h.cache.invalidate(['transactions'])
  page.data.hasDashboard=false
  let release
  h.intercept=action=>action==='dashboard.get'?new Promise(resolve=>{release=resolve}):undefined
  h.respond=action=>action==='dashboard.get'?{ok:false,error:{code:'VALIDATION_ERROR',message:'合成失败'}}:undefined
  const loading=page.loadDashboard()
  await tick();assert.equal(page.data.hasDashboard,true);assert.equal(page.data.loading,true)
  release();await loading;assert.ok(page.data.errorMessage);assert.equal(page.data.hasDashboard,true)
  h.app.globalData.uid='';page.data.hasDashboard=false
  const unidentified=page.loadDashboard();await tick();assert.equal(page.data.hasDashboard,false)
  release();await unidentified
})
test('切换筛选绝不恢复其他查询，旧响应和旧快照不能穿越会话',async()=>{
  const h=runtime(),page=h.page('transactions');await page.prepareAndLoad()
  h.cache.invalidate(['transactions']);let release
  h.intercept=action=>action==='transactions.list'?new Promise(resolve=>{release=resolve}):undefined
  page.data.appliedSearch='new';const loading=page.loadTransactions(false)
  await tick();assert.equal(page.data.transactions.length,0)
  h.cache.reset();h.app.approved=false;page.onShow();release();await loading
  assert.equal(page.data.transactions.length,0)
})
