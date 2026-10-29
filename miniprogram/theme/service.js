const registry = require('./registry')
const { createThemeStore } = require('./store')
const { createNativeChrome } = require('./native-chrome')
const lifecycle = require('./lifecycle')

const THEME_STORAGE_KEY = 'catledger_theme_v1'
const store = createThemeStore({
  read: () => wx.getStorageSync(THEME_STORAGE_KEY),
  write: themeId => wx.setStorageSync(THEME_STORAGE_KEY, themeId)
})
const nativeChrome = createNativeChrome(() => typeof wx === 'undefined' ? null : wx)
const mounted = new Set()
let installedApp = null

function mirrorApp(presentation, explicitApp) {
  const app = explicitApp || installedApp || (typeof getApp === 'function' ? getApp() : null)
  if (app && app.globalData) app.globalData.themeId = presentation.themeId
}

function currentPresentation() { return store.get() }
function initialData() { return currentPresentation() }
function currentTokens() { return registry.getThemeTokens(currentPresentation().themeId) }

function applyPresentation(instance, presentation) {
  const data = instance.data || {}
  if (!Object.keys(presentation).some(key => data[key] !== presentation[key])) return
  const changed = data.themeId !== presentation.themeId
  instance.setData(Object.assign({}, presentation))
  // SVG 等派生展示与主题一起更新，不等待下次业务请求或重新进入页面。
  if (changed && typeof instance.onThemeChange === 'function') instance.onThemeChange(presentation)
}

function attach(instance) {
  if (!instance || typeof instance.setData !== 'function') return
  mounted.add(instance)
  applyPresentation(instance, currentPresentation())
}

function detach(instance) {
  mounted.delete(instance)
  nativeChrome.detach(instance)
}

store.subscribe(presentation => {
  mirrorApp(presentation)
  // 原生层先发出配色；每个已挂载实例再同步视图，含不在当前栈的缓存 tab。
  nativeChrome.update(presentation)
  mounted.forEach(instance => applyPresentation(instance, presentation))
})

function install(app) {
  installedApp = app || (typeof getApp === 'function' ? getApp() : null)
  const presentation = currentPresentation()
  mirrorApp(presentation, installedApp)
  return presentation
}

function selectTheme(themeId, app) {
  const presentation = store.select(themeId)
  mirrorApp(presentation, app)
  return presentation
}

const controller = {
  initialData,
  attach,
  detach,
  activate: instance => nativeChrome.activate(instance, currentPresentation()),
  hide: instance => nativeChrome.hide(instance)
}

module.exports = {
  THEME_STORAGE_KEY,
  currentPresentation,
  currentTokens,
  initialData,
  install,
  selectTheme,
  page: definition => lifecycle.page(definition, controller),
  component: definition => lifecycle.component(definition, controller)
}
