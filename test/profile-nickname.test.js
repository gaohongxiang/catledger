const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { createRequire } = require('node:module')

const filename = path.join(__dirname, '../miniprogram/pages/profile/index.js')

function runtime(profileResponse, updateResponse) {
  let definition
  const calls = [], toasts = []
  let active = true
  let requestNumber = 190
  const app = {
    globalData: { profile: { nickname: '本机旧昵称', avatarUrl: '' }, uid: '1234567890' },
    hasLoginApproval() { return active },
    setLocalNickname(nickname) { this.globalData.profile.nickname = nickname },
    async saveLocalProfile(profile) { this.globalData.profile = profile; return profile }
  }
  const api = {
    isFresh: () => false,
    createRequestId: () => '00000000-0000-4000-8000-' + String(++requestNumber).padStart(12, '0'),
    callApi: async (action, data) => {
      calls.push({ action, data })
      if (action === 'catalog.get') return { uid: '1234567890', accounts: [], categories: [] }
      if (action === 'profile.get') return profileResponse()
      if (action === 'profile.update') return updateResponse ? updateResponse(data) : { nickname: data.nickname }
      throw new Error(action)
    }
  }
  const req = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value },
    getApp: () => app,
    wx: { showToast(options) { toasts.push(options.title) } },
    require(name) {
      if (name === '../../services/catledger-api') return api
      if (name === '../../theme/service') return { bindPage() {} }
      if (name === '../../services/page-read-session') {
        return { begin: () => () => active, capture: () => () => active, isCurrent: () => active }
      }
      return req(name)
    }
  }, { filename })
  const page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
    setData(patch) { Object.assign(this.data, patch) },
    getTabBar: () => null
  })
  return { page, app, calls, toasts, setActive(value) { active = value } }
}

test('我的读取账号昵称并以当前值保存修改', async () => {
  const h = runtime(() => ({ nickname: '账号昵称' }))
  await h.page.onShow()
  assert.equal(h.page.data.nickname, '账号昵称')
  assert.equal(h.app.globalData.profile.nickname, '账号昵称')
  h.page.startEditNickname()
  h.page.bindNicknameDraft({ detail: { value: ' 新昵称 ' } })
  await h.page.saveNickname()
  const update = h.calls.find(call => call.action === 'profile.update')
  assert.equal(update.data.previousNickname, '账号昵称')
  assert.equal(update.data.nickname, '新昵称')
  assert.equal(h.page.data.nickname, '新昵称')
  assert.equal(h.app.globalData.profile.nickname, '新昵称')
  assert.deepEqual(h.toasts, ['昵称已保存'])
})

test('昵称修改拒绝空值或七字，六字可保存且按 Unicode 字符计数', async () => {
  const h = runtime(() => ({ nickname: '原昵称' }))
  await h.page.onShow()
  h.page.startEditNickname()
  for (const nickname of ['   ', '一二三四五六七']) {
    h.page.bindNicknameDraft({ detail: { value: nickname } })
    await h.page.saveNickname()
    assert.equal(h.page.data.nicknameError, '昵称需填写 1～6 个字')
    assert.equal(h.calls.filter(call => call.action === 'profile.update').length, 0)
  }
  h.page.bindNicknameDraft({ detail: { value: ' 一二三四五🐱 ' } })
  await h.page.saveNickname()
  assert.equal(h.page.data.nickname, '一二三四五🐱')
  assert.equal(h.calls.filter(call => call.action === 'profile.update').length, 1)
})

test('旧长昵称读取和取消编辑不改写，主动改名保留完整旧值用于冲突校验', async () => {
  const legacy = '以前保存的完整长昵称'
  const h = runtime(() => ({ nickname: legacy }))
  await h.page.onShow()
  h.page.startEditNickname()
  assert.equal(h.page.data.nicknameDraft, legacy)
  h.page.cancelEditNickname()
  assert.equal(h.page.data.nickname, legacy)
  assert.equal(h.app.globalData.profile.nickname, legacy)
  assert.equal(h.calls.filter(call => call.action === 'profile.update').length, 0)
  h.page.startEditNickname()
  h.page.bindNicknameDraft({ detail: { value: '新昵称' } })
  await h.page.saveNickname()
  assert.equal(h.calls.find(call => call.action === 'profile.update').data.previousNickname, legacy)
})

test('我的可更换头像，保存失败保留原图并可再次选择', async () => {
  const h = runtime(() => ({ nickname: '账号昵称' }))
  await h.page.onShow()
  const original = h.page.data.displayAvatarUrl
  h.app.saveLocalProfile = async () => { throw new Error('头像保存失败，请重新选择') }
  await h.page.chooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/new.png' } })
  assert.equal(h.page.data.displayAvatarUrl, original)
  assert.equal(h.page.data.savingAvatar, false)
  assert.match(h.page.data.avatarError, /重新选择/)
  h.app.saveLocalProfile = async profile => ({ ...profile, avatarUrl: 'wxfile://usr/new.png' })
  await h.page.chooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/new.png' } })
  assert.equal(h.page.data.displayAvatarUrl, 'wxfile://usr/new.png')
  assert.deepEqual(h.toasts, ['头像已保存'])
})

test('昵称读取失败保留本机旧昵称，退出后的迟到响应不回填', async () => {
  let resolveProfile
  const h = runtime(() => new Promise(resolve => { resolveProfile = resolve }))
  const loading = h.page.onShow()
  assert.equal(h.page.data.nickname, '本机旧昵称')
  h.setActive(false)
  resolveProfile({ nickname: '其他会话昵称' })
  await loading
  assert.equal(h.page.data.nickname, '本机旧昵称')
  assert.equal(h.app.globalData.profile.nickname, '本机旧昵称')
})

test('昵称被其他设备修改后，刷新并换请求编号可继续保存', async () => {
  let serverNickname = '原昵称'
  let firstUpdate = true
  const h = runtime(() => ({ nickname: serverNickname }), data => {
    if (firstUpdate) {
      firstUpdate = false
      serverNickname = '其他设备昵称'
      throw Object.assign(new Error('冲突'), { code: 'CONFLICT' })
    }
    serverNickname = data.nickname
    return { nickname: serverNickname }
  })
  await h.page.onShow()
  h.page.startEditNickname()
  h.page.bindNicknameDraft({ detail: { value: '我的新昵称' } })
  await h.page.saveNickname()
  assert.match(h.page.data.nicknameError, /刷新后重试/)
  await h.page.loadNickname({ force: true })
  await h.page.saveNickname()
  const updates = h.calls.filter(call => call.action === 'profile.update').map(call => call.data)
  assert.equal(updates.length, 2)
  assert.notEqual(updates[0].requestId, updates[1].requestId)
  assert.equal(updates[1].previousNickname, '其他设备昵称')
  assert.equal(h.page.data.nickname, '我的新昵称')
})
