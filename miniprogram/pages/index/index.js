const app = getApp()

Page({
  data: {
    checking: false,
    cloudAvailable: false,
    connectionState: '未检查'
  },

  onLoad() {
    const cloudAvailable = app.globalData.cloudAvailable

    this.setData({
      cloudAvailable,
      connectionState: cloudAvailable ? '未检查' : '当前基础库不支持云开发'
    })
  },

  async checkCloudConnection() {
    if (!this.data.cloudAvailable || this.data.checking) {
      return
    }

    this.setData({
      checking: true,
      connectionState: '检查中'
    })

    try {
      const response = await wx.cloud.callFunction({
        name: 'catledger-api',
        data: {
          action: 'health'
        }
      })
      const connected = response.result && response.result.ok === true

      this.setData({
        connectionState: connected ? '云开发已连接' : '云函数响应异常'
      })
    } catch (error) {
      console.warn('云开发连接检查失败，请确认环境和云函数已经配置。')
      this.setData({
        connectionState: '尚未配置云环境'
      })
    } finally {
      this.setData({
        checking: false
      })
    }
  }
})
