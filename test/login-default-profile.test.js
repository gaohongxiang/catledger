const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const profilePresentation = require('../miniprogram/utils/profile-presentation')

function loadApp(storage) {
  let app
  let saves = 0
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/app.js'), 'utf8'), {
    require: function (name) {
      if (name === './utils/profile-presentation') return profilePresentation
      if (name === './services/read-cache') return { reset: function () {} }
      if (name === './theme/service') return { install: function () {} }
      return {}
    },
    App: function (definition) { app = definition },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      cloud: { init: function () {} },
      saveFile: function (options) { saves++; options.success({ savedFilePath: 'wxfile://usr/avatar.png' }) },
      removeSavedFile: function () {}
    }
  })
  app.onLaunch()
  return { app, saves: () => saves }
}

test('默认资料跨面板和重启稳定，生成资料不会授予登录许可', async () => {
  const storage = new Map()
  const first = loadApp(storage)
  assert.equal(storage.size, 0)
  const profile = first.app.prepareLoginProfile()
  assert.equal(profile.avatarUrl, profilePresentation.DEFAULT_AVATAR_URL)
  assert.ok(profile.nickname.length > 0 && profile.nickname.length <= 24)
  assert.doesNotMatch(profile.nickname, /[0-9]/)
  assert.notEqual(profilePresentation.randomNickname(profile.nickname), profile.nickname)
  assert.equal(first.app.prepareLoginProfile().nickname, profile.nickname)
  const next = loadApp(storage)
  assert.equal(next.app.prepareLoginProfile().nickname, profile.nickname)
  assert.equal(next.app.hasLoginApproval(), false)
  await next.app.saveLocalProfile({ nickname: '   ', avatarUrl: profile.avatarUrl })
  assert.equal(next.app.globalData.profile.nickname, profile.nickname)
  assert.equal(next.saves(), 0, '包内头像不得传给临时文件保存接口')
  next.app.logoutWechatAccount()
  assert.equal(storage.size, 0)
  assert.equal(next.app.globalData.profile.nickname, '')
})

test('已有自选资料优先，临时头像照常持久化', async () => {
  const storage = new Map([['catledger_local_profile_v1', { nickname: '自选昵称', avatarUrl: 'wxfile://usr/old.png' }]])
  const loaded = loadApp(storage)
  assert.equal(loaded.app.prepareLoginProfile().nickname, '自选昵称')
  assert.equal(loaded.app.globalData.profile.avatarUrl, 'wxfile://usr/old.png')
  await loaded.app.saveLocalProfile({ nickname: '新的昵称', avatarUrl: 'wxfile://tmp/new.png' })
  assert.equal(loaded.saves(), 1)
  assert.equal(loadApp(storage).app.globalData.profile.nickname, '新的昵称')
  assert.equal(loadApp(storage).app.globalData.profile.avatarUrl, 'wxfile://usr/avatar.png')
})


test('登录 uid 只保存在当前会话，重启重取、退出清空', async () => {
  const storage = new Map()
  const { app } = loadApp(storage)
  const uid = '1234567890'
  await app.completeWechatLogin([], uid)
  assert.equal(app.globalData.uid, uid)
  assert.doesNotMatch(JSON.stringify([...storage]), /1234567890|uid/)
  assert.equal(loadApp(storage).app.globalData.uid, '')
  app.logoutWechatAccount()
  assert.equal(app.globalData.uid, '')
  await app.completeWechatLogin([])
  assert.equal(app.globalData.uid, '', '旧后端缺少 uid 时不得生成替代 ID')
})
