const app = getApp()
const api = require('../../services/catledger-api')
const themeService = require('../../theme/service')

Component({
  data: {
    open: false,
    submitting: false,
    errorMessage: '',
    avatarUrl: '',
    nickname: '',
    nicknameFocused: false,
    themeClass: '',
    themeStyle: ''
  },

  lifetimes: {
    attached: function () {
      this.setData(themeService.currentPresentation())
    }
  },

  methods: {
    show: function (options) {
      if (app.hasLoginApproval()) {
        if (options && typeof options.afterLogin === 'function') options.afterLogin()
        return
      }
      this._afterLogin = options && options.afterLogin
      const profile = app.globalData.profile || {}
      this.setData(Object.assign({}, themeService.currentPresentation(), {
        open: true,
        submitting: false,
        errorMessage: '',
        avatarUrl: profile.avatarUrl || '',
        nickname: profile.nickname || '',
        nicknameFocused: false
      }))
    },

    close: function () {
      if (this.data.submitting) return
      this._afterLogin = null
      this.setData({ open: false, errorMessage: '' })
    },

    stopBubble: function () {},

    chooseAvatar: function (event) {
      const avatarUrl = event && event.detail && event.detail.avatarUrl
      if (avatarUrl) this.setData({ avatarUrl, errorMessage: '' })
    },

    bindNickname: function (event) {
      this.setData({
        nickname: String(event && event.detail && event.detail.value || '').slice(0, 24),
        errorMessage: ''
      })
    },

    focusNickname: function () {
      if (!this.data.submitting) this.setData({ nicknameFocused: true })
    },

    blurNickname: function (event) {
      this.setData({
        nickname: String(event && event.detail && event.detail.value || '').slice(0, 24),
        nicknameFocused: false,
        errorMessage: ''
      })
    },

    confirm: function () {
      if (this.data.submitting) return
      const self = this
      const afterLogin = this._afterLogin
      const profile = { avatarUrl: this.data.avatarUrl, nickname: this.data.nickname }
      this.setData({ submitting: true, errorMessage: '' })
      return api.bootstrapAfterConsent()
        .then(function (result) {
          return app.saveLocalProfile(profile).then(function () {
            return app.completeWechatLogin(result.categories)
          })
        })
        .then(function () {
          self._afterLogin = null
          self.setData({ open: false, submitting: false })
          wx.showToast({ title: '登录成功', icon: 'success' })
          if (typeof afterLogin === 'function') afterLogin()
          self.triggerEvent('success')
        })
        .catch(function (error) {
          self.setData({
            submitting: false,
            errorMessage: error.message || '登录暂时没有完成，请重试'
          })
        })
    }
  }
})
