const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const style = read('miniprogram/pages/index/index.wxss')
const markup = read('miniprogram/pages/index/index.wxml')
const tabStyle = read('miniprogram/custom-tab-bar/index.wxss')
const tabMarkup = read('miniprogram/custom-tab-bar/index.wxml')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = style.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少样式规则：' + selector)
  return match[1]
}

test('首页样板保留净值口径、五项金额绑定和用户头像', () => {
  assert.match(markup, /人民币净值/)
  assert.doesNotMatch(markup, /总资产/)
  for (const key of ['netWorthText', 'incomeText', 'expenseText', 'netIncomeText', 'displayAvatarUrl']) {
    assert.ok(markup.includes('{{' + key + '}}'), key)
  }
  assert.match(markup, /item\.balanceText/)
  assert.match(markup, /item\.amountText/)
})

test('标题使用中等字重和自然字距，不缩小正文来伪造清秀', () => {
  assert.match(rule('.home-title'), /font-weight:\s*500/)
  assert.match(rule('.home-title'), /letter-spacing:\s*0/)
  assert.match(rule('.account-name'), /font-size:\s*28rpx/)
  assert.match(rule('.account-name'), /font-weight:\s*400/)
})

test('金额不省略、不裁掉负号，极长数值允许换行', () => {
  for (const selector of ['.net-worth-number', '.month-stat-value', '.account-balance', '.timeline-amount']) {
    const declarations = rule(selector)
    assert.doesNotMatch(declarations, /text-overflow:\s*ellipsis|overflow:\s*hidden/)
    assert.match(declarations, /overflow-wrap:\s*anywhere/)
  }
})

test('首页数字不继续使用窄体 DIN Alternate 或负字距', () => {
  const body = rule('.home-page .money-number')
  assert.doesNotMatch(body, /DIN|letter-spacing:\s*-/)
  assert.match(body, /font-variant-numeric:\s*tabular-nums/)
})

test('暖橘渐变限定在首页主题变量，不污染其他主题和页面', () => {
  assert.match(style, /\.home-page\.theme-warm-ledger\s*\{/)
  const warm = rule('.home-page.theme-warm-ledger')
  assert.match(warm, /--home-hero-image:\s*linear-gradient/)
  assert.equal((style.match(/linear-gradient\(/g) || []).length, 1)
  assert.match(rule('.net-worth-card'), /background-image:\s*var\(--home-hero-image, none\)/)
  assert.doesNotMatch(style, /--theme-[\w-]+\s*:/)
  assert.doesNotMatch(style, /@font-face|https?:\/\//)
})

test('普通卡片使用 surface，不用浅橘填满所有内容', () => {
  for (const selector of ['.month-stat', '.account-list', '.timeline']) {
    const declarations = rule(selector)
    assert.match(declarations, /--home-surface/)
    assert.doesNotMatch(declarations, /accent-soft|surface-muted/)
  }
})

test('入口保留原事件，查看统计/账户/明细与原交易编辑可达', () => {
  for (const handler of ['openStatistics', 'openAccounts', 'openTransactions', 'editTransaction', 'loadDashboard', 'promptWechatLogin']) {
    assert.ok(markup.includes('bindtap="' + handler + '"'), handler)
  }
  assert.match(markup, /data-index="{{index}}"/)
  assert.match(markup, /wx:key="transactionId"/)
})

test('图表依然直接使用服务端转换后的比例，不写死示例柱高', () => {
  assert.match(markup, /height: {{item\.incomeHeight}}%/)
  assert.match(markup, /height: {{item\.expenseHeight}}%/)
  assert.match(markup, /cashFlowTrend.length > 0/)
  assert.doesNotMatch(markup, /style="height:\s*\d+(?:rpx|px|%)/)
})

test('未登录/空数据/更新/失败分支继续存在', () => {
  for (const expression of ['!cloudAvailable', '!loggedIn', 'loading', 'trendReady', 'errorMessage', 'accounts.length > 0', 'hasDashboard', 'recentTransactions.length > 0']) {
    assert.ok(markup.includes(expression), expression)
  }
  assert.match(markup, /数据同步失败，点击重试/)
})

test('首页不隐藏账户方向和来源时间', () => {
  assert.match(markup, /item\.directionText/)
  assert.match(markup, /item\.accountLine/)
  assert.match(markup, /item\.timeText/)
  assert.doesNotMatch(rule('.account-direction'), /display:\s*none/)
})

test('底栏样板仅随首页选中状态开启，保留主题和现有点击行为', () => {
  assert.ok(tabMarkup.includes("selected === 0 ? 'home-visual-sample' : ''"))
  for (const handler of ['openEntry', 'switchTab', 'chooseBill', 'openEditor', 'closeEntry']) {
    assert.ok(tabMarkup.includes('bindtap="' + handler + '"'), handler)
  }
  assert.match(tabMarkup, /wx:if="{{!hidden}}"/)
  assert.match(tabStyle, /\.tab-shell\.home-visual-sample/)
})

test('账户/账目/主要入口保留触控空间和底部安全区', () => {
  assert.match(rule('.account-row'), /min-height:\s*96rpx/)
  assert.match(rule('.timeline-item'), /min-height:\s*104rpx/)
  assert.match(rule('.section-link'), /min-height:\s*88rpx/)
  assert.match(tabStyle, /min-height:\s*88rpx/)
  assert.match(tabStyle, /env\(safe-area-inset-bottom\)/)
})

test('系统减少动态效果时刷新不旋转，但状态仍可见', () => {
  assert.match(style, /@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  assert.match(style, /animation:\s*none/)
  assert.match(rule('.dashboard-refresh-spinning'), /opacity:\s*1/)
})


test('月度长金额改为纵向摘要，保持原始金额字符串和负号', () => {
  assert.match(markup, /incomeText\.length > 12 \|\| expenseText\.length > 12 \|\| netIncomeText\.length > 12/)
  assert.match(markup, /month-strip-stacked/)
  assert.match(rule('.month-strip-stacked'), /display:\s*block/)
  assert.match(rule('.month-strip-stacked .month-stat'), /justify-content:\s*space-between/)
})
