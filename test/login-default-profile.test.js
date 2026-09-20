const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const profilePresentation = require('../miniprogram/utils/profile-presentation')

function loadApp(storage, saveFile) {
  let app
  let saves = 0
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/app.js'), 'utf8'), {
    require: function (name) {
      if (name === './services/export-files') return require('../miniprogram/services/export-files')
      if (name === './utils/profile-presentation') return profilePresentation
      if (name === './services/read-cache') return { reset() {}, bindScope() {} }
      if (name === './services/catledger-api') return { revalidateForeground: () => Promise.resolve() }
      if (name === './theme/service') return { install: function () {} }
      return {}
    },
    App: function (definition) { app = definition },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      cloud: { init: function () {} },
      saveFile: function (options) { saves++; if (saveFile) saveFile(options); else options.success({ savedFilePath: 'wxfile://usr/avatar.png' }) },
      removeSavedFile: function () {}
    }
  })
  app.onLaunch()
  return { app, saves: () => saves }
}

test('启动不生成昵称，成功保存的默认资料跨重启稳定且退出保留', async () => {
  const storage = new Map()
  const first = loadApp(storage)
  assert.equal(storage.size, 0)
  const profile = profilePresentation.withDefaultProfile({})
  assert.equal(profile.avatarUrl, profilePresentation.DEFAULT_AVATAR_URL)
  assert.ok(Array.from(profile.nickname).length > 0 && Array.from(profile.nickname).length <= 6)
  assert.doesNotMatch(profile.nickname, /[0-9]/)
  assert.notEqual(profilePresentation.randomNickname(profile.nickname), profile.nickname)
  await first.app.saveLocalProfile(profile)
  const next = loadApp(storage)
  assert.equal(next.app.globalData.profile.nickname, profile.nickname)
  assert.equal(next.app.hasLoginApproval(), false)
  await next.app.saveLocalProfile({ nickname: '   ', avatarUrl: profile.avatarUrl })
  assert.equal(next.app.globalData.profile.nickname, profile.nickname)
  assert.equal(next.saves(), 0, '包内头像不得传给临时文件保存接口')
  next.app.logoutWechatAccount()
  assert.equal(storage.size, 1, '退出仅移除登录许可，保留展示资料以供重登')
  assert.equal(next.app.globalData.profile.nickname, profile.nickname)
  assert.equal(next.app.hasLoginApproval(), false)
})

test('已有自选资料优先，临时头像照常持久化', async () => {
  const storage = new Map([['catledger_local_profile_v1', { nickname: '自选昵称', avatarUrl: 'wxfile://usr/old.png' }]])
  const loaded = loadApp(storage)
  assert.equal(loaded.app.globalData.profile.nickname, '自选昵称')
  assert.equal(loaded.app.globalData.profile.avatarUrl, 'wxfile://usr/old.png')
  await loaded.app.saveLocalProfile({ nickname: '新的昵称', avatarUrl: 'wxfile://tmp/new.png' })
  assert.equal(loaded.saves(), 1)
  assert.equal(loadApp(storage).app.globalData.profile.nickname, '新的昵称')
  assert.equal(loadApp(storage).app.globalData.profile.avatarUrl, 'wxfile://usr/avatar.png')
})

test('真机和模拟器的已保存头像重登时均直接复用', async () => {
  for (const avatarUrl of ['wxfile://usr/avatar.png', 'http://usr/avatar.png', 'https://usr/avatar.png']) {
    const { app, saves } = loadApp(new Map())
    await app.saveLocalProfile({ nickname: '账号昵称', avatarUrl })
    assert.equal(saves(), 0)
    assert.equal(app.globalData.profile.avatarUrl, avatarUrl)
  }
})

test('头像存储失败保留原资料，异步保存不得覆盖新昵称或失效会话', async () => {
  const storage = new Map([['catledger_local_profile_v1', { nickname: '原昵称', avatarUrl: 'wxfile://usr/old.png' }]])
  let complete
  const { app } = loadApp(storage, options => { complete = options })
  const failed = app.saveLocalProfile({ nickname: '新昵称', avatarUrl: 'wxfile://tmp/new.png' })
  complete.fail()
  await assert.rejects(failed, /头像保存失败/)
  assert.equal(app.globalData.profile.nickname, '原昵称')
  assert.equal(app.globalData.profile.avatarUrl, 'wxfile://usr/old.png')
  const saving = app.saveLocalProfile({ avatarUrl: 'wxfile://tmp/new.png' }, { avatarOnly: true })
  app.setLocalNickname('云端新昵称')
  complete.success({ savedFilePath: 'wxfile://usr/new.png' })
  await saving
  assert.equal(app.globalData.profile.nickname, '云端新昵称')
  let current = true
  const stale = app.saveLocalProfile({ nickname: '迟到昵称', avatarUrl: 'wxfile://tmp/stale.png' }, { isCurrent: () => current })
  current = false
  complete.success({ savedFilePath: 'wxfile://usr/stale.png' })
  await stale
  assert.equal(app.globalData.profile.nickname, '云端新昵称')
  assert.equal(app.globalData.profile.avatarUrl, 'wxfile://usr/new.png')
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

function loadLoginSheet(app, api, currentPage) {
  let definition
  const events = []
  const cache = require('../miniprogram/services/read-cache').createReadCache()
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/login-sheet/index.js'), 'utf8'), {
    getApp: () => app,
    getCurrentPages: () => currentPage ? [currentPage] : [],
    Component: value => { definition = value },
    require: name => {
      if (name === '../../services/catledger-api') return api
      if (name === '../../services/read-cache') return cache
      if (name === '../../utils/profile-presentation') return profilePresentation
      if (name === '../../theme/service') return { currentPresentation: () => ({}) }
      throw new Error(name)
    },
    wx: { showToast: () => {} }
  })
  const sheet = Object.assign({}, definition.methods, {
    data: Object.assign({}, definition.data),
    setData(patch) { Object.assign(this.data, patch) },
    triggerEvent(name) { events.push(name) }
  })
  return { sheet, events, cache,
    ready: () => definition.lifetimes.ready.call(sheet),
    showPage: () => definition.pageLifetimes.show.call(sheet),
    detach: () => definition.lifetimes.detached.call(sheet) }
}

test('冷启动自动识别当前微信：没有本机登录记录的老用户也直接进入原账本', async () => {
  for (const savedApproval of [false, true]) {
    const storage = new Map(savedApproval ? [['catledger_wechat_login_v1', true]] : [])
    const { app } = loadApp(storage)
    let resolve, identifies = 0, refreshes = 0
    const api = { identifyWechatAccount: () => {
      identifies++
      return new Promise(done => { resolve = done })
    } }
    const page = { onShow() { refreshes++ } }
    const tab = loadLoginSheet(app, api, page)
    const pageSheet = loadLoginSheet(app, api, page)
    const pending = tab.ready()
    await pageSheet.ready()
    await tab.showPage()
    assert.equal(identifies, 1, '多个组件与重复展示只承接一次启动识别')
    assert.equal(tab.sheet.data.stage, 'loading')
    assert.equal(tab.sheet.data.automatic, true)
    assert.equal(pageSheet.sheet.data.open, false)
    assert.equal(app.hasLoginApproval(), false, '旧本机标记不能跳过当前微信身份确认')
    resolve({ uid: '1234567890', nickname: '云端原昵称', categories: [{ id: 'synthetic-category' }] })
    await pending
    assert.equal(app.hasLoginApproval(), true)
    assert.equal(app.globalData.uid, '1234567890')
    assert.equal(app.globalData.profile.nickname, '云端原昵称')
    assert.equal(app.globalData.categories.length, 1)
    assert.equal(tab.sheet.data.open, false)
    assert.equal(refreshes, 1, '自动进入后刷新当前账本页面')
    app.onHide()
    app.onShow()
    await tab.showPage()
    assert.equal(identifies, 1, '后台回前台保留当前会话，不重复弹出识别界面')
  }
})

test('冷启动只有未设置账号昵称才显示一次资料设置，保存后直接进入', async () => {
  const { app } = loadApp(new Map())
  let updates = 0, refreshes = 0
  const ui = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', nickname: '', categories: [] }),
    createRequestId: () => '00000000-0000-4000-8000-000000000002',
    initializeProfileAfterConsent: async ({ nickname }) => { updates++; return { nickname } }
  }, { onShow() { refreshes++ } })
  await ui.ready()
  assert.equal(ui.sheet.data.stage, 'setup')
  assert.equal(app.hasLoginApproval(), false)
  assert.equal(updates, 0)
  await ui.sheet.confirm({ detail: { value: { nickname: '首次自选昵称' } } })
  assert.equal(updates, 1)
  assert.equal(refreshes, 1)
  assert.equal(app.globalData.profile.nickname, '首次自选昵称')
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(ui.sheet.data.open, false)
})

test('首次设置只接受一至六字，旧本机长昵称仅裁成待确认草稿', async () => {
  const legacy = '以前保存的完整长昵称'
  const storage = new Map([['catledger_local_profile_v1', { nickname: legacy }]])
  const { app } = loadApp(storage)
  let updates = 0
  const ui = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', nickname: '', categories: [] }),
    createRequestId: () => '00000000-0000-4000-8000-000000000002',
    initializeProfileAfterConsent: async ({ nickname }) => { updates++; return { nickname } }
  })
  await ui.ready()
  assert.equal(ui.sheet.data.nickname, '以前保存的完')
  assert.equal(storage.get('catledger_local_profile_v1').nickname, legacy)
  for (const nickname of [' ', '一二三四五六七']) {
    await ui.sheet.confirm({ detail: { value: { nickname } } })
    assert.equal(ui.sheet.data.errorMessage, '昵称需填写 1～6 个字')
    assert.equal(updates, 0)
    assert.equal(app.hasLoginApproval(), false)
  }
  await ui.sheet.confirm({ detail: { value: { nickname: ' 一二三四五🐱 ' } } })
  assert.equal(updates, 1)
  assert.equal(app.globalData.profile.nickname, '一二三四五🐱')
  assert.equal(app.hasLoginApproval(), true)
})

test('已有长昵称直接登录，更换头像与重启也不会截短账号昵称', async () => {
  const legacy = '以前保存的完整长昵称'
  const storage = new Map()
  const { app } = loadApp(storage)
  const ui = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', nickname: legacy, categories: [] })
  })
  await ui.ready()
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(ui.sheet.data.open, false)
  await app.saveLocalProfile({ nickname: legacy, avatarUrl: 'wxfile://tmp/new.png' }, { avatarOnly: true })
  assert.equal(app.globalData.profile.nickname, legacy)
  assert.equal(loadApp(storage).app.globalData.profile.nickname, legacy)
})

test('自动识别失败不沿用旧许可，重试恢复原昵称；退出和取消后本次会话不自动重登', async () => {
  const storage = new Map([['catledger_wechat_login_v1', true]])
  const { app } = loadApp(storage)
  let calls = 0
  const api = { identifyWechatAccount: async () => {
    if (++calls === 1) throw new Error('连接失败')
    return { uid: '1234567890', nickname: '原昵称', categories: [] }
  } }
  const ui = loadLoginSheet(app, api)
  await ui.ready()
  assert.equal(ui.sheet.data.stage, 'error')
  assert.equal(ui.sheet.data.nickname, '')
  assert.equal(app.hasLoginApproval(), false)
  await ui.sheet.confirm()
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(app.globalData.profile.nickname, '原昵称')
  app.logoutWechatAccount()
  await loadLoginSheet(app, api).ready()
  app.onHide(); app.onShow()
  await ui.showPage()
  assert.equal(app.hasLoginApproval(), false)
  assert.equal(calls, 2, '退出后切页或返回前台不会立即登录')
  const restart = loadApp(storage)
  await loadLoginSheet(restart.app, api).ready()
  assert.equal(restart.app.hasLoginApproval(), true, '下次冷启动仍能识别原微信账号')

  const firstUse = loadApp(new Map()).app
  const draft = loadLoginSheet(firstUse, { identifyWechatAccount: async () => ({ nickname: '', categories: [] }) })
  await draft.ready()
  draft.sheet.close()
  await draft.showPage()
  assert.equal(draft.sheet.data.open, false, '取消设置后本次会话可以浏览公开页面')
})

test('启动组件卸载后迟到识别不登录，下一入口重新承接识别', async () => {
  const { app } = loadApp(new Map())
  let resolve
  const first = loadLoginSheet(app, { identifyWechatAccount: () => new Promise(done => { resolve = done }) })
  const pending = first.ready()
  first.detach()
  resolve({ uid: '1234567890', nickname: '迟到昵称', categories: [] })
  await pending
  assert.equal(app.hasLoginApproval(), false)
  const next = loadLoginSheet(app, { identifyWechatAccount: async () => ({ uid: '1234567890', nickname: '当前昵称', categories: [] }) })
  await next.ready()
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(app.globalData.profile.nickname, '当前昵称')
})

test('点击登录后先识别，新用户只确认一次资料，重登直接沿用账号昵称', async () => {
  const storage = new Map()
  const { app } = loadApp(storage)
  let savedNickname = ''
  let updates = 0, callbacks = 0, identifies = 0
  const api = {
    identifyWechatAccount: async () => {
      identifies++
      return { uid: '1234567890', categories: [], nickname: savedNickname }
    },
    createRequestId: () => '00000000-0000-4000-8000-000000000001',
    initializeProfileAfterConsent: async data => {
      assert.equal(app.hasLoginApproval(), false)
      updates++
      savedNickname = data.nickname
      return { nickname: savedNickname }
    }
  }
  const first = loadLoginSheet(app, api)
  const identifying = first.sheet.show({ afterLogin: () => { callbacks++ } })
  assert.equal(first.sheet.data.stage, 'loading')
  await first.sheet.show()
  await identifying
  assert.equal(identifies, 1, '重复点击只识别一次')
  assert.equal(first.sheet.data.stage, 'setup')
  assert.ok(first.sheet.data.nickname)
  assert.equal(storage.size, 0, '建议昵称仅在表单中，不提前落盘')
  assert.equal(app.hasLoginApproval(), false)
  await first.sheet.confirm({ detail: { value: { nickname: '微信候选昵称' } } })
  assert.equal(updates, 1)
  assert.equal(app.globalData.profile.nickname, '微信候选昵称', '保存提交时原生昵称框的最新值')
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(callbacks, 1)
  assert.deepEqual(first.events, ['success'])

  app.logoutWechatAccount()
  const relaunched = loadApp(storage)
  const returning = loadLoginSheet(relaunched.app, api)
  await returning.sheet.show()
  assert.equal(returning.sheet.data.open, false)
  assert.notEqual(returning.sheet.data.stage, 'setup')
  assert.equal(relaunched.app.globalData.profile.nickname, savedNickname)
  assert.equal(relaunched.app.hasLoginApproval(), true)
  assert.equal(updates, 1, '老用户不重新提交资料')
})

test('旧版本机昵称只作为首次设置草稿，取消不写入账号', async () => {
  const storage = new Map([['catledger_local_profile_v1', { nickname: '旧版自选昵称', avatarUrl: '' }]])
  const { app } = loadApp(storage)
  let updates = 0
  const { sheet } = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', categories: [], nickname: '' }),
    initializeProfileAfterConsent: async () => { updates++ }
  })
  await sheet.show()
  assert.equal(sheet.data.nickname, '旧版自选昵称')
  sheet.bindNickname({ detail: { value: '未保存的草稿' } })
  sheet.close()
  assert.equal(updates, 0)
  assert.equal(app.hasLoginApproval(), false)
  assert.equal(app.globalData.profile.nickname, '旧版自选昵称')
})

test('首次保存失败可沿用原请求重试，未成功前不开放账本', async () => {
  const { app } = loadApp(new Map())
  const updates = []
  let requestNumber = 0
  const { sheet } = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', categories: [], nickname: '' }),
    createRequestId: () => 'request-' + ++requestNumber,
    initializeProfileAfterConsent: async data => {
      updates.push(data)
      if (updates.length === 1) throw new Error('模拟网络中断')
      return { nickname: data.nickname }
    }
  })
  await sheet.show()
  sheet.bindNickname({ detail: { value: '固定昵称' } })
  await sheet.confirm()
  assert.equal(app.hasLoginApproval(), false)
  assert.equal(sheet.data.stage, 'setup')
  assert.equal(sheet.data.nickname, '固定昵称')
  assert.match(sheet.data.errorMessage, /网络中断/)
  sheet.blurNickname({ detail: { value: '固定昵称' } })
  await sheet.confirm()
  assert.equal(updates[0].requestId, updates[1].requestId)
  assert.equal(app.hasLoginApproval(), true)
})

test('识别失败只显示重试，不能把连接失败当成新用户', async () => {
  const { app } = loadApp(new Map())
  let calls = 0
  const { sheet } = loadLoginSheet(app, {
    identifyWechatAccount: async () => {
      if (++calls === 1) throw new Error('模拟连接失败')
      return { uid: '1234567890', categories: [], nickname: '已保存昵称' }
    }
  })
  await sheet.show()
  assert.equal(sheet.data.stage, 'error')
  assert.equal(sheet.data.nickname, '')
  assert.equal(app.hasLoginApproval(), false)
  await sheet.confirm()
  assert.equal(sheet.data.open, false)
  assert.equal(app.globalData.profile.nickname, '已保存昵称')
})

test('老用户重登不重新保存头像，旧临时头像失效也不阻塞账本', async () => {
  const storage = new Map([['catledger_local_profile_v1', { nickname: '本机昵称', avatarUrl: 'wxfile://tmp/expired.png' }]])
  const { app, saves } = loadApp(storage, options => options.fail())
  const { sheet } = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', categories: [], nickname: '账号昵称' })
  })
  await sheet.show()
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(sheet.data.open, false)
  assert.equal(app.globalData.profile.nickname, '账号昵称')
  assert.equal(saves(), 0)
})

test('取消登录或切换会话后，迟到的微信识别结果不登录也不回填资料', async () => {
  for (const cancel of ['close', 'session']) {
    const { app } = loadApp(new Map())
    let resolve
    const h = loadLoginSheet(app, {
      identifyWechatAccount: () => new Promise(done => { resolve = done })
    })
    const pending = h.sheet.show()
    if (cancel === 'close') h.sheet.close()
    else h.cache.reset()
    resolve({ uid: '1234567890', categories: [], nickname: '迟到资料' })
    await pending
    assert.equal(app.hasLoginApproval(), false)
    assert.equal(app.globalData.profile.nickname, '')
    assert.deepEqual(h.events, [])
  }
})

test('另一设备先完成首次设置时只恢复账号资料，不覆盖昵称', async () => {
  const { app } = loadApp(new Map())
  let reads = 0
  const { sheet } = loadLoginSheet(app, {
    identifyWechatAccount: async () => ({ uid: '1234567890', categories: [], nickname: reads++ ? '另一设备昵称' : '' }),
    createRequestId: () => '00000000-0000-4000-8000-000000000002',
    initializeProfileAfterConsent: async () => { throw Object.assign(new Error('冲突'), { code: 'CONFLICT' }) }
  })
  await sheet.show()
  await sheet.confirm()
  assert.equal(app.hasLoginApproval(), true)
  assert.equal(app.globalData.profile.nickname, '另一设备昵称')
  assert.equal(sheet.data.open, false)
})
