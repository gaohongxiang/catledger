const { switchDraft } = require('./import-draft-switch')
const api = require('./catledger-import')
const config = require('../config/cloudbase')
const readCache = require('./read-cache')
const sessions = new Map()
let sessionScope = readCache.getSession()
let networkListenerInstalled = false
const PREFIX = 'catledger_import_draft_v1:'
const clone = value => JSON.parse(JSON.stringify(value))
const retryable = error => ['CLOUD_TEMPORARY_UNAVAILABLE', 'SERVICE_TEMPORARY_UNAVAILABLE', 'CLOUD_CALL_FAILED', 'INTERNAL_ERROR'].includes(error && error.code)

// 仅在 financeUpdates.summary 已验证批次归属后创建；不保存账单原文。
function create(options) {
  const key = PREFIX + options.scope + ':' + options.view.update.updateId
  const stored = switchDraft(options.read(key))
  let state = stored && stored.schema === 2 && Array.isArray(stored.entries) && stored.drafts && stored.updateId === options.view.update.updateId
    ? stored : { schema: 2, updateId: options.view.update.updateId, entries: [], drafts: {}, flight: null, step: 2 }
  state.pairingDrafts = state.pairingDrafts || {}
  state.pairingResults = state.pairingResults || {}
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
    if (unescape(encodeURIComponent(JSON.stringify(next))).length > 192 * 1024) throw Object.assign(new Error('待同步选择较多，请完成同步后继续'), { code: 'DRAFT_LIMIT_REACHED' })
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
    const fresh = await options.call('financeUpdates.summary', { updateId: state.updateId })
    accept(fresh)
    const next = clone(state)
    for (const entry of next.entries) if (entry.kind === 'pairing' && entry.status === 'saved') {
      next.pairingResults[entry.pairingKey] = Object.assign({}, entry.progress, { status: 'saved', summaryReady: true, scopeToken: entry.scopeToken, previousSavedCount: entry.previousSavedCount || 0 })
    }
    next.entries = next.entries.filter(e => e.status !== 'saved')
    if (fresh.update.status !== 'review' && !next.flight) { next.entries = []; next.drafts = {}; next.pairingDrafts = {} }
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
    if (next.entries.filter(entry => entry.status !== 'saved').length > 8) throw Object.assign(new Error('请等待当前选择同步后继续'), { code: 'DRAFT_LIMIT_REACHED' })
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
          const payload = first.kind === 'pairing'
            ? first.progress && first.progress.continuationToken
              ? { updateId: state.updateId, continuationToken: first.progress.continuationToken }
              : { updateId: state.updateId, scopeToken: first.scopeToken, selection: clone(first.selection) }
            : first.kind === 'account'
            ? { updateId: state.updateId, decisions: entries.map(e => e.decision) }
            : Object.assign({ updateId: state.updateId, updateVersion: version, issueId: first.issueId, issueVersion: first.issueVersion }, first.decision)
          payload.requestId = options.requestId()
          if (first.kind !== 'pairing') payload.updateVersion = version
          if (first.kind === 'account') payload.decisions = entries.map(e => Object.assign({}, e.decision, { issueVersion: e.issueVersion || e.decision.issueVersion }))
          if (unescape(encodeURIComponent(JSON.stringify(payload))).length > 64 * 1024) throw Object.assign(new Error('本次选择内容过多，请减少批量项目后重试'), { code: 'REQUEST_TOO_LARGE' })
          const next = clone(state)
          next.flight = { ids: entries.map(e => e.issueId), action: first.kind === 'pairing' ? 'reviewIssues.resolvePairings' : first.kind === 'account' ? 'reviewIssues.resolveAccountMappings' : 'reviewIssues.resolve', payload }
          // 先落盘请求和幂等键，响应丢失或进程退出后原样重试。
          persist(next, false)
        }
        const flight = state.flight
        const result = await send(flight)
        if (flight.action === 'reviewIssues.resolvePairings' && (!result || result.protocolVersion !== 2 || !result.update || !Number.isSafeInteger(Number(result.update.version)))) {
          throw Object.assign(new Error('配对结果尚未核实，请用原请求恢复'), { code: 'PAIRING_RECEIPT_INVALID' })
        }
        version = Math.max(version, Number(result.update.version))
        const next = clone(state)
        for (const entry of next.entries) {
          if (!flight.ids.includes(entry.issueId)) continue
          if (entry.kind === 'pairing') {
            const progress = result.pairing, previous = entry.progress && entry.progress.savedCount || 0
            const valid = progress && ['savedCount', 'totalCount', 'remainingCount', 'batchSavedCount'].every(name => Number.isSafeInteger(progress[name]) && progress[name] >= 0) &&
              progress.totalCount === entry.totalCount && progress.savedCount >= previous && progress.savedCount + progress.remainingCount === progress.totalCount &&
              progress.batchSavedCount === progress.savedCount - previous && progress.batchSavedCount <= 100 &&
              (progress.remainingCount ? typeof progress.continuationToken === 'string' && progress.continuationToken.length > 0 : !progress.continuationToken)
            if (!valid) throw Object.assign(new Error('配对结果尚未核实，请用原请求恢复'), { code: 'PAIRING_RECEIPT_INVALID' })
            entry.progress = clone(progress)
            entry.status = progress.remainingCount ? 'queued' : 'saved'
            if (entry.status === 'saved') {
              next.pairingResults[entry.pairingKey] = Object.assign({}, progress, { status: 'saved', summaryReady: false, scopeToken: entry.scopeToken, previousSavedCount: entry.previousSavedCount || 0 })
              if (next.pairingDrafts[entry.pairingKey] && next.pairingDrafts[entry.pairingKey].revision === entry.revision) delete next.pairingDrafts[entry.pairingKey]
            }
            continue
          }
          entry.status = 'saved'
          if (entry.kind === 'account' && next.drafts[entry.issueId] && next.drafts[entry.issueId].revision === entry.revision) delete next.drafts[entry.issueId]
        }
        next.flight = null
        persist(next, state.entries.some(entry => flight.ids.includes(entry.issueId) && entry.kind === 'account'))
        retryCount = 0
        emit()
      }
      if (!paused) await refresh()
      } while (!paused && state.entries.some(e => e.status === 'queued' && !e.error))
      if (state.entries.some(e => e.error)) throw Object.assign(new Error('部分选择需要重新核对，已保留原选择'), { code: 'DRAFT_CONFLICT' })
      errorMessage = ''
    } catch (error) {
      const committed = !state.flight && state.entries.some(e => e.status === 'saved')
      const pairing = state.entries.find(e => e.kind === 'pairing' && e.status !== 'saved' && e.progress && (e.progress.savedCount || e.previousSavedCount))
      errorMessage = committed ? '选择已同步，明细待刷新' : pairing ? '已保存 ' + ((pairing.previousSavedCount || 0) + pairing.progress.savedCount) + ' 组，剩余 ' + pairing.progress.remainingCount + ' 组待继续核对' : retryable(error) ? '选择已保存在本机，网络恢复后自动同步' : (error.message || '同步未完成，请重试')
      if (error.code === 'SESSION_CHANGED') paused = true
      if (state.flight && !state.flight.reconcile && !retryable(error) && !['DRAFT_STORAGE_FAILED', 'PAIRING_RECEIPT_INVALID', 'SESSION_CHANGED'].includes(error.code)) {
        const next = clone(state)
        for (const entry of next.entries) if (next.flight.ids.includes(entry.issueId)) {
          entry.error = errorMessage
          if (entry.kind === 'pairing' && next.pairingDrafts[entry.pairingKey]) next.pairingDrafts[entry.pairingKey].needsRecheck = true
        }
        next.flight = null
        persist(next)
        // 冲突后读取服务端权威状态，草稿保留供重新核对。
        await refresh().catch(() => {})
      }
      if (retryable(error) && retryCount < 3) schedule([2000, 5000, 15000][retryCount++])
      throw error
    } finally { emit() }
  }
  function send(flight) {
    return flight.reconcile
      ? options.call('imports.commandResult', { requestId: flight.payload.requestId, commandAction: flight.action })
      : options.call(flight.action, flight.payload)
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
    savePairingDraft(pairingKey, draft) {
      const next = clone(state)
      // 仅允许选择和范围标识进入现有草稿；不持久化任何账单展示/原文字段。
      const saved = {}
      for (const key of ['mode', 'issueId', 'viewVersion', 'scopeToken', 'total', 'sourceCount', 'revision', 'needsRecheck', 'excludedPairKeys', 'missingPairKeys', 'missingAcknowledged', 'pairs']) {
        if (draft[key] !== undefined) saved[key] = clone(draft[key])
      }
      if ((saved.excludedPairKeys || []).length > 500 || (saved.pairs || []).length > 100) throw Object.assign(new Error('本次例外最多 500 组，具体配对最多 100 组；请先保存当前选择'), { code: 'DRAFT_LIMIT_REACHED' })
      saved.pairs = (saved.pairs || []).map(pair => ({ pairKey: pair.pairKey, decision: pair.decision, bankEventId: pair.bankEventId, platformEventId: pair.platformEventId }))
      next.pairingDrafts[pairingKey] = saved
      persist(next, false); emit()
    },
    pairingTask(pairingKey) {
      return state.entries.find(entry => entry.kind === 'pairing' && entry.pairingKey === pairingKey) || state.pairingResults[pairingKey] || null
    },
    enqueuePairing(pairingKey, draft, totalCount) {
      if (!draft.scopeToken || draft.needsRecheck || (draft.missingPairKeys || []).length && !draft.missingAcknowledged || !Number.isSafeInteger(totalCount) || totalCount <= 0) throw new Error('请先核验配对范围')
      const missing = new Set(draft.missingPairKeys || [])
      const prior = state.entries.find(entry => entry.kind === 'pairing' && entry.pairingKey === pairingKey && entry.error) ||
        (state.pairingResults[pairingKey] && state.pairingResults[pairingKey].status === 'conflict' ? state.pairingResults[pairingKey] : null)
      const previousSavedCount = prior ? (prior.previousSavedCount || 0) + (prior.progress ? prior.progress.savedCount : prior.savedCount || 0) : 0
      const selection = draft.mode === 'suggested' ? { mode: 'all_except', excludedPairKeys: (draft.excludedPairKeys || []).filter(key => !missing.has(key)) }
        : { mode: 'include', pairs: (draft.pairs || []).filter(pair => !missing.has(pair.pairKey)).map(pair => ({ pairKey: pair.pairKey, decision: pair.decision })) }
      enqueue([{ kind: 'pairing', issueId: 'pairing:' + pairingKey, pairingKey, revision: draft.revision,
        scopeToken: draft.scopeToken, selection, totalCount, previousSavedCount, progress: { savedCount: 0, totalCount, remainingCount: totalCount, continuationToken: null } }])
    },
    saveDrafts(drafts, step) {
      if (state.flight && state.flight.ids.some(id => drafts[id] && state.drafts[id] && drafts[id].revision !== state.drafts[id].revision)) throw new Error('此项正在同步，请稍后修改')
      const next = Object.assign({}, state, { drafts: clone(drafts), step: step || state.step })
      next.entries = state.entries.filter(e => e.kind !== 'account' || e.status !== 'queued' || e.error || (drafts[e.issueId] && drafts[e.issueId].localConfirmed && drafts[e.issueId].revision === e.revision))
      persist(next)
    },
    async post() {
      if (!state.postFlight) persist(Object.assign({}, state, { postFlight: { action: 'financeUpdates.post',
        payload: { requestId: options.requestId(), updateId: state.updateId, version: version, mode: 'all_ready' } } }), false)
      try { return await send(state.postFlight) }
      catch (error) {
        if (error.code === 'HISTORY_REVIEW_REQUIRED' || !state.postFlight.reconcile && !retryable(error)) persist(Object.assign({}, state, { postFlight: null }), false)
        throw error
      }
    },
    discardConflicts() {
      const next = clone(state)
      next.conflictedChoices = next.entries.filter(e => e.error)
      for (const entry of next.conflictedChoices) if (entry.kind === 'pairing') {
        next.pairingResults[entry.pairingKey] = Object.assign({}, entry.progress, { status: 'conflict', error: entry.error,
          scopeToken: entry.scopeToken, previousSavedCount: entry.previousSavedCount || 0 })
      }
      next.entries = next.entries.filter(e => !e.error)
      persist(next); errorMessage = ''; emit(); schedule()
    },
    async retry() {
      const fresh = await refresh()
      const next = clone(state)
      for (const entry of next.entries) {
        // 配对范围冲突必须重新展示、核验和显式确认，不能替换版本自动重放。
        if (entry.kind === 'pairing') continue
        const issue = entry.error
          ? (await options.call('reviewIssues.get', { protocolVersion: 2, updateId: state.updateId, issueId: entry.issueId, pageSize: 1 })).issue
          : (fresh.issues || []).find(i => i.issueId === entry.issueId)
        if (entry.error && issue && issue.status === 'open' && issue.version === entry.issueVersion) entry.error = ''
      }
      persist(next); return flush()
    },
    async pause() { paused = true; if (timer) clearTimeout(timer); timer = null; if (running) await running.catch(() => {}) },
    resume() { paused = false; schedule() },
    clear() { paused = true; if (timer) clearTimeout(timer); options.remove(key); state = Object.assign({}, state, { entries: [], drafts: {}, pairingDrafts: {}, pairingResults: {}, flight: null }); projectionRevision++; emit() }
  }
}

function open(view) {
  if (sessionScope !== readCache.getSession()) {
    sessions.forEach(session => { session.pause() })
    sessions.clear(); sessionScope = readCache.getSession()
  }
  if (!networkListenerInstalled && typeof wx.onNetworkStatusChange === 'function') {
    wx.onNetworkStatusChange(function (result) { if (result.isConnected) sessions.forEach(function (session) { session.schedule(0) }) })
    networkListenerInstalled = true
  }
  const id = config.envId + ':' + view.update.updateId
  for (const [key, prior] of sessions) if (key !== id) { prior.pause(); sessions.delete(key) }
  if (!sessions.has(id)) sessions.set(id, create({ scope: config.envId, view,
    read: key => wx.getStorageSync(key), write: (key, value) => wx.setStorageSync(key, value), remove: key => wx.removeStorageSync(key),
    call: api.callImport, requestId: api.createRequestId }))
  const session = sessions.get(id)
  session.accept(view)
  rememberLast(view.update.updateId)
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
function ownerScope() {
  const app = getApp(), uid = app.globalData.uid
  return app.hasLoginApproval() && uid ? config.envId + ':' + uid : null
}
function rememberLast(updateId, scope = ownerScope()) {
  if (!scope) return
  const key = PREFIX + scope + ':last'
  try {
    wx.setStorageSync(key, updateId)
    if (wx.getStorageSync(key) !== updateId) throw new Error('write not persisted')
  } catch (_) { throw Object.assign(new Error('本机未能保存整理进度，请释放空间后刷新'), { code: 'DRAFT_STORAGE_FAILED' }) }
}
function lastUpdateId() { const scope = ownerScope(); return scope ? wx.getStorageSync(PREFIX + scope + ':last') || '' : '' }
function forgetLast() { const scope = ownerScope(); if (scope) wx.removeStorageSync(PREFIX + scope + ':last') }

// 只投影用户已作的决定；金额、退款与重复关系仍以服务端结果为准。
function project(view, entries) {
  const pending = entries.filter(e => e.kind === 'review' && !e.error &&
    !(e.decision && e.decision.fields && e.decision.fields.repaymentOwnership &&
      e.decision.fields.repaymentOwnership.owner === 'other' && e.decision.fields.repaymentOwnership.treatment === 'pending'))
  const ids = new Set(pending.map(e => e.issueId))
  const issues = (view.issues || []).map(i => ids.has(i.issueId) ? Object.assign({}, i, { status: 'resolved', blocking: false }) : i)
  const events = (view.events || []).map(event => {
    const chosen = pending.filter(e => (e.subjectIds || []).includes(event.eventId))
    if (!chosen.length) return event
    const category = chosen.find(e => e.issueType === 'category_assignment' && e.decision.fields && e.decision.fields.categoryId)
    const confirmed = chosen.some(e => e.issueType !== 'category_assignment')
    return Object.assign({}, event, { localReviewConfirmed: confirmed }, category ? { categoryId: category.decision.fields.categoryId } : {})
  })
  return Object.assign({}, view, { issues, events })
}
module.exports = { create, open, pauseUpdate, clearUpdate, rememberLast, lastUpdateId, forgetLast, project }
