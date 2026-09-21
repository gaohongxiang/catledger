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
  assert.match(markup, /净资产/)
  assert.doesNotMatch(markup, /总资产|人民币净值|资产减去负债/)
  for (const key of ['netWorthText', 'incomeText', 'expenseText', 'netIncomeText', 'displayAvatarUrl']) {
    assert.ok(key === 'displayAvatarUrl' ? markup.includes('{{' + key + '}}') : markup.includes("{{loggedIn && hasDashboard ? " + key + " : '—'}}"), key)
  }
  assert.match(markup, /item\.balanceText/)
  assert.match(markup, /item\.amountText/)
})

test('标题使用中等字重和自然字距，不缩小正文来伪造清秀', () => {
  assert.match(rule('.home-title'), /font-weight:\s*500/)
  assert.match(rule('.home-title'), /letter-spacing:\s*0/)
  assert.match(rule('.account-name'), /font-size:\s*var\(--font-body, 28rpx\)/)
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
  for (const selector of ['.month-stat']) {
    const declarations = rule(selector)
    assert.match(declarations, /--home-surface/)
    assert.doesNotMatch(declarations, /accent-soft|surface-muted/)
  }
})

test('首页卡片节奏：账户卡浅驼底无边框，最近账目为发丝线列表', () => {
  assert.match(rule('.account-list'), /background:\s*var\(--home-surface-muted/)
  assert.match(rule('.account-list'), /border:\s*0/)
  assert.match(rule('.timeline'), /background:\s*transparent/)
  assert.match(rule('.timeline'), /border-top:\s*1rpx solid var\(--home-line/)
  assert.match(rule('.timeline'), /border-bottom:\s*1rpx solid var\(--home-line/)
  assert.match(rule('.timeline'), /box-shadow:\s*none/)
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
  const chart = markup.slice(markup.indexOf('class="trend-chart"'), markup.indexOf('trend-guide'))
  assert.doesNotMatch(chart, /style="height:\s*\d+(?:rpx|px|%)/, '真实趋势图不写死柱高')
  assert.doesNotMatch(markup, /trend-guide-ghost/, '稀疏引导不放装饰柱')
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

test('底栏轻量样式应用于全部主页面，保留主题及两种记账方式', () => {
  assert.ok(tabMarkup.includes('class="tab-shell {{themeClass}} ui-refined"'))
  for (const handler of ['switchTab', 'openEntry', 'chooseBill', 'openEditor', 'closeEntry']) {
    assert.ok(tabMarkup.includes('bindtap="' + handler + '"'), handler)
  }
  assert.match(tabMarkup, /entryOpen/)
  assert.match(tabMarkup, /选择记账方式/)
  assert.match(tabMarkup, /wx:if="{{!hidden}}"/)
  assert.match(tabStyle, /\.tab-shell\.ui-refined/)
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


test('净值卡文字颜色全部走主题 hero 令牌，不再保留页面级覆盖', () => {
  assert.doesNotMatch(style, /--home-hero-ink|--home-hero-value/)
  assert.match(rule('.net-worth-card'), /color:\s*var\(--theme-hero-ink/)
  assert.match(rule('.net-worth-number'), /color:\s*var\(--theme-hero-value-ink/)
  assert.match(rule('.net-worth-label'), /color:\s*var\(--theme-hero-muted/)
  assert.match(rule('.net-worth-month'), /color:\s*var\(--theme-hero-muted/)
})

test('月度长金额改为纵向摘要，保持原始金额字符串和负号', () => {
  assert.match(markup, /incomeText\.length > 12 \|\| expenseText\.length > 12 \|\| netIncomeText\.length > 12/)
  assert.match(markup, /month-strip-stacked/)
  assert.match(rule('.month-strip-stacked'), /display:\s*block/)
  assert.match(rule('.month-strip-stacked .month-stat'), /justify-content:\s*space-between/)
})

test('首页 hero 大圆角抬升柔影，无水印无卡内趋势', () => {
  assert.match(rule('.net-worth-card'), /border-radius:\s*var\(--theme-radius-xl, 32rpx\)/)
  assert.match(rule('.net-worth-card'), /box-shadow:\s*var\(--theme-shadow-lifted\)/)
  assert.doesNotMatch(style, /--home-shadow\s*:/)
  assert.doesNotMatch(markup, /net-worth-watermark|hero-trend/)
})

test('时段问候移到页头标题之上，月度收支结余小字条留在 hero 底部', () => {
  const source = read('miniprogram/pages/index/index.js')
  assert.match(markup, /class="home-greeting">\{\{todayLabel\}\}/)
  assert.doesNotMatch(markup, /net-worth-greeting/)
  assert.ok(markup.indexOf('class="home-greeting"') < markup.indexOf('class="home-title'), '问候应在主标题之前')
  assert.ok(markup.indexOf('class="home-greeting"') < markup.indexOf('class="net-worth-card"'), '问候不属于净值卡')
  assert.match(source, /if \(!loggedIn\) return '你好'/)
  assert.match(source, /hour >= 6 && hour < 11 \? '早上好'/)
  assert.match(source, /hour >= 11 && hour < 18 \? '下午好'/)
  assert.match(source, /'晚上好'/)
  assert.ok(markup.indexOf('class="net-worth-card"') < markup.indexOf('month-strip'), '统计条应位于 hero 卡内')
  assert.ok(markup.indexOf('month-strip') < markup.indexOf('class="home-flow"'), '统计条应在 home-flow 之前')
  assert.match(rule('.net-worth-card .month-stat'), /background:\s*transparent/)
  assert.match(rule('.net-worth-card .month-stat-value'), /color:\s*var\(--theme-hero-value-ink/)
})
