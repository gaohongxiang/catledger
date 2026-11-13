const app = getApp()
const themeService = require('../theme/service')
const { tabs: mainTabs, visualKey } = require('../shell/tabs')
const api = require('../services/catledger-api')

Component(themeService.component({
  data: {
    hidden: false,
    entryOpen: false,
    // activeKey：底栏高亮的唯一事实源（字符串 key，不是数组下标）。高亮 = item.key === activeKey。
    activeKey: 'home',
    // 底部四个可视位左右各两位，纯静态定义（不含 active 状态）。
    // 左：首页(key=home)、明细·统计(key=records)；右：账户·分类(key=accounts)、我的(key=profile)。
    tabsLeft: [
      { key: 'home', text: '首页', kind: 'single', tabId: 'home', iconPath: 'tab-home.svg', selectedIconPath: 'tab-home-active.svg' },
      { key: 'records', text: '明细·统计', kind: 'records', iconPath: 'tab-list.svg', selectedIconPath: 'tab-list-active.svg' }
    ],
    tabsRight: [
      { key: 'accounts', text: '账户·分类', kind: 'accounts', iconPath: 'tab-wallet.svg', selectedIconPath: 'tab-wallet-active.svg' },
      { key: 'profile', text: '我的', kind: 'single', tabId: 'profile', iconPath: 'tab-user.svg', selectedIconPath: 'tab-user-active.svg' }
    ],
    // 二选一弹层：'' 关闭；'records' 选明细/统计；'accounts' 选账户/分类
    choiceOpen: '',
    accountCount: 0,
    categoryCount: 0,
  },

  lifetimes: {
    attached: function () {
      this.syncSelected()
    }
  },

  pageLifetimes: {
    show: function () { this.syncSelected() },
    hide: function () { this.closeEntry(); this.closeOverlay() }
  },

  methods: {
    // 唯一高亮写入口：接受 key 或旧式数字下标（兼容），统一落到 activeKey。
    setActiveKey: function (keyOrIndex) {
      let key = keyOrIndex
      if (typeof keyOrIndex === 'number') {
        const all = this.data.tabsLeft.concat(this.data.tabsRight)
        const item = all[keyOrIndex]
        key = item ? item.key : ''
      }
      if (key !== this.data.activeKey) this.setData({ activeKey: key })
    },
    // 从宿主 activeTab 派生 activeKey（面板/宿主都不用再直写高亮）。
    syncSelected: function () {
      const pages = getCurrentPages()
      const currentPage = pages[pages.length - 1]
      if (!currentPage || currentPage.route !== 'shell/index') return
      const activeTab = currentPage.data.activeTab
      // 二级页沿用其 parent 的高亮 key；visualKey 一处决定，避免这里重复维护映射。
      const key = visualKey(activeTab)
      if (key && key !== this.data.activeKey) this.setData({ activeKey: key })
    },
    isLoggedIn: function () {
      return app.hasLoginApproval()
    },

    requestLogin: function (options) {
      const pages = getCurrentPages()
      const host = pages[pages.length - 1]
      const panel = host && host.activePanel && host.activePanel()
      const afterLogin = options && options.afterLogin
      const complete = () => {
        if (host && host._shellVisible && panel === host.activePanel()) {
          if (typeof afterLogin === 'function') afterLogin()
        }
      }
      if (this.isLoggedIn()) {
        complete()
        return
      }
      this.closeEntry()
      const sheet = this.selectComponent('#loginSheet')
      if (sheet && typeof sheet.show === 'function') sheet.show(Object.assign({}, options, { afterLogin: complete }))
    },

    switchTab: function (event) {
      const key = event.currentTarget.dataset.key
      const all = this.data.tabsLeft.concat(this.data.tabsRight)
      const tab = all.find(t => t.key === key)
      if (!tab) return
      if (tab.kind === 'single') {
        if (tab.key === this.data.activeKey) return
        this.closeEntry()
        this.triggerEvent('tabchange', { id: tab.tabId })
        return
      }
      // 合并位：弹出二选一菜单（records/accounts）
      this.closeEntry()
      if (tab.kind === 'accounts') this.refreshCounts()
      this.setData({ choiceOpen: tab.kind })
    },

    // 从已有缓存读账户/分类数量（不额外请求）；缓存缺失则保持上一次值/0。
    refreshCounts: function () {
      // 先从缓存读（免费）；缺什么再用轻量 catalog.get 补拉一次（它本身就带 accounts+categories）。
      try {
        const accounts = api.peek('accounts.list')
        const catalog = api.peek('catalog.get')
        if (accounts && Array.isArray(accounts.accounts)) this.setData({ accountCount: accounts.accounts.filter(a => !a.archived).length })
        if (catalog && Array.isArray(catalog.categories)) {
          this.setData({ categoryCount: catalog.categories.length,
            accountCount: Array.isArray(catalog.accounts) ? catalog.accounts.filter(a => !a.archived).length : this.data.accountCount })
          return
        }
        // 缓存不全：补拉一次 catalog.get（走缓存接口，不额外压后端）。
        const self = this
        api.callApi('catalog.get', {}).then(function (result) {
          if (!result || !Array.isArray(result.categories)) return
          self.setData({
            categoryCount: result.categories.length,
            accountCount: Array.isArray(result.accounts) ? result.accounts.filter(a => !a.archived).length : self.data.accountCount
          })
        }).catch(function () { /* 数量仅辅助展示，失败静默 */ })
      } catch (_) { /* 数量仅辅助展示，失败不影响菜单 */ }
    },

    closeChoice: function () { if (this.data.choiceOpen) this.setData({ choiceOpen: '' }) },
    keepChoiceOpen: function () {},

    // 「明细·统计」二选一
    chooseRecords: function (event) {
      const id = event.currentTarget.dataset.id === 'statistics' ? 'statistics' : 'transactions'
      this.setData({ choiceOpen: '' })
      this.triggerEvent('tabchange', { id })
    },

    // 「账户·分类」二选一：切到宿主内的账户/分类面板（与明细·统计同一机制，底栏常驻）。
    chooseAccounts: function (event) {
      const id = event.currentTarget.dataset.id === 'categories' ? 'categories' : 'accounts'
      this.setData({ choiceOpen: '' })
      this.triggerEvent('tabchange', { id })
    },

    openEntry: function () {
      if (!this._openingPage) this.setData({ entryOpen: true })
    },

    closeEntry: function () {
      this.setData({ entryOpen: false, choiceOpen: '' })
    },

    keepEntryOpen: function () {},

    chooseBill: function () {
      this.openEntryPage('/packages/finance/pages/import-workbench/index', '暂时无法打开导入，请重试')
    },

    openEditor: function () {
      this.openEntryPage('/pages/transaction-editor/index', '暂时无法打开记账，请重试')
    },

    openEntryPage: function (url, failureMessage) {
      if (this._openingPage) return
      this.closeEntry()
      if (!this.isLoggedIn()) {
        this.requestLogin({ afterLogin: () => this.openEntryPage(url, failureMessage) })
        return
      }
      this._openingPage = true
      wx.navigateTo({
        url,
        fail: () => wx.showToast({ title: failureMessage, icon: 'none' }),
        complete: () => { this._openingPage = false }
      })
    }
  }
}))
