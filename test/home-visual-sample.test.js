const test = require('node:test')
const assert = require('node:assert/strict')
const { readSource } = require('./helpers/source-files')
const path = require('node:path')
const read = (p) => readSource(path.join(__dirname, '..', p))
const style = read('miniprogram/pages/index/index.wxss')
const markup = read('miniprogram/pages/index/panel.wxml')
const tabStyle = read('miniprogram/custom-tab-bar/index.wxss')
const tabMarkup = read('miniprogram/custom-tab-bar/index.wxml')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = style.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少样式规则：' + selector)
  return match[1]
}

test('首页样板保留净值口径、资产与负债两侧总额和用户头像', () => {
  assert.match(markup, /净资产/)
  assert.match(markup, /\{\{loggedIn && hasDashboard \? netWorthText : '—'\}\}/)
  assert.equal((markup.match(/<template is="net-worth-mix"/g) || []).length, 1, '两行共用一次网格渲染')
  assert.match(markup, /data="\{\{assets: assetShares, assetsText: assetsText, liabilities: liabilityShares, liabilitiesText: liabilitiesText\}\}"/)
  assert.match(markup, /\{\{displayAvatarUrl\}\}/)
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
  for (const selector of ['.net-worth-number', '.mix-total', '.account-balance', '.timeline-amount']) {
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

test('净值卡渐变只从主题 hero token 取色，不写主题私有覆盖', () => {
  const card = rule('.net-worth-card')
  assert.match(card, /background-image:\s*linear-gradient\([^;]*var\(--theme-hero-start[^;]*var\(--theme-hero-end/)
  assert.equal((style.match(/linear-gradient\(/g) || []).length, 1)
  assert.doesNotMatch(style, /\.home-page\.theme-[\w-]+\s*\{/)
  assert.doesNotMatch(style, /--theme-[\w-]+\s*:/)
  assert.doesNotMatch(style, /@font-face|https?:\/\//)
})

test('净值卡内只有构成条，本月收支搬离首屏', () => {
  assert.doesNotMatch(markup, /month-stat|month-strip|net-worth-columns|本月收支/)
  assert.doesNotMatch(markup, /monthExpenseText|monthIncomeText|monthNetText/)
  // 构成段只是条上的一小块，不再各自长成卡片。
  assert.doesNotMatch(rule('.mix-seg'), /border:\s|box-shadow/)
})

test('首页三个模块共用同一种卡片容器', () => {
  const card = rule('.home-card')
  assert.match(card, /background:\s*var\(--home-surface, var\(--theme-surface/)
  assert.match(card, /border:\s*1rpx solid var\(--home-line/)
  assert.match(card, /border-radius:\s*var\(--theme-radius-large/)
  assert.equal((markup.match(/class="home-card"/g) || []).length, 3, '统计、账户、账目各一张卡')
  // 净值卡不在 .home-flow 里，靠自己的左右外边距补上同一条内缩，四张卡左右边缘对齐。
  assert.match(rule('.net-worth-card'), /margin-left:\s*var\(--layout-space-4\)/)
  assert.match(rule('.net-worth-card'), /margin-right:\s*var\(--layout-space-4\)/)
  assert.match(rule('.home-flow'), /padding-left:\s*var\(--layout-space-4\)/)
  // 行不再自带容器，也没有负边距出血：左边缘只有一条内容线。
  assert.doesNotMatch(rule('.account-list'), /background|border|box-shadow/)
  assert.doesNotMatch(rule('.timeline'), /background|border|box-shadow/)
  assert.doesNotMatch(style, /margin:\s*0\s+-20rpx/)
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
  assert.match(markup, /重新读取首页全部数据/)
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
  assert.doesNotMatch(markup, /net-worth-month|monthLabel/)
})

test('净值卡按资产／负债各一行构成：标签、构成条、该侧总额、横滑图例', () => {
  assert.match(markup, /<template name="net-worth-mix">/)
  // 两行共用一套网格：标签、条、该侧总额各占一列，图例跨三列。
  assert.match(markup, /class="mix-label">资产</)
  assert.match(markup, /class="mix-label">负债</)
  assert.match(markup, /class="mix-track">/)
  assert.match(markup, /class="mix-total money-number[^"]*">\{\{assetsText\}\}/)
  assert.match(markup, /class="mix-total money-number[^"]*">\{\{liabilitiesText\}\}/)
  assert.match(rule('.mix-grid'), /display:\s*grid/)
  assert.match(rule('.mix-grid'), /grid-template-columns:\s*auto minmax\(120rpx, 1fr\) auto/)
  // 图例横滑：账目变多时条封顶 6 段，图例靠滑动看全。
  assert.match(markup, /class="mix-legend-scroll" scroll-x="\{\{true\}\}"/)
  assert.match(markup, /wx:for="\{\{assets\.items\}\}" wx:key="accountId"/)
  assert.match(markup, /wx:for="\{\{liabilities\.bar\}\}"/)
  assert.match(rule('.mix-legend-scroll'), /grid-column:\s*1 \/ -1/)
  assert.match(rule('.mix-seg'), /background:\s*var\(--theme-hero-value-ink/)
  assert.match(rule('.mix-total'), /color:\s*var\(--theme-hero-value-ink/)
  // 金额列不再写死宽度：由两条金额里更长的那条撑开，右对齐；空侧居中。
  assert.doesNotMatch(rule('.mix-total'), /(?:^|;)\s*width:\s*\d/)
  assert.match(rule('.mix-total'), /text-align:\s*right/)
  assert.match(rule('.mix-total-empty'), /text-align:\s*center/)
  assert.match(markup, /\{\{assets\.empty \? 'mix-total-empty' : ''\}\}/)
  assert.match(markup, /\{\{liabilities\.empty \? 'mix-total-empty' : ''\}\}/)
  // 图例只是条的注释，比标签和金额低一档。
  assert.match(rule('.mix-label'), /font-size:\s*var\(--font-caption/)
  assert.match(rule('.mix-legend-text'), /font-size:\s*22rpx/)
  assert.doesNotMatch(markup, /累计收入|累计支出|month-strip/)
})

test('账面日期写成「最后一笔」，空数据时不出现这一行', () => {
  const source = read('miniprogram/pages/index/page.js')
  assert.match(markup, /wx:if="\{\{loggedIn && hasDashboard && asOfText\}\}"[^>]*>最后一笔 \{\{asOfText\}\}/)
  assert.doesNotMatch(markup, /数据截至/, '别把账面日期写成导入日期')
  assert.match(source, /function asOfLabel\(transactions\)/)
  assert.match(source, /first && first\.occurredLocalAt/)
  assert.match(source, /\^\\d\{4\}-\(\\d\{2\}\)-\(\\d\{2\}\)/)
})

test('首页提醒行只在有事时出现在净值卡下面，两条各自去自己的工作台', () => {
  assert.match(markup, /class="home-alerts home-content-line"/)
  assert.match(markup, /wx:if="\{\{loggedIn && \(alertImportText \|\| alertDueText\)\}\}"/)
  assert.match(markup, /bindtap="openImport"[^>]*aria-label="\{\{alertImportText\}\}，去导入工作台核对"/)
  assert.match(markup, /bindtap="openLoans"[^>]*aria-label="\{\{alertDueText\}\}，查看贷款计划"/)
  assert.ok(markup.indexOf('class="home-alerts') > markup.indexOf('class="net-worth-card'), '提醒跟在净值卡之后')
  assert.ok(markup.indexOf('class="home-alerts') < markup.indexOf('class="home-flow'), '提醒不混进模块卡')
  assert.match(rule('.home-alerts'), /flex-direction:\s*column/)
  assert.match(rule('.home-alert-text'), /flex:\s*1 1 auto/, '文字吃掉剩余宽度，动作词贴右')
  assert.match(rule('.home-alert'), /width:\s*100%/)
  assert.match(rule('.home-alert-text'), /text-overflow:\s*ellipsis/)
  assert.match(rule('.home-alert-dot-review'), /var\(--theme-accent/)
  // 待还是常规义务，用警示色；红色留给逾期与读取失败。
  assert.match(rule('.home-alert-dot-due'), /var\(--theme-warning/)
  assert.match(rule('.home-alert-figure'), /var\(--theme-accent-strong/)
  assert.match(rule('.home-alert-due .home-alert-figure'), /var\(--theme-warning/)
  assert.match(markup, /wx:for="\{\{alertImportParts\}\}"/)
  assert.match(markup, /wx:for="\{\{alertDueParts\}\}"/)
  assert.match(markup, /home-alert-action">去核对 ›/, '动作词带箭头，读得出可点')
})

test('首页 hero 大圆角抬升柔影，无水印无卡内趋势', () => {
  assert.match(rule('.net-worth-card'), /border-radius:\s*var\(--theme-radius-xl, 32rpx\)/)
  assert.match(rule('.net-worth-card'), /box-shadow:\s*var\(--theme-shadow-lifted\)/)
  assert.doesNotMatch(style, /--home-shadow\s*:/)
  assert.doesNotMatch(markup, /net-worth-watermark|hero-trend/)
})

test('时段问候移到页头标题之上，构成条留在 hero 卡内', () => {
  const source = read('miniprogram/pages/index/page.js')
  assert.match(markup, /class="home-greeting">\{\{todayLabel\}\}/)
  assert.doesNotMatch(markup, /net-worth-greeting/)
  assert.ok(markup.indexOf('class="home-greeting"') < markup.indexOf('class="home-title'), '问候应在主标题之前')
  assert.ok(markup.indexOf('class="home-greeting"') < markup.indexOf('class="net-worth-card"'), '问候不属于净值卡')
  assert.match(source, /if \(!loggedIn\) return '你好'/)
  assert.match(source, /hour >= 6 && hour < 11 \? '早上好'/)
  assert.match(source, /hour >= 11 && hour < 18 \? '下午好'/)
  assert.match(source, /'晚上好'/)
  const hero = markup.slice(markup.indexOf('class="net-worth-card"'), markup.indexOf('class="home-flow"'))
  assert.match(hero, /<template is="net-worth-mix"/, '构成条应位于 hero 卡内')
  assert.match(hero, /asOfText/, '最后一笔应位于 hero 卡内')
  assert.ok(hero.indexOf('net-worth-number') < hero.indexOf('<template is="net-worth-mix"'), '净资产在构成条之上')
  assert.match(rule('.mix-label'), /color:\s*var\(--theme-hero-muted/)
  assert.match(rule('.mix-legend-text'), /color:\s*var\(--theme-hero-muted/)
})
