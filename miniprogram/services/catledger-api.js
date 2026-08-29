function loginRequiredError() {
  const error = new Error('请先使用微信登录')
  error.code = 'LOGIN_REQUIRED'
  return error
}

function hasLoginApproval() {
  const app = getApp()
  return app && typeof app.hasLoginApproval === 'function' && app.hasLoginApproval()
}

function callApiInternal(action, data) {
  return wx.cloud.callFunction({
    name: 'catledger-api',
    data: {
      action: action,
      data: data || {}
    }
  }).catch(function () {
    const error = new Error('账本暂时没连接上')
    error.code = 'CLOUD_CALL_FAILED'
    throw error
  }).then(function (response) {
    const result = response.result
    if (!result || result.ok !== true) {
      const error = new Error(
        result && result.error && result.error.message
          ? result.error.message
          : '服务暂时不可用，请稍后重试'
      )
      error.code = result && result.error ? result.error.code : 'INTERNAL_ERROR'
      throw error
    }
    return result.data
  })
}

function callApi(action, data) {
  if (!hasLoginApproval()) {
    return Promise.reject(loginRequiredError())
  }
  return callApiInternal(action, data)
}

function bootstrapInternal() {
  return wx.cloud.callFunction({
    name: 'catledger-api',
    data: { action: 'bootstrap' }
  }).catch(function () {
    const error = new Error('账本暂时没连接上')
    error.code = 'CLOUD_CALL_FAILED'
    throw error
  }).then(function (response) {
    const result = response.result
    if (!result || result.ok !== true) {
      const error = new Error(
        result && result.error && result.error.message
          ? result.error.message
          : '账本初始化失败'
      )
      error.code = result && result.error ? result.error.code : 'INTERNAL_ERROR'
      throw error
    }
    return result.data
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
