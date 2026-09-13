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

async function loadCatalog(data, options) {
  const session = cache.getSession()
  try {
    return await client.call('catalog.get', data)
  } catch (error) {
    // 新客户端先于目录接口上线时，沿用旧版读取；其他失败交给原错误处理。
    if (error.code !== 'UNSUPPORTED_ACTION' || cache.getSession() !== session ||
      (data && (typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length))) throw error
    const [identity, accounts, categories] = await Promise.all([
      bootstrap(options), client.call('accounts.list'), client.call('categories.list')
    ])
    if (!identity || typeof identity.uid !== 'string' || !/^[1-9]\d{9}$/.test(identity.uid) ||
      !accounts || !Array.isArray(accounts.accounts) || !categories || !Array.isArray(categories.categories)) {
      const invalid = new Error('暂时无法加载账户和分类')
      invalid.code = 'INVALID_RESPONSE'
      throw invalid
    }
    return {
      uid: identity.uid,
      accounts: accounts.accounts.map(({ accountId, type, nature, name, currency, version, archived }) =>
        ({ accountId, type, nature, name, currency, version, archived })),
      categories: categories.categories
    }
  }
}

function callApi(action, data, options) {
  const app = getApp()
  if (!app || !app.hasLoginApproval()) return client.call(action, data)
  if (action === 'catalog.get') return read(action, data, options, () => loadCatalog(data, options))
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
