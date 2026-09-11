const app = getApp()
const api = require('../../services/catledger-api')
const pageReadSession = require('../../services/page-read-session')
const profilePresentation = require('../../utils/profile-presentation')
const themeService = require('../../theme/service')

Page({
  data: {
    loggedIn: false,
    loading: false,
    hasLoaded: false,
    connected: false,
    nickname: '',
    uid: '',
    displayUid: '',
    displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
    errorMessage: '',
    accountCount: 0,
    categoryCount: 0
  },

  onLoad: function () { themeService.bindPage(this) },

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
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, profile)
    })
    if (loggedIn) {
      return this.loadProfile()
    }
    this.setData({
      loading: false, hasLoaded: false, connected: false, uid: '', displayUid: '',
      errorMessage: '', accountCount: 0, categoryCount: 0
    })
  },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadProfile({ force: true }).finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadProfile: function (options) {
    const isCurrent = pageReadSession.begin(this, ['uid', 'displayUid', 'loading', 'hasLoaded', 'connected', 'errorMessage', 'accountCount', 'categoryCount'], ['_profileLoad'])
    if (!app.hasLoginApproval() || this._profileLoad) {
      return this._profileLoad || Promise.resolve()
    }
    const self = this
    const force = Boolean(options && options.force)
    const uid = options && options.identityConfirmed && typeof app.globalData.uid === 'string' ? app.globalData.uid : this.data.uid
    this.setData({ loading: force || !api.isFresh('catalog.get'), errorMessage: '',
      uid, displayUid: profilePresentation.displayUserId(uid), connected: this.data.connected || Boolean(uid) })
    this._profileLoad = api.callApi('catalog.get', {}, { force })
      .then(function (result) {
        if (!isCurrent()) return
        const categories = result.categories || []
        const uid = typeof result.uid === 'string' ? result.uid : ''
        app.globalData.uid = uid
        self.setData({ uid, displayUid: profilePresentation.displayUserId(uid), connected: true,
          hasLoaded: true, accountCount: (result.accounts || []).filter(account => !account.archived).length,
          categoryCount: categories.length, errorMessage: '' })
      }).catch(function (error) {
        if (isCurrent()) self.setData({ errorMessage: error.message || '账户和分类暂未同步' })
      })
      .finally(function () {
        if (!isCurrent()) return
        self.setData({ loading: false })
        self._profileLoad = null
      })
    return this._profileLoad
  },

  retryProfile: function () {
    if (!this.data.loading && (this.data.errorMessage || !this.data.uid)) {
      return this.loadProfile({ force: true })
    }
  },

  openAccounts: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openAccounts.bind(this))
      return
    }
    wx.navigateTo({ url: '/pages/accounts/index' })
  },

  openCategories: function () {
    if (!app.hasLoginApproval()) {
      this.promptWechatLogin(this.openCategories.bind(this))
      return
    }
    wx.navigateTo({ url: '/pages/categories/index' })
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

  copyId: function () {
    if (!app.hasLoginApproval() || !pageReadSession.isCurrent(this) || !this.data.uid) return
    wx.setClipboardData({
      data: this.data.uid,
      success: function () { wx.showToast({ title: 'ID 已复制', icon: 'success' }) },
      fail: function () { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }
    })
  },

  showPrivacy: function () {
    wx.showModal({
      title: '数据与隐私',
      content: '只有你主动点击登录后，招财猫记账本才会创建并连接个人账本。头像和昵称由你自愿选择，仅保存在当前设备用于“我的”页面展示；服务端使用微信可信身份隔离账本。页面 ID 是你的账号标识，可复制给客服定位问题，不是登录凭证。微信 OpenID 与身份摘要不对外展示，普通日志不记录身份信息。',
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
          uid: '',
          displayUid: '',
          hasLoaded: false,
          displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
          errorMessage: '',
          accountCount: 0,
          categoryCount: 0
        })
        wx.showToast({ title: '已退出登录', icon: 'none' })
      }
    })
  }
})
