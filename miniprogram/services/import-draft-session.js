const api = require('./catledger-import')
const config = require('../config/cloudbase')
const sessions = new Map()
let networkListenerInstalled = false
const PREFIX = 'catledger_import_draft_v1:'
const clone = value => JSON.parse(JSON.stringify(value))
const retryable = error => ['CLOUD_TEMPORARY_UNAVAILABLE', 'SERVICE_TEMPORARY_UNAVAILABLE', 'CLOUD_CALL_FAILED', 'INTERNAL_ERROR'].includes(error && error.code)

// 仅在 financeUpdates.get/prepare 已验证批次归属后创建；不保存账单原文。
function create(options) {
  const key = PREFIX + options.scope + ':' + options.view.update.updateId
  const stored = options.read(key)
  let state = stored && stored.schema === 1 && Array.isArray(stored.entries) && stored.drafts && stored.updateId === options.view.update.updateId
    ? stored : { schema: 1, updateId: options.view.update.updateId, entries: [], drafts: {}, flight: null, step: 2 }
  let view = options.view
  let version = Number(view.update.version)
  let projectionRevision = 0
  let running = null
  let timer = null
  let retryCount = 0
  let errorMessage = ''
  let paused = false
  const listeners = new Set()
  function persist(next, affectsProjection = true) {
    try { options.write(key, clone(next)); state = next; if (affectsProjection) projectionRevision++ }
    catch (error) { throw Object.assign(new Error('本机草稿未保存，请检查存储空间后重试'), { code: 'DRAFT_STORAGE_FAILED' }) }
  }
  function emit() { listeners.forEach(fn => fn()) }
  function schedule(delay = 700) {
    if (paused || running || options.autoSync === false || timer || !state.entries.some(e => !e.error)) return
    timer = setTimeout(() => { timer = null; flush().catch(() => {}) }, delay)
  }
  function accept(next) {
    if (next.update.updateId !== state.updateId) throw new Error('导入批次不一致')
    if (Number(next.update.version) >= Number(view.update.version) && next !== view) { view = next; projectionRevision++ }
    version = Math.max(version, Number(next.update.version))
  }
  async function refresh() {
    const fresh = await options.call('financeUpdates.get', { updateId: state.updateId })
    accept(fresh)
    const next = clone(state)
    next.entries = next.entries.filter(e => e.status !== 'saved')
    if (fresh.update.status !== 'review') { next.entries = []; next.drafts = {}; next.flight = null }
    persist(next)
    emit()
    return fresh
  }
  function enqueue(entries, drafts) {
    if (paused || view.update.status !== 'review') throw new Error('当前导入已结束，请查看最新结果')
    const next = clone(state)
    if (drafts) next.drafts = clone(drafts)
    for (const entry of entries) {
      const locked = next.flight && next.flight.ids.includes(entry.issueId)
      if (locked) throw new Error('此项正在同步，请稍后修改；其他交易可以继续处理')
      next.entries = next.entries.filter(e => e.issueId !== entry.issueId)
      next.entries.push(Object.assign({}, clone(entry), { status: 'queued', error: '' }))
    }
    persist(next)
    errorMessage = ''
    emit()
    schedule()
  }
  async function work() {
    try {
      do {
      while (!paused) {
        if (!state.flight) {
          const candidates = state.entries.filter(e => e.status === 'queued' && !e.error)
          const first = candidates.find(e => e.kind === 'account') || candidates.find(e => e.issueType !== 'category_assignment') || candidates[0]
          if (!first) break
          const entries = first.kind === 'account' ? candidates.filter(e => e.kind === 'account').slice(0, 50) : [first]
          const payload = first.kind === 'account'
            ? { updateId: state.updateId, decisions: entries.map(e => e.decision) }
            : Object.assign({ updateId: state.updateId, updateVersion: version, issueId: first.issueId, issueVersion: first.issueVersion }, first.decision)
          payload.requestId = options.requestId()
          const next = clone(state)
          next.flight = { ids: entries.map(e => e.issueId), action: first.kind === 'account' ? 'reviewIssues.resolveAccountMappings' : 'reviewIssues.resolve', payload }
          // 先落盘请求和幂等键，响应丢失或进程退出后原样重试。
          persist(next, false)
        }
        const flight = state.flight
        const result = await options.call(flight.action, flight.payload)
        version = Math.max(version, Number(result.update.version))
        const next = clone(state)
        for (const entry of next.entries) {
          if (!flight.ids.includes(entry.issueId)) continue
          entry.status = 'saved'
          if (entry.kind === 'account' && next.drafts[entry.issueId] && next.drafts[entry.issueId].revision === entry.revision) delete next.drafts[entry.issueId]
        }
        next.flight = null
        persist(next, state.entries.some(entry => flight.ids.includes(entry.issueId) && entry.kind === 'account'))
        retryCount = 0
        if (result.events && result.issues) accept(result)
        emit()
      }
      if (!paused) await refresh()
      } while (!paused && state.entries.some(e => e.status === 'queued' && !e.error))
      if (state.entries.some(e => e.error)) throw Object.assign(new Error('部分选择需要重新核对，已保留原选择'), { code: 'DRAFT_CONFLICT' })
      errorMessage = ''
    } catch (error) {
      errorMessage = retryable(error) ? '选择已保存在本机，网络恢复后自动同步' : (error.message || '同步未完成，请重试')
      if (state.flight && !retryable(error) && error.code !== 'DRAFT_STORAGE_FAILED') {
        const next = clone(state)
        for (const entry of next.entries) if (next.flight.ids.includes(entry.issueId)) entry.error = errorMessage
        next.flight = null
        persist(next)
        // 冲突后读取服务端权威状态，草稿保留供重新核对。
        await refresh().catch(() => {})
      }
      if (retryable(error) && retryCount < 3) schedule([2000, 5000, 15000][retryCount++])
      throw error
    } finally { emit() }
  }
  function flush() {
    if (running) return running
    if (timer) { clearTimeout(timer); timer = null }
    if (paused) return Promise.reject(new Error('当前导入正在结束'))
    running = work().finally(() => { running = null; emit() })
    emit()
    return running
  }
  return {
    get state() { return state }, get view() { return view }, get projectionRevision() { return projectionRevision },
    get status() { return { pending: state.entries.filter(e => e.status !== 'saved').length, syncing: Boolean(running), error: errorMessage, conflicts: state.entries.filter(e => e.error).length } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    accept, enqueue, flush, schedule,
    saveDrafts(drafts, step) {
      if (state.flight && state.flight.ids.some(id => drafts[id] && state.drafts[id] && drafts[id].revision !== state.drafts[id].revision)) throw new Error('此项正在同步，请稍后修改')
      const next = Object.assign({}, state, { drafts: clone(drafts), step: step || state.step })
      next.entries = state.entries.filter(e => e.kind !== 'account' || e.status !== 'queued' || e.error || (drafts[e.issueId] && drafts[e.issueId].localConfirmed && drafts[e.issueId].revision === e.revision))
      persist(next)
    },
    async post() {
      if (!state.postFlight) persist(Object.assign({}, state, { postFlight: { requestId: options.requestId(), updateId: state.updateId, version: version, mode: 'all_ready' } }), false)
      try { return await options.call('financeUpdates.post', state.postFlight) }
      catch (error) {
        if (!retryable(error)) persist(Object.assign({}, state, { postFlight: null }), false)
        throw error
      }
    },
    discardConflicts() {
      const next = clone(state)
      next.conflictedChoices = next.entries.filter(e => e.error)
      next.entries = next.entries.filter(e => !e.error)
      persist(next); errorMessage = ''; emit(); schedule()
    },
    async retry() {
      const fresh = await refresh()
      const next = clone(state)
      for (const entry of next.entries) {
        const issue = fresh.issues.find(i => i.issueId === entry.issueId)
        if (entry.error && issue && issue.status === 'open' && issue.version === entry.issueVersion) entry.error = ''
      }
      persist(next); return flush()
    },
    async pause() { paused = true; if (timer) clearTimeout(timer); timer = null; if (running) await running.catch(() => {}) },
    resume() { paused = false; schedule() },
    clear() { paused = true; if (timer) clearTimeout(timer); options.remove(key); state = Object.assign({}, state, { entries: [], drafts: {}, flight: null }); projectionRevision++; emit() }
  }
}

function open(view) {
  if (!networkListenerInstalled && typeof wx.onNetworkStatusChange === 'function') {
    wx.onNetworkStatusChange(function (result) { if (result.isConnected) sessions.forEach(function (session) { session.schedule(0) }) })
    networkListenerInstalled = true
  }
  const id = config.envId + ':' + view.update.updateId
  if (!sessions.has(id)) sessions.set(id, create({ scope: config.envId, view,
    read: key => wx.getStorageSync(key), write: (key, value) => wx.setStorageSync(key, value), remove: key => wx.removeStorageSync(key),
    call: api.callImport, requestId: api.createRequestId }))
  const session = sessions.get(id)
  session.accept(view)
  wx.setStorageSync(PREFIX + config.envId + ':last', view.update.updateId)
  return session
}
async function pauseUpdate(updateId) {
  const session = sessions.get(config.envId + ':' + updateId)
  if (session) await session.pause()
}
function clearUpdate(updateId) {
  const id = config.envId + ':' + updateId
  const session = sessions.get(id)
  if (session) session.clear()
  else wx.removeStorageSync(PREFIX + id)
  sessions.delete(id)
  if (lastUpdateId() === updateId) forgetLast()
}
function lastUpdateId() { return wx.getStorageSync(PREFIX + config.envId + ':last') || '' }
function forgetLast() { wx.removeStorageSync(PREFIX + config.envId + ':last') }

// 只投影用户已作的决定；金额、退款与重复关系仍以服务端结果为准。
function project(view, entries) {
  const pending = entries.filter(e => e.kind === 'review' && !e.error &&
    !(e.decision && e.decision.fields && e.decision.fields.repaymentOwnership &&
      e.decision.fields.repaymentOwnership.owner === 'other' && e.decision.fields.repaymentOwnership.treatment === 'pending'))
  const ids = new Set(pending.map(e => e.issueId))
  const issues = view.issues.map(i => ids.has(i.issueId) ? Object.assign({}, i, { status: 'resolved', blocking: false }) : i)
  const events = view.events.map(event => {
    const chosen = pending.filter(e => (e.subjectIds || []).includes(event.eventId))
    if (!chosen.length) return event
    const category = chosen.find(e => e.issueType === 'category_assignment' && e.decision.fields && e.decision.fields.categoryId)
    const confirmed = chosen.some(e => e.issueType !== 'category_assignment')
    return Object.assign({}, event, { localReviewConfirmed: confirmed }, category ? { categoryId: category.decision.fields.categoryId } : {})
  })
  return Object.assign({}, view, { issues, events })
}
module.exports = { create, open, pauseUpdate, clearUpdate, lastUpdateId, forgetLast, project }
