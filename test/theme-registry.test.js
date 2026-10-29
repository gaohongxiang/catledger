const test = require('node:test')
const assert = require('node:assert/strict')

const registry = require('../miniprogram/theme/registry')
const themeServicePath = require.resolve('../miniprogram/theme/service')

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(function (part) { return parseInt(part, 16) / 255 })
  const linear = channels.map(function (value) {
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05)
}

function withThemeRuntime(options, run) {
  const storage = Object.assign({}, options && options.storage)
  const systemCalls = []
  const app = { globalData: {} }
  const previousWx = global.wx
  const previousGetApp = global.getApp

  global.wx = {
    getStorageSync: function (key) {
      if (options && options.readError) {
        throw new Error('storage unavailable')
      }
      return storage[key]
    },
    setStorageSync: function (key, value) { storage[key] = value },
    setNavigationBarColor: function (payload) { systemCalls.push(['navigation', payload]) },
    setBackgroundColor: function (payload) { systemCalls.push(['background', payload]) }
  }
  global.getApp = function () { return app }
  delete require.cache[themeServicePath]

  try {
    return run(require(themeServicePath), { app: app, storage: storage, systemCalls: systemCalls })
  } finally {
    delete require.cache[themeServicePath]
    global.wx = previousWx
    global.getApp = previousGetApp
  }
}

test('主题注册表提供六套唯一且完整的视觉方案', function () {
  const themes = registry.listThemes()
  assert.equal(themes.length, 6)
  assert.equal(new Set(themes.map(function (theme) { return theme.id })).size, 6)
  themes.forEach(function (theme) {
    assert.ok(theme.name)
    assert.ok(theme.description)
    assert.match(theme.previewStyle, /--preview-accent:/)
    assert.match(theme.previewStyle, /--preview-surface:/)
    assert.match(theme.previewStyle, /--preview-radius-large:/)
    assert.match(theme.previewStyle, /--preview-radius-xl:32rpx/)
    assert.equal(registry.getTheme(theme.id).tokens.radiusXl, '32rpx')
  })
})

function channels(hex) {
  return hex.match(/[a-f\d]{2}/gi).map(function (part) { return parseInt(part, 16) })
}

// 语义色只允许「同一个色相在不同明暗背景上换等价色」，不允许换色相、更不允许收支对调。
test('六套主题共享收支语义：浅底用原色，深底用同色相的提亮版', function () {
  const light = registry.SEMANTIC_TOKENS
  const dark = registry.SEMANTIC_DARK_TOKENS

  Object.keys(light).forEach(function (name) {
    const lightChannels = channels(light[name])
    const darkChannels = channels(dark[name])
    darkChannels.forEach(function (value, index) {
      assert.ok(value >= lightChannels[index], name + ' 的深色版应当是提亮，不是换色相')
    })
  })
  // 提亮之后红绿也不能被换掉：收入仍是偏绿的那一支，支出仍是偏红的那一支。
  assert.ok(channels(dark.income)[1] > channels(dark.expense)[1], '深色版收入必须比支出更绿')
  assert.ok(channels(dark.expense)[0] > channels(dark.income)[0], '深色版支出必须比收入更红')

  registry.listThemes().forEach(function (item) {
    const theme = registry.getTheme(item.id)
    const presentation = registry.getThemePresentation(item.id)
    const expected = theme.semanticTone === 'dark' ? dark : light
    assert.equal(theme.tokens.income, light.income)
    assert.equal(theme.tokens.expense, light.expense)
    assert.equal(presentation.semanticStyle, '--sem-income:' + expected.income + ';--sem-expense:' + expected.expense + ';')
    assert.doesNotMatch(presentation.themeStyle, /--theme-(?:income|expense):/)
  })

  assert.equal(registry.SEMANTIC_TOKENS.income, '#477153')
  assert.equal(registry.SEMANTIC_TOKENS.expense, '#B54738')
})

test('六套主题主卡大金额与卡面保持大字对比度', function () {
  registry.listThemes().forEach(function (item) {
    const tokens = registry.getTheme(item.id).tokens
    assert.ok(contrastRatio(tokens.heroStart, tokens.heroValueInk) >= 3, item.id + ' 主卡大金额对比度不足')
  })
})

test('无效主题安全回退到暖橘手账', function () {
  assert.equal(registry.normalizeThemeId('unknown-theme'), registry.DEFAULT_THEME_ID)
  assert.equal(registry.getTheme('unknown-theme').id, registry.DEFAULT_THEME_ID)
})

test('页面主题只输出受控的语义变量', function () {
  const presentation = registry.getThemePresentation('ticket-proof')
  assert.equal(presentation.themeId, 'ticket-proof')
  assert.equal(presentation.themeClass, 'theme-ticket-proof')
  const tokens = registry.getTheme('ticket-proof').tokens
  assert.match(presentation.themeStyle, new RegExp('--theme-hero-start:' + tokens.heroStart + ';'))
  assert.match(presentation.themeStyle, new RegExp('--theme-shadow-soft:' + tokens.shadowSoft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ';'))
  assert.match(presentation.themeStyle, /--theme-radius-xl:32rpx;/)
  assert.equal((presentation.themeStyle.match(/--theme-/g) || []).length, registry.TOKEN_NAMES.length)
})

test('主题服务只在本机保存选择并同步页面、底栏与外壳字段', function () {
  withThemeRuntime({}, function (service, runtime) {
    const tabBarPatches = []
    const pagePatches = []
    const tabBar = { setData: function (patch) { tabBarPatches.push(patch) } }
    const page = {
      setData: function (patch) { pagePatches.push(patch) },
      getTabBar: function () { return tabBar }
    }

    Object.assign(page, service.page({ data: page.data }))
    service.component({}).lifetimes.attached.call(tabBar)
    service.selectTheme('emerald-list')
    page.onLoad()

    assert.equal(runtime.storage[service.THEME_STORAGE_KEY], 'emerald-list')
    assert.equal(runtime.app.globalData.themeId, 'emerald-list')
    assert.equal(pagePatches.at(-1).themeId, 'emerald-list')
    assert.equal(tabBarPatches.at(-1).themeId, 'emerald-list')
    assert.equal(service.currentTokens().accent, registry.getTheme('emerald-list').tokens.accent)
    assert.ok(runtime.systemCalls.some(call => call[0] === 'navigation'), '当前页面必须发出原生配色')
    assert.equal(pagePatches.at(-1).themeNavBackground, registry.getTheme('emerald-list').tokens.navBackground)
    assert.equal(pagePatches.at(-1).themePageColor, registry.getTheme('emerald-list').tokens.page)
  })
})

test('本机存储不可用或主题值失效时仍安全回退默认主题', function () {
  withThemeRuntime({ readError: true }, function (service, runtime) {
    assert.equal(service.install().themeId, registry.DEFAULT_THEME_ID)
    assert.equal(runtime.app.globalData.themeId, registry.DEFAULT_THEME_ID)
  })

  withThemeRuntime({ storage: { catledger_theme_v1: 'retired-theme' } }, function (service) {
    assert.equal(service.install().themeId, registry.DEFAULT_THEME_ID)
  })
})


test('同一主题返回已加载页面时不重复替换页面和底栏主题数据', function () {
  withThemeRuntime({}, function (service, runtime) {
    let pageUpdates = 0
    let tabUpdates = 0
    const tabBar = { data: {}, setData: function (patch) { Object.assign(this.data, patch); tabUpdates += 1 } }
    const page = { data: {}, getTabBar: function () { return tabBar }, setData: function (patch) { Object.assign(this.data, patch); pageUpdates += 1 } }
    Object.assign(page, service.page({ data: page.data }))
    service.selectTheme('red-editorial')
    service.component({}).lifetimes.attached.call(tabBar)
    page.onLoad()
    page.onShow()
    assert.equal(pageUpdates, 1)
    assert.equal(tabUpdates, 1)
    assert.equal(page.data.themeIconRoot, '/assets/icons/themes/red-editorial')
    service.selectTheme('warm-ledger')
    page.onShow()
    assert.equal(pageUpdates, 2)
    assert.equal(tabUpdates, 2)
    assert.equal(page.data.themeIconRoot, '/assets/icons/themes/warm-ledger')
  })
})

// 骨架屏扫光是页面里唯一一处大面积高光。深色主题上沿用白光，会变成一道刺眼的横条，
// 比"配色不对"更像 bug；所以它必须从主题取色，而不是写死 rgba(255,255,255,.55)。
test('骨架屏高光按主题取色，深底不用白光', function () {
  registry.listThemes().forEach(function (item) {
    const theme = registry.getTheme(item.id)
    const presentation = registry.getThemePresentation(item.id)
    assert.ok(theme.tokens.shimmer, item.id + ' 缺少 shimmer token')
    assert.match(presentation.themeStyle, /--theme-shimmer:/, item.id + ' 的骨架屏高光没有进入变量表')
    if (theme.semanticTone === 'dark') {
      assert.doesNotMatch(theme.tokens.shimmer, /rgba\(255,\s*255,\s*255/, item.id + ' 深色底不能再用白光扫')
    }
  })
})
