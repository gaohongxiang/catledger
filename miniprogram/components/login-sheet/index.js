const app = getApp()
const api = require('../../services/catledger-api')
const readCache = require('../../services/read-cache')
const profilePresentation = require('../../utils/profile-presentation')
const themeService = require('../../theme/service')

Component({
  data: {
    open: false, automatic: false, submitting: false, errorMessage: '',
    avatarUrl: '', nickname: '', nicknameFocused: false,
    nicknameMaxLength: profilePresentation.NICKNAME_MAX_LENGTH,
    stage: 'loading', themeClass: '', themeStyle: ''
  },

  lifetimes: {
    attached: function () { this.setData(themeService.currentPresentation()) },
    ready: function () { return this.startOnLaunch() },
    detached: function () {
      if (this.data.automatic && this.data.open && this._attemptSession === readCache.getSession() && !app.hasLoginApproval()) {
        app.globalData.loginStartupPending = true
      }
      this._attempt = null
    }
  },

  pageLifetimes: {
    show: function () { return this.startOnLaunch() }
  },

  methods: {
    startOnLaunch: function () {
      if (!app.globalData.loginStartupPending || !app.globalData.cloudAvailable) return
      return this.show({ automatic: true, afterLogin: function () {
        const pages = getCurrentPages()
        const page = pages[pages.length - 1]
        if (page && typeof page.onShow === 'function') page.onShow()
      } })
    },

    show: function (options) {
      if (app.hasLoginApproval()) {
        if (options && typeof options.afterLogin === 'function') options.afterLogin()
        return Promise.resolve()
      }
      if (this.data.open) {
        if (options && typeof options.afterLogin === 'function') this._afterLogin = options.afterLogin
        return this._loginLoad || Promise.resolve()
      }
      const automatic = Boolean(options && options.automatic || app.globalData.loginStartupPending)
      // 页内和底栏可能同时挂载此组件；仅首个可见入口承接启动识别。
      app.globalData.loginStartupPending = false
      this._afterLogin = options && options.afterLogin
      this._bootstrapResult = null
      this._profileRequestId = null
      this._attempt = {}
      this._attemptSession = readCache.getSession()
      this.setData(Object.assign({}, themeService.currentPresentation(), {
        open: true, automatic, submitting: false, errorMessage: '',
        avatarUrl: '', nickname: '', nicknameFocused: false, stage: 'loading'
      }))
      // 启动即识别微信账号，已设置资料的用户无需再点击登录或保存。
      return this.identify()
    },

    close: function () {
      if (this.data.submitting && this.data.stage !== 'loading') return
      this._attempt = null
      this._afterLogin = null
      this._bootstrapResult = null
      this._profileRequestId = null
      this._loginLoad = null
      this.setData({ open: false, submitting: false, errorMessage: '' })
    },

    captureAttempt: function () {
      const attempt = this._attempt
      const session = readCache.getSession()
      return () => Boolean(attempt) && this._attempt === attempt && this.data.open &&
        readCache.getSession() === session
    },

    identify: function () {
      if (this._loginLoad) return this._loginLoad
      const isCurrent = this.captureAttempt()
      this.setData({ stage: 'loading', submitting: true, errorMessage: '' })
      const pending = api.identifyWechatAccount().then(result => {
        if (!isCurrent()) return
        if (result.nickname) return this.finish(result, result.nickname, isCurrent)
        this._bootstrapResult = result
        const profile = profilePresentation.withDefaultProfile(app.globalData.profile)
        this.setData({ stage: 'setup', submitting: false,
          nickname: Array.from(profile.nickname).slice(0, profilePresentation.NICKNAME_MAX_LENGTH).join(''),
          avatarUrl: profile.avatarUrl })
      }).catch(error => {
        if (isCurrent()) this.setData({ stage: 'error', submitting: false,
          errorMessage: error.message || '暂时无法连接账本，请重试' })
      }).finally(() => {
        if (this._loginLoad === pending) this._loginLoad = null
      })
      this._loginLoad = pending
      return pending
    },

    finish: function (result, nickname, isCurrent) {
      const avatarUrl = this.data.avatarUrl || app.globalData.profile.avatarUrl || profilePresentation.DEFAULT_AVATAR_URL
      // 重登只恢复账号昵称，不重复处理本机头像；旧临时头像失效不能阻塞账号进入。
      const saveProfile = this.data.stage === 'setup'
        ? app.saveLocalProfile({ avatarUrl, nickname }, { isCurrent })
        : Promise.resolve(app.setLocalNickname(nickname))
      return saveProfile.then(() => {
        if (!isCurrent()) return
        return app.completeWechatLogin(result.categories, result.uid).then(() => {
          if (!isCurrent()) return
          const afterLogin = this._afterLogin
          this._attempt = null
          this._afterLogin = null
          this._bootstrapResult = null
          this._profileRequestId = null
          this.setData({ open: false, submitting: false })
          if (typeof afterLogin === 'function') afterLogin()
          this.triggerEvent('success')
        })
      })
    },

    stopBubble: function () {},

    chooseAvatar: function (event) {
      if (this.data.submitting || this.data.stage !== 'setup') return
      const avatarUrl = event && event.detail && event.detail.avatarUrl
      if (avatarUrl) this.setData({ avatarUrl, errorMessage: '' })
    },

    bindNickname: function (event) {
      if (this.data.submitting || this.data.stage !== 'setup') return
      const nickname = String(event && event.detail && event.detail.value || '')
      if (nickname.trim() !== this.data.nickname.trim()) this._profileRequestId = null
      this.setData({ nickname, errorMessage: '' })
    },

    shuffleNickname: function () {
      if (this.data.submitting || this.data.stage !== 'setup') return
      this._profileRequestId = null
      this.setData({ nickname: profilePresentation.randomNickname(this.data.nickname), errorMessage: '' })
    },

    focusNickname: function () {
      if (!this.data.submitting) this.setData({ nicknameFocused: true })
    },

    blurNickname: function (event) {
      this.bindNickname(event)
      this.setData({ nicknameFocused: false })
    },

    confirm: function (event) {
      if (this.data.submitting) return
      if (this.data.stage === 'error') return this.identify()
      if (this.data.stage !== 'setup' || !this._bootstrapResult) return
      const form = event && event.detail && event.detail.value
      if (form && typeof form.nickname === 'string') this.bindNickname({ detail: { value: form.nickname } })
      const nickname = String(this.data.nickname || '').trim()
      if (!nickname || Array.from(nickname).length > profilePresentation.NICKNAME_MAX_LENGTH) {
        this.setData({ errorMessage: '昵称需填写 1～6 个字' })
        return
      }
      const isCurrent = this.captureAttempt()
      this._profileRequestId = this._profileRequestId || api.createRequestId()
      this.setData({ submitting: true, errorMessage: '' })
      return api.initializeProfileAfterConsent({ requestId: this._profileRequestId, nickname }).then(result => {
        if (isCurrent()) return this.finish(this._bootstrapResult, result.nickname, isCurrent)
      }).catch(error => {
        if (!isCurrent()) return
        // 另一设备已完成首次资料时，恢复服务端资料，不覆盖它。
        if (error.code === 'CONFLICT') return api.identifyWechatAccount().then(result => {
          if (!isCurrent()) return
          if (result.nickname) return this.finish(result, result.nickname, isCurrent)
          throw error
        })
        throw error
      }).catch(error => {
        if (isCurrent()) this.setData({ submitting: false,
          errorMessage: error.message || '资料保存失败，请重试' })
      })
    }
  }
})
