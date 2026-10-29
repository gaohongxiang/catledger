const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { createLoader } = require('./helpers/vm-loader')
const { pageDefinition } = require('./helpers/page-definitions')

function profilePage() {
  const root = path.join(__dirname, '../miniprogram')
  let resolveCatalog
  const catalog = new Promise(function (resolve) { resolveCatalog = resolve })
  const app = { globalData: { profile: { nickname: '测试用户' }, categories: [] }, hasLoginApproval: function () { return true } }
  const api = { isFresh: () => false, cacheToken: () => null, callApi: function () { return catalog } }
  const wx = {}, themeService = { page: definition => definition, component: definition => definition }
  const load = createLoader({ getApp: () => app, wx }, filename => filename.endsWith('/services/catledger-api.js') ? api : undefined)
  const definition = pageDefinition(root, 'pages/profile/index', load, { app, api, themeService, wx })
  const page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
    setData: function (patch) { Object.assign(this.data, patch) },
    getTabBar: function () { return null }
  })
  return { page: page, app: app, resolveCatalog: resolveCatalog }
}

test('返回个人页时，延迟刷新保留已连接状态和已有数量', async function () {
  const runtime = profilePage()
  const page = runtime.page
  Object.assign(page.data, { loggedIn: true, connected: true, accountCount: 8, categoryCount: 16 })
  const pending = page.onShow()
  assert.equal(page.data.loading, true)
  assert.equal(page.data.accountCount, 8)
  assert.equal(page.data.categoryCount, 16)
  assert.equal(page.data.connected, true)
  runtime.resolveCatalog({ accounts: [{}, {}], categories: [{ id: 'a' }] })
  await pending
  assert.equal(page.data.loading, false)
  assert.equal(page.data.accountCount, 2)
  assert.equal(page.data.categoryCount, 1)
})

test('退出登录后进入个人页仍清除旧数量和连接状态', function () {
  const runtime = profilePage()
  Object.assign(runtime.page.data, { loggedIn: true, connected: true, accountCount: 8, categoryCount: 16 })
  runtime.app.hasLoginApproval = function () { return false }
  runtime.page.onShow()
  assert.equal(runtime.page.data.loggedIn, false)
  assert.equal(runtime.page.data.connected, false)
  assert.equal(runtime.page.data.accountCount, 0)
  assert.equal(runtime.page.data.categoryCount, 0)
})
