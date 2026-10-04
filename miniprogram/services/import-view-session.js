const cache = require('./read-cache')
const observer = require('./read-observer')
const MAX_PAGES = 32
const MAX_BYTES = 256 * 1024
const MAX_HISTORY = 8

// 同一版本共用一个有界 LRU，容纳当前八笔成员的原文与目录；不随账单大小增长。
function create(call, summary, options = {}) {
  const session = cache.getSession()
  const pages = new Map()
  const pending = new Map()
  let state = summary, closed = false, stale = false, revision = 0, cachedBytes = 0
  const current = () => !closed && session === cache.getSession()
  function invalidate() {
    if (!current() || stale) return
    if (options.onStale) options.onStale()
    stale = true; pages.clear(); cachedBytes = 0; revision++
  }
  const inputFor = data => Object.assign({ protocolVersion: 2, updateId: state.update.updateId, viewVersion: state.viewVersion, pageSize: 40, cursor: null }, data)
  function remember(key, result, action) {
    const size = observer.bytes(result)
    if (pages.has(key)) { cachedBytes -= pages.get(key).size; pages.delete(key) }
    if (size > MAX_BYTES) return
    pages.set(key, { result, size, action }); cachedBytes += size
    const listing = [...pages.entries()].filter(([, page]) => ['reviewIssues.list', 'economicEvents.list'].includes(page.action))
    for (const [oldest, page] of listing.slice(0, Math.max(0, listing.length - 3))) {
      cachedBytes -= page.size; pages.delete(oldest)
    }
    while (pages.size > MAX_PAGES || cachedBytes > MAX_BYTES) {
      const oldest = pages.keys().next().value
      cachedBytes -= pages.get(oldest).size; pages.delete(oldest)
    }
  }
  function seed(action, data, result) {
    if (!current() || stale || !result || result.viewVersion !== state.viewVersion) return false
    remember(cache.stableKey(action, inputFor(data)), result, action)
    return true
  }
  function accept(next) {
    if (!current() || next.update.updateId !== state.update.updateId) return false
    if (state.viewVersion !== next.viewVersion) { pages.clear(); cachedBytes = 0; revision++ }
    stale = false
    state = next
    return true
  }
  async function read(action, data, valid = () => true) {
    if (!current()) throw Object.assign(new Error('页面已关闭'), { code: 'STALE_SESSION' })
    if (stale) throw Object.assign(new Error('整理结果已更新，请重新核验'), { code: 'STALE_VIEW' })
    if (!valid()) throw Object.assign(new Error('分页请求已失效'), { code: 'STALE_VIEW' })
    const epoch = revision
    const input = inputFor(data)
    const key = cache.stableKey(action, input)
    observer.record('cache', { action, source: pages.has(key) || pending.has(key) ? 'memory' : 'network', hit: pages.has(key) || pending.has(key) })
    if (pages.has(key)) { const value = pages.get(key); pages.delete(key); pages.set(key, value); return value.result }
    while (!pending.has(key) && pending.size >= 8) await Promise.race([...pending.values()].map(promise => promise.catch(() => {})))
    if (!current() || epoch !== revision || !valid()) throw Object.assign(new Error('分页请求已失效'), { code: 'STALE_VIEW' })
    if (!pending.has(key)) {
      const promise = Promise.resolve().then(() => call(action, input)).finally(() => { if (pending.get(key) === promise) pending.delete(key) })
      pending.set(key, promise)
    }
    let result
    try { result = await pending.get(key) }
    catch (error) {
      if (current() && epoch === revision && error.code === 'STALE_VIEW') invalidate()
      throw error
    }
    if (!current() || epoch !== revision || !valid()) throw Object.assign(new Error('整理结果已更新，请刷新本页'), { code: 'STALE_VIEW' })
    if (result.viewVersion !== state.viewVersion) { invalidate(); throw Object.assign(new Error('整理结果已更新，请重新核验'), { code: 'STALE_VIEW' }) }
    remember(key, result, action)
    return result
  }
  function pager(action, data, settings = {}, snapshot) {
    let history = snapshot ? snapshot.history.slice() : [{ cursor: null, start: 0, index: 0 }]
    let position = snapshot ? snapshot.position : 0, result = snapshot ? snapshot.result : null, ticket = 0
    const epoch = snapshot ? snapshot.epoch : revision
    async function loadPage(cursor, token) {
      const size = inputFor(data).pageSize
      const seen = new Set()
      let combined = null
      do {
        if (seen.has(cursor)) throw Object.assign(new Error('分页结果不完整，请重试'), { code: 'INVALID_CURSOR' })
        seen.add(cursor)
        const input = Object.assign({}, data, { cursor })
        if (settings.fillPage) input.pageSize = size - (combined ? combined.items.length : 0)
        const next = await read(action, input, () => token === ticket && epoch === revision)
        if (!settings.fillPage) return next
        if (!Array.isArray(next.items) || next.items.length > input.pageSize ||
          (next.nextCursor && (!next.items.length || seen.has(next.nextCursor))) || (combined && combined.total !== next.total)) {
          throw Object.assign(new Error('分页结果不完整，请重试'), { code: 'INVALID_CURSOR' })
        }
        combined = Object.assign({}, next, { items: (combined ? combined.items : []).concat(next.items) })
        cursor = next.nextCursor
      } while (cursor && combined.items.length < size)
      return combined
    }
    return {
      async load(direction) {
        const token = ++ticket
        let nextHistory = history.slice(), nextPosition = position
        if (direction === 'first') { nextHistory = [{ cursor: null, start: 0, index: 0 }]; nextPosition = 0 }
        else if (direction === 1 && result && result.nextCursor) {
          const previous = history[position]
          nextHistory = history.slice(0, position + 1).concat({ cursor: result.nextCursor, start: previous.start + (result.items || result.members || []).length, index: previous.index + 1 })
          if (nextHistory.length > MAX_HISTORY) nextHistory.shift()
          nextPosition = nextHistory.length - 1
        } else if (direction === -1 && position > 0) nextPosition--
        const point = nextHistory[nextPosition]
        // 原文弹层保留失败位置供原位重试；主列表补足整页后才推进页码。
        if (!settings.fillPage) { history = nextHistory; position = nextPosition }
        const next = await loadPage(point.cursor, token)
        if (token !== ticket || epoch !== revision) throw Object.assign(new Error('分页请求已失效'), { code: 'STALE_VIEW' })
        history = nextHistory; position = nextPosition
        result = next
        return Object.assign({}, next, { page: { index: point.index, count: next.total, start: point.start + (next.total ? 1 : 0),
          end: point.start + (next.items || next.members || []).length, hasPrevious: position > 0, hasNext: Boolean(next.nextCursor), canFirst: point.index > 0 } })
      },
      // 从同一来源位置打开弹层，保留有界游标且不移动底层卡片。
      fork() { return pager(action, data, settings, { history, position, result, epoch }) },
      cancel() { ticket++ },
      get historySize() { return history.length }
    }
  }
  return { read, pager, seed, accept, get active() { return current() && !stale }, get summary() { return state }, get pageCount() { return pages.size },
    get cachedBytes() { return cachedBytes },
    get cachedItems() { return [...pages.values()].reduce((n, page) => n + (page.result.items || page.result.members || []).length, 0) },
    close() { closed = true; pages.clear(); cachedBytes = 0; revision++ } }
}
module.exports = { create, MAX_PAGES, MAX_BYTES, MAX_HISTORY }
