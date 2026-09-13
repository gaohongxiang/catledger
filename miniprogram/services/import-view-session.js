const cache = require('./read-cache')
const MAX_PAGES = 3
const MAX_HISTORY = 8

// 每个工作台只保留三个响应页；历史游标也有上限，不随账单大小增长。
function create(call, summary) {
  const session = cache.getSession()
  const pages = new Map()
  const pending = new Map()
  let state = summary, closed = false, revision = 0
  const current = () => !closed && session === cache.getSession()
  function accept(next) {
    if (!current() || next.update.updateId !== state.update.updateId) return false
    if (state.viewVersion !== next.viewVersion) { pages.clear(); revision++ }
    state = next
    return true
  }
  async function read(action, data, valid = () => true) {
    if (!current()) throw Object.assign(new Error('页面已关闭'), { code: 'STALE_SESSION' })
    const epoch = revision
    const input = Object.assign({ protocolVersion: 2, updateId: state.update.updateId, viewVersion: state.viewVersion, pageSize: 40 }, data)
    const key = cache.stableKey(action, input)
    if (pages.has(key)) { const value = pages.get(key); pages.delete(key); pages.set(key, value); return value }
    while (!pending.has(key) && pending.size >= 8) await Promise.race([...pending.values()].map(promise => promise.catch(() => {})))
    if (!current() || epoch !== revision || !valid()) throw Object.assign(new Error('分页请求已失效'), { code: 'STALE_VIEW' })
    if (!pending.has(key)) {
      const promise = Promise.resolve().then(() => call(action, input)).finally(() => { if (pending.get(key) === promise) pending.delete(key) })
      pending.set(key, promise)
    }
    const result = await pending.get(key)
    if (!current() || epoch !== revision || !valid() || result.viewVersion !== state.viewVersion) throw Object.assign(new Error('整理结果已更新，请刷新本页'), { code: 'STALE_VIEW' })
    pages.set(key, result)
    while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value)
    return result
  }
  function pager(action, data) {
    let history = [{ cursor: null, start: 0, index: 0 }], position = 0, result = null, ticket = 0
    const epoch = revision
    return {
      async load(direction) {
        const token = ++ticket
        if (direction === 'first') { history = [{ cursor: null, start: 0, index: 0 }]; position = 0 }
        else if (direction === 1 && result && result.nextCursor) {
          const previous = history[position]
          history = history.slice(0, position + 1).concat({ cursor: result.nextCursor, start: previous.start + (result.items || result.members || []).length, index: previous.index + 1 })
          if (history.length > MAX_HISTORY) history.shift()
          position = history.length - 1
        } else if (direction === -1 && position > 0) position--
        const point = history[position]
        const next = await read(action, Object.assign({}, data, { cursor: point.cursor }), () => token === ticket)
        if (token !== ticket || epoch !== revision) throw Object.assign(new Error('分页请求已失效'), { code: 'STALE_VIEW' })
        result = next
        return Object.assign({}, next, { page: { index: point.index, count: next.total, start: point.start + (next.total ? 1 : 0),
          end: point.start + (next.items || next.members || []).length, hasPrevious: position > 0, hasNext: Boolean(next.nextCursor), canFirst: point.index > 0 } })
      },
      cancel() { ticket++ },
      get historySize() { return history.length }
    }
  }
  return { read, pager, accept, get summary() { return state }, get pageCount() { return pages.size },
    get cachedItems() { return [...pages.values()].reduce((n, page) => n + (page.items || page.members || []).length, 0) },
    close() { closed = true; pages.clear(); revision++ } }
}
module.exports = { create, MAX_PAGES, MAX_HISTORY }
