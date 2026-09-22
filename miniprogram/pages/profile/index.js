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
    serverNickname: '',
    profileLoaded: false,
    editingNickname: false,
    nicknameDraft: '',
    nicknameMaxLength: profilePresentation.NICKNAME_MAX_LENGTH,
    savingNickname: false,
    savingAvatar: false,
    avatarError: '',
    nicknameError: '',
    uid: '',
    displayUid: '',
    displayAvatarUrl: profilePresentation.DEFAULT_AVATAR_URL,
    errorMessage: '',
    accountCount: 0,
    categoryCount: 0
  },

  onLoad: function () { themeService.bindPage(this) },

  onShow: function () {
    this._nicknameRequestId = null
    themeService.bindPage(this)
    if (this.getTabBar()) {
      this.getTabBar().setData({ selected: 3, hidden: false })
    }
    const loggedIn = app.hasLoginApproval()
    const profile = app.globalData.profile || {}
    this.setData({
      loggedIn: loggedIn,
      nickname: loggedIn ? profile.nickname || '' : '',
      editingNickname: false,
      nicknameDraft: '',
      nicknameError: '',
      displayAvatarUrl: profilePresentation.displayAvatarUrl(loggedIn, profile)
    })
    if (loggedIn) {
      const catalog = this.loadProfile()
      return Promise.all([catalog, this.loadNickname()])
    }
    this.setData({
      loading: false, hasLoaded: false, connected: false, uid: '', displayUid: '',
      errorMessage: '', accountCount: 0, categoryCount: 0,
      serverNickname: '', profileLoaded: false, savingNickname: false, savingAvatar: false, avatarError: ''
    })
  },

  onPullDownRefresh: function () {
    if (!app.hasLoginApproval()) {
      wx.stopPullDownRefresh()
      return
    }
    Promise.all([this.loadProfile({ force: true }), this.loadNickname({ force: true })]).finally(function () {
      wx.stopPullDownRefresh()
    })
  },

  loadProfile: function (options) {
    const isCurrent = pageReadSession.begin(this, [
      'uid', 'displayUid', 'loading', 'hasLoaded', 'connected', 'errorMessage', 'accountCount', 'categoryCount',
      'nickname', 'serverNickname', 'profileLoaded', 'editingNickname', 'nicknameDraft', 'savingNickname', 'nicknameError',
      'savingAvatar', 'avatarError'
    ], ['_profileLoad', '_nicknameLoad'])
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

  loadNickname: function (options) {
    if (!app.hasLoginApproval() || this._nicknameLoad) return this._nicknameLoad || Promise.resolve()
    const self = this
    const isCurrent = pageReadSession.capture(this)
    this._nicknameLoad = api.callApi('profile.get', {}, options).then(function (result) {
      if (!isCurrent()) return
      const nickname = typeof result.nickname === 'string' ? result.nickname : ''
      if (nickname && typeof app.setLocalNickname === 'function') app.setLocalNickname(nickname)
      self.setData({
        nickname: nickname || (app.globalData.profile && app.globalData.profile.nickname || ''),
        serverNickname: nickname, profileLoaded: true, nicknameError: ''
      })
    }).catch(function (error) {
      if (isCurrent()) self.setData({ nicknameError: error.message || '昵称暂时无法同步' })
    }).finally(function () {
      if (isCurrent()) self._nicknameLoad = null
    })
    return this._nicknameLoad
  },

  startEditNickname: function () {
    if (!app.hasLoginApproval()) return
    if (!this.data.profileLoaded) {
      this.loadNickname({ force: true })
      return
    }
    this.setData({ editingNickname: true, nicknameDraft: this.data.nickname, nicknameError: '' })
  },

  bindNicknameDraft: function (event) {
    if (this.data.savingNickname) return
    const nicknameDraft = String(event && event.detail && event.detail.value || '')
    if (nicknameDraft.trim() !== this.data.nicknameDraft.trim()) this._nicknameRequestId = null
    this.setData({ nicknameDraft, nicknameError: '' })
  },

  cancelEditNickname: function () {
    if (this.data.savingNickname) return
    this._nicknameRequestId = null
    this.setData({ editingNickname: false, nicknameDraft: '', nicknameError: '' })
  },

  saveNickname: function (event) {
    if (!app.hasLoginApproval() || !this.data.profileLoaded || this.data.savingNickname) return
    const form = event && event.detail && event.detail.value
    if (form && typeof form.nickname === 'string') this.bindNicknameDraft({ detail: { value: form.nickname } })
    const nickname = String(this.data.nicknameDraft || '').trim()
    if (!nickname || Array.from(nickname).length > profilePresentation.NICKNAME_MAX_LENGTH) {
      this.setData({ nicknameError: '昵称需填写 1～6 个字' })
      return
    }
    if (nickname === this.data.serverNickname) {
      this.cancelEditNickname()
      return
    }
    const self = this
    const isCurrent = pageReadSession.capture(this)
    this._nicknameRequestId = this._nicknameRequestId || api.createRequestId()
    this.setData({ savingNickname: true, nicknameError: '' })
    return api.callApi('profile.update', {
      requestId: this._nicknameRequestId, nickname, previousNickname: this.data.serverNickname
    }).then(function (result) {
      if (!isCurrent() || !app.hasLoginApproval()) return
      const savedNickname = result && result.nickname || nickname
      app.setLocalNickname(savedNickname)
      self._nicknameRequestId = null
      self.setData({ nickname: savedNickname, serverNickname: savedNickname,
        editingNickname: false, nicknameDraft: '', nicknameError: '' })
      wx.showToast({ title: '昵称已保存', icon: 'success' })
    }).catch(function (error) {
      if (!isCurrent()) return
      if (error.code === 'CONFLICT') self._nicknameRequestId = null
      self.setData({ nicknameError: error.code === 'CONFLICT'
        ? '昵称已在其他设备更新，请刷新后重试' : error.message || '昵称保存失败，请重试' })
    }).finally(function () {
      if (isCurrent()) self.setData({ savingNickname: false })
    })
  },

  chooseAvatar: function (event) {
    const avatarUrl = event && event.detail && event.detail.avatarUrl
    if (!app.hasLoginApproval() || !avatarUrl || this.data.savingAvatar) return
    const isCurrent = pageReadSession.capture(this)
    this.setData({ savingAvatar: true, avatarError: '' })
    return app.saveLocalProfile({ avatarUrl, nickname: this.data.nickname }, { isCurrent, avatarOnly: true }).then(profile => {
      if (!isCurrent() || !app.hasLoginApproval()) return
      this.setData({ displayAvatarUrl: profile.avatarUrl })
      wx.showToast({ title: '头像已保存', icon: 'success' })
    }).catch(error => {
      if (isCurrent()) this.setData({ avatarError: error.message || '头像保存失败，请重试' })
    }).finally(() => {
      if (isCurrent()) this.setData({ savingAvatar: false })
    })
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
    this.loadNickname({ force: true })
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
    wx.navigateTo({ url: '/pages/data-privacy/index' })
  },

  openAbout: function () {
    wx.navigateTo({ url: '/pages/about/index' })
  },

  logoutAccount: function () {
    const self = this
    wx.showModal({
      title: '退出登录？',
      content: '会清除本机登录状态，昵称和头像留待下次登录使用；不会删除云端账本。',
      cancelText: '取消',
      confirmText: '退出',
      confirmColor: themeService.currentTokens().danger,
      success: function (result) {
        if (!result.confirm) {
          return
        }
        app.logoutWechatAccount()
        self._nicknameRequestId = null
        self.setData({
          loggedIn: false,
          loading: false,
          connected: false,
          nickname: '',
          serverNickname: '',
          profileLoaded: false,
          editingNickname: false,
          nicknameDraft: '',
          savingNickname: false,
          savingAvatar: false,
          avatarError: '',
          nicknameError: '',
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
