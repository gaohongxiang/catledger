const { HOST_ROUTE, resolveTab, isSubpage } = require('./tabs')

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

// 二级页整页入口：重定向到宿主对应面板（底栏常驻）。宿主不在栈顶就回退/重启到宿主对应 tab。
// query 仅用于宿主首帧即定位面板；业务参数由面板自身从宿主环境读取。
function legacyRedirect(id) {
  return { onLoad: function (query) {
    const pages = getCurrentPages()
    const index = pages.findIndex(page => page.route === HOST_ROUTE)
    const host = pages[index]
    if (host) {
      host.pendingTab = id
      wx.navigateBack({ delta: pages.length - index - 1 })
      return
    }
    wx.reLaunch({ url: '/' + HOST_ROUTE + '?tab=' + id })
  } }
}

// 二级页路由前缀 -> 面板 id
const SUBPAGE_BY_ROUTE = {}
const { subpages: _subpages } = require('./tabs')
Object.keys(_subpages).forEach(function (id) { SUBPAGE_BY_ROUTE['/' + _subpages[id].route] = id })

// 按整页 URL 打开二级页（供调用点最小改动）。url 形如 /pages/xxx/index?a=1&b=2。
// 命中二级页 -> 交给宿主面板（底栏常驻）并解析 query 作为面板 onLoad 参数；否则真整页 navigateTo。
function openSubpageUrl(url, options) {
  const str = String(url || '')
  const q = str.indexOf('?')
  const pathPart = q < 0 ? str : str.slice(0, q)
  const queryStr = q < 0 ? '' : str.slice(q + 1)
  const id = SUBPAGE_BY_ROUTE[pathPart]
  if (!id) { wx.navigateTo(Object.assign({}, options || {}, { url: str })); return false }
  let params = {}
  queryStr.split('&').forEach(function (pair) {
    if (!pair) return
    const eq = pair.indexOf('=')
    const k = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq))
    const v = eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1))
    params[k] = v
  })
  const pages = getCurrentPages()
  const index = pages.findIndex(page => page.route === HOST_ROUTE)
  const host = pages[index]
  if (host && typeof host.openSubpage === 'function') {
    if (options && options.success) options.success()
    if (options && options.complete) options.complete()
    host.openSubpage(id, params)
    return true
  }
  // 宿主不在栈：整页兜底，保留原始 URL（含 query），legacyRedirect 会再带回宿主。
  wx.navigateTo(Object.assign({}, options || {}, { url: str }))
  return false
}

// 从任意页面/面板打开二级页：优先交给宿主面板（底栏常驻），宿主不在则退回整页。
function openSubpage(id, params) {
  if (!isSubpage(id)) return false
  const pages = getCurrentPages()
  const index = pages.findIndex(page => page.route === HOST_ROUTE)
  const host = pages[index]
  if (host && typeof host.openSubpage === 'function') { host.openSubpage(id, params); return true }
  // 宿主不在栈：整页兜底（legacyRedirect 会再带回宿主）。
  const { subpages } = require('./tabs')
  wx.navigateTo({ url: '/' + subpages[id].route })
  return false
}

module.exports = { openTab, legacyPage, legacyRedirect, openSubpage, openSubpageUrl }
