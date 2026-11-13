const test = require('node:test')
const assert = require('node:assert/strict')
const { readSource } = require('./helpers/source-files')
const path = require('node:path')
const read = p => readSource(path.join(__dirname, '..', p))
const markup = read('miniprogram/pages/statistics/content.wxml')
const style = read('miniprogram/pages/statistics/index.wxss')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = style.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, '缺少样式规则：' + selector)
  return match[1]
}

test('页头：标题 + 年份切换器（‹ 年 ›），可切年份', () => {
  assert.match(markup, /class="stats-head"/)
  assert.match(markup, /class="stats-head-title">收支统计/)
  assert.match(markup, /class="year-switch"/)
  assert.match(markup, /class="year-label money-number">\{\{viewYear\}\}年/)
  assert.match(markup, /bindtap="previousYear"/)
  assert.match(markup, /bindtap="nextYear"/)
  assert.doesNotMatch(markup, /class="stats-header"/)
  // 标题在最左，年份切换紧随其后
  const head = markup.slice(markup.indexOf('class="stats-head"'), markup.indexOf('class="month-strip"'))
  assert.ok(head.indexOf('stats-head-title') < head.indexOf('year-switch'), '标题应在最左，年份切换在其后')
  // 标题行左对齐，不 space-between
  assert.doesNotMatch(rule('.stats-head'), /justify-content:\s*space-between/)
})

test('月份条：12 个月等分一屏不滚动，选中月高亮', () => {
  // 不是 scroll-view，避免滚动定位错乱
  assert.doesNotMatch(markup, /scroll-into-view/)
  assert.match(markup, /class="month-strip"/)
  // 等分：每个 chip flex:1
  assert.match(rule('.month-chip'), /aspect-ratio:\s*1/)
  assert.match(rule('.month-strip'), /display:\s*grid/)
})

test('月份条：全年 12 月横滑、当前月高亮、未来月置灰', () => {
  assert.match(markup, /class="month-strip"/)
  assert.match(markup, /wx:for="\{\{monthOptions\}\}"/)
  assert.match(markup, /month-chip-active/)
  assert.match(markup, /month-chip-future/)
  assert.match(markup, /bindtap="pickMonth"/)
  assert.match(rule('.month-chip-active'), /background:\s*var\(--theme-accent/)
  assert.ok(rule('.month-chip-future'))
})

test('Hero 结余卡：结余为主大字，收入/支出对称分列带环比', () => {
  assert.match(markup, /class="hero-card on-dark-surface"/)
  assert.match(markup, /class="hero-amount money-number/)
  assert.match(markup, /class="hero-split"/)
  // 收入、支出两个 hero-side
  assert.equal((markup.match(/class="hero-side"/g) || []).length, 2)
  assert.match(markup, /incomeVsPrevious/)
  assert.match(markup, /expenseVsPrevious/)
  const amount = rule('.hero-amount')
  assert.match(amount, /font-size:\s*62rpx/)
})

test('收支构成：顶部「支出|收入」分段 + 环图 + 图例即排行（不再双色条/展开按钮）', () => {
  assert.match(markup, /class="segmented"/)
  assert.equal((markup.match(/class="segmented-item/g) || []).length, 3)
  assert.match(markup, /bindtap="selectCompositionKind"/)
  assert.match(markup, /class="compose-ring"/)
  assert.match(markup, /rings\.expense\.legend/)
  // 图例带环比 delta
  assert.match(markup, /legend-delta delta-/)
  // 旧的横条与展开按钮应移除
  assert.doesNotMatch(markup, /class="band"/)
  assert.doesNotMatch(markup, /展开分类/)
  assert.doesNotMatch(markup, /composition-pair/)
})

test('支出日历并入收支构成卡（第三视图），不再独立成块；负债块在页面底部', () => {
  // 日历不再是独立 section，而是构成卡内的 calendar 视图
  assert.doesNotMatch(markup, /title="支出日历"/, '独立日历 section 应移除')
  assert.match(markup, /data-kind="calendar"/)
  assert.match(markup, /class="compose-calendar"/)
  const liabIdx = markup.indexOf('负债与分期')
  const composeIdx = markup.indexOf('class="compose-card"')
  const heroIdx = markup.indexOf('class="hero-card on-dark-surface"')
  assert.ok(heroIdx > 0 && heroIdx < composeIdx, 'Hero 卡在构成卡之前')
  assert.ok(composeIdx > 0 && liabIdx > composeIdx, '负债块在构成卡之后（页面底部）')
})

test('所有卡片左右 margin 统一为 --layout-content-inset，Hero/构成/趋势/负债对齐', () => {
  for (const sel of ['.hero-card', '.compose-card', '.graph-surface', '.liability-card']) {
    const r = rule(sel)
    assert.match(r, /margin:[^;]*var\(--layout-content-inset/, sel + ' 缺少统一左右 margin，会与 Hero 卡错位')
  }
})
