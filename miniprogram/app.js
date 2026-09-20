const cloudbaseConfig = require('./config/cloudbase')
const themeService = require('./theme/service')
const profilePresentation = require('./utils/profile-presentation')
const readCache = require('./services/read-cache')

const LOCAL_PROFILE_KEY = 'catledger_local_profile_v1'

function readStoredProfile() {
  const profile = wx.getStorageSync(LOCAL_PROFILE_KEY)
  if (!profile || typeof profile !== 'object') {
    return { nickname: '', avatarUrl: '' }
  }
  return {
    nickname: String(profile.nickname || ''),
    avatarUrl: String(profile.avatarUrl || '')
  }
}

App({
  globalData: {
    cloudAvailable: false,
    loginApproved: false,
    loginStartupPending: false,
    uid: '',
    profile: { nickname: '', avatarUrl: '' },
    themeId: '',
    categories: [],
    openStatisticsCompletion: false,
    editingTransaction: null
  },

  onLaunch() {
    require('./services/export-files').cleanup(false)
    themeService.install(this)
    // 每次启动重新确认当前微信身份，本机旧登录标记不能代替账号识别。
    this.globalData.loginApproved = false
    this.globalData.loginStartupPending = true
    wx.removeStorageSync('catledger_wechat_login_v1')
    this.globalData.profile = readStoredProfile()

    if (!wx.cloud) {
      console.warn('当前基础库不支持云开发，请升级微信开发者工具或基础库。')
      return
    }

    wx.cloud.init({
      env: cloudbaseConfig.envId,
      traceUser: true
    })

    this.globalData.cloudAvailable = true
  },

  onHide: function () { this._readCacheWasHidden = true },

  onShow: function () {
    require('./services/export-files').cleanup(false)
    if (this._readCacheWasHidden) {
      readCache.invalidate(['accounts', 'transactions', 'categories', 'profile'])
      this._readCacheWasHidden = false
    }
  },

  hasLoginApproval: function () {
    return this.globalData.loginApproved === true
  },

  selectTheme: function (themeId) {
    return themeService.selectTheme(themeId, this)
  },

  saveLocalProfile: function (profile, options) {
    const self = this
    const resolvedProfile = profilePresentation.withDefaultProfile(profile, this.globalData.profile)
    const nickname = resolvedProfile.nickname
    const avatarUrl = resolvedProfile.avatarUrl
    const savedAvatar = /^(?:wxfile|https?):\/\/usr\//.test(avatarUrl) ||
      Boolean(wx.env && wx.env.USER_DATA_PATH && avatarUrl.indexOf(wx.env.USER_DATA_PATH + '/') === 0)
    const persistAvatar = avatarUrl !== profilePresentation.DEFAULT_AVATAR_URL && !savedAvatar
      ? new Promise(function (resolve, reject) {
          wx.saveFile({
            tempFilePath: avatarUrl,
            success: function (result) { resolve(result.savedFilePath || avatarUrl) },
            fail: function () { reject(new Error('头像保存失败，请重新选择')) }
          })
        })
      : Promise.resolve(avatarUrl)

    return persistAvatar.then(function (savedAvatarUrl) {
      if (options && options.isCurrent && !options.isCurrent()) return
      const savedProfile = { nickname: options && options.avatarOnly ? self.globalData.profile.nickname : nickname,
        avatarUrl: savedAvatarUrl }
      self.globalData.profile = savedProfile
      wx.setStorageSync(LOCAL_PROFILE_KEY, savedProfile)
      return savedProfile
    })
  },

  setLocalNickname: function (nickname) {
    const savedProfile = {
      nickname: String(nickname || ''),
      avatarUrl: this.globalData.profile && this.globalData.profile.avatarUrl || ''
    }
    this.globalData.profile = savedProfile
    wx.setStorageSync(LOCAL_PROFILE_KEY, savedProfile)
    return savedProfile
  },

  completeWechatLogin: function (categories, uid) {
    this.globalData.uid = typeof uid === 'string' ? uid : ''
    this.globalData.loginApproved = true
    this.globalData.loginStartupPending = false
    this.globalData.categories = Array.isArray(categories) ? categories : []
    return Promise.resolve(this.globalData.profile)
  },

  logoutWechatAccount: function () {
    require('./services/export-files').cleanup(true)
    readCache.reset()
    this.globalData.loginApproved = false
    this.globalData.loginStartupPending = false
    this.globalData.uid = ''
    this.globalData.categories = []
    this.globalData.openStatisticsCompletion = false
    this.globalData.transactionsImportFilter = null
    this.globalData.editingTransaction = null
  }
})
