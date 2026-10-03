const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime } = require('./helpers/read-runtime')

const flush = () => new Promise(resolve => setImmediate(resolve))
const identity = nickname => ({ ok: true, data: { nickname, categories: [] } })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function clock() {
  let now = 100000, sequence = 0
  const timers = new Map()
  return {
    Date: class extends Date { static now() { return now } },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    get pending() { return timers.size },
    jump(ms) { now += ms },
    async advance(ms) {
      const end = now + ms
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
      }
      now = end; await flush()
    }
  }
}
function startup() {
  const time = clock(), h = runtime(undefined, time), events = []
  h.app.approved = false
  Object.assign(h.app.globalData, { loginStartupPending: true, profile: {}, uid: '' })
  h.app.setLocalNickname = nickname => { h.app.globalData.profile.nickname = nickname }
  h.app.completeWechatLogin = async (categories, uid) => {
    h.app.globalData.uid = uid; h.app.globalData.categories = categories
    h.app.approved = true; h.app.globalData.loginStartupPending = false
  }
  const definition = h.load('components/login-sheet/index')
  const sheet = { ...definition.methods, data: { ...definition.data },
    setData(patch) { Object.assign(this.data, patch) }, triggerEvent(name) { events.push(name) } }
  return { h, time, sheet, events, detach: () => definition.lifetimes.detached.call(sheet) }
}
function launchApp(h) {
  const definition = h.load('app')
  Object.assign(h.app, definition, { globalData: { ...definition.globalData } })
  h.app.onLaunch()
}

test('启动请求在界面挂载前发出，先返回或稍后返回都只发一次并自动进入', async () => {
  for (const earlyResponse of [false, true]) {
    const { h, sheet, time, events } = startup(), response = deferred()
    h.respond = () => response.promise
    launchApp(h); await flush()
    assert.deepEqual(h.calls.map(call => call.action), ['bootstrap'], '不等登录组件 ready 才开始请求')
    assert.equal(sheet.data.open, false)
    assert.equal(h.app.hasLoginApproval(), false)
    await time.advance(500)
    if (earlyResponse) { response.resolve(identity('原账本昵称')); await flush() }
    let entered = 0
    const entering = sheet.show({ automatic: true, afterLogin: () => { entered++ } })
    if (!earlyResponse) { await flush(); response.resolve(identity('原账本昵称')) }
    await entering
    assert.equal(h.calls.length, 1, '提前返回的身份结果也不重复请求')
    assert.equal(h.app.hasLoginApproval(), true)
    assert.equal(sheet.data.open, false)
    assert.equal(entered, 1)
    assert.deepEqual(events, ['success'])
    assert.equal(time.pending, 0)
  }
})

test('提前请求失败后可重试，退出或长时间未挂载后的结果不复用', async () => {
  for (const boundary of ['failure', 'logout', 'expired']) {
    const { h, sheet, time } = startup(), response = deferred()
    let requests = 0
    h.respond = () => ++requests === 1 ? response.promise : identity('当前昵称')
    launchApp(h); await flush()
    if (boundary === 'logout') {
      h.app.logoutWechatAccount()
      response.resolve(identity('退出前昵称')); await flush()
      assert.equal(h.app.hasLoginApproval(), false)
      await sheet.show()
    } else if (boundary === 'expired') {
      response.resolve(identity('挂载前旧昵称')); await flush()
      await time.advance(15001)
      await sheet.show({ automatic: true })
    } else {
      response.resolve({ ok: false, error: { code: 'INVALID_STATE', message: '本次未成功' } }); await flush()
      await sheet.show({ automatic: true })
      assert.equal(sheet.data.stage, 'error')
      assert.equal(requests, 1)
      await sheet.confirm()
    }
    assert.equal(requests, 2)
    assert.equal(h.app.hasLoginApproval(), true)
    assert.equal(h.app.globalData.profile.nickname, '当前昵称')
    assert.equal(time.pending, 0)
  }
})

test('身份确认前不进入首页，成功后自动打开账本且没有额外等待', async () => {
  const { h, time, sheet, events } = startup(), response = deferred(), page = h.page('index')
  page.onLoad()
  h.respond = action => action === 'bootstrap' ? response.promise : undefined
  let refreshed = 0
  const work = sheet.show({ automatic: true, afterLogin: () => { refreshed++; page.onShow() } })
  await flush()
  assert.equal(page.data.hasDashboard, false)
  await time.advance(4000)
  assert.equal(sheet.data.stage, 'loading')
  assert.equal(h.app.hasLoginApproval(), false)
  assert.deepEqual(h.calls.map(call => call.action), ['bootstrap'])
  response.resolve(identity('合成昵称')); await work; await flush()
  assert.equal(sheet.data.open, false)
  assert.equal(h.app.hasLoginApproval(), true)
  assert.equal(refreshed, 1)
  assert.deepEqual(events, ['success'])
  assert.equal(time.pending, 0)
  assert.equal(page.data.hasDashboard, true)
  await time.advance(30000)
  assert.equal(sheet.data.open, false)
})

test('平台请求一直不返回时有界失败，重新连接发出新请求，旧成功不能覆盖新身份结果', async () => {
  const { h, time, sheet, events } = startup(), old = deferred(), fresh = deferred()
  let requests = 0, refreshes = 0
  h.respond = () => ++requests === 1 ? old.promise : fresh.promise
  const first = sheet.show({ automatic: true, afterLogin: () => { refreshes++ } })
  await flush(); await time.advance(15000); await first
  assert.equal(sheet.data.stage, 'error')
  assert.match(sheet.data.errorMessage, /超时.*重新连接/)
  assert.equal(sheet.data.submitting, false)
  assert.equal(h.app.hasLoginApproval(), false)
  assert.equal(time.pending, 0)
  const retry = sheet.confirm(); sheet.confirm(); await flush()
  assert.equal(requests, 2, '双击重试只发出一个新请求，不复用已超时的缓存等待')
  old.resolve(identity('迟到旧昵称')); await flush()
  assert.equal(h.app.hasLoginApproval(), false)
  assert.equal(h.app.globalData.profile.nickname, undefined)
  assert.equal(h.cache.peek(h.cache.stableKey('bootstrap', {})), null)
  fresh.resolve(identity('本次昵称')); await retry
  assert.equal(h.app.globalData.profile.nickname, '本次昵称')
  assert.equal(h.cache.peek(h.cache.stableKey('bootstrap', {})).nickname, '本次昵称')
  assert.equal(refreshes, 1)
  assert.deepEqual(events, ['success'])
})

test('自动重试共用启动等待预算，临近截止的失败和迟到失败都不会追加云调用', async () => {
  for (const late of [false, true]) {
    const { h, time, sheet } = startup(), response = deferred()
    h.respond = () => response.promise
    const work = sheet.show({ automatic: true }); await flush()
    await time.advance(late ? 15000 : 14900)
    response.reject({ errMsg: 'request:fail timeout' }); await flush()
    await time.advance(300); await work
    assert.equal(sheet.data.stage, 'error')
    assert.equal(h.calls.length, 1)
    assert.equal(h.app.hasLoginApproval(), false)
    assert.equal(time.pending, 0)
  }
})

test('短暂连接失败在剩余预算内自动恢复，第二次请求不能获得额外十五秒', async () => {
  for (const succeeds of [true, false]) {
    const { h, time, sheet } = startup(), first = deferred(), second = deferred()
    let calls = 0
    h.respond = () => ++calls === 1 ? first.promise : second.promise
    const work = sheet.show({ automatic: true }); await flush(); await time.advance(7000)
    first.resolve({ ok: false, error: { code: 'SERVICE_TEMPORARY_UNAVAILABLE', message: '暂时未连接' } })
    await flush(); await time.advance(300)
    assert.equal(calls, 2)
    if (succeeds) second.resolve(identity('恢复成功'))
    else await time.advance(7700)
    await work
    assert.equal(h.app.hasLoginApproval(), succeeds)
    assert.equal(sheet.data.open, !succeeds)
    if (!succeeds) assert.match(sheet.data.errorMessage, /超时/)
    assert.equal(time.pending, 0)
  }
})

test('微信后台暂停计时回调后，超过等待上限的成功仍不能作为当前登录结果', async () => {
  const { h, time, sheet } = startup(), response = deferred()
  h.respond = () => response.promise
  const work = sheet.show({ automatic: true }); await flush()
  time.jump(20000)
  response.resolve(identity('后台迟到')); await work
  assert.equal(sheet.data.stage, 'error')
  assert.match(sheet.data.errorMessage, /超时/)
  assert.equal(h.app.hasLoginApproval(), false)
  assert.equal(time.pending, 0)
})

test('取消或卸载后旧请求返回不能登录或继续原操作', async () => {
  for (const cancel of ['close', 'detach']) {
    const { h, time, sheet, events, detach } = startup(), response = deferred()
    h.respond = () => response.promise
    let continued = 0
    const work = sheet.show({ automatic: true, afterLogin: () => { continued++ } }); await flush()
    if (cancel === 'close') sheet.close()
    else detach()
    await time.advance(5000)
    response.resolve(identity('取消后迟到')); await work
    assert.equal(h.app.hasLoginApproval(), false)
    assert.equal(continued, 0)
    assert.deepEqual(events, [])
    assert.equal(time.pending, 0)
    assert.equal(h.app.globalData.loginStartupPending, cancel === 'detach')
  }
})

test('身份确认自动重试前换会话不再发请求，旧启动遮罩关闭', async () => {
  const { h, time, sheet, events } = startup()
  h.respond = () => Promise.reject({ errMsg: 'request:fail timeout' })
  const work = sheet.show({ automatic: true }); await flush()
  h.cache.reset(); await time.advance(300); await work
  assert.equal(h.calls.length, 1)
  assert.equal(h.app.hasLoginApproval(), false)
  assert.equal(sheet.data.open, false)
  assert.deepEqual(events, [])
  assert.equal(time.pending, 0)
})

test('启动等待限制不作用于正常业务写入，首次资料草稿保留', async () => {
  const { h, time, sheet } = startup()
  h.respond = () => identity('')
  await sheet.show({ automatic: true })
  sheet.bindNickname({ detail: { value: '自选昵称' } })
  await time.advance(20000)
  assert.equal(sheet.data.stage, 'setup')
  assert.equal(sheet.data.nickname, '自选昵称')
  const saved = deferred()
  h.respond = () => saved.promise
  h.app.approved = true
  let settled = false
  const saving = h.api.callApi('transactions.create', { requestId: '00000000-0000-4000-8000-000000000001' }).finally(() => { settled = true })
  await flush(); await time.advance(20000)
  assert.equal(settled, false, '原有写入恢复契约不被启动超时修改')
  saved.resolve({ ok: true, data: { saved: true } }); await saving
  assert.equal(settled, true)
})
