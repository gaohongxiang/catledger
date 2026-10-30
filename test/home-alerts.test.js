const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')
const { readSource } = require('./helpers/source-files')
const path = require('node:path')

const progressKey = storage => [...storage.keys()].find(key => key.endsWith(':progress'))

test('首页待核对读本机草稿进度：按用户保存，超过一天不再算数', () => {
  const h = runtime()
  const sessions = h.load('services/import-draft-session')
  assert.equal(sessions.savedProgress(), null, '没有草稿就是没有')
  sessions.rememberProgress('update-1', { pending: 12, categories: 39 })
  const saved = sessions.savedProgress()
  assert.equal(saved.updateId, 'update-1')
  assert.equal(saved.pending, 12)
  assert.equal(saved.categories, 39)
  assert.ok(saved.at > 0)
  const key = progressKey(h.storage)
  assert.ok(key && key.includes('1234567890'), '按当前用户隔离')
  // 草稿保 24 小时；更旧的数字不能再冒充当前待办。
  h.storage.set(key, Object.assign({}, h.storage.get(key), { at: Date.now() - 25 * 60 * 60 * 1000 }))
  assert.equal(sessions.savedProgress(), null)
})

test('入账或放弃后草稿进度随草稿一起清掉', () => {
  const h = runtime()
  const sessions = h.load('services/import-draft-session')
  sessions.rememberProgress('update-1', { pending: 2, categories: 0 })
  sessions.clearUpdate('update-1')
  assert.equal(sessions.savedProgress(), null)
  // 别的批次被清掉时不动当前进度。
  sessions.rememberProgress('update-2', { pending: 5, categories: 1 })
  sessions.clearUpdate('update-1')
  assert.equal(sessions.savedProgress().pending, 5)
})

test('工作台每次应用视图都把两个页签的待办数写给首页', () => {
  const source = readSource(path.join(__dirname, '../miniprogram/packages/finance/pages/import-workbench/runtime.js'))
  assert.match(source, /draftSessions\.rememberProgress\(view\.update\.updateId, \{/)
  assert.match(source, /pending: countOf\(patch\.reviewStatusTabs, 'pending'\)/)
  assert.match(source, /categories: countOf\(patch\.categoryStatusTabs, 'pending'\)/)
  assert.match(source, /if \(view\.update\.status === 'review'\) \{\n\s+const countOf/)
})
