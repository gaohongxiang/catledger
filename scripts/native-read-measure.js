// automation_evaluate fnSource；仅在 native-read-sandbox.js 建立的独立工程运行。
async function measureNativeReads(state) {
  var transport = require('native-read-transport.js'), api = require('services/catledger-api.js'), observer = require('services/read-observer.js'), tabs = require('shell/tabs.js')
  var app = getApp(), samples = []
  transport.measurements = samples; transport.phase = 'starting'; transport.failReads = false
  function hostPage() { return getCurrentPages().slice(-1)[0] }
  function page() {
    var host = hostPage()
    return host && host.route === 'shell/index' ? host.activePanel() : host
  }
  function navigation(method, url) { return new Promise(function(resolve, reject) { wx[method]({ url: url, success: resolve, fail: reject }) }) }
  async function selectTab(tabId) {
    var pages = getCurrentPages(), host = hostPage()
    if (!host || host.route !== 'shell/index') {
      var shellIndex = pages.findIndex(function(entry) { return entry.route === 'shell/index' })
      if (shellIndex >= 0) {
        var shell = pages[shellIndex]
        shell.pendingTab = tabId
        await new Promise(function(resolve, reject) {
          wx.navigateBack({ delta: pages.length - shellIndex - 1, success: resolve, fail: function(error) { shell.pendingTab = null; reject(error) } })
        })
      } else {
        await navigation('reLaunch', '/shell/index?tab=' + encodeURIComponent(tabId))
      }
      await ready(function() { var current=hostPage();return current && current.route === 'shell/index' })
      host = hostPage()
    }
    host.selectTab(tabId)
    await ready(function() {
      var current = host.activePanel()
      return hostPage() === host && current && current.route === tabs.resolveTab(tabId).route
    })
  }
  function ready(check) { return new Promise(function(resolve, reject) { var began=Date.now(); var timer=setInterval(function(){ if(check()){clearInterval(timer);resolve()}else if(Date.now()-began>15000){clearInterval(timer);reject(new Error('Synthetic page timeout'))}},10) }) }
  async function measure(scenario, operation) {
    // 相邻导航先稳定350ms，避免上个路由动画混入本场景；该等待不计入测量。
    await new Promise(function(resolve){setTimeout(resolve,350)})
    transport.phase = scenario; observer.enable(true); var before = transport.traces.length, began = Date.now()
    var freshTimes=[],snapshotTimes=[],record=observer.record
    observer.record=function(event,value){if(event==='fresh')freshTimes.push(Date.now()-began);if(event==='snapshot')snapshotTimes.push(Date.now()-began);return record(event,value)}
    try { await operation() } finally { observer.record=record }
    var operationMs = Date.now() - began, latestReadyMs=freshTimes.length?Math.max.apply(null,freshTimes):null
    await new Promise(function(resolve) { page().setData({}, resolve) })
    var metrics = observer.snapshot(), requests = transport.traces.slice(before)
    samples.push({ scenario: scenario, operationMs:operationMs,latestReadyMs: latestReadyMs, snapshotReadyMs:snapshotTimes.length?Math.min.apply(null,snapshotTimes):null,renderAckMs: Date.now()-began, interactiveMs: null,
      requests: requests.length, calls: requests,
      snapshotMs: metrics.filter(function(x){return x.event==='snapshot'}).map(function(x){return x.ms}),
      maxSetDataBytes: Math.max.apply(null,[0].concat(metrics.filter(function(x){return x.event==='setData'}).map(function(x){return x.bytes}))),
      setDataBytes: metrics.filter(function(x){return x.event==='setData'}).reduce(function(sum,x){return sum+x.bytes},0) })
  }
  app.logoutWechatAccount(); app.globalData.loginStartupPending = true
  await measure('cold-home', async function() {
    await navigation('reLaunch','/shell/index')
    await ready(function(){var current=page();return app.hasLoginApproval() && current && current.data.hasDashboard && !current.data.loading})
  })
  await measure('same-session-home', function(){return page().loadDashboard()})
  await measure('background-home', function(){app.onHide();app.onShow();return page().loadDashboard()})
  await navigation('navigateTo','/packages/finance/pages/loan-detail/index?loanId='+encodeURIComponent(state.loanId));await page().load()
  await navigation('navigateTo','/packages/finance/pages/loan-plan/index?loanId='+encodeURIComponent(state.loanId))
  await ready(function(){return !page().data.loading})
  await measure('loan-return', async function(){await navigation('navigateBack');await ready(function(){return !!page().data.loan&&!page().data.loading})})
  await measure('write-return', async function(){
    transport.writePhases = []; var writeBegan = Date.now()
    await api.callApi('transactions.create',{requestId:api.createRequestId(),type:'expense',sourceAccountId:state.accountId,categoryId:state.categoryId,amountMinor:'100',occurredLocalAt:'2026-09-04T12:00:00',timezoneOffsetMinutes:-480,note:'合成写后返回'})
    transport.writePhases.push({phase:'confirmed',ms:Date.now()-writeBegan})
    await selectTab('home');transport.writePhases.push({phase:'navigation',ms:Date.now()-writeBegan});await ready(function(){return page().data.hasDashboard&&!page().data.loading});transport.writePhases.push({phase:'latest',ms:Date.now()-writeBegan})
  })
  await selectTab('transactions');await page().prepareAndLoad()
  for(var i=2;i<=10;i++)await measure('transactions-page-'+i,function(){return page().loadTransactions(true)})
  var loadedRows=page().data.transactions.length
  await measure('selection',async function(){page().toggleSelection();await page().selectAll();page().resetSelection()})
  if(loadedRows!==300 || page().data.selectedCount!==0)throw new Error('Synthetic native pagination/selection failed')
  await selectTab('home');await page().loadDashboard()
  await measure('weak-network-home',async function(){transport.failReads=true;app.onHide();app.onShow();await page().loadDashboard()})
  transport.failReads=false
  if(!page().data.hasDashboard || !page().data.errorMessage)throw new Error('Weak network lost snapshot')
  transport.phase = 'complete'
  return { sourceSha:state.sourceSha,sourceHash:state.sourceHash,scope:'WeChat DevTools native runtime; synthetic local MySQL; fixed 40ms transport delay; no phone/cloud claim',
    samples:samples,writePhases:transport.writePhases,navigationSettlingMs:350,loadedRows:loadedRows,weakFailureRetained:true,interactiveLimit:'setData callback is a render acknowledgement; user input readiness needs separate real-device evidence' }
}
