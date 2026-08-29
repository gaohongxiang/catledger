const registry = require('./registry')

const THEME_STORAGE_KEY = 'catledger_theme_v1'

function appInstance(explicitApp) {
  if (explicitApp) {
    return explicitApp
  }
  return typeof getApp === 'function' ? getApp() : null
}

function readStoredThemeId() {
  try {
    return registry.normalizeThemeId(wx.getStorageSync(THEME_STORAGE_KEY))
  } catch (error) {
    return registry.DEFAULT_THEME_ID
  }
}

function currentPresentation(explicitApp) {
  const app = appInstance(explicitApp)
  const themeId = app && app.globalData && app.globalData.themeId
    ? app.globalData.themeId
    : readStoredThemeId()
  return registry.getThemePresentation(themeId)
}

function currentTokens(explicitApp) {
  return registry.getTheme(currentPresentation(explicitApp).themeId).tokens
}

function applySystemChrome(themeId) {
  const theme = registry.getTheme(themeId)
  wx.setNavigationBarColor({
    frontColor: theme.tokens.navFront,
    backgroundColor: theme.tokens.navBackground,
    animation: { duration: 180, timingFunc: 'easeIn' }
  })
  if (typeof wx.setBackgroundColor === 'function') {
    wx.setBackgroundColor({
      backgroundColor: theme.tokens.page,
      backgroundColorTop: theme.tokens.page,
      backgroundColorBottom: theme.tokens.canvasBottom
    })
  }
}

function install(explicitApp) {
  const app = appInstance(explicitApp)
  const presentation = registry.getThemePresentation(readStoredThemeId())
  if (app && app.globalData) {
    app.globalData.themeId = presentation.themeId
  }
  applySystemChrome(presentation.themeId)
  return presentation
}

function selectTheme(themeId, explicitApp) {
  const app = appInstance(explicitApp)
  const presentation = registry.getThemePresentation(themeId)
  wx.setStorageSync(THEME_STORAGE_KEY, presentation.themeId)
  if (app && app.globalData) {
    app.globalData.themeId = presentation.themeId
  }
  applySystemChrome(presentation.themeId)
  return presentation
}

function bindTabBar(tabBar) {
  if (!tabBar || typeof tabBar.setData !== 'function') {
    return
  }
  tabBar.setData(currentPresentation())
}

function bindPage(page) {
  if (!page || typeof page.setData !== 'function') {
    return
  }
  const presentation = currentPresentation()
  page.setData(presentation)
  applySystemChrome(presentation.themeId)
  if (typeof page.getTabBar === 'function') {
    bindTabBar(page.getTabBar())
  }
}

module.exports = {
  THEME_STORAGE_KEY: THEME_STORAGE_KEY,
  bindPage: bindPage,
  bindTabBar: bindTabBar,
  currentPresentation: currentPresentation,
  currentTokens: currentTokens,
  install: install,
  selectTheme: selectTheme
}
