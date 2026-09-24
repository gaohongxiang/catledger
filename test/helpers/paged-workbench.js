const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createReadCache, stableKey } = require('../../miniprogram/services/read-cache')
const { create: createDraft } = require('../../miniprogram/services/import-draft-session')
const { workbenchSummary } = require('../../cloudfunctions/catledger-import/src/workbench-summary')
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture(count = 121, blocking = false) {
  const events = Array.from({ length: count }, (_, index) => ({ eventId: 'synthetic-event-' + index, version: 1, status: blocking ? 'needs_action' : 'ready',
    economicNature: 'expense', flowDirection: 'outflow', amountMinor: '100', categoryId: 'synthetic-category', ledgerAccountId: 'synthetic-account',
    fieldSources: {}, localAt: '2026-09-01 12:00:00', primaryEvidence: { sourceType: 'wechat', item: '合成商品' + index, counterparty: '合成商户' }, evidenceCount: 1 }))
  const issues = blocking ? [{ issueId: 'synthetic-issue', issueType: 'same_event', status: 'open', version: 1, blocking: true,
    memberCount: count, candidateCount: 0, subjectEventIds: [], subject: events[0] }] : []
  const summary = { protocolVersion: 2, viewVersion: 'v1', update: { updateId: 'synthetic-update', version: 1, status: 'review', counts: { readyEvents: blocking ? 0 : count } },
    sources: [], coverage: { selectedEventsReadyToPost: !blocking, openBlockingIssues: blocking ? 1 : 0, dataRows: count, rowConservationPassed: true },
    freshness: { requiresAccountGroupRefresh: false }, posting: null,
    workbench: workbenchSummary(events, blocking ? events.map(event => ({ eventId: event.eventId, review: 1 })) : [],
      blocking ? [{ issueType: 'same_event', status: 'open', count: 1 }] : [], 0, 0) }
  return { events, issues, summary }
}
function runtime(data = fixture()) {
  const cache = Object.assign(createReadCache(), { stableKey }), storage = new Map(), calls = [], patches = [], modules = new Map()
  let session, definition
  const h = { ...data, calls, patches, cache, intercept: null, maxDataBytes: 0, derives: {}, activeSubscriptions: 0 }
  h.app = { approved: true, hasLoginApproval() { return this.approved }, globalData: {} }
  const call = async (action, input = {}) => {
    calls.push({ action, input: JSON.parse(JSON.stringify(input)) })
    if (h.intercept) { const value = await h.intercept(action, input); if (value !== undefined) return value }
    if (action === 'financeUpdates.summary') return h.summary
    let rows = [], extra = {}
    if (action === 'economicEvents.list') rows = h.events.filter(event => (!input.status || event.status === input.status) &&
      (!input.economicNature || event.economicNature === input.economicNature))
    else if (action === 'reviewIssues.list') rows = h.issues.filter(issue => input.group === 'review' ? issue.issueType !== 'account_mapping' : input.group === 'accounts' ? issue.issueType === 'account_mapping' : true)
    else if (action === 'reviewIssues.members' || action === 'reviewIssues.get') {
      const issue = h.issues.find(item => item.issueId === input.issueId)
      rows = input.memberKind === 'relation' ? [] : h.events.map(event => ({ objectType: 'event', objectId: event.eventId, event, objectVersion: 1, memberRole: 'subject' }))
      extra = { issue, subject: h.events[0] }
    } else if (action === 'financeUpdates.options') rows = input.kind === 'accounts' ? [{ accountId: 'synthetic-account', name: '合成钱包', type: 'wallet' }]
      : input.kind === 'categories' ? [{ categoryId: 'synthetic-category', name: '合成分类', kind: 'expense' }] : []
    else if (action === 'economicEvents.evidence') rows = Array.from({ length: 17 }, (_, index) => ({ evidenceId: 'synthetic-evidence-' + index, detailRequired: true, fileName: '合成账单.csv', rowNumber: index + 1 }))
    else if (action === 'economicEvents.detail') {
      const index = Number(input.cursor || 0)
      return { protocolVersion: 2, viewVersion: h.summary.viewVersion, part: '合成原文😀'.repeat(200), nextCursor: index < 20 ? String(index + 1) : null }
    } else throw new Error('unexpected action ' + action)
    const start = Number(input.cursor || 0), size = input.pageSize || 40
    const result = { protocolVersion: 2, viewVersion: h.summary.viewVersion, update: h.summary.update,
      items: rows.slice(start, start + size), total: rows.length, nextCursor: start + size < rows.length ? String(start + size) : null, ...extra }
    if (action === 'reviewIssues.get') { result.members = result.items; delete result.items }
    return result
  }
  const api = { callImport: call, readSummary: updateId => call('financeUpdates.summary', { updateId }),
    command: (action, input) => call(action, { ...input }), createRequestId: () => 'synthetic-request-' + calls.length }
  const draftService = { lastUpdateId: () => '', forgetLast() {}, clearUpdate() {}, pauseUpdate() {}, project: (view) => view,
    open(view) { if (!session) { session = createDraft({ scope: 'synthetic', view, autoSync: false, call,
      read: key => storage.get(key), write: (key, value) => storage.set(key, value), remove: key => storage.delete(key), requestId: api.createRequestId });
      const subscribe = session.subscribe
      session.subscribe = listener => {
        h.activeSubscriptions++; const off = subscribe(listener); let active = true
        return () => { if (active) { active = false; h.activeSubscriptions--; off() } }
      }
    } return session } }
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), showToast() {}, pageScrollTo() {} }
  h.wx = wx
  const root = path.join(__dirname, '../../miniprogram')
  function load(filename) {
    if (filename.endsWith('/services/catledger-import.js')) return api
    if (filename.endsWith('/services/import-draft-session.js')) return draftService
    if (filename.endsWith('/services/read-cache.js')) return cache
    if (filename.endsWith('/services/login-guard.js')) return { run: (_, work) => work() }
    if (filename.endsWith('/theme/service.js')) return { bindPage() {} }
    if (modules.has(filename)) return modules.get(filename).exports
    const module = { exports: {} }; modules.set(filename, module)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Page: value => { definition = value },
      wx, getApp: () => h.app, setTimeout, clearTimeout,
      require: name => load(path.resolve(path.dirname(filename), name) + '.js') }, { filename })
    if (filename.endsWith('/import-workbench/model.js')) for (const [name, fn] of Object.entries(module.exports)) if (typeof fn === 'function') {
      module.exports[name] = (...args) => { h.derives[name] = (h.derives[name] || 0) + 1; return fn(...args) }
    }
    return module.exports
  }
  load(path.join(root, 'pages/import-workbench/index.js'))
  h.createPage = () => {
    const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(patch, callback) {
    patches.push(Buffer.byteLength(JSON.stringify(patch)))
    for (const [key, value] of Object.entries(patch)) {
      const keys = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = this.data
      for (const key of keys.slice(0, -1)) target = target[key] || (target[key] = {})
      target[keys.at(-1)] = value
    }
    h.maxDataBytes = Math.max(h.maxDataBytes, Buffer.byteLength(JSON.stringify(this.data)))
    if (callback) callback.call(this)
  } })
    page.onLoad({})
    page.applyUpdateView(h.summary)
    return page
  }
  h.page = h.createPage()
  h.flush = flush
  return h
}
module.exports = { runtime, fixture, flush }
