const cloudCallPolicy = require('./cloud-call-policy')

const CLOUD_RETRY_DELAY_MS = 300

function loginRequiredError() {
  const error = new Error('请先使用微信登录')
  error.code = 'LOGIN_REQUIRED'
  return error
}

function hasLoginApproval() {
  const app = getApp()
  return app && typeof app.hasLoginApproval === 'function' && app.hasLoginApproval()
}

function waitBeforeRetry() {
  return new Promise(function (resolve) {
    setTimeout(resolve, CLOUD_RETRY_DELAY_MS)
  })
}

function invokeCloudFunction(action, payload, attempt) {
  return Promise.resolve()
    .then(function () {
      return wx.cloud.callFunction({
        name: 'catledger-api',
        data: payload
      })
    })
    .catch(function (originalError) {
      const failure = cloudCallPolicy.classifyCloudFailure(originalError)
      if (cloudCallPolicy.shouldRetry(action, failure, attempt)) {
        return waitBeforeRetry().then(function () {
          return invokeCloudFunction(action, payload, attempt + 1)
        })
      }
      throw cloudCallPolicy.toPublicError(failure)
    })
}

function unwrapResponse(response, fallbackMessage) {
  const result = response.result
  if (!result || result.ok !== true) {
    const error = new Error(
      result && result.error && result.error.message
        ? result.error.message
        : fallbackMessage
    )
    error.code = result && result.error ? result.error.code : 'INTERNAL_ERROR'
    throw error
  }
  return result.data
}

function callApiInternal(action, data) {
  return invokeCloudFunction(action, {
    action: action,
    data: data || {}
  }, 0).then(function (response) {
    return unwrapResponse(response, '服务暂时不可用，请稍后重试')
  })
}

function callApi(action, data) {
  if (!hasLoginApproval()) {
    return Promise.reject(loginRequiredError())
  }
  return callApiInternal(action, data)
}

function bootstrapInternal() {
  return invokeCloudFunction('bootstrap', { action: 'bootstrap' }, 0)
    .then(function (response) {
      return unwrapResponse(response, '账本初始化失败')
    })
}

function bootstrap() {
  if (!hasLoginApproval()) {
    return Promise.reject(loginRequiredError())
  }
  return bootstrapInternal()
}

function bootstrapAfterConsent() {
  return bootstrapInternal()
}

function createRequestId() {
  let seed = Date.now().toString(16)
  while (seed.length < 32) {
    seed += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  }
  const chars = seed.slice(0, 32).split('')
  chars[12] = '4'
  chars[16] = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]
  return [
    chars.slice(0, 8).join(''),
    chars.slice(8, 12).join(''),
    chars.slice(12, 16).join(''),
    chars.slice(16, 20).join(''),
    chars.slice(20, 32).join('')
  ].join('-')
}

module.exports = {
  bootstrap: bootstrap,
  callApi: callApi,
  createRequestId: createRequestId,
  bootstrapAfterConsent: bootstrapAfterConsent
}
