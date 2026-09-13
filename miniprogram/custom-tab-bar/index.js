const app = getApp()
const themeService = require('../theme/service')

Component({
  data: {
    hidden: false,
    themeId: '',
    themeName: '',
    themeClass: '',
    themeStyle: '',
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
      themeService.bindTabBar(this)
    }
  },

  methods: {
    syncTheme: function () {
      themeService.bindTabBar(this)
    },
    isLoggedIn: function () {
      return app.hasLoginApproval()
    },

    requestLogin: function (options) {
      if (this.isLoggedIn()) {
        if (options && typeof options.afterLogin === 'function') {
          options.afterLogin()
        }
        return
      }
      const sheet = this.selectComponent('#loginSheet')
      if (sheet && typeof sheet.show === 'function') sheet.show(options || {})
    },

    switchTab: function (event) {
      const index = Number(event.currentTarget.dataset.index)
      const tab = this.data.tabs[index]
      if (!tab || index === this.data.selected) {
        return
      }
      wx.switchTab({ url: tab.pagePath })
    },

    openEditor: function () {
      if (this._openingEditor) return
      if (!this.isLoggedIn()) {
        this.requestLogin({ afterLogin: this.openEditor.bind(this) })
        return
      }
      this._openingEditor = true
      wx.navigateTo({
        url: '/pages/transaction-editor/index',
        fail: () => wx.showToast({ title: '暂时无法打开记账，请重试', icon: 'none' }),
        complete: () => { this._openingEditor = false }
      })
    }
  }
})
