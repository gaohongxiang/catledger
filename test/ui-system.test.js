const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('全页面暖橘表面与强调色分离，仅首页保留局部渐变', function () {
  const registry = require('../miniprogram/theme/registry')
  const warm = registry.getTheme(registry.DEFAULT_THEME_ID)
  const homeStyle = read('miniprogram/pages/index/index.wxss')

  assert.equal(warm.tokens.accent, '#BE5B24')
  assert.equal(warm.tokens.surfaceMuted, '#F1EEE9')
  assert.equal(warm.tokens.accentSoft, '#FCEEE3')
  assert.equal(warm.tokens.heroStart, '#BE5B24')
  assert.equal(warm.tokens.heroEnd, '#BE5B24')
  assert.equal(warm.tokens.heroInk, '#FFFFFF')
  assert.equal(warm.tokens.heroValueInk, '#FFFFFF')
  assert.match(homeStyle, /\.home-page\.theme-warm-ledger\s*\{[^}]*--home-hero-image:\s*linear-gradient/)
  assert.equal((homeStyle.match(/linear-gradient\(/g) || []).length, 1)
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

test('非样板页面保留轻量主题，首页仅有暖橘局部渐变', function () {
  const registry = require('../miniprogram/theme/registry')
  const sharedStyles = [
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
  const homeStyle = read('miniprogram/pages/index/index.wxss')
  const outsideWarmScope = homeStyle.replace(/\.home-page\.theme-warm-ledger\s*\{[^}]*\}/g, '')
  assert.doesNotMatch(outsideWarmScope, /linear-gradient|radial-gradient/)
})

test('退款与其他待整理问题复用同一卡片骨架', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const style = read('miniprogram/pages/import-workbench/index.wxss')
  const pendingStart = template.indexOf('<block wx:if="{{activeReviewStatus === \'pending\'}}">')
  const pendingEnd = template.indexOf('<block wx:elif="{{activeReviewStatus === \'completed\'}}">')
  const pendingMarkup = template.slice(pendingStart, pendingEnd)

  assert.ok(pendingStart >= 0 && pendingEnd > pendingStart)
  assert.doesNotMatch(pendingMarkup, /item\.issueType === 'refund_relation'/)
  assert.doesNotMatch(pendingMarkup, /refund-issue-list|refund-issue-row/)
  assert.match(pendingMarkup, /wx:for="{{item\.issues}}"[\s\S]*class="review-decision-card"/)
  assert.doesNotMatch(style, /\.refund-issue-(?:list|row)/)
})

test('已排除分类由整行展开收起且不保留原生按钮白边', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const style = read('miniprogram/pages/import-workbench/index.wxss')
  const excludedStart = template.indexOf('<block wx:if="{{activeReviewTab === \'review\' && activeReviewStatus === \'excluded\'}}">')
  const excludedEnd = template.indexOf('<block wx:if="{{activeReviewTab === \'review\' && activeReviewStatus === \'duplicate\'}}">', excludedStart)
  const excludedMarkup = template.slice(excludedStart, excludedEnd)

  assert.ok(excludedStart >= 0 && excludedEnd > excludedStart)
  assert.doesNotMatch(excludedMarkup, /<button class="excluded-group-toggle"/)
  assert.match(excludedMarkup, /<view class="excluded-group-toggle"[^>]*bindtap="toggleExcludedGroup"[^>]*aria-role="button"/)
  assert.match(excludedMarkup, /wx:if="{{item\.expanded}}" class="excluded-group-records"/)
  assert.match(style, /\.excluded-group-toggle \{[^}]*width: 100%;[^}]*background: var\(--ui-surface-muted/)
})

test('待整理同层展示原文，保留主记录选择并将确认与证据置于滚动区', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const start = template.indexOf('<scroll-view class="review-editor-body"')
  const end = template.indexOf('<view class="sheet-actions">', start)
  const content = template.slice(start, end)
  assert.ok(start >= 0 && end > start)
  assert.match(content, /template is="record-source-fields"/)
  assert.match(content, /wx:if="[^"]*currentIssue\.issueType === 'category_assignment'[^"]*" class="mapping-fields"/)
  assert.doesNotMatch(content, /bindtap="openEvidence"|bindtap="openIssueEvent"/)
  assert.match(content, /bindtap="selectPrimaryEvent"/)
  assert.ok(content.indexOf('class="mapping-fields"') < content.indexOf('class="review-source-section"'))
  assert.match(content, /<\/scroll-view>/)
})

test('原始交易在当前弹层内下钻并由底部按钮返回处理', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const style = read('miniprogram/pages/import-workbench/index.wxss')
  const drilldownStart = template.indexOf('<view wx:if="{{evidenceSheet}}" class="evidence-drilldown">')
  const drilldownEnd = template.indexOf('<block wx:else>', drilldownStart)
  const drilldownMarkup = template.slice(drilldownStart, drilldownEnd)

  assert.ok(drilldownStart >= 0 && drilldownEnd > drilldownStart)
  assert.match(drilldownMarkup, /class="sheet-title serif-title">原始交易</)
  assert.doesNotMatch(drilldownMarkup, /evidence-sheet-heading[\s\S]*account-choice-cancel[\s\S]*返回处理/)
  assert.match(drilldownMarkup.trim(), /class="evidence-return"[^>]*bindtap="closeEvidence">\{\{currentIssue \? '返回处理' : '返回列表'\}\}<\/button>\s*<\/view>$/)
  assert.match(style, /\.evidence-return \{[^}]*width: 100%;/)
})

test('问题处理操作区全宽对齐且超额还款时禁用保存', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const source = read('miniprogram/pages/import-workbench/index.js')
  const style = read('miniprogram/pages/import-workbench/index.wxss')

  assert.match(template, /bankBatchSelectedCount[^\n]+保存选择/)
  assert.match(template, /disabled="{{[^"}]*\(currentIssue\.aggregateRepayment && !repaymentAllocationCanSave\)[^"}]*}}"/)
  assert.match(source, /repaymentAllocationCanSave/)
  assert.match(style, /\.sheet-actions \{[^}]*width: 100%;/)
  assert.match(style, /\.sheet-confirm-wide \{[^}]*width: 100%;[^}]*max-width: none;/)
})

test('最终入账展示财务与相同记录拆分并提供入账后的去向', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const source = read('miniprogram/pages/import-workbench/index.js')

  assert.match(template, /本批支出/)
  assert.match(template, /本批收入/)
  assert.doesNotMatch(template, /分类完成度|还剩 {{reviewIssues.length}} 项/)
  assert.equal((template.match(/全部记录 {{recordSummary.totalCount}}/g) || []).length, 3)
  assert.match(template, /disabled="{{busy \|\| openIssueCount \|\| accountStepSummary.pending > 0 \|\| !coverage.selectedEventsReadyToPost}}"/)
  assert.match(template, /新建账户/)
  assert.match(template, /查看明细/)
  assert.match(template, /查看统计/)
  assert.match(source, /finalSummary/)
})

test('统计页保留半年趋势与日历，收支同卡且无重复每日柱图', function () {
  const template = read('miniprogram/pages/statistics/index.wxml')
  const source = read('miniprogram/pages/statistics/index.js')

  assert.match(template, /近六个月/)
  assert.doesNotMatch(template, /每日收支|⌄|metric-strip|recent-month/)
  assert.match(template, /bindtap="previousMonth"/)
  assert.match(template, /bindtap="nextMonth"/)
  assert.ok(template.indexOf('收支构成') < template.indexOf('近六个月'))
  assert.match(template, /待分类/)
  assert.match(template, /charts.monthlyChart.src/)
  assert.match(template, /composition-pair/)
  assert.match(template, /selectCategoryKind/)
  assert.match(template, /trend-selection/)
  assert.doesNotMatch(template, /点击月份查看金额|selectedTrend.month}}/)
  assert.doesNotMatch(template, /累计结余|category-quality/)
  assert.doesNotMatch(template, /category-completion-link/)
  assert.match(template, /openUnclassifiedCategory/)
  assert.match(template, /wx:if="{{categoryKind}}" class="composition-details"/)
  assert.match(template, /支出日历/)
  assert.match(source, /cashFlowTrend/)
  assert.match(source, /openCategoryCompletion/)
})

test('账户页以净资产和异常余额为主，管理动作收进账户详情', function () {
  const template = read('miniprogram/pages/accounts/index.wxml')
  const style = read('miniprogram/pages/accounts/index.wxss')
  const source = read('miniprogram/pages/accounts/index.js')
  const model = read('miniprogram/pages/accounts/model.js')

  assert.match(template, /净资产/)
  assert.match(template, /资产合计/)
  assert.match(template, /待还负债/)
  assert.match(template, /账户总览/)
  assert.match(template, /assetCorrectionCount/)
  assert.match(template, /item\.amountTone/)
  assert.match(template, /accountDetail\.balanceLabel/)
  assert.match(template, /待校正/)
  assert.match(template, /bindtap="openAccountDetail"/)
  assert.match(template, /aria-label="新建账户"/)
  assert.match(template, /<text>新建<\/text>/)
  assert.match(template, /wealth-primary[\s\S]*wealth-label[\s\S]*wealth-value[\s\S]*wealth-caption/)
  assert.match(template, /class="detail-action-list"/)
  assert.match(template, /class="detail-action-row/)
  assert.doesNotMatch(template, /<button[^>]+class="account-row/)
  assert.doesNotMatch(template, /<button[^>]+class="archived-toggle/)
  assert.doesNotMatch(template, /class="account-actions"/)
  assert.doesNotMatch(template, /class="detail-secondary"/)
  assert.match(style, /\.create-account-button\s*\{[^}]*background:\s*transparent/)
  assert.match(style, /\.wealth-summary\s*\{[^}]*background:\s*var\(--theme-surface\)/)
  assert.match(style, /\.wealth-summary\s*\{[^}]*border-radius:\s*26rpx/)
  assert.match(style, /\.wealth-primary\s*\{[^}]*display:\s*block/)
  assert.doesNotMatch(style, /\.wealth-summary::before/)
  assert.match(style, /\.account-sheet\s*\{[^}]*flex-shrink:\s*0/)
  assert.match(source, /archivedExpanded/)
  assert.match(model, /溢缴余额/)
  assert.match(model, /amountTone/)
})

test('分类管理与账户详情共用整行查看和渐进式管理动作', function () {
  const template = read('miniprogram/pages/categories/index.wxml')
  const style = read('miniprogram/pages/categories/index.wxss')
  const source = read('miniprogram/pages/categories/index.js')

  assert.match(template, /分类总览/)
  assert.match(template, /bindtap="openCategoryDetail"/)
  assert.match(template, /class="category-toolbar(?: content-inset)?"/)
  assert.match(template, /新建分类/)
  assert.match(template, /class="category-drag-handle"[^>]*catchtouchstart="startCategoryDrag"[^>]*catchtouchmove="moveCategoryDrag"[^>]*catchtouchend="endCategoryDrag"/)
  assert.match(template, /class="category-detail-actions"/)
  assert.match(template, /bindtap="toggleArchived"/)
  assert.doesNotMatch(template, /bindtap="move"/)
  assert.doesNotMatch(template, /上移一位|下移一位/)
  assert.doesNotMatch(template, /class="category-actions"/)
  assert.doesNotMatch(template, /class="category-mark/)
  assert.match(style, /\.category-add\s*\{[^}]*background:\s*transparent/)
  assert.match(style, /\.category-drag-handle\s*\{[^}]*min-width:\s*88rpx/)
  assert.match(style, /\.kind-switch\s*\{[^}]*background:\s*var\(--theme-surface-muted\)/)
  assert.match(style, /\.category-sheet\s*\{[^}]*flex-shrink:\s*0/)
  assert.match(source, /categoryDetail/)
  assert.match(source, /openCategoryDetail/)
  assert.match(source, /archivedExpanded/)
  assert.match(source, /startCategoryDrag/)
  assert.match(source, /moveCategoryDrag/)
  assert.match(source, /endCategoryDrag/)
  assert.doesNotMatch(source, /\n\s*move:\s*function/)
})

test('首页只保留三条最近账目以避免摘要页重心下坠', function () {
  const homeScript = read('miniprogram/pages/index/index.js')
  const homeStyle = read('miniprogram/pages/index/index.wxss')

  assert.match(homeScript, /HOME_RECENT_LIMIT\s*=\s*3/)
  assert.match(homeScript, /\.slice\(0, HOME_RECENT_LIMIT\)/)
  assert.match(homeStyle, /\.section-title[^}]*font-weight:\s*500/)
  assert.match(homeStyle, /\.timeline-label[^}]*font-weight:\s*400/)
  assert.match(homeStyle, /\.account-empty[^}]*font-size:\s*var\(--font-body-small, 26rpx\)/)
  assert.match(homeStyle, /\.recent-empty-title[^}]*font-size:\s*var\(--font-body-small, 26rpx\)[^}]*font-weight:\s*400/)
})

test('首页卡片外沿与文字使用内收的双基线', function () {
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
  assert.match(profile, /class="profile-id-retry"/)
  assert.doesNotMatch(profile, /profile-error|profile-footnote|OpenID、内部用户标识/)
})

test('首页与我的共用同一个头像展示字段', function () {
  const home = read('miniprogram/pages/index/index.wxml')
  const profile = read('miniprogram/pages/profile/index.wxml')

  assert.match(home, /class="home-logo" src="\{\{displayAvatarUrl\}\}"/)
  assert.match(profile, /class="profile-logo" src="\{\{displayAvatarUrl\}\}"/)
  assert.doesNotMatch(profile, /profile-avatar-empty/)
})
