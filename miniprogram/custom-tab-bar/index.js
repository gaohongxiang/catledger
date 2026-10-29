const app = getApp()
const themeService = require('../theme/service')
const { tabs: mainTabs } = require('../shell/tabs')

Component(themeService.component({
  data: {
    hidden: false,
    entryOpen: false,
    selected: 0,
    tabs: [
      {
        pagePath: '/pages/index/index',
        text: '首页',
        iconPath: 'tab-home.svg',
        selectedIconPath: 'tab-home-active.svg'
      },
      {
        pagePath: '/pages/transactions/index',
        text: '明细',
        iconPath: 'tab-list.svg',
        selectedIconPath: 'tab-list-active.svg'
      },
      {
        pagePath: '/pages/statistics/index',
        text: '统计',
        iconPath: 'statistics.svg',
        selectedIconPath: 'statistics-active.svg'
      },
      {
        pagePath: '/pages/profile/index',
        text: '我的',
        iconPath: 'tab-user.svg',
        selectedIconPath: 'tab-user-active.svg'
      }
    ]
  },

  lifetimes: {
    attached: function () {
      this.syncSelected()
    }
  },

  pageLifetimes: {
    show: function () { this.syncSelected() },
    hide: function () { this.closeEntry() }
  },

  methods: {
    syncSelected: function () {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1]
      const selected = currentPage && currentPage.route === 'shell/index'
        ? mainTabs.findIndex(tab => tab.id === currentPage.data.activeTab) : -1
      if (selected >= 0 && selected !== this.data.selected) this.setData({ selected })
    },
    isLoggedIn: function () {
      return app.hasLoginApproval()
    },

    requestLogin: function (options) {
      const pages = getCurrentPages()
      const host = pages[pages.length - 1]
      const panel = host && host.activePanel && host.activePanel()
      const afterLogin = options && options.afterLogin
      const complete = () => {
        if (host && host._shellVisible && panel === host.activePanel()) {
          if (typeof afterLogin === 'function') afterLogin()
        }
      }
      if (this.isLoggedIn()) {
        complete()
        return
      }
      this.closeEntry()
      const sheet = this.selectComponent('#loginSheet')
      if (sheet && typeof sheet.show === 'function') sheet.show(Object.assign({}, options, { afterLogin: complete }))
    },

    switchTab: function (event) {
      const index = Number(event.currentTarget.dataset.index)
      const tab = this.data.tabs[index]
      if (!tab || index === this.data.selected) {
        return
      }
      this.closeEntry()
      this.triggerEvent('tabchange', { id: mainTabs[index].id })
    },

    openEntry: function () {
      if (!this._openingPage) this.setData({ entryOpen: true })
    },

    closeEntry: function () {
      this.setData({ entryOpen: false })
    },

    keepEntryOpen: function () {},

    chooseBill: function () {
      this.openEntryPage('/packages/finance/pages/import-workbench/index', '暂时无法打开导入，请重试')
    },

    openEditor: function () {
      this.openEntryPage('/pages/transaction-editor/index', '暂时无法打开记账，请重试')
    },

    openEntryPage: function (url, failureMessage) {
      if (this._openingPage) return
      this.closeEntry()
      if (!this.isLoggedIn()) {
        this.requestLogin({ afterLogin: () => this.openEntryPage(url, failureMessage) })
        return
      }
      this._openingPage = true
      wx.navigateTo({
        url,
        fail: () => wx.showToast({ title: failureMessage, icon: 'none' }),
        complete: () => { this._openingPage = false }
      })
    }
  }
}))
