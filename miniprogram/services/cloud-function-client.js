const cloudCallPolicy = require('./cloud-call-policy')

const CLOUD_RETRY_DELAY_MS = 300

function loginRequiredError() {
  const error = new Error('请先登录')
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

function handleTransportFailure(originalError, action, data, attempt, invoke) {
  const failure = cloudCallPolicy.classifyCloudFailure(originalError)
  if (cloudCallPolicy.shouldRetry(action, data, failure, attempt)) {
    return waitBeforeRetry().then(function () {
      return invoke(action, data, attempt + 1)
    })
  }
  throw cloudCallPolicy.toPublicError(failure)
}

function unwrapResponse(response, fallbackMessage) {
  const result = response && response.result
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

function createCloudFunctionClient(options) {
  const functionName = options.functionName
  const fallbackMessage = options.fallbackMessage || '服务暂时不可用，请稍后重试'

  function invoke(action, data, attempt, message) {
    return Promise.resolve()
      .then(function () {
        return wx.cloud.callFunction({
          name: functionName,
          data: { action: action, data: data || {} }
        })
      })
      .then(function (response) {
        if (!response || !response.result || typeof response.result !== 'object') {
          return handleTransportFailure(response, action, data, attempt, function (retryAction, retryData, retryAttempt) {
            return invoke(retryAction, retryData, retryAttempt, message)
          })
        }
        try {
          return unwrapResponse(response, message || fallbackMessage)
        } catch (error) {
          const failure = cloudCallPolicy.classifyServiceFailure(error)
          if (cloudCallPolicy.shouldRetry(action, data, failure, attempt)) {
            return waitBeforeRetry().then(function () {
              return invoke(action, data, attempt + 1, message)
            })
          }
          throw error
        }
      }, function (originalError) {
        return handleTransportFailure(originalError, action, data, attempt, function (retryAction, retryData, retryAttempt) {
          return invoke(retryAction, retryData, retryAttempt, message)
        })
      })
  }

  function callInternal(action, data, message) {
    return invoke(action, data, 0, message)
  }

  function call(action, data) {
    if (!hasLoginApproval()) return Promise.reject(loginRequiredError())
    return callInternal(action, data)
  }

  return {
    call: call,
    callInternal: callInternal
  }
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
  createCloudFunctionClient: createCloudFunctionClient,
  createRequestId: createRequestId
}
