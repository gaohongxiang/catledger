const app = getApp()
const api = require('../../services/catledger-api')
const profilePresentation = require('../../utils/profile-presentation')
const themeService = require('../../theme/service')

Page({
  data: {
    loggedIn: false,
    loading: false,
    connected: false,
    nickname: '',
    displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
    identityStatusText: '尚未登录',
    syncActionText: '',
    errorMessage: '',
    accountCount: 0,
    categoryCount: 0
  },

  onShow: function () {
    themeService.bindPage(this)
    if (this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, hidden: false })
    }
    const loggedIn = app.hasLoginApproval()
    const profile = app.globalData.profile || {}
    this.setData({
      loggedIn: loggedIn,
      nickname: loggedIn ? profile.nickname : '',
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, profile),
      connected: false,
      identityStatusText: loggedIn ? '正在连接个人账本' : '尚未登录',
      syncActionText: '',
      errorMessage: '',
      accountCount: 0,
      categoryCount: 0
    })
    if (loggedIn) {
      this.loadProfile()
    }
  },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadProfile().finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadProfile: function (options) {
    if (!app.hasLoginApproval() || this.data.loading) {
      return Promise.resolve()
    }
    const self = this
    let identityConnected = Boolean(options && options.identityConfirmed)
    this.setData({
      loading: true,
      errorMessage: '',
      syncActionText: '',
      connected: identityConnected,
      identityStatusText: identityConnected ? '个人账本已连接' : '正在连接个人账本'
    })

    const bootstrapPromise = identityConnected
      ? Promise.resolve({ categories: app.globalData.categories })
      : api.bootstrap()

    return bootstrapPromise
      .then(function (result) {
        const categories = Array.isArray(result.categories) ? result.categories : []
        identityConnected = true
        app.globalData.categories = categories
        self.setData({
          connected: true,
          identityStatusText: '个人账本已连接',
          categoryCount: categories.length,
          syncActionText: '',
          errorMessage: ''
        })
        return api.callApi('accounts.list')
      })
      .then(function (result) {
        const accounts = Array.isArray(result.accounts) ? result.accounts : []
        self.setData({
          accountCount: accounts.filter(function (account) { return !account.archived }).length,
          syncActionText: '',
          errorMessage: ''
        })
      })
      .catch(function (error) {
        self.setData({
          connected: identityConnected,
          identityStatusText: identityConnected ? '个人账本已连接' : '个人账本暂未连接',
          syncActionText: identityConnected ? '同步数据' : '重试',
          errorMessage: identityConnected
            ? '账户数据暂未同步'
            : (error.message || '身份状态加载失败')
        })
      })
      .finally(function () {
        self.setData({ loading: false })
      })
  },

  retryProfile: function () {
    if (this.data.errorMessage && !this.data.loading) {
      this.loadProfile()
    }
  },

  openTheme: function () {
    wx.navigateTo({ url: '/pages/theme/index' })
  },

  promptWechatLogin: function (afterLogin) {
    const tabBar = this.getTabBar()
    if (tabBar && typeof tabBar.requestLogin === 'function') {
      tabBar.requestLogin({
        afterLogin: typeof afterLogin === 'function'
          ? afterLogin
          : this.onWechatLoginSuccess.bind(this)
      })
    }
  },

  onWechatLoginSuccess: function () {
    const profile = app.globalData.profile || {}
    this.setData({
      loggedIn: true,
      nickname: profile.nickname || '',
      displayAvatarUrl: profilePresentation.displayAvatarUrl(true, profile)
    })
    this.loadProfile({ identityConfirmed: true })
  },

  showPrivacy: function () {
    wx.showModal({
      title: '数据与隐私',
      content: '只有你主动点击登录后，招财猫记账本才会创建并连接个人账本。头像和昵称由你自愿选择，仅保存在当前设备用于“我的”页面展示；服务端使用微信可信身份隔离账本，不在页面、响应或普通日志中展示 OpenID 和内部用户标识。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: themeService.currentTokens().accent
    })
  },

  showAbout: function () {
    wx.showModal({
      title: '关于招财猫记账本',
      content: '招财猫记账本是一款以账单导入为主、手动记账为辅的个人财务小程序。当前为开发版，尚未上传审核。',
      showCancel: false,
      confirmText: '知道了',
      confirmColor: themeService.currentTokens().accent
    })
  },

  logoutAccount: function () {
    const self = this
    wx.showModal({
      title: '退出登录？',
      content: '只会清除本机登录状态和展示资料，不会删除云端账本。',
      cancelText: '取消',
      confirmText: '退出',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm) {
          return
        }
        app.logoutWechatAccount()
        self.setData({
          loggedIn: false,
          loading: false,
          connected: false,
          nickname: '',
          displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
          identityStatusText: '尚未登录',
          syncActionText: '',
          errorMessage: '',
          accountCount: 0,
          categoryCount: 0
        })
        wx.showToast({ title: '已退出登录', icon: 'none' })
      }
    })
  }
})
