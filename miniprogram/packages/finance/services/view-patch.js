// 原生输入框已在处理键盘事件时更新，避免整块重复下发干扰输入和光标。
function changedData(current, patch) {
  const result = {}
  function visit(before, after, path) {
    if (before === after) return
    const beforeObject = before && typeof before === 'object'
    const afterObject = after && typeof after === 'object'
    if (beforeObject && afterObject && Array.isArray(before) === Array.isArray(after)) {
      const beforeKeys = Object.keys(before), afterKeys = Object.keys(after)
      if (beforeKeys.length === afterKeys.length && beforeKeys.every(key => Object.prototype.hasOwnProperty.call(after, key))) {
        afterKeys.forEach(key => visit(before[key], after[key], Array.isArray(after) ? path + '[' + key + ']' : path + '.' + key))
        return
      }
    }
    result[path] = after
  }
  Object.keys(patch).forEach(key => visit(current[key], patch[key], key))
  return result
}
function setChangedData(page, patch) {
  const changed = changedData(page.data, patch)
  if (Object.keys(changed).length) page.setData(changed)
}
module.exports = { changedData, setChangedData }
