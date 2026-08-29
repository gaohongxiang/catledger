const cloudbaseConfig = require('./config/cloudbase')

App({
  globalData: {
    cloudAvailable: false
  },

  onLaunch() {
    if (!wx.cloud) {
      console.warn('当前基础库不支持云开发，请升级微信开发者工具或基础库。')
      return
    }

    wx.cloud.init({
      env: cloudbaseConfig.envId,
      traceUser: true
    })

    this.globalData.cloudAvailable = true
  }
})
