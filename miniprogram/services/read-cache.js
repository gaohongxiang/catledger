// 只保留当前登录会话的短期读取结果；不写本地存储，不参与业务写入重放。
function stableKey(action, data) {
  function ordered(value) {
    if (Array.isArray(value)) return value.map(ordered)
    if (!value || typeof value !== 'object') return value
    const result = {}
    Object.keys(value).sort().forEach(key => { if (value[key] !== undefined) result[key] = ordered(value[key]) })
    return result
  }
  return action + ':' + JSON.stringify(ordered(data || {}))
}

function createReadCache(options) {
  const now = options && options.now || Date.now
  const maxEntries = options && options.maxEntries || 48
  const entries = new Map(), pending = new Map(), revisions = new Map(), writes = new Set()
  let session = 0, sequence = 0
  const clone = value => value === undefined ? value : JSON.parse(JSON.stringify(value))
  const stamp = tags => tags.map(tag => tag + ':' + (revisions.get(tag) || 0)).join('|')
  function checkSession(expected) {
    if (session === expected) return
    const error = new Error('登录状态已改变，请重新打开页面')
    error.code = 'SESSION_CHANGED'
    throw error
  }
  function fresh(key) {
    const entry = entries.get(key)
    return entry && entry.expiresAt > now() ? entry : null
  }
  function put(key, policy, value, expiresAt) {
    entries.delete(key)
    entries.set(key, { value: clone(value), tags: policy.tags, expiresAt, token: ++sequence })
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }
  function invalidate(tags) {
    tags.forEach(tag => revisions.set(tag, (revisions.get(tag) || 0) + 1))
    for (const [key, entry] of entries) {
      if (entry.tags.some(tag => tags.includes(tag))) entries.delete(key)
    }
  }
  function read(key, policy, loader, requestOptions) {
    const expectedSession = session
    const copy = value => { checkSession(expectedSession); return clone(value) }
    const blockers = [...writes].filter(write => write.tags.some(tag => policy.tags.includes(tag)))
    if (blockers.length) return Promise.all(blockers.map(write => write.done)).then(() => {
      checkSession(expectedSession)
      return read(key, policy, loader, requestOptions)
    })
    const entry = fresh(key)
    if (!(requestOptions && requestOptions.force) && entry) return Promise.resolve().then(() => copy(entry.value))
    const currentStamp = stamp(policy.tags)
    const existing = pending.get(key)
    if (existing && existing.stamp === currentStamp) return existing.promise.then(copy)
    const slot = { stamp: currentStamp }
    function release() { if (pending.get(key) === slot) pending.delete(key) }
    slot.promise = Promise.resolve().then(() => {
      checkSession(expectedSession)
      return loader()
    }).then(value => {
      checkSession(expectedSession)
      if (stamp(policy.tags) !== currentStamp) {
        release()
        return read(key, policy, loader)
      }
      put(key, policy, value, now() + policy.ttl)
      return value
    }, error => {
      checkSession(expectedSession)
      if (stamp(policy.tags) !== currentStamp) {
        release()
        return read(key, policy, loader)
      }
      throw error
    }).finally(release)
    pending.set(key, slot)
    return slot.promise.then(copy)
  }
  function mutate(tags, operation) {
    const expectedSession = session
    invalidate(tags)
    let finish
    const write = { tags, done: new Promise(resolve => { finish = resolve }) }
    writes.add(write)
    return Promise.resolve().then(() => {
      checkSession(expectedSession)
      return operation()
    }).then(result => {
      checkSession(expectedSession)
      return result
    }).finally(() => {
      if (session === expectedSession) invalidate(tags)
      writes.delete(write)
      finish()
    })
  }
  return {
    read,
    guard(operation) {
      const expectedSession = session
      return Promise.resolve().then(() => { checkSession(expectedSession); return operation() })
        .then(result => { checkSession(expectedSession); return result })
    },
    getSession: () => session,
    mutate,
    invalidate,
    token(key) { const entry = fresh(key); return entry ? entry.token : null },
    seedFrom(sourceKey, key, policy, project) {
      const source = fresh(sourceKey)
      if (!source || fresh(key) || pending.has(key)) return
      put(key, policy, project(clone(source.value)), Math.min(source.expiresAt, now() + policy.ttl))
    },
    reset() { session++; entries.clear(); pending.clear(); revisions.clear(); writes.clear() }
  }
}

module.exports = Object.assign(createReadCache(), { createReadCache, stableKey })
