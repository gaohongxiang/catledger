const cloudbaseConfig = require('./config/cloudbase')
const themeService = require('./theme/service')

const LOGIN_APPROVAL_KEY = 'catledger_wechat_login_v1'
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
    profile: { nickname: '', avatarUrl: '' },
    themeId: '',
    categories: [],
    editingTransaction: null
  },

  onLaunch() {
    themeService.install(this)
    this.globalData.loginApproved = wx.getStorageSync(LOGIN_APPROVAL_KEY) === true
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

  hasLoginApproval: function () {
    return this.globalData.loginApproved === true
  },

  selectTheme: function (themeId) {
    return themeService.selectTheme(themeId, this)
  },

  saveLocalProfile: function (profile) {
    const self = this
    const nickname = String(profile && profile.nickname || '').trim().slice(0, 24)
    const avatarUrl = String(profile && profile.avatarUrl || '')
    const persistAvatar = avatarUrl && avatarUrl.indexOf('wxfile://usr/') !== 0
      ? new Promise(function (resolve) {
          wx.saveFile({
            tempFilePath: avatarUrl,
            success: function (result) { resolve(result.savedFilePath || avatarUrl) },
            fail: function () { resolve(avatarUrl) }
          })
        })
      : Promise.resolve(avatarUrl)

    return persistAvatar.then(function (savedAvatarUrl) {
      const savedProfile = { nickname: nickname, avatarUrl: savedAvatarUrl }
      self.globalData.profile = savedProfile
      wx.setStorageSync(LOCAL_PROFILE_KEY, savedProfile)
      return savedProfile
    })
  },

  completeWechatLogin: function (categories) {
    this.globalData.loginApproved = true
    this.globalData.categories = Array.isArray(categories) ? categories : []
    wx.setStorageSync(LOGIN_APPROVAL_KEY, true)
    return Promise.resolve(this.globalData.profile)
  },

  logoutWechatAccount: function () {
    const avatarUrl = this.globalData.profile && this.globalData.profile.avatarUrl
    if (avatarUrl && avatarUrl.indexOf('wxfile://usr/') === 0) {
      wx.removeSavedFile({
        filePath: avatarUrl,
        fail: function () {}
      })
    }
    this.globalData.loginApproved = false
    this.globalData.profile = { nickname: '', avatarUrl: '' }
    this.globalData.categories = []
    this.globalData.editingTransaction = null
    wx.removeStorageSync(LOGIN_APPROVAL_KEY)
    wx.removeStorageSync(LOCAL_PROFILE_KEY)
  }
})
