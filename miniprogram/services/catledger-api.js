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

function callApi(action, data, options) {
  const app = getApp()
  if (!app || !app.hasLoginApproval()) return client.call(action, data)
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
