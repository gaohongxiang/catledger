const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..', '..', 'miniprogram')

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// 只模拟微信宿主边界；主题服务与注册表均执行仓库中的真实源码。
// 这里验证数据和生命周期行为，不模拟渲染帧或真机原生外壳。
function themeRuntime(options = {}) {
  const modules = new Map()
  const storage = new Map(Object.entries(options.storage || {}))
  if (options.themeId) storage.set('catledger_theme_v1', options.themeId)
  const runtime = {
    app: { globalData: {} },
    currentPages: [],
    nativeCalls: [],
    nativeRequests: [],
    nativeErrors: new Set(options.nativeErrors || []),
    nativeFailures: new Set(options.nativeFailures || []),
    writeError: Boolean(options.writeError),
    storage
  }

  function nativeCall(api, payload) {
    runtime.nativeCalls.push({ api, payload: clone(payload) })
    runtime.nativeRequests.push({ api, payload })
    if (runtime.nativeErrors.has(api)) throw new Error(api + ' unavailable')
    if (runtime.nativeFailures.has(api) && typeof payload.fail === 'function') {
      payload.fail({ errMsg: api + ':fail' })
    }
  }

  const wx = {
    getStorageSync(key) {
      if (options.readError) throw new Error('storage unavailable')
      return storage.get(key)
    },
    setStorageSync(key, value) {
      if (runtime.writeError) throw new Error('storage write unavailable')
      storage.set(key, value)
    },
    setBackgroundColor(payload) { nativeCall('setBackgroundColor', payload) },
    setBackgroundTextStyle(payload) { nativeCall('setBackgroundTextStyle', payload) },
    setNavigationBarColor(payload) { nativeCall('setNavigationBarColor', payload) }
  }

  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }
    modules.set(filename, module)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module,
      exports: module.exports,
      require(name) {
        if (!name.startsWith('.')) throw new Error('Unexpected theme dependency: ' + name)
        return load(path.resolve(path.dirname(filename), name + (path.extname(name) ? '' : '.js')))
      },
      wx,
      getApp: () => runtime.app,
      getCurrentPages: () => runtime.currentPages,
      console
    }, { filename })
    return module.exports
  }

  function instance(definition, component) {
    const patches = []
    return Object.assign({}, definition, component ? definition.methods : {}, {
      data: clone(definition.data || {}),
      patches,
      getTabBar: () => null,
      setData(patch, callback) {
        patches.push(clone(patch))
        Object.assign(this.data, clone(patch))
        if (callback) callback.call(this)
      }
    })
  }

  runtime.service = load(path.join(root, 'theme', 'service.js'))
  runtime.registry = load(path.join(root, 'theme', 'registry.js'))
  runtime.page = definition => instance(definition, false)
  runtime.component = definition => instance(definition, true)
  runtime.componentHook = function (component, name, ...args) {
    const hook = component.lifetimes && component.lifetimes[name] || component[name]
    return hook && hook.apply(component, args)
  }
  return runtime
}

module.exports = { themeRuntime }
