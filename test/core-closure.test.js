const assert = require('node:assert/strict')
const { readSource } = require('./helpers/source-files')
const path = require('node:path')
const test = require('node:test')
const { pageRoute } = require('./helpers/page-routes')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return readSource(path.join(root, relativePath))
}

test('protected subpages and the main host share the same login sheet component', () => {
  for (const page of ['accounts', 'categories', 'transaction-editor', 'import-workbench']) {
    const directory = path.posix.dirname(pageRoute(page))
    const config = JSON.parse(read(`miniprogram/${directory}/index.json`))
    assert.equal(config.usingComponents['login-sheet'], '/components/login-sheet/index')
    assert.match(read(`miniprogram/${directory}/index.wxml`), /id="page-login-sheet"/)
    const controller = page === 'import-workbench' ? 'runtime' : 'index'
    if (page === 'import-workbench') assert.match(read(`miniprogram/${directory}/index.js`), /onLoad:\s*runtime\.onLoad/)
    assert.match(read(`miniprogram/${directory}/${controller}.js`), /loginGuard\.run/)
  }
  const tabConfig = JSON.parse(read('miniprogram/custom-tab-bar/index.json'))
  assert.equal(tabConfig.usingComponents['login-sheet'], '/components/login-sheet/index')
  assert.match(read('miniprogram/custom-tab-bar/index.wxml'), /<login-sheet id="loginSheet"/)
  assert.match(read('miniprogram/pages/statistics/page.js'), /loginGuard\.run/)
  assert.match(read('miniprogram/shell/panel.js'), /requestLogin:[\s\S]*bar\.requestLogin/)
  const hostConfig = JSON.parse(read('miniprogram/shell/index.json'))
  assert.equal(hostConfig.usingComponents['main-tabs'], '/custom-tab-bar/index')
})

test('profile keeps personal settings and does not duplicate ledger settings', () => {
  const profile = read('miniprogram/pages/profile/panel.wxml')
  assert.doesNotMatch(profile, /账本设置|openLedger/)
  assert.match(profile, /title="主题"/)
  assert.match(profile, /title="数据与隐私"/)
})

test('public contract exposes category lifecycle and linked refunds', () => {
  const contract = JSON.parse(read('shared/catledger-api.json'))
  for (const action of [
    'categories.list', 'categories.create', 'categories.update',
    'categories.archive', 'categories.restore', 'categories.reorder',
    'transactions.refundable'
  ]) {
    assert.ok(contract.actions[action], action)
  }
  assert.match(contract.rules.refund, /original expense/)
})

test('home requests the dashboard directly and bootstraps only an uninitialized user', () => {
  const source = read('miniprogram/pages/index/page.js')
  assert.match(source, /api\.callApi\('dashboard\.get'/)
  assert.match(source, /error\.code !== 'INITIALIZATION_REQUIRED'/)
  assert.match(source, /return api\.bootstrap\(\{ force: true \}\)\.then/)
  assert.doesNotMatch(source, /ensureBootstrap/)
})
