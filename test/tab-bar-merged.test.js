const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

function allTabs(bar) { return bar.data.tabsLeft.concat(bar.data.tabsRight) }

test('底栏 4 个可视位：首页/明细·统计/账户·分类/我的，合并位带 caret(kind)', () => {
  const bar = runtime().component()
  const tabs = allTabs(bar)
  assert.deepEqual(tabs.map(t => t.text), ['首页', '明细·统计', '账户·分类', '我的'])
  assert.deepEqual(tabs.map(t => t.kind), ['single', 'records', 'accounts', 'single'])
  assert.deepEqual(tabs.map(t => t.key), ['home', 'records', 'accounts', 'profile'])
})

test('高亮唯一由 activeKey 决定（item.key===activeKey），默认首页', () => {
  const bar = runtime().component()
  assert.equal(bar.data.activeKey, 'home')
  // 每个 tab 不再自带 active 派生字段，避免第二套状态
  for (const t of allTabs(bar)) assert.equal(t.active, undefined)
})

test('setActiveKey 接受 key 或旧式下标（兼容），落到同一 activeKey', () => {
  const bar = runtime().component()
  bar.setActiveKey('records'); assert.equal(bar.data.activeKey, 'records')
  bar.setActiveKey('profile'); assert.equal(bar.data.activeKey, 'profile')
  bar.setActiveKey(0); assert.equal(bar.data.activeKey, 'home', '下标 0 -> home')
  bar.setActiveKey(2); assert.equal(bar.data.activeKey, 'accounts', '下标 2 -> accounts')
})

test('账户/分类已并入 shell tab，高亮 key 与明细·统计同一机制', () => {
  const bar = runtime().component()
  for (const k of ['home', 'records', 'accounts', 'profile']) { bar.setActiveKey(k); assert.equal(bar.data.activeKey, k) }
  // accounts/categories 都是宿主面板 tab，合并位 key=accounts
  assert.equal(require('../miniprogram/shell/tabs').visualKey('accounts'), 'accounts')
  assert.equal(require('../miniprogram/shell/tabs').visualKey('categories'), 'accounts')
})

test('点合并位先弹二选一，不直接切 tab', () => {
  const bar = runtime().component()
  bar.switchTab({ currentTarget: { dataset: { key: 'records' } } })
  assert.equal(bar.data.choiceOpen, 'records')
  assert.equal(bar.events.length, 0)
  bar.switchTab({ currentTarget: { dataset: { key: 'accounts' } } })
  assert.equal(bar.data.choiceOpen, 'accounts')
})

test('二选一选明细/统计 -> 触发 tabchange', () => {
  const bar = runtime().component()
  bar.switchTab({ currentTarget: { dataset: { key: 'records' } } })
  bar.chooseRecords({ currentTarget: { dataset: { id: 'statistics' } } })
  assert.equal(bar.data.choiceOpen, '')
  const e = bar.events.pop(); assert.equal(e.name, 'tabchange'); assert.equal(e.detail.id, 'statistics')
})

test('二选一选账户/分类 -> 触发 tabchange 切宿主面板（与明细·统计同一机制，不 navigateTo）', () => {
  const h = runtime(), bar = h.component()
  bar.switchTab({ currentTarget: { dataset: { key: 'accounts' } } })
  bar.chooseAccounts({ currentTarget: { dataset: { id: 'accounts' } } })
  assert.equal(bar.data.choiceOpen, '')
  let e = bar.events.pop(); assert.equal(e.name, 'tabchange'); assert.equal(e.detail.id, 'accounts')
  bar.switchTab({ currentTarget: { dataset: { key: 'accounts' } } })
  bar.chooseAccounts({ currentTarget: { dataset: { id: 'categories' } } })
  e = bar.events.pop(); assert.equal(e.name, 'tabchange'); assert.equal(e.detail.id, 'categories')
  assert.equal(h.navigation.length, 0, '宿主内切面板，不应整页 navigateTo')
})

test('点「首页」「我的」直接 tabchange', () => {
  const bar = runtime().component()
  bar.data.activeKey = 'profile'
  bar.switchTab({ currentTarget: { dataset: { key: 'home' } } })
  let e = bar.events.pop(); assert.equal(e.name, 'tabchange'); assert.equal(e.detail.id, 'home')
  bar.data.activeKey = 'home'
  bar.switchTab({ currentTarget: { dataset: { key: 'profile' } } })
  e = bar.events.pop(); assert.equal(e.name, 'tabchange'); assert.equal(e.detail.id, 'profile')
})

test('架构约束：底栏高亮只由 activeKey 决定，不存在 selected 下标第二来源', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const js = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.wxml'), 'utf8')
  // wxml 用 item.key === activeKey，不用 selected === index
  assert.match(wxml, /item\.key === activeKey/)
  assert.doesNotMatch(wxml, /selected === index/)
  assert.doesNotMatch(wxml, /wx:key="pagePath"/)
  // 各面板/宿主不再直接写 selected 下标；统一调 setActiveKey
  const host = fs.readFileSync(path.join(__dirname, '../miniprogram/shell/host.js'), 'utf8')
  assert.match(host, /setActiveKey/)
  assert.doesNotMatch(host, /setData\(\{\s*selected:/)
})

test('架构约束：强调色只由 .tab-item-selected 一处驱动；未选中用中性图标，选中用强调图标', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const bar = runtime().component()
  const all = allTabs(bar)
  // 每个可视位声明两套图标：中性(iconPath) + 强调(selectedIconPath)。用 <image> 按 activeKey 切换，
  // 不依赖 CSS mask/currentColor（真机不渲染），确保图标在任何环境都可见。
  for (const t of all) {
    assert.ok(t.iconPath, t.key + ' 需要 iconPath（中性色）')
    assert.ok(t.selectedIconPath, t.key + ' 需要 selectedIconPath（强调色）')
  }
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.wxml'), 'utf8')
  // 图标是 <image>，src 按 item.key === activeKey 在中性/强调之间切换
  assert.match(wxml, /<image class="tab-icon"[^>]*src="\{\{themeIconRoot\}\}\/\{\{item\.key === activeKey \? item\.selectedIconPath : item\.iconPath\}\}"/)
  assert.doesNotMatch(wxml, /<view class="tab-icon"><\/view>/, '不得再用空的 mask 图标容器')
  const wxss = fs.readFileSync(path.join(__dirname, '../miniprogram/custom-tab-bar/index.wxss'), 'utf8')
  // 禁止 CSS mask / currentColor 方案（真机不渲染导致图标消失）
  assert.doesNotMatch(wxss, /-webkit-mask|mask:\s*var|\.tab-icon[^}]*background-color:\s*currentColor/, '不得用 CSS mask/currentColor 渲染底栏图标')
  // 单一强调态来源：--tab-accent 只在 .tab-item-selected 上赋值
  assert.match(wxss, /\.tab-item-selected\s*\{[^}]*--tab-accent:\s*var\(--theme-accent/)
})

test('架构约束：底栏图标资源齐全且均为实色（<image> 可直接显示，非 currentColor）', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const roots = [path.join(__dirname, '../miniprogram/assets/icons'),
    ...['gilded-ledger', 'navy-ledger', 'taro-note'].map(t => path.join(__dirname, '../miniprogram/assets/icons/themes', t))]
  for (const root of roots) {
    for (const name of ['tab-home.svg', 'tab-list.svg', 'tab-wallet.svg', 'tab-user.svg',
                        'tab-home-active.svg', 'tab-list-active.svg', 'tab-wallet-active.svg', 'tab-user-active.svg']) {
      const svg = fs.readFileSync(path.join(root, name), 'utf8')
      assert.match(svg, /stroke="#[0-9A-Fa-f]{3,6}"/, path.join(root, name) + ' 必须是实色描边（<image> 依赖）')
      assert.doesNotMatch(svg, /currentColor/, path.join(root, name) + ' 不能是 currentColor（<image> 不解析会消失）')
    }
  }

})

test('架构约束：同一主题下未选中 tab 图标必须同色(中性)，选中必须同色(强调)——防止混入金色未选中图标', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const themes = ['gilded-ledger', 'navy-ledger', 'taro-note']
  const base = ['tab-home', 'tab-list', 'tab-wallet', 'tab-user']
  const color = svg => (svg.match(/stroke="(#[0-9A-Fa-f]{3,6})"/) || [])[1]
  for (const theme of themes) {
    const dir = path.join(__dirname, '../miniprogram/assets/icons/themes', theme)
    const neutrals = base.map(n => color(fs.readFileSync(path.join(dir, n + '.svg'), 'utf8')))
    const actives = base.map(n => color(fs.readFileSync(path.join(dir, n + '-active.svg'), 'utf8')))
    assert.equal(new Set(neutrals).size, 1, theme + ' 未选中四图标必须同色，实际：' + JSON.stringify(neutrals))
    assert.equal(new Set(actives).size, 1, theme + ' 选中四图标必须同色，实际：' + JSON.stringify(actives))
    assert.notEqual(neutrals[0], actives[0], theme + ' 未选中与选中必须不同色')
  }
})

test('架构约束：深色语境收支色走全局 .on-dark-surface，不在单页写私有覆盖', () => {
  const fs = require('node:fs'); const path = require('node:path')
  // app.wxss 必须提供全局语义色工具类与深底切换
  const app = fs.readFileSync(path.join(__dirname, '../miniprogram/app.wxss'), 'utf8')
  assert.match(app, /\.income-color\s*\{\s*color:\s*var\(--sem-income/)
  assert.match(app, /\.on-dark-surface \.income-color\s*\{\s*color:\s*var\(--sem-income-on-dark/)
  assert.match(app, /\.on-dark-surface \.expense-color\s*\{\s*color:\s*var\(--sem-expense-on-dark/)
  // 统计页：hero 卡用 on-dark-surface 标记，且不得再写 .hero-card .income-color 私有覆盖
  const stats = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/statistics/index.wxss'), 'utf8')
  assert.doesNotMatch(stats, /\.hero-card \.income-color\s*\{/, '不得回到单页私有覆盖')
  const content = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/statistics/content.wxml'), 'utf8')
  assert.match(content, /class="hero-card on-dark-surface"/, 'hero 卡需带 on-dark-surface')
})

test('架构约束：所有二级页都是宿主面板（底栏常驻），不再整页 navigateTo', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const { subpages } = require('../miniprogram/shell/tabs')
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '../miniprogram/app.json'), 'utf8'))
  const allRoutes = app.pages.concat((app.subPackages || []).flatMap(pack => pack.pages.map(p => pack.root + '/' + p)))
  // 每个二级页：index.js 是 legacyRedirect，且有 panel 四件套；route 在 app.json 里
  for (const id of Object.keys(subpages)) {
    const route = subpages[id].route
    assert.ok(allRoutes.includes(route), id + ' 路由未在 app.json 注册')
    const index = fs.readFileSync(path.join(__dirname, '../miniprogram', route + '.js'), 'utf8')
    assert.match(index, new RegExp("legacyRedirect\\('" + id + "'\\)"), route + ' 整页入口必须重定向到宿主面板')
    const dir = path.join(__dirname, '../miniprogram', route.replace(/index$/, ''))
    for (const f of ['panel.js', 'panel.wxml', 'panel.wxss', 'panel.json']) {
      assert.ok(fs.existsSync(path.join(dir, f)), id + ' 缺少 ' + f)
    }
  }
  // shell 里为每个二级页渲染面板容器
  const shell = fs.readFileSync(path.join(__dirname, '../miniprogram/shell/index.wxml'), 'utf8')
  for (const id of Object.keys(subpages)) {
    assert.ok(shell.includes('<view class="shell-panel shell-subpage" hidden="{{activeTab !== \'' + id + '\'}}"'), 'shell 缺面板容器 ' + id)
    assert.ok(shell.includes('id="panel-' + id + '"'), 'shell 缺面板挂载 ' + id)
  }
  // 所有页面打开二级页都走统一路由，不再直接 wx.navigateTo 到二级页足径
  const subRoutes = Object.keys(subpages).map(id => '/' + subpages[id].route)
  for (const tf of fs.readdirSync(path.join(__dirname, '../miniprogram'), { recursive: true })) {
    const fp = path.join(__dirname, '../miniprogram', tf)
    if (!fs.existsSync(fp) || !fp.endsWith('.js') || fp.includes('node_modules')) continue
    const src = fs.readFileSync(fp, 'utf8')
    for (const r of subRoutes) {
      // 允许 legacyRedirect/panel 内部，但禁止 `wx.navigateTo({url:'/xxx/index...` 直开二级页
      const bad = new RegExp("wx\\.navigateTo\\(\\{\\s*url:\\s*['\"]" + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      assert.doesNotMatch(src, bad, path.relative(path.join(__dirname, '..'), fp) + ' 直接 navigateTo 二级页 ' + r + '，应走 openSubpageUrl')
    }
  }
})
