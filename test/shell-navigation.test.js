const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { runtime } = require('./helpers/read-runtime')

function instance(definition, component) {
  const target = Object.assign({}, component ? definition.methods : definition, {
    data: JSON.parse(JSON.stringify(definition.data)), patches: [],
    setData(patch, done) {
      this.patches.push(JSON.parse(JSON.stringify(patch)))
      for (const [key, value] of Object.entries(patch)) {
        const keys = key.split('.'); let current = this.data
        for (const part of keys.slice(0, -1)) current = current[part] || (current[part] = {})
        current[keys[keys.length - 1]] = value
      }
      if (done) done.call(this)
    }
  })
  return target
}

function fixture() {
  const h = runtime(new Map([['catledger_theme_v1', 'navy-ledger']]), { realTheme: true })
  const host = instance(h.load('shell/host').createHost())
  host.route = 'shell/index'
  const nodes = new Map()
  const bar = { data: {}, setData(patch) { Object.assign(this.data, patch) }, closeEntry() {} }
  nodes.set('#main-tabs', bar)
  host.selectComponent = selector => nodes.get(selector)
  h.currentPages = [host]
  host.onLoad({})
  host.onShow()
  function mount(id, business) {
    const definition = h.load('shell/panel').panel(id, business)
    const component = instance(definition, true)
    component.triggerEvent = (event, detail) => host.registerPanel({ detail })
    nodes.set('#panel-' + id, component)
    definition.lifetimes.attached.call(component)
    return { component, definition }
  }
  return { h, host, bar, mount }
}

test('首次切四个主Tab复用同一宿主与底栏，已挂载面板状态保留且只激活当前面板', () => {
  const { host, bar, mount } = fixture()
  const log = []
  const business = id => ({ data: { filter: '' }, onLoad() { log.push(id + ':load') },
    onShow() { log.push(id + ':show') }, onHide() { log.push(id + ':hide') } })
  const home = mount('home', business('home')).component
  home.setData({ filter: 'preserve' })
  for (const id of ['transactions', 'statistics', 'profile']) {
    host.selectTab(id)
    mount(id, business(id))
    assert.equal(host.activePanel().route, 'pages/' + id + '/index')
    assert.equal(host.getTabBar(), bar)
    assert.equal(Object.values(host._panels).filter(panel => panel._panelActive).length, 1)
  }
  host.selectTab('home')
  assert.equal(host.activePanel(), home)
  assert.equal(home.data.filter, 'preserve')
  assert.equal(log.filter(item => item === 'home:load').length, 1)
  assert.equal(log.filter(item => item === 'home:show').length, 2)
})

// 标题跟 activeTab 一起进 data，由 <navigation-bar title> 声明：切 Tab 时标题与内容同帧。
// 用 wx.setNavigationBarTitle 补的话，切过去会先看到上一个 Tab 的标题一帧。
test('导航标题由 data 声明，与当前 Tab 同批更新', () => {
  const { h, host } = fixture()
  assert.equal(host.data.activeTab, 'home')
  assert.equal(host.data.navTitle, '招财猫记账本')
  const tabs = h.load('shell/tabs').tabs
  for (const tab of tabs) {
    host.selectTab(tab.id)
    assert.equal(host.data.activeTab, tab.id)
    assert.equal(host.data.navTitle, tab.title, tab.id + ' 的标题没有跟着 activeTab 走')
  }
  const markup = require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/shell/index.wxml'), 'utf8')
  assert.match(markup, /<navigation-bar title="\{\{navTitle\}\}"/, '外壳没有声明式地绑定标题')
  assert.doesNotMatch(require('node:fs').readFileSync(require('node:path').join(__dirname, '../miniprogram/shell/host.js'), 'utf8'), /setNavigationBarTitle/, '宿主又调回运行时标题接口了')
})

test('从详情跳另一Tab只在返回后激活目标一次，宿主隐藏时新组件不读取业务', () => {
  const { h, host, mount } = fixture()
  const calls = []
  mount('home', { data: {}, onShow() { calls.push('home') } })
  host.selectTab('statistics')
  mount('statistics', { data: {}, onShow() { calls.push('statistics') } })
  host.selectTab('home')
  calls.length = 0
  host.onHide()
  h.currentPages = [host, { route: 'pages/theme/index' }]
  h.load('shell/router').openTab('statistics')
  assert.equal(host.pendingTab, 'statistics')
  assert.deepEqual(calls, [])
  h.currentPages = [host]
  host.onShow()
  assert.deepEqual(calls, ['statistics'])
  host.onHide()
  host.selectTab('profile')
  const hidden = mount('profile', { data: {}, onShow() { calls.push('hidden') } }).component
  hidden.onShow()
  assert.deepEqual(calls, ['statistics'])
})

test('注册后切主题再首挂载时，就绪门和当前主题同批提交；隐藏面板换色不触发业务show', () => {
  const { h, host, mount } = fixture()
  let shows = 0
  const definition = h.load('shell/panel').panel('home', { data: {}, onShow() { shows++ } })
  const service = h.load('theme/service')
  for (const theme of h.load('theme/registry').listThemes()) {
    service.selectTheme(theme.id)
    const component = instance(definition, true)
    component.triggerEvent = () => {}
    definition.lifetimes.attached.call(component)
    const ready = component.patches.find(patch => patch.panelReady)
    assert.equal(ready.themeId, theme.id)
    assert.equal(shows, 0)
    definition.lifetimes.detached.call(component)
  }
  const home = mount('home', { data: {}, onShow() { shows++ } }).component
  host.onHide()
  service.selectTheme('navy-ledger')
  home.onShow()
  assert.equal(shows, 1)
})

test('下拉刷新按所属面板结束，迟到结果不停止另一个面板的刷新；隐藏面板不触底加载', () => {
  const { host, mount } = fixture()
  let more = 0
  const business = { data: {}, onPullDownRefresh() {}, onReachBottom() { more++ } }
  const home = mount('home', business).component
  home.refreshPanel()
  host.selectTab('transactions')
  const transactions = mount('transactions', business).component
  transactions.refreshPanel()
  home.stopPullDownRefresh()
  assert.equal(home.data.panelRefreshing, false)
  assert.equal(transactions.data.panelRefreshing, true)
  home.reachPanelBottom()
  transactions.reachPanelBottom()
  assert.equal(more, 1)
})

test('主导航没有原生tab窗口；四旧路由只兼容跳转，滚动容器不会随切换销毁', () => {
  const app = JSON.parse(fs.readFileSync('miniprogram/app.json'))
  assert.equal(app.pages[0], 'shell/index')
  assert.equal(app.tabBar, undefined)
  const markup = fs.readFileSync('miniprogram/shell/index.wxml', 'utf8')
  for (const id of ['home', 'transactions', 'statistics', 'profile']) {
    assert.ok(markup.includes('wx:if="{{mounted.' + id + '}}"'))
    assert.ok(markup.includes("hidden=\"{{activeTab !== '" + id + "'}}\""))
  }
  assert.doesNotMatch(markup, /wx:if="{{activeTab/)
  const { h } = fixture()
  h.currentPages = [{ route: 'pages/profile/index' }]
  h.load('shell/router').legacyPage('profile').onLoad({})
  assert.deepEqual(h.navigation, ['/shell/index?tab=profile'])
})

test('自动登录迟到通知只刷新可见面板，不伪造宿主onShow', () => {
  const { h, host, mount } = fixture()
  let shows = 0
  const home = mount('home', { data: {}, onShow() { shows++ } }).component
  const sheet = h.load('components/login-sheet/index')
  const login = Object.assign({}, sheet.methods)
  host.onHide()
  login.notifyLoginChange()
  assert.equal(host._shellVisible, false)
  assert.equal(home._panelActive, false)
  assert.equal(shows, 1)
  host.onShow()
  sheet.pageLifetimes.hide.call(login)
  login.notifyLoginChange()
  assert.equal(shows, 2)
  login._pageVisible = true
  login.notifyLoginChange()
  assert.equal(shows, 3)
})

test('子组件先就绪再触发宿主onLoad时保留注册，卸载后忽略迟到就绪事件', () => {
  const h = runtime()
  const host = instance(h.load('shell/host').createHost())
  let active = 0
  const panel = { connectHost() {}, activate() { active++ }, deactivate() {} }
  host.selectComponent = selector => selector === '#panel-home' ? panel : null
  host.registerPanel({ detail: { id: 'home' } })
  host.onLoad({})
  host.onShow()
  assert.equal(host.activePanel(), panel)
  assert.equal(active, 1)
  host.onUnload()
  host.registerPanel({ detail: { id: 'home' } })
  assert.equal(host.activePanel(), undefined)
})

test('缓存面板先清理旧会话再开放显示，快速切走后迟到渲染回调不能重新开放', () => {
  const { h } = fixture()
  let owner = '甲'
  const definition = h.load('shell/panel').panel('profile', {
    data: { owner: '' }, onShow() { this.setData({ owner }) }
  })
  const component = instance(definition, true)
  component.triggerEvent = () => {}
  definition.lifetimes.attached.call(component)
  component.connectHost({ getTabBar: () => null })
  component.activate()
  assert.equal(component.data.panelVisible, true)
  component.deactivate()
  owner = '乙'
  const commits = []
  const setData = component.setData
  component.setData = function (patch, done) {
    setData.call(this, patch)
    if (done) commits.push(done)
  }
  component.activate()
  assert.equal(component.data.owner, '乙')
  assert.equal(component.data.panelVisible, false, '业务同步清屏未确认渲染前不能显示')
  component.deactivate()
  commits.shift()()
  assert.equal(component.data.panelVisible, false, '迟到回调不能重新开放隐藏面板')
  component.activate()
  commits.shift()()
  assert.equal(component.data.panelVisible, true)
  assert.equal(component.data.owner, '乙')
})
