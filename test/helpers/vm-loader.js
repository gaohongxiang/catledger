const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')

// 在同一组宿主边界内递归执行真实业务模块，避免 factory 的内部 require 绕过注入。
function createLoader(globals, override = () => undefined) {
  const modules = new Map()
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    const local = createRequire(filename)
    const replaced = override(filename, local, load)
    if (replaced !== undefined) { modules.set(filename, { exports: replaced }); return replaced }
    if (filename.endsWith('.json')) return local(filename)
    const module = { exports: {} }
    modules.set(filename, module)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      console, setTimeout, clearTimeout, ...globals,
      module, exports: module.exports,
      Page: definition => { module.exports = definition },
      Component: definition => { module.exports = definition },
      require(name) { return name.startsWith('.') ? load(local.resolve(name)) : local(name) }
    }, { filename })
    return module.exports
  }
  return load
}

module.exports = { createLoader }
