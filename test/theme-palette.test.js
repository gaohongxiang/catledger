const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const registry = require('../miniprogram/theme/registry')
const { buildStatisticsView } = require('../miniprogram/pages/statistics/model')

function declarations(style) {
  return Object.fromEntries(style.split(';').filter(Boolean).map(function (entry) {
    const colon = entry.indexOf(':')
    return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]
  }))
}

const chartInput = {
  month: '2026-01',
  cashFlowTrend: [{ month: '2026-01', incomeMinor: '10000', expenseMinor: '5000' }],
  expenseCategories: [{ name: '示例支出', amountMinor: '5000' }],
  incomeCategories: [{ name: '示例收入', amountMinor: '10000' }],
  daily: []
}

registry.listThemes().forEach(function (item) {
  test(item.id + ' 的页面、图表、原生外壳使用同一份有效配色', function () {
    const source = registry.getTheme(item.id)
    const tokens = registry.getThemeTokens(item.id)
    const presentation = registry.getThemePresentation(item.id)
    const css = declarations(presentation.themeStyle)
    const semantic = source.semanticTone === 'dark'
      ? registry.SEMANTIC_DARK_TOKENS : registry.SEMANTIC_TOKENS
    const charts = buildStatisticsView(chartInput, tokens)
    const bars = decodeURIComponent(charts.monthlyChart.src)

    assert.equal(tokens.income, semantic.income)
    assert.equal(tokens.expense, semantic.expense)
    for (const kind of ['income', 'expense']) {
      assert.equal(css['--sem-' + kind], tokens[kind])
      assert.ok(bars.includes('fill="' + css['--sem-' + kind] + '"'), kind + ' 柱状图与页面语义色不同')
      assert.equal(charts[kind + 'Ring'].legend[0].color, css['--sem-' + kind])
      assert.equal(source.tokens[kind], registry.SEMANTIC_TOKENS[kind], '原始基础规范不能被有效快照改写')
    }
    assert.equal(presentation.themePageColor, tokens.page)
    assert.equal(presentation.themeCanvasBottom, tokens.canvasBottom)
    assert.equal(presentation.themeNavBackground, tokens.navBackground)
    assert.equal(presentation.themeNavFront, tokens.navFront)
    assert.equal(css['--theme-page'], tokens.page)
    Object.keys(source.tokens).filter(key => !['income', 'expense'].includes(key)).forEach(function (key) {
      assert.equal(tokens[key], source.tokens[key], key + ' 现有视觉值必须保留')
    })
    assert.equal(registry.getThemeTokens(item.id), tokens, '同主题应复用快照')
    assert.ok(Object.isFrozen(tokens), '调用方不能改写其他页面共享的配色')
    assert.equal(Reflect.set(tokens, 'income', '#000000'), false)
  })
})

test('主题预览卡片的收支色属于卡片本身，不随当前页面主题变化', function () {
  const style = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/theme/index.wxss'), 'utf8')
  const backgroundVariables = {}
  for (const kind of ['income', 'expense']) {
    const blocks = Array.from(style.matchAll(new RegExp('\\.preview-' + kind + '\\s*\\{([^}]+)\\}', 'g')))
    let background
    blocks.forEach(function (block) {
      const values = declarations(block[1])
      if (values.background) background = values.background
    })
    assert.ok(background, kind + ' 预览背景样式不存在')
    const variable = /^var\((--[\w-]+)/.exec(background)
    assert.ok(variable, kind + ' 预览未引用卡片变量')
    assert.equal(variable[1], '--preview-' + kind)
    backgroundVariables[kind] = variable[1]
  }
  for (const current of registry.listThemes()) {
    const inherited = declarations(registry.getThemePresentation(current.id).themeStyle)
    for (const card of registry.listThemes()) {
      const cardVariables = Object.assign({}, inherited, declarations(card.previewStyle))
      const effective = registry.getThemeTokens(card.id)
      for (const kind of ['income', 'expense']) {
        assert.equal(cardVariables[backgroundVariables[kind]], effective[kind], current.id + ' 页面中的 ' + card.id + ' 预览串色')
      }
    }
  }
})

test('原型键和非字符串偏好安全回退，不能变成伪主题或触发属性访问错误', function () {
  const fallback = registry.DEFAULT_THEME_ID
  const invalid = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'unknown-theme', '', null, undefined, 0, [], {},
    { toString() { throw new Error('主题校验不应隐式转换对象') } }]
  for (const value of invalid) {
    assert.equal(registry.normalizeThemeId(value), fallback)
    assert.equal(registry.getTheme(value).id, fallback)
    assert.equal(registry.getThemeTokens(value), registry.getThemeTokens(fallback))
    assert.equal(registry.getThemePresentation(value), registry.getThemePresentation(fallback))
  }
})
