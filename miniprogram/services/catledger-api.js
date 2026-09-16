const cloudFunctionClient = require('./cloud-function-client')
const cache = require('./read-cache')
const { READ_POLICIES, mutationTags } = require('./read-policy')

const client = cloudFunctionClient.createCloudFunctionClient({
  functionName: 'catledger-api',
  fallbackMessage: '服务暂时不可用，请稍后重试'
})

function read(action, data, options, loader) {
  const key = cache.stableKey(action, data)
  return cache.read(key, READ_POLICIES[action], loader, options).then(result => {
    // 首页与账户列表使用同一个服务端账户投影；只复用完整账户集合。
    if (action === 'dashboard.get' && Array.isArray(result.accounts)) {
      cache.seedFrom(key, cache.stableKey('accounts.list'), READ_POLICIES['accounts.list'], view => ({ accounts: view.accounts }))
    }
    return result
  })
}

async function loadCatalog(data) {
  const result = await client.call('catalog.get', data)
  if (!result || typeof result.uid !== 'string' || !/^[1-9]\d{9}$/.test(result.uid) ||
    !Array.isArray(result.accounts) || !Array.isArray(result.categories)) {
    throw Object.assign(new Error('暂时无法加载账户和分类'), { code: 'INVALID_RESPONSE' })
  }
  return result
}

async function loadStatistics(data) {
  const result = await client.call('statistics.get', data)
  if (!data || !data.trendEndMonth) return result
  const end = view => Array.isArray(view.cashFlowTrend) && view.cashFlowTrend.length
    ? view.cashFlowTrend[view.cashFlowTrend.length - 1].month : view.trendEndMonth
  if (end(result) !== data.trendEndMonth) throw Object.assign(new Error('趋势月份校验失败，请刷新后重试'), { code: 'INVALID_RESPONSE' })
  return result
}

async function loadTransactions(data) {
  const result = await client.call('transactions.list', data)
  if (data && data.source && (!result || result.source !== data.source)) {
    throw Object.assign(new Error('来源筛选暂不可用，请稍后重试'), { code: 'INVALID_RESPONSE' })
  }
  return result
}

function callApi(action, data, options) {
  const app = getApp()
  if (!app || !app.hasLoginApproval()) return client.call(action, data)
  if (action === 'catalog.get') {
    const session = cache.getSession()
    return read(action, data, options, () => loadCatalog(data)).then(result => {
      if (cache.getSession() !== session || !app.hasLoginApproval()) {
        throw Object.assign(new Error('登录状态已改变，请重新打开页面'), { code: 'SESSION_CHANGED' })
      }
      app.globalData.uid = result.uid
      return result
    })
  }
  if (action === 'statistics.get') return read(action, data, options, () => loadStatistics(data))
  if (action === 'transactions.list') return read(action, data, options, () => loadTransactions(data))
  if (READ_POLICIES[action]) return read(action, data, options, () => client.call(action, data))
  const tags = mutationTags(action)
  return tags.length ? cache.mutate(tags, () => client.call(action, data)) : cache.guard(() => client.call(action, data))
}

function bootstrap(options) { return callApi('bootstrap', {}, options) }
function bootstrapAfterConsent() {
  return read('bootstrap', {}, { force: true }, () => client.callInternal('bootstrap', {}, '账本初始化失败'))
}
function cacheToken(action, data) {
  const app = getApp()
  return app && app.hasLoginApproval() ? cache.token(cache.stableKey(action, data)) : null
}

function peek(action, data) {
  const app = getApp()
  return app && app.hasLoginApproval() ? cache.peek(cache.stableKey(action, data)) : null
}

module.exports = {
  bootstrap,
  callApi,
  cacheToken,
  peek,
  isFresh: (action, data) => cacheToken(action, data) !== null,
  createRequestId: cloudFunctionClient.createRequestId,
  bootstrapAfterConsent
}
