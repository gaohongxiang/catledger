const { tabs, resolveTab } = require('./tabs')

// 宿主不直接调任何原生接口：窗口、导航栏、标题全部由 shell/index.wxml 的 page-meta 声明，
// 与内容同一次渲染提交。运行时接口只能"先错一帧再改对"。
function createHost() {
  return {
    data: {
      activeTab: 'home',
      navTitle: tabs[0].title,
      mounted: { home: false, transactions: false, statistics: false, profile: false }
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
    selectTab: function (id) {
      const next = resolveTab(id)
      const previous = this.activePanel()
      if (previous && this.data.activeTab !== next.id) previous.deactivate()
      this.setData({ activeTab: next.id, navTitle: next.title, ['mounted.' + next.id]: true })
      const bar = this.getTabBar()
      if (bar) bar.setData({ selected: tabs.indexOf(next), hidden: false, entryOpen: false })
      const current = this.activePanel()
      if (this._shellVisible && current) current.activate()
    },
    switchTab: function (event) { this.selectTab(event.detail.id) }
  }
}

module.exports = { createHost }
