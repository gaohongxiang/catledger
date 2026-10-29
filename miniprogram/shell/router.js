const { HOST_ROUTE, resolveTab } = require('./tabs')

// 主导航只切宿主内的组件；从详情返回时交给宿主 onShow 激活一次。
function openTab(id, options) {
  const tab = resolveTab(id)
  const callbacks = options || {}
  const pages = getCurrentPages()
  const index = pages.findIndex(page => page.route === HOST_ROUTE)
  const host = pages[index]
  if (host && index === pages.length - 1) {
    host.selectTab(tab.id)
    if (callbacks.success) callbacks.success()
    if (callbacks.complete) callbacks.complete()
    return
  }
  if (host) {
    host.pendingTab = tab.id
    wx.navigateBack(Object.assign({}, callbacks, {
      delta: pages.length - index - 1,
      fail: error => {
        host.pendingTab = null
        if (callbacks.fail) callbacks.fail(error)
      }
    }))
    return
  }
  wx.reLaunch(Object.assign({}, callbacks, { url: '/' + HOST_ROUTE + '?tab=' + tab.id }))
}

function legacyPage(id) {
  return { onLoad: function (query) {
    if (id === 'statistics' && query && query.completeCategories === '1') getApp().globalData.openStatisticsCompletion = true
    openTab(id)
  } }
}

module.exports = { openTab, legacyPage }
