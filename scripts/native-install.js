// 仅供微信 automation_evaluate 的 fnSource；不在小程序包中。重新编译即可撤销所有替换。
async function installNative(state) {
  var app = getApp()
  if (app.__nativeHarness) throw new Error('Native harness already installed')
  var original = { callFunction: wx.cloud.callFunction, get: wx.getStorageSync, set: wx.setStorageSync, remove: wx.removeStorageSync,
    globalData: JSON.parse(JSON.stringify(app.globalData)) }
  var storage = new Map(), traces = []
  wx.getStorageSync = function(key) { return String(key).indexOf('catledger_') === 0 ? storage.get(key) : original.get.call(wx, key) }
  wx.setStorageSync = function(key, value) { if (String(key).indexOf('catledger_') === 0) storage.set(key, value); else original.set.call(wx, key, value) }
  wx.removeStorageSync = function(key) { if (String(key).indexOf('catledger_') === 0) storage.delete(key); else original.remove.call(wx, key) }
  wx.cloud.callFunction = function(options) {
    var start = Date.now()
    return new Promise(function(resolve, reject) {
      wx.request({ url: state.endpoint, method: 'POST', data: { name: options.name, data: options.data }, timeout: 20000,
        success: function(response) {
          var result = response.data
          traces.push({ action: options.data.action, ms: Date.now() - start, ok: !!(result.result && result.result.ok) })
          if (options.success) options.success(result)
          resolve(result)
        }, fail: function(error) { if (options.fail) options.fail(error); reject(error) }
      })
    })
  }
  app.globalData.uid = state.uid
  app.globalData.categories = state.categories
  app.globalData.profile = { nickname: '合成验证', avatarUrl: '' }
  app.globalData.loginApproved = true
  require('services/read-cache.js').reset()
  app.__nativeHarness = { state: state, traces: traces, storage: storage, restore: function() {
    wx.cloud.callFunction = original.callFunction; wx.getStorageSync = original.get; wx.setStorageSync = original.set; wx.removeStorageSync = original.remove
    app.globalData = original.globalData
    require('services/read-cache.js').reset()
    delete app.__nativeHarness
  } }
  var probe = await wx.cloud.callFunction({ name: 'catledger-import', data: { action: 'financeUpdates.summary', data: { updateId: state.updateId } } })
  if (!probe.result || !probe.result.ok) throw new Error('Local summary read failed')
  await new Promise(function(resolve, reject) { wx.reLaunch({ url: '/pages/import-workbench/index?updateId=' + state.updateId, success: resolve, fail: reject }) })
  return { localSynthetic: true, rows: 121, protocolVersion: probe.result.data.protocolVersion }
}
