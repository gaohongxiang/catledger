const test = require('node:test')
const assert = require('node:assert/strict')

const registry = require('../miniprogram/theme/registry')
const themeServicePath = require.resolve('../miniprogram/theme/service')

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
  assert.match(presentation.themeStyle, /--theme-hero-start:#E3B84F;/)
  assert.match(presentation.themeStyle, /--theme-shadow-soft:5rpx 5rpx 0/)
  assert.equal((presentation.themeStyle.match(/--theme-/g) || []).length, registry.TOKEN_NAMES.length)
})

test('主题服务只在本机保存选择并同步页面、底栏与系统栏', function () {
  withThemeRuntime({}, function (service, runtime) {
    const tabBarPatches = []
    const pagePatches = []
    const tabBar = { setData: function (patch) { tabBarPatches.push(patch) } }
    const page = {
      setData: function (patch) { pagePatches.push(patch) },
      getTabBar: function () { return tabBar }
    }

    service.selectTheme('emerald-list')
    service.bindPage(page)

    assert.equal(runtime.storage[service.THEME_STORAGE_KEY], 'emerald-list')
    assert.equal(runtime.app.globalData.themeId, 'emerald-list')
    assert.equal(pagePatches.at(-1).themeId, 'emerald-list')
    assert.equal(tabBarPatches.at(-1).themeId, 'emerald-list')
    assert.equal(service.currentTokens().accent, registry.getTheme('emerald-list').tokens.accent)
    assert.ok(runtime.systemCalls.some(function (call) { return call[0] === 'navigation' }))
    assert.ok(runtime.systemCalls.some(function (call) { return call[0] === 'background' }))
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
