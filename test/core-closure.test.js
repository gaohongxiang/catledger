const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('protected subpages share the same login sheet component', () => {
  for (const page of ['accounts', 'categories', 'transaction-editor', 'statistics', 'import-workbench']) {
    const config = JSON.parse(read(`miniprogram/pages/${page}/index.json`))
    assert.equal(config.usingComponents['login-sheet'], '/components/login-sheet/index')
    assert.match(read(`miniprogram/pages/${page}/index.wxml`), /id="page-login-sheet"/)
    assert.match(read(`miniprogram/pages/${page}/index.js`), /loginGuard\.run/)
  }
  const tabConfig = JSON.parse(read('miniprogram/custom-tab-bar/index.json'))
  assert.equal(tabConfig.usingComponents['login-sheet'], '/components/login-sheet/index')
})

test('profile keeps personal settings and does not duplicate ledger settings', () => {
  const profile = read('miniprogram/pages/profile/index.wxml')
  assert.doesNotMatch(profile, /账本设置|openLedger/)
  assert.match(profile, />主题</)
  assert.match(profile, />数据与隐私</)
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
  const source = read('miniprogram/pages/index/index.js')
  assert.match(source, /api\.callApi\('dashboard\.get'/)
  assert.match(source, /error\.code !== 'INITIALIZATION_REQUIRED'/)
  assert.match(source, /return api\.bootstrap\(\)\.then/)
  assert.doesNotMatch(source, /ensureBootstrap/)
})
