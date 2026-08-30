const test = require('node:test')
const assert = require('node:assert/strict')

const profilePresentation = require('../miniprogram/utils/profile-presentation')

test('未登录时始终展示品牌 Logo', function () {
  assert.equal(
    profilePresentation.displayAvatarUrl(false, { avatarUrl: 'wxfile://usr/selected-avatar.png' }),
    profilePresentation.DEFAULT_AVATAR_URL
  )
})

test('已登录但未选头像时回退品牌 Logo', function () {
  assert.equal(
    profilePresentation.displayAvatarUrl(true, { avatarUrl: '' }),
    profilePresentation.DEFAULT_AVATAR_URL
  )
})

test('已登录且已选头像时展示用户头像', function () {
  const avatarUrl = 'wxfile://usr/selected-avatar.png'
  assert.equal(
    profilePresentation.displayAvatarUrl(true, { avatarUrl: avatarUrl }),
    avatarUrl
  )
})
