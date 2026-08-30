const app = getApp()
const themeService = require('../theme/service')

Component({
  data: {
    hidden: false,
    entryOpen: false,
    themeId: '',
    themeName: '',
    themeClass: '',
    themeStyle: '',
    selected: 0,
    tabs: [
      {
        pagePath: '/pages/index/index',
        text: '首页',
        iconPath: '/assets/icons/tab-home.svg',
        selectedIconPath: '/assets/icons/tab-home-active.svg'
      },
      {
        pagePath: '/pages/transactions/index',
        text: '明细',
        iconPath: '/assets/icons/tab-list.svg',
        selectedIconPath: '/assets/icons/tab-list-active.svg'
      },
      {
        pagePath: '/pages/ledger/index',
        text: '账本',
        iconPath: '/assets/icons/tab-book.svg',
        selectedIconPath: '/assets/icons/tab-book-active.svg'
      },
      {
        pagePath: '/pages/profile/index',
        text: '我的',
        iconPath: '/assets/icons/tab-user.svg',
        selectedIconPath: '/assets/icons/tab-user-active.svg'
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
      this.setData({ entryOpen: false })
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

    openEntry: function () {
      this.setData({ entryOpen: true })
    },

    closeEntry: function () {
      this.setData({ entryOpen: false })
    },

    keepEntryOpen: function () {},

    chooseBill: function () {
      this.closeEntry()
      if (!this.isLoggedIn()) {
        this.requestLogin({ afterLogin: this.chooseBill.bind(this) })
        return
      }
      wx.chooseMessageFile({
        count: 9,
        type: 'file',
        extension: ['csv', 'xlsx', 'xls', 'zip'],
        success: function (result) {
          const count = Array.isArray(result.tempFiles) ? result.tempFiles.length : 0
          if (count === 0) {
            return
          }
          wx.showModal({
            title: '已选择' + count + '个账单文件',
            content: '当前开发版尚未上传文件；解析、整理和入账会在账单导入阶段接入。',
            showCancel: false,
            confirmText: '知道了'
          })
        },
        fail: function (error) {
          if (!error || !String(error.errMsg || '').includes('cancel')) {
            wx.showToast({ title: '未能读取账单文件', icon: 'none' })
          }
        }
      })
    },

    openEditor: function () {
      this.closeEntry()
      if (!this.isLoggedIn()) {
        this.requestLogin({ afterLogin: this.openEditor.bind(this) })
        return
      }
      wx.navigateTo({ url: '/pages/transaction-editor/index' })
    }
  }
})
