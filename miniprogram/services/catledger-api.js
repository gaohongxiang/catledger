const cloudFunctionClient = require('./cloud-function-client')
const cache = require('./read-cache')
const { READ_POLICIES, mutationTags, ALL_TAGS } = require('./read-policy')
const { assertMetadata } = require('./read-metadata')
const { envId } = require('../config/cloudbase')
const observer = require('./read-observer')
const client = cloudFunctionClient.createCloudFunctionClient({ functionName: 'catledger-api', fallbackMessage: '服务暂时不可用，请稍后重试' })

function validatePayload(action, data, result) {
  if (action === 'catalog.get' && (!Array.isArray(result.accounts) || !Array.isArray(result.categories))) {
    throw Object.assign(new Error('暂时无法加载账户和分类'), { code: 'INVALID_RESPONSE' })
  }
  if (action === 'statistics.get' && data && data.trendEndMonth) {
    const end = Array.isArray(result.cashFlowTrend) && result.cashFlowTrend.length
      ? result.cashFlowTrend[result.cashFlowTrend.length - 1].month : result.trendEndMonth
    if (end !== data.trendEndMonth) throw Object.assign(new Error('趋势月份校验失败，请刷新后重试'), { code: 'INVALID_RESPONSE' })
  }
  if (action === 'transactions.list' && data) {
    if (data.source && result.source !== data.source) throw Object.assign(new Error('来源筛选暂不可用，请稍后重试'), { code: 'INVALID_RESPONSE' })
    if (data.importUpdateId && result.importUpdateId !== data.importUpdateId) throw Object.assign(new Error('本次导入的账目暂时无法加载，请稍后重试'), { code: 'INVALID_RESPONSE' })
  }
  return result
}
async function load(action, data, options, internal) {
  const app = getApp(), uid = app && app.hasLoginApproval() ? app.globalData.uid : ''
  const key = cache.stableKey(action, data)
  const snapshot = !(options && options.force) && action !== 'bootstrap' && cache.snapshot(key)
  const previous = snapshot && snapshot.value
  const request = previous ? { knownRevision: previous.dataRevision } : undefined
  const invoke = requestOptions => internal
    ? client.callInternal(action, data, '账本初始化失败', requestOptions) : client.call(action, data, requestOptions)
  let result = assertMetadata(await invoke(request), uid)
  if (result.unchanged) {
    if (previous && previous.uid === result.uid && previous.dataRevision === result.dataRevision) result = { ...previous, unchanged: false }
    else {
      // Same protocol, without a condition; never guess or merge an incomplete response.
      result = assertMetadata(await invoke(), uid)
      if (result.unchanged) throw Object.assign(new Error('读取内容不完整，请重试'), { code: 'INVALID_RESPONSE' })
    }
  }
  return validatePayload(action, data, result)
}
function read(action, data, options, internal) {
  const key = cache.stableKey(action, data), app = getApp()
  if (app && app.hasLoginApproval() && app.globalData.uid) cache.bindScope(envId, app.globalData.uid)
  const hit = !(options && options.force) && cache.token(key) !== null, startedAt = Date.now()
  observer.record('cache', { action, source: hit ? 'memory' : 'network', hit })
  if (!hit && options && options.onSnapshot && app && app.hasLoginApproval() && app.globalData.uid) {
    const snapshot = cache.snapshot(key)
    if (snapshot) { options.onSnapshot(snapshot.value); observer.record('snapshot', { action, source: snapshot.source, ms: Date.now() - startedAt }) }
  }
  return cache.guard(() => cache.waitForValidation().then(() => cache.read(key, READ_POLICIES[action], () => load(action, data, options, internal), options))).then(result => {
    observer.record('fresh', { action, source: hit ? 'memory' : 'network', ms: Date.now() - startedAt })
    if (action === 'dashboard.get' && Array.isArray(result.accounts)) {
      cache.seedFrom(key, cache.stableKey('accounts.list'), READ_POLICIES['accounts.list'], view => ({
        accounts: view.accounts, uid: view.uid, readVersion: view.readVersion, dataRevision: view.dataRevision, unchanged: false
      }))
    }
    return result
  })
}
function callApi(action, data, options) {
  const app = getApp()
  if (!app || !app.hasLoginApproval()) return client.call(action, data)
  if (READ_POLICIES[action] && action !== 'reads.validate') {
    const session = cache.getSession()
    return read(action, data, options).then(result => {
      if (cache.getSession() !== session || !app.hasLoginApproval()) throw Object.assign(new Error('登录状态已改变，请重新打开页面'), { code: 'SESSION_CHANGED' })
      if (action === 'catalog.get') { app.globalData.uid = result.uid; cache.bindScope(envId, result.uid) }
      return result
    })
  }
  if (action === 'reads.validate') return revalidateForeground()
  const tags = mutationTags(action)
  return tags.length ? cache.mutate(tags, () => client.call(action, data)) : cache.guard(() => client.call(action, data))
}
function revalidateForeground() {
  const app = getApp()
  if (!app || !app.hasLoginApproval() || !app.globalData.uid) return Promise.resolve()
  cache.bindScope(envId, app.globalData.uid)
  return cache.validate(ALL_TAGS, () => cache.read(cache.stableKey('reads.validate'), READ_POLICIES['reads.validate'], () => load('reads.validate', {}, { force: true }), { force: true }))
}
function bootstrap(options) { return callApi('bootstrap', {}, options) }
function identifyWechatAccount() { return read('bootstrap', {}, { force: true }, true) }
function initializeProfileAfterConsent(data) {
  return cache.mutate(mutationTags('profile.update'), () => client.callInternal('profile.update', {
    requestId: data.requestId, nickname: data.nickname, previousNickname: ''
  }, '资料保存失败，请重试'))
}
function cacheToken(action, data) {
  const app = getApp()
  return app && app.hasLoginApproval() ? cache.token(cache.stableKey(action, data)) : null
}
function peek(action, data) {
  const app = getApp()
  return app && app.hasLoginApproval() ? cache.peek(cache.stableKey(action, data)) : null
}
module.exports = { bootstrap, callApi, cacheToken, peek, revalidateForeground,
  isFresh: (action, data) => cacheToken(action, data) !== null,
  createRequestId: cloudFunctionClient.createRequestId, identifyWechatAccount, initializeProfileAfterConsent }
