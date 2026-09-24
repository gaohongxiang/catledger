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
  assert.equal(warm.tokens.surfaceMuted, '#F4EEE3')
  assert.equal(warm.tokens.accentSoft, '#F0E2CE')
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
  const source = read('miniprogram/pages/import-workbench/index.js') + read('miniprogram/pages/import-workbench/transaction-review.js') + read('miniprogram/pages/import-workbench/posting-flow.js')
  const style = read('miniprogram/pages/import-workbench/index.wxss')

  assert.match(template, /bankBatchSelectedCount[^\n]+保存选择/)
  assert.match(template, /disabled="{{[^"}]*\(currentIssue\.aggregateRepayment && !repaymentAllocationCanSave\)[^"}]*}}"/)
  assert.match(source, /repaymentAllocationCanSave/)
  assert.match(style, /\.sheet-actions \{[^}]*width: 100%;/)
  assert.match(style, /\.sheet-confirm-wide \{[^}]*width: 100%;[^}]*max-width: none;/)
})

test('最终入账展示财务与相同记录拆分并提供入账后的去向', function () {
  const template = read('miniprogram/pages/import-workbench/index.wxml')
  const source = read('miniprogram/pages/import-workbench/index.js') + read('miniprogram/pages/import-workbench/transaction-review.js') + read('miniprogram/pages/import-workbench/posting-flow.js')

  assert.match(template, /本批支出/)
  assert.match(template, /本批收入/)
  assert.doesNotMatch(template, /分类完成度|还剩 {{reviewIssues.length}} 项/)
  assert.equal((template.match(/template is="record-count-formula"/g) || []).length, 3)
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

test('收支构成以彩色分段带为主视觉，环形图退场，当日格子主橙高亮', function () {
  const template = read('miniprogram/pages/statistics/index.wxml')
  const style = read('miniprogram/pages/statistics/index.wxss')
  const source = read('miniprogram/pages/statistics/index.js')
  const model = read('miniprogram/pages/statistics/model.js')

  assert.match(template, /wx:for="{{expenseCategories}}"[^>]*class="band-segment" style="width: {{item\.barWidth}}; background: {{item\.bandColor}};/)
  assert.match(template, /wx:for="{{incomeCategories}}"[^>]*class="band-segment"/)
  assert.doesNotMatch(template, /ring-image|ring-wrap|charts\.expenseRing\.src|charts\.incomeRing\.src/)
  assert.match(style, /\.band \{[^}]*border-radius:\s*999rpx/)
  assert.doesNotMatch(style, /\.ring-image|\.ring-wrap/)
  assert.match(source, /bandColor: bandColorFor\(row\.name, row\.systemKey\)/)
  assert.match(template, /calendar-cell-today/)
  assert.match(style, /\.calendar-cell-today \{[^}]*var\(--theme-accent/)
  assert.match(model, /today: row\.date === time\.today\(\)/)
})

test('账户页以净资产和异常余额为主，行内图标直达改名与停用，点行进详情页', function () {
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
  assert.match(template, /待校正/)
  assert.match(template, /bindtap="openAccountDetail"/)
  assert.match(template, /aria-label="新建账户"/)
  assert.match(template, /<text>新建账户<\/text>/)
  assert.match(template, /class="head-cta"/)
  assert.match(template, /wealth-primary[\s\S]*wealth-label[\s\S]*wealth-value[\s\S]*wealth-caption/)
  assert.doesNotMatch(template, /account-row-edit/)
  assert.doesNotMatch(template, /catchtap="openRename"|catchtap="archive"/)
  assert.match(template, /全部贷款与还款/)
  assert.doesNotMatch(template, /accountDetail|detail-sheet|detail-action-list/)
  assert.doesNotMatch(template, /<button[^>]+class="account-row/)
  assert.doesNotMatch(template, /<button[^>]+class="archived-toggle/)
  assert.doesNotMatch(template, /class="account-actions"/)
  assert.doesNotMatch(style, /\.create-account-button/)
  assert.match(read('miniprogram/app.wxss'), /\.head-cta-label\s*\{[^}]*background:\s*var\(--theme-accent/)
  assert.match(read('miniprogram/app.wxss'), /\.account-sheet\s*\{[^}]*flex-shrink:\s*0/)
  assert.match(style, /\.wealth-summary\s*\{[^}]*background:\s*var\(--theme-surface\)/)
  assert.match(style, /\.wealth-summary\s*\{[^}]*border-radius:\s*var\(--theme-radius-large, 24rpx\)/)
  assert.match(style, /\.wealth-primary\s*\{[^}]*display:\s*block/)
  assert.doesNotMatch(style, /\.wealth-summary::before/)
  assert.doesNotMatch(style, /\.account-row-edit/)
  assert.match(source, /archivedExpanded/)
  assert.match(source, /pages\/account-detail\/index\?accountId=/)
  assert.doesNotMatch(source, /openRename|openCorrection|loadAccountLoans|closeAccountDetail|findAccount/)
  assert.match(model, /溢缴余额/)
  assert.match(model, /amountTone/)
})

test('账户详情独立页：余额大卡、流水入口、负债贷款区与操作区', function () {
  const markup = read('miniprogram/pages/account-detail/index.wxml')
  const source = read('miniprogram/pages/account-detail/index.js')
  const style = read('miniprogram/pages/account-detail/index.wxss')
  const config = read('miniprogram/pages/account-detail/index.json')

  assert.match(config, /"navigationBarTitleText": "账户详情"/)
  assert.match(read('miniprogram/app.json'), /"pages\/account-detail\/index"/)
  assert.match(markup, /class="ad-title serif-title">{{account \? account\.name : '账户详情'}}/)
  assert.match(markup, /ad-icon-button" bindtap="startEditName"[^>]*aria-label="修改名称"/)
  assert.match(markup, /ad-name-input {{nameError \? 'field-error-shake'/)
  assert.match(markup, /bindtap="cancelEditName"[\s\S]*?bindtap="saveName"/)
  assert.match(markup, /ad-copy">{{account\.typeLabel}}{{account\.archived \? ' · 已停用' : ''}}/)
  assert.match(markup, /ad-balance-value money-number {{account\.amountTone}}/)
  assert.doesNotMatch(markup, /ad-balance-state/)
  assert.match(markup, /{{account\.balanceLabel}}/)
  assert.match(markup, /<view class="ad-card">[\s\S]*?class="ad-card-link" bindtap="openAccountTransactions"/)
  assert.doesNotMatch(markup, /class="ad-list"/)
  assert.match(markup, /wx:if="{{account\.nature === 'liability'}}" class="account-loans"/)
  assert.match(markup, /bindtap="createAccountLoan"[^>]*aria-label="为当前账户新增贷款"/)
  assert.match(markup, /ad-loans-add-icon/)
  assert.doesNotMatch(markup, /＋ 新增/)
  assert.match(markup, /class="correction-callout"/)
  assert.match(markup, /bindtap="openCorrection"/)
  assert.match(markup, /bindtap="archive"/)
  assert.doesNotMatch(markup, /bindtap="openRename"|bindtap="saveForm"|formMode/)
  assert.match(markup, /class="ad-actions"/)
  assert.match(markup, /sheet-mask/)
  assert.match(source, /require\('\.\.\/accounts\/model'\)/)
  assert.match(source, /require\('\.\.\/loans\/model'\)/)
  assert.match(source, /accounts\.update/)
  assert.match(source, /accounts\.correctBalance/)
  assert.match(source, /accounts\.archive/)
  assert.match(source, /wx\.navigateTo\(\{ url: '\/pages\/account-transactions\/index\?accountId='/)
  assert.match(read('miniprogram/app.json'), /"pages\/account-transactions\/index"/)
  assert.match(read('miniprogram/pages/account-transactions/index.js'), /createTransactionsPage\(true,/)
  assert.match(read('miniprogram/pages/account-transactions/index.wxml'), /include src="\.\.\/transactions\/index\.wxml"/)
  assert.match(style, /\.ad-card \{[^}]*var\(--theme-radius-xl, 32rpx\)/)
  assert.match(style, /\.ad-actions \{[^}]*background:\s*var\(--theme-surface/)
  assert.match(style, /\.ad-icon-button \{[^}]*min-height:\s*88rpx|\.ad-icon-button \{[^}]*height:\s*88rpx/)
})

test('分类管理与账户详情共用整行查看和渐进式管理动作', function () {
  const template = read('miniprogram/pages/categories/index.wxml')
  const style = read('miniprogram/pages/categories/index.wxss')
  const source = read('miniprogram/pages/categories/index.js')

  assert.match(template, /分类总览/)
  assert.match(template, /bindtap="tapCategory"/)
  assert.match(template, /catchtap="openEdit"/)
  assert.match(template, /catchtap="setArchived"/)
  assert.match(template, /trash\.svg/)
  assert.doesNotMatch(template, /category-detail-actions|openCategoryDetail/)
  assert.match(source, /tapCategory/)
  assert.match(template, /class="category-toolbar(?: content-inset)?"/)
  assert.match(template, /新建分类/)
  assert.match(template, /class="category-drag-handle"[^>]*catchtouchstart="startCategoryDrag"[^>]*catchtouchmove="moveCategoryDrag"[^>]*catchtouchend="endCategoryDrag"/)
  assert.match(template, /bindtap="toggleArchived"/)
  assert.doesNotMatch(template, /bindtap="move"/)
  assert.doesNotMatch(template, /上移一位|下移一位/)
  assert.doesNotMatch(template, /class="category-actions"/)
  assert.doesNotMatch(template, /class="category-mark/)
  assert.match(template, /class="head-cta"/)
  assert.doesNotMatch(style, /\.category-add\b/)
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
  const sectionHeaderStyle = read('miniprogram/components/section-header/index.wxss')
  assert.match(sectionHeaderStyle, /\.sh-title[^}]*font-weight:\s*500/)
  assert.match(homeStyle, /\.timeline-label[^}]*font-weight:\s*400/)
  assert.match(homeStyle, /\.account-empty[^}]*font-size:\s*var\(--font-caption, 24rpx\)/)
  assert.match(read('miniprogram/pages/index/index.wxml'), /<empty-cat wx:else title="这个月还没有账"/)
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
  assert.match(profile, /title="主题"/)
  assert.match(profile, /title="数据与隐私"/)
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

test('分类瓷贴接入明细、统计、分类管理与记一笔，账户行首使用主题账户图标', function () {
  assert.match(read('miniprogram/pages/transactions/index.wxml'), /<category-tile[^>]*size="small" hide-name name="\{\{item\.label\}\}"/)
  assert.match(read('miniprogram/pages/statistics/index.wxml'), /<category-tile[^>]*size="small" hide-name name="\{\{item\.categoryId \? item\.name : ''\}\}"/)
  assert.match(read('miniprogram/pages/categories/index.wxml'), /<category-tile[^>]*size="small" hide-name name="\{\{item\.name\}\}"/)
  assert.match(read('miniprogram/pages/transaction-editor/index.wxml'), /<category-tile[^>]*hide-name name="\{\{categories\[categoryIndex\]\.name\}\}"/)
  assert.doesNotMatch(read('miniprogram/pages/statistics/index.wxml'), /ring-dot/)

  const accountsMarkup = read('miniprogram/pages/accounts/index.wxml')
  assert.equal((accountsMarkup.match(/account-type-icon/g) || []).length, 3)
  assert.match(accountsMarkup, /src="\{\{themeIconRoot\}\}\/\{\{item\.iconPath\}\}"/)
  assert.match(read('miniprogram/pages/accounts/model.js'), /iconPath: TYPE_ICONS\[account\.type\]/)
})

test('分类瓷贴默认色映射覆盖八个内置分类并回退灰色', function () {
  const palette = require('../miniprogram/utils/category-palette')
  const pairs = [['餐饮', 'orange'], ['交通', 'blue'], ['购物', 'purple'], ['住房', 'teal'], ['医疗', 'red'], ['教育', 'yellow'], ['娱乐', 'green']]
  pairs.forEach(function (pair) {
    assert.equal(palette.COLOR_BY_NAME[pair[0]], pair[1])
    assert.match(palette.bandColorFor(pair[0]), /^#[0-9a-f]{6}$/i)
  })
  assert.equal(palette.colorNameFor('不存在的分类'), 'grey')
  assert.equal(palette.bandColorFor('不存在的分类'), palette.TILE_COLORS.grey.solid)
  assert.match(read('miniprogram/components/category-tile/index.wxss'), /\.ct-grey \.ct-box/)
  Object.keys(palette.TILE_COLORS).forEach(function (name) {
    assert.match(read('miniprogram/components/category-tile/index.wxss'), new RegExp('\\.ct-' + name + ' \\.ct-box'), '瓷贴缺少 ' + name + ' 配色')
    assert.equal(palette.bandColorFor(''), palette.TILE_COLORS.grey.solid)
  })
})

test('page-head 统一全部页面页头，徽章按需只留真实业务上下文', function () {
  // profile 页头按用户要求移除（导航标题「我的」即页头），不加 page-head
  const pages = ['loans', 'import-history', 'data-privacy', 'ledger', 'accounts', 'categories', 'theme', 'loan-payment', 'loan-plan', 'loan-link', 'loan-detail', 'import-workbench']
  pages.forEach(function (page) {
    const markup = read('miniprogram/pages/' + page + '/index.wxml')
    const config = read('miniprogram/pages/' + page + '/index.json')
    assert.match(markup, /<page-head[\s>]/, page + ' 缺少 page-head')
    assert.match(config, /"page-head":\s*"\/components\/page-head\/index"/, page + ' 未注册 page-head')
  })
  const badged = ['loan-link', 'loan-plan']
  badged.forEach(function (page) {
    assert.match(read('miniprogram/pages/' + page + '/index.wxml'), /<page-head[^>]*badge="/, page + ' 应保留业务徽章')
  })
  pages.filter(function (page) { return badged.indexOf(page) < 0 }).forEach(function (page) {
    assert.doesNotMatch(read('miniprogram/pages/' + page + '/index.wxml'), /<page-head[^>]*badge=/, page + ' 不应再带徽章')
  })
  const about = read('miniprogram/pages/about/index.wxml')
  assert.doesNotMatch(about, /<page-head[^>]*badge=/, 'about 不应再带徽章')
  assert.match(read('miniprogram/components/page-head/index.wxml'), /wx:if="\{\{badge\}\}"/)
  assert.match(read('miniprogram/components/page-head/index.wxss'), /\.ph-plain \.ph-top/)
  ;['index', 'statistics', 'data-privacy'].forEach(function (page) {
    const markup = read('miniprogram/pages/' + page + '/index.wxml')
    const headers = markup.match(/<section-header[^>]*>/g) || []
    assert.ok(headers.length > 0, page + ' 应保留页内小节')
    headers.forEach(function (tag) { assert.match(tag, /compact/, page + ' section-header 仅允许 compact：' + tag) })
  })
  assert.doesNotMatch(read('miniprogram/pages/loans/index.wxml'), /section-header/)
})

test('empty-cat 接管主场景空态，empty-state 保留次级场景', function () {
  assert.match(read('miniprogram/pages/index/index.wxml'), /<empty-cat wx:else title="这个月还没有账"/)
  assert.match(read('miniprogram/pages/transactions/index.wxml'), /<empty-cat wx:elif[^>]*title="这里暂时没有账目"/)
  assert.match(read('miniprogram/pages/loans/index.wxml'), /<empty-cat[^>]*hide-art[^>]*title="还没有贷款资料"/)
  assert.match(read('miniprogram/pages/import-history/index.wxml'), /<empty-cat[^>]*title="暂无已入账的导入记录"/)
  assert.match(read('miniprogram/components/empty-cat/index.wxml'), /\/assets\/catledger-logo\.png/)
  assert.match(read('miniprogram/components/empty-cat/index.wxss'), /opacity:\s*\.32/)
  assert.match(read('miniprogram/pages/index/index.wxml'), /<empty-state[^>]*title="当前基础库不支持云开发"/)
})

test('empty-cat 升级场景卡：径向光圈、星点与 hide-art 无图变体', function () {
  const markup = read('miniprogram/components/empty-cat/index.wxml')
  const style = read('miniprogram/components/empty-cat/index.wxss')
  assert.match(markup, /<view wx:if="{{!hideArt}}" class="ec-scene"/)
  assert.match(markup, /class="ec-glow"/)
  assert.ok((markup.match(/ec-star/g) || []).length >= 3, '需要星点装饰')
  assert.match(style, /\.ec-glow \{[^}]*radial-gradient\(circle, var\(--theme-accent-soft/)
  assert.match(style, /\.ec-star \{[^}]*var\(--theme-accent/)
  assert.match(markup, /ec-plain/)
  assert.match(style, /\.ec-plain \.ec-title/)
})

test('大卡与弹层圆角升 xl，列表行卡保持 large', function () {
  assert.match(read('miniprogram/pages/statistics/index.wxss'), /\.graph-surface \{[^}]*border-radius:\s*var\(--theme-radius-xl, 32rpx\)/)
  assert.match(read('miniprogram/pages/statistics/index.wxss'), /\.composition-card \{[^}]*border-radius:\s*var\(--theme-radius-xl, 32rpx\)/)
  const sheetFiles = ['miniprogram/pages/statistics/index.wxss', 'miniprogram/pages/categories/index.wxss', 'miniprogram/app.wxss', 'miniprogram/components/login-sheet/index.wxss', 'miniprogram/pages/import-workbench/index.wxss']
  sheetFiles.forEach(function (file) {
    assert.match(read(file), /border-radius:\s*var\(--theme-radius-xl, 32rpx\) var\(--theme-radius-xl, 32rpx\) 0 0/, file)
  })
  assert.match(read('miniprogram/pages/loan-payment/index.wxss'), /\.lp-summary \{[^}]*var\(--theme-radius-xl, 32rpx\)/)
  assert.match(read('miniprogram/pages/loan-detail/index.wxss'), /\.ld-form-card \{[^}]*var\(--theme-radius-xl, 32rpx\)/)
  assert.match(read('miniprogram/pages/loan-detail/index.wxss'), /\.record-sheet \{[^}]*border-radius: 30rpx/)
})

test('我的页资料区：头像即按钮、昵称与 ID 使用图标按钮，编辑逻辑不变', function () {
  const markup = read('miniprogram/pages/profile/index.wxml')
  const style = read('miniprogram/pages/profile/index.wxss')
  assert.match(markup, /class="profile-avatar-button[^"]*"[^>]*open-type="chooseAvatar"[^>]*bindchooseavatar="chooseAvatar"/)
  assert.doesNotMatch(markup, />取消<|>保存<|profile-avatar-label|profile-id-copy/)
  assert.match(markup, /aria-label="修改昵称"[^>]*bindtap="startEditNickname"/)
  assert.match(markup, /aria-label="取消修改昵称"[^>]*bindtap="cancelEditNickname"/)
  assert.match(markup, /aria-label="保存昵称"[^>]*bindtap="saveNickname"/)
  assert.match(markup, /aria-label="复制完整 ID"[^>]*bindtap="copyId"/)
  assert.match(markup, /\/assets\/icons\/pencil\.svg/)
  assert.match(markup, /\/assets\/icons\/copy\.svg/)
  assert.match(style, /\.profile-card \{[^}]*var\(--theme-radius-xl, 32rpx\)[^}]*box-shadow:\s*var\(--theme-shadow-soft\)/)
  assert.match(style, /\.profile-icon-button \{[^}]*min-height:\s*88rpx/)
  assert.match(style, /\.profile-avatar-button:active \{\s*opacity:/)
})

test('ticker-number 逐位滚动接入首页净值与统计总额', function () {
  const comp = read('miniprogram/components/ticker-number/index.js')
  const markup = read('miniprogram/components/ticker-number/index.wxml')
  const style = read('miniprogram/components/ticker-number/index.wxss')
  assert.match(comp, /observers:[\s\S]*value: function/)
  assert.match(markup, /item\.digit/)
  assert.match(markup, /translateY\(\{\{item\.top\}\}\)/)
  assert.match(style, /transition:\s*transform 600ms var\(--motion-ticker-timing/)
  assert.match(style, /prefers-reduced-motion:\s*reduce/)
  assert.match(read('miniprogram/pages/index/index.wxml'), /<ticker-number class="net-worth-number money-number" value="\{\{loggedIn && hasDashboard \? netWorthText : '—'\}\}"/)
  assert.match(read('miniprogram/pages/statistics/index.wxml'), /<ticker-number class="composition-amount expense-color money-number" value="\{\{expenseText\}\}"/)
  assert.match(read('miniprogram/pages/statistics/index.wxml'), /<ticker-number class="composition-amount income-color money-number" value="\{\{incomeText\}\}"/)
})

test('skeleton-rows 骨架屏替换四处读取中状态', function () {
  const style = read('miniprogram/components/skeleton-rows/index.wxss')
  assert.match(style, /animation:\s*sk-sweep var\(--layout-motion-shimmer, 1400ms\)/)
  assert.match(style, /prefers-reduced-motion:\s*reduce/)
  assert.match(read('miniprogram/pages/transactions/index.wxml'), /<skeleton-rows wx:elif="\{\{loading && !hasLoaded\}\}" rows="\{\{4\}\}"/)
  assert.doesNotMatch(read('miniprogram/pages/transactions/index.wxml'), /正在读取账目…/)
  assert.match(read('miniprogram/pages/accounts/index.wxml'), /<skeleton-rows wx:if="\{\{loading && !hasLoaded\}\}"/)
  assert.match(read('miniprogram/pages/statistics/index.wxml'), /<skeleton-rows wx:elif="\{\{!hasLoaded && !errorMessage\}\}"/)
  assert.match(read('miniprogram/pages/index/index.wxml'), /<skeleton-rows wx:elif="\{\{loading\}\}" rows="\{\{3\}\}"/)
  assert.doesNotMatch(read('miniprogram/pages/index/index.wxml'), /正在读取最近账目…/)
})

test('按压回弹：按钮体系与可点卡片统一 scale 回弹', function () {
  const appStyle = read('miniprogram/app.wxss')
  assert.match(appStyle, /--motion-press-scale:\s*\.965/)
  assert.match(appStyle, /--motion-press-timing:\s*cubic-bezier\(\.34, 1\.56, \.64, 1\)/)
  assert.match(appStyle, /\.primary-button:active,[\s\S]*?transform:\s*scale\(var\(--motion-press-scale/)
  assert.match(appStyle, /\.primary-button\[disabled\][\s\S]*?opacity:\s*\.65/)
  assert.match(read('miniprogram/components/list-row/index.wxss'), /\.lr-active \{\s*transform:\s*scale\(var\(--motion-press-scale/)
  assert.match(read('miniprogram/pages/loan-link/index.wxss'), /\.ll-candidate-hover \{\s*transform:\s*scale/)
  assert.match(read('miniprogram/pages/loan-detail/index.wxss'), /\.ld-history-hover \{\s*transform:\s*scale/)
})

test('校验抖动：login-sheet、profile、loan-detail 三处接入', function () {
  const appStyle = read('miniprogram/app.wxss')
  assert.match(appStyle, /@keyframes field-error-shake/)
  assert.match(appStyle, /\.field-error-shake \{\s*animation:\s*field-error-shake 360ms/)
  assert.match(appStyle, /\.field-error-inline/)
  assert.match(read('miniprogram/pages/profile/index.wxml'), /profile-name-input \{\{nicknameError \? 'field-error-shake'/)
  assert.match(read('miniprogram/components/login-sheet/index.wxml'), /nicknameShake \? 'login-nickname-shake'/)
  assert.match(read('miniprogram/components/login-sheet/index.wxss'), /@keyframes login-nickname-shake/)
  const loanDetailMarkup = read('miniprogram/pages/loan-detail/index.wxml')
  assert.match(loanDetailMarkup, /fieldError === 'account' \? 'field-error-shake'/)
  assert.match(loanDetailMarkup, /fieldError === 'principal' \? 'field-error-shake'/)
  assert.match(loanDetailMarkup, /fieldError === 'schedule' \? 'field-error-shake'/)
  assert.match(loanDetailMarkup, /errorMessage && !fieldError/)
  assert.match(read('miniprogram/pages/loan-detail/index.js'), /fieldError: fieldErrorFor\(error\.message\)/)
})

test('列表错峰入场：四类行逐行 fadeUp 带 70ms 间隔，封顶且翻页不入场', function () {
  const appStyle = read('miniprogram/app.wxss')
  assert.match(appStyle, /@keyframes row-fade-up/)
  assert.match(appStyle, /\.row-enter \{\s*animation:\s*row-fade-up var\(--layout-motion-enter, 380ms\) ease backwards/)
  assert.match(appStyle, /--layout-motion-enter:\s*380ms/)
  const capped = /animation-delay: \{\{index < 10 \? index \* 70 : 700\}\}ms/
  const files = [
    'miniprogram/pages/transactions/index.wxml',
    'miniprogram/pages/accounts/index.wxml',
    'miniprogram/pages/statistics/index.wxml',
    'miniprogram/pages/index/index.wxml'
  ]
  files.forEach(function (file) {
    const markup = read(file)
    assert.match(markup, /row-enter/, file)
    assert.match(markup, capped, file + ' 延迟应封顶')
  })
  assert.match(read('miniprogram/pages/transactions/index.wxml'), /\{\{staggerOn \? 'row-enter' : ''\}\}/, '明细翻页追加不入场')
  const reduced = appStyle.slice(appStyle.indexOf('prefers-reduced-motion'))
  assert.match(reduced, /animation-delay:\s*0ms !important/, '减少动态效果须同时取消延迟')
})

test('瓷贴默认分类与自定义分类均有图标，原生渲染不依赖插槽', function () {
  const palette = require('../miniprogram/utils/category-palette')
  const pairs = [['餐饮', 'dining'], ['交通', 'transport'], ['购物', 'shopping'], ['住房', 'housing'], ['医疗', 'medical'], ['教育', 'education'], ['娱乐', 'entertainment'], ['其他', 'other']]
  pairs.forEach(function (pair) {
    const file = 'miniprogram/assets/icons/categories/' + pair[1] + '.svg'
    assert.equal(palette.iconFor(pair[0]), '/assets/icons/categories/' + pair[1] + '.svg')
    assert.ok(fs.existsSync(path.join(root, file)), file + ' 缺失')
    const svg = read(file)
    assert.match(svg, /stroke="#[0-9A-Fa-f]{6}"|fill="#[0-9A-Fa-f]{6}"/, pair[0] + ' 图标未烘焙 ink 色')
    if (pair[1] !== 'other') assert.match(svg, /stroke-width="1\.8"/, pair[0] + ' 线宽不符合规范')
  })
  assert.equal(palette.iconFor('自定义'), '/assets/icons/categories/other.svg', '自定义分类使用通用图标')
  const markup = read('miniprogram/components/category-tile/index.wxml')
  assert.match(markup, /wx:if="\{\{icon\}\}" class="ct-icon"/)
  assert.match(markup, /wx:else class="ct-letter"/)
  assert.doesNotMatch(markup, /<slot\b/, '原生插槽默认内容不渲染，图标与首字须作为组件自身节点')
  const style = read('miniprogram/components/category-tile/index.wxss')
  assert.match(style, /\.ct-icon \{/)
  assert.match(style, /\.ct-small \.ct-icon \{/)
})

test('明细按天分组：组头标签与分页同日合并', function () {
  const markup = read('miniprogram/pages/transactions/index.wxml')
  const source = read('miniprogram/pages/transactions/page.js')
  assert.match(markup, /<text wx:if="\{\{item\.dayLabel\}\}" class="detail-group content-inset">\{\{item\.dayLabel\}\}<\/text>/)
  assert.match(source, /function attachDayLabels\(rows, previousDay\)/)
  assert.match(source, /return '今天'/)
  assert.match(source, /return '昨天'/)
  assert.match(source, /'年' \+ monthDay/)
  assert.match(source, /occurredLocalAt \|\| ''\)\.slice\(0, 10\)/)
  assert.match(source, /attachDayLabels\(rows, lastDay\)/, '分页追加须传入已有末日避免重复组头')
  assert.match(read('miniprogram/pages/transactions/index.wxss'), /\.detail-group \{[^}]*font-size:\s*var\(--font-caption/)
})
