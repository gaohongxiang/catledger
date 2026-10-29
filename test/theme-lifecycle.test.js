const test = require('node:test')
const assert = require('node:assert/strict')
const { themeRuntime } = require('./helpers/theme-runtime')

const nativeApis = ['setBackgroundColor', 'setBackgroundTextStyle', 'setNavigationBarColor']

function assertPresentation(runtime, instance, themeId) {
  const expected = runtime.registry.getThemePresentation(themeId)
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(instance.data[key], value, themeId + ' / ' + key)
  }
}

function assertNativeTheme(runtime, themeId) {
  const expected = runtime.registry.getThemePresentation(themeId)
  for (const api of nativeApis) {
    assert.equal(runtime.nativeCalls.filter(call => call.api === api).length, 1, api + ' 应只由当前页面同步一次')
  }
  const payload = api => runtime.nativeCalls.find(call => call.api === api).payload
  assert.equal(payload('setBackgroundColor').backgroundColor, expected.themePageColor)
  assert.equal(payload('setBackgroundColor').backgroundColorTop, expected.themePageColor)
  assert.equal(payload('setBackgroundColor').backgroundColorBottom, expected.themeCanvasBottom)
  assert.equal(payload('setBackgroundTextStyle').textStyle, expected.themeBackgroundTextStyle)
  assert.equal(payload('setNavigationBarColor').backgroundColor, expected.themeNavBackground)
  assert.equal(payload('setNavigationBarColor').frontColor, expected.themeNavFront)
}

test('三套已保存主题在页面和组件定义时提供完整初值，页面加载前同步原生颜色', function () {
  const themes = themeRuntime().registry.listThemes()
  assert.equal(themes.length, 3)
  for (const theme of themes) {
    const runtime = themeRuntime({ themeId: theme.id })
    const service = runtime.service
    let businessLoaded = false
    const page = runtime.page(service.page({
      data: { business: 'ready' },
      onLoad() {
        assertPresentation(runtime, this, theme.id)
        assertNativeTheme(runtime, theme.id)
        businessLoaded = true
      }
    }))
    const component = runtime.component(service.component({ data: { open: false } }))

    assertPresentation(runtime, page, theme.id)
    assertPresentation(runtime, component, theme.id)
    assert.equal(page.data.business, 'ready')
    assert.equal(component.data.open, false)
    assert.equal(runtime.nativeCalls.length, 0, '创建定义不能改写尚未激活页面的原生颜色')
    page.onLoad({})
    assert.equal(businessLoaded, true)
    assert.equal(page.patches.length, 0, '主题初值已正确时无需补写页面 data')
  }
})

test('适配器保留业务定义并隔离页面与组件的可变 data', function () {
  const runtime = themeRuntime({ themeId: 'navy-ledger' })
  const sourceData = { editor: { amount: '100', rows: [{ label: '合成记录' }] }, themeId: 'obsolete' }
  const original = { data: sourceData }
  const first = runtime.service.page(original)
  const second = runtime.service.page(original)
  const component = runtime.service.component(original)

  assert.notEqual(first, original)
  assert.notEqual(first.data, sourceData)
  assert.notEqual(first.data.editor, sourceData.editor)
  first.data.editor.rows[0].label = '修改后的草稿'
  assert.equal(sourceData.editor.rows[0].label, '合成记录')
  assert.equal(second.data.editor.rows[0].label, '合成记录')
  assert.equal(component.data.editor.rows[0].label, '合成记录')
  assert.equal(sourceData.themeId, 'obsolete')
  assert.equal(first.data.themeId, 'navy-ledger')
})

test('模块定义后再次选主题，新实例在业务 onLoad 与 attached 前纠正旧快照', function () {
  const runtime = themeRuntime({ themeId: 'gilded-ledger' })
  const observed = []
  const pageDefinition = runtime.service.page({
    data: { draft: '保留草稿' },
    onLoad() { observed.push(['page', this.data.themeId, this.data.draft]) }
  })
  const componentDefinition = runtime.service.component({
    data: { open: true },
    lifetimes: { attached() { observed.push(['component', this.data.themeId, this.data.open]) } }
  })
  runtime.service.selectTheme('navy-ledger')
  const page = runtime.page(pageDefinition)
  const component = runtime.component(componentDefinition)

  page.onLoad({})
  runtime.componentHook(component, 'attached')

  assertPresentation(runtime, page, 'navy-ledger')
  assertPresentation(runtime, component, 'navy-ledger')
  assert.deepEqual(observed, [['page', 'navy-ledger', '保留草稿'], ['component', 'navy-ledger', true]])
})

test('主题广播覆盖不在当前页面栈的隐藏 tab 和已挂载组件，卸载后停止更新', function () {
  const runtime = themeRuntime({ themeId: 'gilded-ledger' })
  const definition = runtime.service.page({ data: { draft: '未提交金额' } })
  const hidden = runtime.page(definition)
  const active = runtime.page(definition)
  const component = runtime.component(runtime.service.component({ data: { open: false } }))
  hidden.onLoad({})
  hidden.onHide()
  active.onLoad({})
  runtime.componentHook(component, 'attached')
  runtime.currentPages = [active]
  runtime.nativeCalls.length = 0

  runtime.service.selectTheme('navy-ledger')

  for (const target of [hidden, active, component]) assertPresentation(runtime, target, 'navy-ledger')
  assert.equal(hidden.data.draft, '未提交金额')
  assertNativeTheme(runtime, 'navy-ledger')
  hidden.onUnload()
  runtime.componentHook(component, 'detached')
  const hiddenPatchCount = hidden.patches.length
  const componentPatchCount = component.patches.length
  runtime.nativeCalls.length = 0
  runtime.service.selectTheme('taro-note')

  assertPresentation(runtime, active, 'taro-note')
  assert.equal(hidden.data.themeId, 'navy-ledger')
  assert.equal(component.data.themeId, 'navy-ledger')
  assert.equal(hidden.patches.length, hiddenPatchCount)
  assert.equal(component.patches.length, componentPatchCount)
  assertNativeTheme(runtime, 'taro-note')
})

test('隐藏页面与组件更新主题不抢系统栏，页面再次显示才恢复原生同步', function () {
  const runtime = themeRuntime({ themeId: 'gilded-ledger' })
  const page = runtime.page(runtime.service.page({ data: {} }))
  const component = runtime.component(runtime.service.component({ data: {} }))
  page.onLoad({})
  page.onHide()
  runtime.nativeCalls.length = 0
  runtime.componentHook(component, 'attached')
  runtime.service.selectTheme('taro-note')

  assertPresentation(runtime, page, 'taro-note')
  assertPresentation(runtime, component, 'taro-note')
  assert.equal(runtime.nativeCalls.length, 0)
  const patchCount = page.patches.length
  page.onShow()
  assert.equal(page.patches.length, patchCount, '后台订阅已同步，重显无需重写主题 data')
  assertNativeTheme(runtime, 'taro-note')
  page.onUnload()
  runtime.nativeCalls.length = 0
  runtime.service.selectTheme('navy-ledger')
  assert.equal(runtime.nativeCalls.length, 0, '卸载活动页后不得保留原生同步所有权')
})

test('旧页面迟到的 hide 和 unload 不撤销新页面的原生同步所有权', function () {
  const runtime = themeRuntime()
  const definition = runtime.service.page({ data: {} })
  const previous = runtime.page(definition)
  const current = runtime.page(definition)
  previous.onLoad({})
  current.onLoad({})
  previous.onHide()
  previous.onUnload()
  runtime.nativeCalls.length = 0

  runtime.service.selectTheme('navy-ledger')

  assertPresentation(runtime, current, 'navy-ledger')
  assertNativeTheme(runtime, 'navy-ledger')
})

test('页面生命周期保持业务 this、全部参数、同步值与 Promise 身份', async function () {
  const runtime = themeRuntime()
  const records = []
  const args = [{ source: 'synthetic' }, 42]
  const values = {
    onLoad: { result: 'loaded' },
    onShow: Promise.resolve('shown'),
    onHide: false,
    onUnload: Promise.resolve('unloaded')
  }
  const original = { data: {} }
  for (const name of Object.keys(values)) {
    original[name] = function (...received) {
      records.push({ name, target: this, args: received })
      return values[name]
    }
  }
  const page = runtime.page(runtime.service.page(original))
  for (const [name, expected] of Object.entries(values)) {
    assert.equal(page[name](...args), expected, name + ' 不应替换业务返回值或 Promise')
  }
  for (const record of records) {
    assert.equal(record.target, page)
    assert.deepEqual(record.args, args)
  }
  assert.equal(records.length, 4)
  assert.equal(await values.onShow, 'shown')
  assert.equal(await values.onUnload, 'unloaded')
})

test('组件生命周期保持业务 this、参数与 Promise，原定义和普通方法不受包装影响', async function () {
  const runtime = themeRuntime()
  const args = [{ source: 'synthetic' }, 'second']
  const records = []
  const attachedValue = Promise.resolve('attached')
  const detachedValue = { result: 'detached' }
  const attached = function (...received) {
    records.push({ target: this, args: received })
    return attachedValue
  }
  const detached = function (...received) {
    records.push({ target: this, args: received })
    return detachedValue
  }
  const method = function () { return this.data.draft }
  const definition = { data: { draft: '草稿' }, lifetimes: { attached, detached }, methods: { readDraft: method } }
  const component = runtime.component(runtime.service.component(definition))

  assert.equal(runtime.componentHook(component, 'attached', ...args), attachedValue)
  assert.equal(runtime.componentHook(component, 'detached', ...args), detachedValue)
  assert.equal(component.readDraft(), '草稿')
  assert.equal(component.readDraft, method)
  assert.equal(definition.lifetimes.attached, attached)
  assert.equal(definition.lifetimes.detached, detached)
  for (const record of records) {
    assert.equal(record.target, component)
    assert.deepEqual(record.args, args)
  }
  assert.equal(records.length, 2)
  assert.equal(await attachedValue, 'attached')
})

test('原生颜色 API 抛错或回调失败不阻断页面业务与后续主题广播', function () {
  for (const failureMode of ['nativeErrors', 'nativeFailures']) {
    for (const api of nativeApis) {
      const runtime = themeRuntime({ [failureMode]: [api] })
      let loaded = 0
      let shown = 0
      const result = { success: true }
      const page = runtime.page(runtime.service.page({
        data: {},
        onLoad() { loaded += 1; return result },
        onShow() { shown += 1; return result }
      }))

      assert.equal(page.onLoad({}), result, failureMode + ' / ' + api)
      assert.equal(page.onShow(), result)
      assert.equal(loaded, 1)
      assert.equal(shown, 1)
      assert.doesNotThrow(() => runtime.service.selectTheme('navy-ledger'))
      assertPresentation(runtime, page, 'navy-ledger')
    }
  }
})

test('派生主题回调在新快照写入后更新隐藏页和组件，同主题选择与卸载不重复派生', function () {
  const runtime = themeRuntime({ themeId: 'gilded-ledger' })
  const changes = []
  function onThemeChange(presentation) {
    assert.equal(this.data.themeId, presentation.themeId, '派生回调必须看到更新后的主题')
    changes.push({ target: this, presentation })
    this.setData({ chartColor: presentation.themePageColor })
  }
  const hidden = runtime.page(runtime.service.page({ data: { chartColor: '' }, onThemeChange }))
  const active = runtime.page(runtime.service.page({ data: {} }))
  const component = runtime.component(runtime.service.component({
    data: { chartColor: '' }, methods: { onThemeChange }
  }))
  hidden.onLoad({})
  hidden.onHide()
  active.onLoad({})
  runtime.componentHook(component, 'attached')
  runtime.service.selectTheme('navy-ledger')

  assert.equal(changes.length, 2)
  for (const target of [hidden, component]) {
    assert.equal(changes.filter(change => change.target === target).length, 1)
    assert.equal(target.data.chartColor, runtime.registry.getThemePresentation('navy-ledger').themePageColor)
  }
  runtime.service.selectTheme('navy-ledger')
  assert.equal(changes.length, 2)
  hidden.onUnload()
  runtime.componentHook(component, 'detached')
  runtime.service.selectTheme('taro-note')
  assert.equal(changes.length, 2)
})

test('主题持久化失败保留已选主题、应用状态和已挂载视图，恢复后可以重试', function () {
  const runtime = themeRuntime({ themeId: 'gilded-ledger' })
  runtime.service.install(runtime.app)
  const page = runtime.page(runtime.service.page({ data: {} }))
  const component = runtime.component(runtime.service.component({ data: {} }))
  page.onLoad({})
  runtime.componentHook(component, 'attached')
  runtime.nativeCalls.length = 0
  const pagePatchCount = page.patches.length
  const componentPatchCount = component.patches.length
  runtime.writeError = true

  assert.throws(() => runtime.service.selectTheme('navy-ledger'), /storage write unavailable/)

  assert.equal(runtime.service.currentPresentation().themeId, 'gilded-ledger')
  assert.equal(runtime.app.globalData.themeId, 'gilded-ledger')
  assert.equal(runtime.storage.get(runtime.service.THEME_STORAGE_KEY), 'gilded-ledger')
  assertPresentation(runtime, page, 'gilded-ledger')
  assertPresentation(runtime, component, 'gilded-ledger')
  assert.equal(page.patches.length, pagePatchCount)
  assert.equal(component.patches.length, componentPatchCount)
  assert.equal(runtime.nativeCalls.length, 0)
  runtime.writeError = false
  runtime.service.selectTheme('navy-ledger')
  assert.equal(runtime.storage.get(runtime.service.THEME_STORAGE_KEY), 'navy-ledger')
  assert.equal(runtime.app.globalData.themeId, 'navy-ledger')
  assertPresentation(runtime, page, 'navy-ledger')
  assertPresentation(runtime, component, 'navy-ledger')
  assertNativeTheme(runtime, 'navy-ledger')
})

test('首次原生配色失败在下一次显示时重试，成功后同主题不重复调用', function () {
  for (const failureMode of ['nativeErrors', 'nativeFailures']) {
    for (const api of nativeApis) {
      const runtime = themeRuntime({ themeId: 'navy-ledger', [failureMode]: [api] })
      const page = runtime.page(runtime.service.page({ data: {} }))
      page.onLoad({})
      runtime[failureMode].clear()
      runtime.nativeCalls.length = 0

      page.onShow()

      assertNativeTheme(runtime, 'navy-ledger')
      runtime.nativeCalls.length = 0
      page.onShow()
      assert.equal(runtime.nativeCalls.length, 0, failureMode + ' / ' + api + ' 成功后不应继续重试')
    }
  }
})

test('旧主题的迟到原生失败不使新主题失效，也不重新应用旧色', function () {
  const runtime = themeRuntime({ themeId: 'gilded-ledger' })
  const page = runtime.page(runtime.service.page({ data: {} }))
  page.onLoad({})
  const oldRequests = runtime.nativeRequests.slice()
  runtime.service.selectTheme('navy-ledger')
  runtime.nativeCalls.length = 0
  for (const request of oldRequests) request.payload.fail({ errMsg: request.api + ':late failure' })

  page.onShow()

  assert.equal(runtime.nativeCalls.length, 0, '旧请求失败不能使已成功的新主题再发请求')
  assertPresentation(runtime, page, 'navy-ledger')
  const current = runtime.page(runtime.service.page({ data: {} }))
  current.onLoad({})
  runtime.nativeCalls.length = 0
  for (const request of oldRequests) request.payload.fail({ errMsg: request.api + ':late failure' })
  current.onShow()
  assert.equal(runtime.nativeCalls.length, 0, '旧页面失败不能使新页面重复配色')
})
