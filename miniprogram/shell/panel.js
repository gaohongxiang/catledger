const theme = require('../theme/service')
const { resolveTab } = require('./tabs')

// onReachBottom 既可能是滚动触底（由 reachPanelBottom 调），也可能是内容里的“加载更多”按钮 tap；
// 两者都应可调用，故不排除，作为普通 method 保留。
const lifecycleKeys = new Set(['onLoad', 'onShow', 'onHide', 'onUnload', 'onReady', 'onPullDownRefresh', 'onPageScroll'])
function call(definition, name, instance, argument) {
  if (typeof definition[name] === 'function') return definition[name].call(instance, argument)
}

// 组件只拥有内容和业务状态。宿主独占可见生命周期、窗口与导航。
function panel(id, definition) {
  const methods = {}
  Object.keys(definition).forEach(key => {
    if (typeof definition[key] === 'function' && !lifecycleKeys.has(key)) methods[key] = definition[key]
  })
  return theme.component({
    options: { styleIsolation: 'apply-shared' },
    data: Object.assign({}, definition.data, { panelReady: false, panelVisible: false, panelRefreshing: false, panelRefreshEnabled: typeof definition.onPullDownRefresh === 'function' }),
    lifetimes: {
      attached: function () {
        this._panelActive = false
        // 就绪门与当前主题在同一次渲染更新提交，注册时的旧主题不进入可见内容。
        this.setData(Object.assign({}, theme.currentPresentation(), { panelReady: true }), () => {
          if (!this._panelDisposed) this.triggerEvent('panelready', { id })
        })
      },
      detached: function () {
        this.deactivate()
        this._panelDisposed = true
        call(definition, 'onUnload', this)
        this._host = null
      }
    },
    methods: Object.assign(methods, {
      connectHost: function (host) {
        if (this._host || this._panelDisposed) return
        this._host = host
        this.route = resolveTab(id).route
        // 传入宿主为该二级面板保存的进入参数（如 loanId/accountId），否则空对象。
        call(definition, 'onLoad', this, (this._host.subpageParams && this._host.subpageParams(id)) || {})
        call(definition, 'onReady', this)
      },
      activate: function () {
        if (this._panelActive || this._panelDisposed || !this._host) return
        this._panelActive = true
        return this.onShow()
      },
      deactivate: function () {
        if (!this._panelActive) return
        this._panelActive = false
        this._panelActivation = null
        this.setData({ panelVisible: false })
        call(definition, 'onHide', this)
      },
      onShow: function () {
        if (!this._panelActive || this._panelDisposed) return
        const activation = {}
        this._panelActivation = activation
        this.setData({ panelVisible: false })
        const result = call(definition, 'onShow', this)
        // 先提交业务同步清屏，再开放缓存面板；不能依赖父子 setData 跨组件原子呈现。
        this.setData({}, () => {
          if (this._panelActive && !this._panelDisposed && this._panelActivation === activation) this.setData({ panelVisible: true })
        })
        return result
      },
      getTabBar: function () { return this._host && this._host.getTabBar() },
      requestLogin: function (afterLogin) {
        const bar = this.getTabBar()
        if (this._panelActive && bar) bar.requestLogin({ afterLogin })
      },
      refreshPanel: function () {
        if (!this._panelActive || this.data.panelRefreshing) return
        this.setData({ panelRefreshing: true })
        return call(definition, 'onPullDownRefresh', this)
      },
      stopPullDownRefresh: function () { this.setData({ panelRefreshing: false }) },
      reachPanelBottom: function () {
        if (this._panelActive) return call(definition, 'onReachBottom', this)
      }
    })
  })
}

module.exports = { panel }
