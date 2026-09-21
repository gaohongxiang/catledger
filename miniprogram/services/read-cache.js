const { createSnapshotStore } = require('./read-snapshot-store')
const { validMetadata, compare } = require('./read-metadata')
// 展示快照与新鲜读取分开；普通失效不删画面，正式读取仍受写屏障保护。
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
  let session = 0, sequence = 0, scope = null, latestRevision = null, validation = null, persistQueued = null
  const disk = createSnapshotStore(options && options.storage, now)
  const persistent = !(options && options.persistence === false)
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
    return entry && !validation && !entry.dirty && entry.expiresAt > now() &&
      ![...writes].some(write => write.tags.some(tag => entry.tags.includes(tag))) ? entry : null
  }
  function persist() {
    if (!persistent || !scope || persistQueued) return
    const ticket = { session, scope }; persistQueued = ticket
    ticket.done = new Promise(resolve => {
      // 先交付新鲜数据和setData，再在下一任务合并有界存储；不阻塞read的Promise链。
      setTimeout(() => {
        if (persistQueued === ticket && ticket.session === session && ticket.scope === scope) {
          persistQueued = null
          disk.write(scope, [...entries].map(([key, entry]) => ({ key, value: entry.value, updatedAt: entry.updatedAt })))
        }
        resolve()
      }, 0)
    })
  }
  function observe(value) {
    if (!validMetadata(value)) return
    if (latestRevision !== null && compare(value.dataRevision, latestRevision) < 0) {
      throw Object.assign(new Error('数据版本已变化，请重试'), { code: 'STALE_READ' })
    }
    latestRevision = value.dataRevision
    for (const entry of entries.values()) if (!entry.value || entry.value.dataRevision !== latestRevision) entry.dirty = true
  }
  function put(key, policy, value, expiresAt) {
    observe(value)
    entries.delete(key)
    entries.set(key, { value: clone(value), tags: policy.tags, expiresAt, updatedAt: now(), source: 'memory', dirty: false, ttl: policy.ttl, token: ++sequence })
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    persist()
  }
  function invalidate(tags) {
    tags.forEach(tag => revisions.set(tag, (revisions.get(tag) || 0) + 1))
    for (const [key, entry] of entries) {
      if (entry.tags.some(tag => tags.includes(tag))) entry.dirty = true
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
      if (validMetadata(value) && latestRevision !== null && compare(value.dataRevision, latestRevision) < 0) {
        release()
        return read(key, policy, loader, { force: true })
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
    bindScope(env, uid) {
      if (typeof env !== 'string' || !env || !/^[1-9]\d{9}$/.test(uid)) return
      if (scope && scope.env === env && scope.uid === uid) return
      if (scope) { session++; entries.clear(); pending.clear(); revisions.clear(); writes.clear(); validation = null }
      scope = { env, uid }; latestRevision = null; persistQueued = null
      if (persistent) for (const item of disk.read(scope)) {
        if (entries.has(item.key)) continue
        entries.set(item.key, { value: clone(item.value), tags: item.policy.tags, ttl: item.policy.ttl,
          updatedAt: item.updatedAt, expiresAt: 0, dirty: true, token: ++sequence, source: 'storage' })
      }
    },
    validate(tags, operation) {
      if (validation) return validation
      const expectedSession = session
      invalidate(tags)
      const work = Promise.resolve().then(operation).then(value => {
        checkSession(expectedSession)
        observe(value)
        for (const entry of entries.values()) if (entry.value && entry.value.dataRevision === value.dataRevision && entry.value.uid === value.uid) {
          entry.dirty = false; entry.expiresAt = now() + entry.ttl
        }
        return value
      }).finally(() => { if (validation === work) validation = null })
      validation = work
      return work
    },
    waitForValidation: () => validation || Promise.resolve(),
    settleStorage: () => persistQueued ? persistQueued.done : Promise.resolve(),
    now,
    mutate,
    invalidate,
    token(key) { const entry = fresh(key); return entry ? entry.token : null },
    peek(key) { const entry = fresh(key); return entry ? clone(entry.value) : null },
    snapshot(key) {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key); entries.set(key, entry)
      return { value: clone(entry.value), fresh: Boolean(fresh(key)), updatedAt: entry.updatedAt, source: entry.source }
    },
    seedFrom(sourceKey, key, policy, project) {
      const source = fresh(sourceKey)
      if (!source || fresh(key) || pending.has(key)) return
      put(key, policy, project(clone(source.value)), Math.min(source.expiresAt, now() + policy.ttl))
    },
    reset() { session++; entries.clear(); pending.clear(); revisions.clear(); writes.clear(); scope = null; latestRevision = null; validation = null; persistQueued = null; disk.clear() }
  }
}

module.exports = Object.assign(createReadCache({ persistence: require('../config/read-strategy').persistentSnapshots }), { createReadCache, stableKey })
