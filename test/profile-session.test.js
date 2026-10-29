const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

function profileRuntime() {
  const h = runtime()
  h.app.setLocalNickname = function (nickname) { this.globalData.profile.nickname = nickname }
  h.app.globalData.profile = { nickname: '甲本机昵称', avatarUrl: 'wxfile://usr/profile-a.png' }
  h.respond = action => action === 'profile.get'
    ? { ok: true, data: { nickname: '甲云端昵称' } }
    : undefined
  return h
}

function switchToOfflineAccount(h) {
  h.cache.reset()
  h.uid = '2234567890'
  h.app.globalData.uid = h.uid
  h.app.globalData.profile = { nickname: '乙账号昵称', avatarUrl: 'wxfile://usr/profile-b.png' }
  h.intercept = async () => { throw new Error('合成离线') }
}

function assertCurrentProfile(page) {
  assert.equal(page.data.loggedIn, true)
  assert.equal(page.data.nickname, '乙账号昵称')
  assert.equal(page.data.displayAvatarUrl, 'wxfile://usr/profile-b.png')
  assert.equal(page.data.serverNickname, '')
  assert.equal(page.data.profileLoaded, false)
  assert.equal(page.data.accountCount, 0)
  assert.equal(page.data.categoryCount, 0)
  assert.equal(page.data.editingNickname, false)
  assert.equal(page.data.nicknameDraft, '')
  assert.equal(page.data.savingNickname, false)
  assert.equal(page.data.savingAvatar, false)
}

test('我的首次显示后换账号并离线，先清除旧会话再呈现当前昵称和头像', async () => {
  const h = profileRuntime(), page = h.page('profile')
  await page.onShow()
  assert.equal(page.data.nickname, '甲云端昵称')
  assert.equal(page.data.accountCount, 1)
  page.setData({ editingNickname: true, nicknameDraft: '甲未保存草稿', savingNickname: true, savingAvatar: true })

  switchToOfflineAccount(h)
  const loading = page.onShow()
  assertCurrentProfile(page)
  assert.equal(page.data.uid, '')
  assert.equal(page.data.displayUid, '')
  assert.equal(page.data.connected, false)
  await loading
  assertCurrentProfile(page)
  assert.match(page.data.errorMessage, /暂时不可用/)
  assert.match(page.data.nicknameError, /暂时不可用/)
  assert.equal(h.app.globalData.profile.nickname, '乙账号昵称')
})

test('我的登录成功入口换账号并离线，当前登录资料不被旧会话初始值覆盖', async () => {
  const h = profileRuntime(), page = h.page('profile')
  page.onWechatLoginSuccess()
  await Promise.all([page._profileLoad, page._nicknameLoad])
  assert.equal(page.data.nickname, '甲云端昵称')

  switchToOfflineAccount(h)
  page.onWechatLoginSuccess()
  const loading = Promise.all([page._profileLoad, page._nicknameLoad])
  assertCurrentProfile(page)
  assert.equal(page.data.uid, h.uid)
  assert.equal(page.data.connected, true)
  await loading
  assertCurrentProfile(page)
  assert.match(page.data.errorMessage, /暂时不可用/)
  assert.match(page.data.nicknameError, /暂时不可用/)
  assert.equal(h.app.globalData.profile.nickname, '乙账号昵称')
})
