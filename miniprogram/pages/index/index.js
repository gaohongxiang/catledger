const app = getApp()

Page({
  data: {
    initializing: false,
    cloudAvailable: false,
    initializationState: '准备中',
    categoryCount: 0
  },

  onLoad() {
    const cloudAvailable = app.globalData.cloudAvailable

    this.setData({
      cloudAvailable,
      initializationState: cloudAvailable ? '准备中' : '当前基础库不支持云开发'
    })

    if (cloudAvailable) {
      this.initializeLedger()
    }
  },

  async initializeLedger() {
    if (!this.data.cloudAvailable || this.data.initializing) {
      return
    }

    this.setData({
      initializing: true,
      initializationState: '正在准备你的账本'
    })

    try {
      const response = await wx.cloud.callFunction({
        name: 'catledger-api',
        data: {
          action: 'bootstrap'
        }
      })
      const result = response.result

      if (!result || result.ok !== true) {
        const code = result && result.error && result.error.code
        this.setData({
          initializationState: code === 'SERVICE_NOT_CONFIGURED'
            ? '猫账数据库尚未配置'
            : '初始化失败，请稍后重试'
        })
        return
      }

      const categories = Array.isArray(result.data.categories)
        ? result.data.categories
        : []
      this.setData({
        initializationState: '账本已准备好',
        categoryCount: categories.length
      })
    } catch (error) {
      console.warn('账本初始化失败，请确认云环境、云函数和数据库已经配置。')
      this.setData({
        initializationState: '尚未配置完整云环境'
      })
    } finally {
      this.setData({
        initializing: false
      })
    }
  }
})
