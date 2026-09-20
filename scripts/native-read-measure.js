// automation_evaluate fnSource；仅在 native-read-sandbox.js 建立的独立工程运行。
async function measureNativeReads(state) {
  var transport = require('native-read-transport.js'), api = require('services/catledger-api.js'), observer = require('services/read-observer.js')
  var app = getApp(), samples = []
  transport.measurements = samples; transport.phase = 'starting'; transport.failReads = false
  function page() { return getCurrentPages().slice(-1)[0] }
  function navigation(method, url) { return new Promise(function(resolve, reject) { wx[method]({ url: url, success: resolve, fail: reject }) }) }
  function ready(check) { return new Promise(function(resolve, reject) { var began=Date.now(); var timer=setInterval(function(){ if(check()){clearInterval(timer);resolve()}else if(Date.now()-began>15000){clearInterval(timer);reject(new Error('Synthetic page timeout'))}},10) }) }
  async function measure(scenario, operation) {
    transport.phase = scenario; observer.enable(true); var before = transport.traces.length, began = Date.now()
    await operation()
    var latestReadyMs = Date.now() - began
    await new Promise(function(resolve) { page().setData({}, resolve) })
    var metrics = observer.snapshot(), requests = transport.traces.slice(before)
    samples.push({ scenario: scenario, latestReadyMs: latestReadyMs, renderAckMs: Date.now()-began, interactiveMs: null,
      requests: requests.length, calls: requests,
      snapshotMs: metrics.filter(function(x){return x.event==='snapshot'}).map(function(x){return x.ms}),
      maxSetDataBytes: Math.max.apply(null,[0].concat(metrics.filter(function(x){return x.event==='setData'}).map(function(x){return x.bytes}))),
      setDataBytes: metrics.filter(function(x){return x.event==='setData'}).reduce(function(sum,x){return sum+x.bytes},0) })
  }
  app.logoutWechatAccount(); app.globalData.loginStartupPending = true
  await measure('cold-home', async function() {
    await navigation('reLaunch','/pages/index/index')
    await ready(function(){return app.hasLoginApproval() && page().data.hasDashboard && !page().data.loading})
  })
  await measure('same-session-home', function(){return page().loadDashboard()})
  await measure('background-home', function(){app.onHide();app.onShow();return page().loadDashboard()})
  await navigation('navigateTo','/pages/loan-detail/index?loanId='+encodeURIComponent(state.loanId));await page().load()
  await navigation('navigateTo','/pages/loan-plan/index?loanId='+encodeURIComponent(state.loanId))
  await ready(function(){return !page().data.loading})
  await measure('loan-return', async function(){await navigation('navigateBack');await page().load()})
  await measure('write-return', async function(){
    await api.callApi('transactions.create',{requestId:api.createRequestId(),type:'expense',sourceAccountId:state.accountId,categoryId:state.categoryId,amountMinor:'100',occurredLocalAt:'2026-09-04T12:00:00',timezoneOffsetMinutes:-480,note:'合成写后返回'})
    await navigation('switchTab','/pages/index/index');await page().loadDashboard()
  })
  await navigation('switchTab','/pages/transactions/index');await page().prepareAndLoad()
  for(var i=2;i<=10;i++)await measure('transactions-page-'+i,function(){return page().loadTransactions(true)})
  var loadedRows=page().data.transactions.length
  await measure('selection',async function(){page().toggleSelection();await page().selectAll();page().resetSelection()})
  if(loadedRows!==300 || page().data.selectedCount!==0)throw new Error('Synthetic native pagination/selection failed')
  await navigation('switchTab','/pages/index/index');await page().loadDashboard()
  await measure('weak-network-home',async function(){transport.failReads=true;app.onHide();app.onShow();await page().loadDashboard()})
  transport.failReads=false
  if(!page().data.hasDashboard || !page().data.errorMessage)throw new Error('Weak network lost snapshot')
  transport.phase = 'complete'
  return { sourceSha:state.sourceSha,sourceHash:state.sourceHash,scope:'WeChat DevTools native runtime; synthetic local MySQL; fixed 40ms transport delay; no phone/cloud claim',
    samples:samples,loadedRows:loadedRows,weakFailureRetained:true,interactiveLimit:'setData callback is a render acknowledgement; user input readiness needs separate real-device evidence' }
}
