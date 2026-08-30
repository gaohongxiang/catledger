const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('默认视觉使用暖橘纸面而不是黄色渐变', function () {
  const registry = require('../miniprogram/theme/registry')
  const warm = registry.getTheme(registry.DEFAULT_THEME_ID)
  const homeStyle = read('miniprogram/pages/index/index.wxss')

  assert.equal(warm.tokens.accent, '#D97732')
  assert.equal(warm.tokens.heroStart, '#D97732')
  assert.equal(warm.tokens.heroEnd, '#D97732')
  assert.equal(warm.tokens.heroInk, '#29231E')
  assert.equal(warm.tokens.heroValueInk, '#633921')
  assert.doesNotMatch(homeStyle, /linear-gradient/)
})

test('底栏只保留导航和记账入口样式', function () {
  const tabStyle = read('miniprogram/custom-tab-bar/index.wxss')
  const loginStyle = read('miniprogram/components/login-sheet/index.wxss')

  assert.doesNotMatch(tabStyle, /\.login-/)
  assert.match(tabStyle, /min-height:\s*88rpx/)
  assert.match(tabStyle, /env\(safe-area-inset-bottom\)/)
  assert.match(tabStyle, /\.record-entry[\s\S]*width:\s*112rpx[\s\S]*height:\s*134rpx/)
  assert.match(tabStyle, /\.record-fab[\s\S]*width:\s*88rpx[\s\S]*border-radius:\s*999rpx/)
  assert.match(read('miniprogram/custom-tab-bar/index.wxml'), /class="record-label">记账</)
  assert.match(loginStyle, /min-height:\s*88rpx/)
})

test('一级页共享稳定的页面骨架与触控基线', function () {
  const appStyle = read('miniprogram/app.wxss')
  const pages = ['index', 'transactions', 'ledger', 'profile']

  assert.match(appStyle, /--layout-page-gutter:\s*32rpx/)
  assert.match(appStyle, /--layout-touch-min:\s*88rpx/)
  assert.doesNotMatch(appStyle, /linear-gradient/)

  pages.forEach(function (page) {
    const markup = read('miniprogram/pages/' + page + '/index.wxml')
    assert.match(markup, /page-canvas/)
  })
})

test('六套主题共享轻量层级且不恢复渐变和硬阴影', function () {
  const registry = require('../miniprogram/theme/registry')
  const sharedStyles = [
    'miniprogram/pages/index/index.wxss',
    'miniprogram/pages/transactions/index.wxss',
    'miniprogram/pages/ledger/index.wxss',
    'miniprogram/pages/profile/index.wxss',
    'miniprogram/pages/theme/index.wxss',
    'miniprogram/custom-tab-bar/index.wxss'
  ].map(read).join('\n')

  registry.listThemes().forEach(function (item) {
    const theme = registry.getTheme(item.id)
    assert.equal(theme.tokens.heroStart, theme.tokens.heroEnd)
    assert.doesNotMatch(theme.tokens.shadowSoft, /\d+rpx\s+\d+rpx\s+0\s/)
    assert.doesNotMatch(theme.tokens.shadowLifted, /\d+rpx\s+\d+rpx\s+0\s/)
  })

  assert.doesNotMatch(sharedStyles, /font-weight:\s*650/)
  assert.doesNotMatch(sharedStyles, /linear-gradient|radial-gradient/)
})

test('首页只保留三条最近账目以避免摘要页重心下坠', function () {
  const homeScript = read('miniprogram/pages/index/index.js')
  const homeStyle = read('miniprogram/pages/index/index.wxss')

  assert.match(homeScript, /HOME_RECENT_LIMIT\s*=\s*3/)
  assert.match(homeScript, /\.slice\(0, HOME_RECENT_LIMIT\)/)
  assert.match(homeStyle, /\.section-title[^}]*font-weight:\s*500/)
  assert.match(homeStyle, /\.timeline-label[^}]*font-weight:\s*400/)
  assert.match(homeStyle, /\.account-empty[^}]*font-size:\s*24rpx/)
  assert.match(homeStyle, /\.recent-empty-title[^}]*font-size:\s*24rpx[^}]*font-weight:\s*400/)
})

test('首页重色摘要与正文使用外框线和内内容线双基线', function () {
  const template = read('miniprogram/pages/index/index.wxml')
  const style = read('miniprogram/pages/index/index.wxss')

  assert.match(template, /class="home-header home-content-line"/)
  assert.match(template, /class="home-flow"/)
  assert.match(style, /\.home-content-line,[\s\S]*\.home-flow[\s\S]*padding-left:\s*20rpx/)
})

test('首页月度摘要直接使用收入绿与支出红', function () {
  const template = read('miniprogram/pages/index/index.wxml')

  assert.match(template, /month-stat-value money-number amount-income/)
  assert.match(template, /month-stat-value money-number amount-expense/)
})

test('我的页不恢复账户设置或账本设置', function () {
  const profile = read('miniprogram/pages/profile/index.wxml')
  assert.doesNotMatch(profile, /账户设置|账本设置/)
  assert.match(profile, />主题</)
  assert.match(profile, />数据与隐私</)
  assert.match(profile, /class="identity-retry"/)
  assert.doesNotMatch(profile, /profile-error|profile-footnote|OpenID、内部用户标识/)
})

test('首页与我的共用同一个头像展示字段', function () {
  const home = read('miniprogram/pages/index/index.wxml')
  const profile = read('miniprogram/pages/profile/index.wxml')

  assert.match(home, /class="home-logo" src="\{\{displayAvatarUrl\}\}"/)
  assert.match(profile, /class="profile-logo" src="\{\{displayAvatarUrl\}\}"/)
  assert.doesNotMatch(profile, /profile-avatar-empty/)
})
