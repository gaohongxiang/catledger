const cache = require('./read-cache')

// 视图和请求结果属于同一次本机登录会话；换会话先清屏，再允许新查询。
function begin(page, fields, pendingFields) {
  const session = cache.getSession()
  if (!page._readInitial) {
    page._readInitial = {}
    fields.forEach(key => { page._readInitial[key] = JSON.parse(JSON.stringify(page.data[key])) })
  }
  if (page._readSession !== session) {
    const changed = page._readSession !== undefined
    page._readSession = session
    pendingFields.forEach(key => { page[key] = null })
    if (changed) page.setData(JSON.parse(JSON.stringify(page._readInitial)))
  }
  return function isCurrent() { return page._readSession === session && cache.getSession() === session }
}

module.exports = { begin, isCurrent: page => page._readSession === cache.getSession() }
