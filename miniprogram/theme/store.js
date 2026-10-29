const registry = require('./registry')

// 应用偏好只有这一份运行态；本机存储是持久化，不是每个视图各自的状态源。
function createThemeStore(storage) {
  let current
  const listeners = new Set()

  function get() {
    if (!current) {
      let themeId
      try { themeId = storage.read() } catch (_) { /* 无存储时使用默认主题。 */ }
      current = registry.getThemePresentation(themeId)
    }
    return current
  }

  function select(themeId) {
    const next = registry.getThemePresentation(themeId)
    const previous = get()
    // 先保存：失败时保留原偏好，不向用户报告一个下次启动就丢失的选择。
    storage.write(next.themeId)
    if (next === previous) return previous
    current = next
    listeners.forEach(listener => listener(next))
    return next
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { get, select, subscribe }
}

module.exports = { createThemeStore }
