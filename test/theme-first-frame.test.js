const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tabs, HOST_ROUTE } = require('../miniprogram/shell/tabs')

const ROOT = path.join(__dirname, '..')
const legacyTabs = new Map(tabs.map(tab => [tab.route, tab]))

function relative(file) { return path.relative(ROOT, file) }

// app.json 是页面清单的唯一真源：这里不维护第二份列表，新增页面自动纳入检查。
function declaredPageRoutes() {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.json'), 'utf8'))
  const routes = app.pages.slice()
  ;(app.subPackages || []).forEach(function (group) {
    group.pages.forEach(function (route) { routes.push(group.root + '/' + route) })
  })
  return routes
}

// 去掉注释后取第一个标签；account-transactions 这类只有 <include> 的页面顺着 include 找。
function firstMarkup(file, depth) {
  const source = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim()
  const included = /^<include\s+src="([^"]+)"\s*\/>/.exec(source)
  if (!included) return { source: source, file: file }
  assert.ok((depth || 0) < 3, 'include 套得太深：' + file)
  return firstMarkup(path.resolve(path.dirname(file), included[1]), (depth || 0) + 1)
}

// 这里检查接入契约；真实生命周期和失败恢复由 theme-lifecycle.test.js 验证。
// 原生窗口显示时序必须另做原生/真机验证，源码结构不代表无闪烁。
test('主宿主与独立页面使用主题生命周期，旧主入口只转发到宿主', function () {
  assert.ok(declaredPageRoutes().includes(HOST_ROUTE))
  for (const route of declaredPageRoutes()) {
    const source = fs.readFileSync(path.join(ROOT, 'miniprogram', route + '.js'), 'utf8')
    if (legacyTabs.has(route)) {
      assert.match(source, /require\(['"]\.\.\/\.\.\/shell\/router['"]\)/, route)
      assert.ok(source.includes("Page(legacyPage('" + legacyTabs.get(route).id + "'))"), route + ' 必须跳转对应主入口')
      assert.doesNotMatch(source, /create\w+Page|\.page\(|data\s*:/, route + ' 兼容页不能重新拥有业务或原生主题')
      continue
    }
    assert.match(source, /(?:theme|themeService)\.page\(/, route)
    assert.doesNotMatch(source, /\.initialData\(\)|\.bindPage\(/, route + ' 主题生命周期必须由适配器拥有')
  }
  for (const tab of tabs) {
    const file = path.join(ROOT, 'miniprogram', tab.route.replace(/index$/, 'page') + '.js')
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /(?:theme|themeService)\.(?:initialData|page|bindPage)\(|\bPage\(/, tab.id + ' 业务定义不得管理原生主题或注册 Page')
  }
})

test('独立主题组件与主面板通过相同生命周期订阅和清理', function () {
  for (const file of ['custom-tab-bar/index.js', 'components/login-sheet/index.js', 'shell/panel.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'miniprogram', file), 'utf8')
    assert.match(source, /(?:theme|themeService)\.component\(/, file)
    assert.doesNotMatch(source, /\.initialData\(\)|\.bindTabBar\(/, file)
  }
  for (const tab of tabs) {
    const base = tab.route.replace(/index$/, 'panel')
    const source = fs.readFileSync(path.join(ROOT, 'miniprogram', base + '.js'), 'utf8')
    const markup = fs.readFileSync(path.join(ROOT, 'miniprogram', base + '.wxml'), 'utf8')
    assert.ok(source.includes("Component(panel('" + tab.id + "'"), base)
    assert.match(markup, /wx:if="{{panelReady}}"/, base + ' 主题就绪前不得展示内容')
    assert.doesNotMatch(markup, /<page-meta|<navigation-bar/, base + ' 系统外壳归主宿主所有')
  }
})

// page-meta 维护页面根节点与声明式外壳；原生配色也由生命周期适配器提前发出。
test('主宿主与独立页面以主题 page-meta 开头，兼容入口没有第二个内容窗口', function () {
  const offenders = []
  declaredPageRoutes().forEach(function (route) {
    const markup = firstMarkup(path.join(ROOT, 'miniprogram', route + '.wxml'))
    const label = relative(markup.file)
    if (legacyTabs.has(route)) {
      assert.match(markup.source, /^<view\s*\/>$/, label + ' 兼容页只能是空跳转入口')
      return
    }
    if (!/^<page-meta\b/.test(markup.source)) {
      offenders.push(label + '：第一个节点不是 page-meta')
      return
    }
    const head = /^<page-meta\b[\s\S]*?<\/page-meta>/.exec(markup.source)
    if (!head) {
      offenders.push(label + '：page-meta 没有闭合')
      return
    }
    const block = head[0]
    ;[
      ['root-background-color="{{themePageColor}}"', '页面空白与 resize 空闲区没有跟随主题'],
      ['page-style="{{themePageStyle}}"', 'page 根节点没有跟随主题'],
      ['background-color="{{themePageColor}}"', '窗口背景没有跟随主题'],
      ['background-text-style="{{themeBackgroundTextStyle}}"', '下拉 loading 的明暗没有跟随主题'],
      // 允许在 front-color 之前再挂 title（主宿主用它声明式地表达当前 Tab 标题）。
      [/<navigation-bar\b[^>]*front-color="\{\{themeNavFront\}\}"[^>]*background-color="\{\{themeNavBackground\}\}"/, '导航栏没有跟随主题']
    ].forEach(function (pair) {
      const matched = pair[0] instanceof RegExp ? pair[0].test(block) : block.indexOf(pair[0]) >= 0
      if (!matched) offenders.push(label + '：' + pair[1])
    })
  })
  assert.deepEqual(offenders, [], '页面缺少统一主题外壳声明')
})

// 外壳值必须从 token 派生。写死任何一支颜色，都会在六套主题里错五套。
test('外壳字段与主题 token 同源，深色主题自动换成浅色前景', function () {
  const registry = require('../miniprogram/theme/registry')
  registry.listThemes().forEach(function (item) {
    const theme = registry.getTheme(item.id)
    const presentation = registry.getThemePresentation(item.id)
    const dark = registry.isDarkColor(theme.tokens.page)

    assert.equal(presentation.themePageColor, theme.tokens.page, item.id + ' 页面底色不是 page token')
    assert.equal(presentation.themeCanvasBottom, theme.tokens.canvasBottom, item.id + ' 窗口底部色不是 canvasBottom')
    assert.equal(presentation.themeNavBackground, theme.tokens.navBackground, item.id + ' 导航栏底色不是 navBackground')
    assert.match(presentation.themeNavFront, /^#[fF]{6}$|^#0{6}$/, item.id + ' 导航栏前景只允许纯黑或纯白')
    assert.equal(presentation.themeBackgroundTextStyle, dark ? 'light' : 'dark', item.id + ' 下拉 loading 明暗与底色相反')
    assert.equal(presentation.themePageStyle, 'background:' + theme.tokens.page + ';color:' + theme.tokens.ink + ';')
    // 外壳走字面色值，页面子树走变量：两条通道同时存在，不能互相顶替。
    assert.doesNotMatch(presentation.themePageStyle, /var\(/, '外壳不能引用变量，page 根节点不在变量继承链上')
    assert.match(presentation.themeStyle, /--theme-page:/, '页面子树仍要拿到完整的变量表')
  })
})
