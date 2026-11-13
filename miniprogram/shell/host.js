const { tabs, subpages, resolveTab, isSubpage, visualKey } = require('./tabs')

// 宿主不直接调任何原生接口：窗口、导航栏、标题全部由 shell/index.wxml 的 page-meta 声明，
// 与内容同一次渲染提交。运行时接口只能"先错一帧再改对"。
function createHost() {
  return {
    data: {
      activeTab: 'home',
      navTitle: tabs[0].title,
      // 所有面板（可视 tab + 二级页）的挂载位；二级页惰性挂载。
      mounted: (function () {
        const map = {}
        tabs.forEach(t => { map[t.id] = false })
        Object.keys(subpages).forEach(id => { map[id] = false })
        return map
      })()
    },
    onLoad: function (query) {
      this._panels = this._panels || {}
      this.selectTab(query && query.tab || 'home')
    },
    onShow: function () {
      if (this.pendingTab) {
        const next = this.pendingTab
        this.pendingTab = null
        this.selectTab(next)
      }
      this._shellVisible = true
      const current = this.activePanel()
      if (current) {
        if (current._panelActive) current.onShow()
        else current.activate()
      }
    },
    onHide: function () {
      this._shellVisible = false
      const current = this.activePanel()
      if (current) current.deactivate()
      const bar = this.getTabBar()
      if (bar) bar.closeEntry()
    },
    onUnload: function () { this.onHide(); this._hostDisposed = true; this._panels = {} },
    activePanel: function () { return this._panels && this._panels[this.data.activeTab] },
    refreshActivePanel: function () {
      const current = this.activePanel()
      if (this._shellVisible && current) return current.onShow()
    },
    getTabBar: function () { return this.selectComponent('#main-tabs') },
    registerPanel: function (event) {
      const id = event.detail.id
      const component = this.selectComponent('#panel-' + id)
      if (!component || this._hostDisposed) return
      this._panels = this._panels || {}
      this._panels[id] = component
      component.connectHost(this)
      if (this._shellVisible && id === this.data.activeTab) component.activate()
    },
    selectTab: function (id, options) {
      const next = resolveTab(id)
      const previous = this.activePanel()
      if (previous && this.data.activeTab !== next.id) previous.deactivate()
      // 返回栈：进入二级页时记录来源（便于返回），进入主 tab 时清空栈。
      this._backStack = this._backStack || []
      if (isSubpage(next.id)) {
        const from = options && options.from ? options.from : this.data.activeTab
        if (from && from !== next.id) this._backStack.push(from)
      } else {
        this._backStack = []
      }
      this.setData({ activeTab: next.id, navTitle: next.title, ['mounted.' + next.id]: true })
      const bar = this.getTabBar()
      // 高亮由 tab bar 的 activeKey 唯一驱动；host 明确告知该高亮哪个 key，不写下标。
      if (bar) { bar.setData({ hidden: false, entryOpen: false }); if (bar.setActiveKey) bar.setActiveKey(visualKey(next.id)) }
      const current = this.activePanel()
      if (this._shellVisible && current) current.activate()
    },
    // 二级页返回：回到来源页；没有来源时回 parent。
    back: function () {
      this._backStack = this._backStack || []
      const prev = this._backStack.pop()
      const id = this.data.activeTab
      const target = prev || (subpages[id] ? subpages[id].parent : 'home')
      this.selectTab(target)
    },
    // 打开二级页（供面板/页面调用）：确保宿主在栈顶，切到该面板；params 传给面板 onLoad。
    openSubpage: function (id, params) {
      if (!isSubpage(id)) return
      this._subpageParams = this._subpageParams || {}
      this._subpageParams[id] = params || {}
      const pages = getCurrentPages()
      const hostRoute = 'shell/index'
      const index = pages.findIndex(p => p.route === hostRoute)
      if (index >= 0 && index === pages.length - 1) { this.selectTab(id); return }
      if (index >= 0) { this.pendingTab = id; wx.navigateBack({ delta: pages.length - index - 1 }); return }
      wx.reLaunch({ url: '/' + hostRoute + '?tab=' + id })
    },
    // 面板取自己的进入参数（onLoad 用）。
    subpageParams: function (id) { return (this._subpageParams && this._subpageParams[id]) || {} },
    switchTab: function (event) { this.selectTab(event.detail.id) }
  }
}

module.exports = { createHost }
