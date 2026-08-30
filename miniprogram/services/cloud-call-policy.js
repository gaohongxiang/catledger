const SAFE_RETRY_ACTIONS = Object.freeze({
  bootstrap: true,
  'accounts.list': true,
  'categories.list': true,
  'dashboard.get': true,
  'statistics.get': true,
  'transactions.list': true,
  'transactions.refundable': true
})

const APP_CONTEXT_PATTERN = /appid missing|(?:^|\s)41002(?:\s|$)|err_code["':\s]*41002|webapi_getwxaasyncsecinfo/i
const TRANSIENT_PATTERN = /cloud api isn't enabled|internal server error|network|request:fail|systemerror|system error|timed?\s*out|timeout|temporar(?:y|ily)|connection (?:closed|reset)|socket/i

function errorText(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  const parts = [error.errCode, error.errMsg, error.message]
    .filter(function (item) { return item !== undefined && item !== null })
  return parts.length > 0 ? parts.join(' ') : String(error)
}

function classifyCloudFailure(error) {
  const detail = errorText(error)

  if (APP_CONTEXT_PATTERN.test(detail)) {
    return {
      code: 'APP_CONTEXT_MISSING',
      message: '开发工具未加载小程序身份，请重新打开项目后重试',
      retryable: false
    }
  }

  if (TRANSIENT_PATTERN.test(detail)) {
    return {
      code: 'CLOUD_TEMPORARY_UNAVAILABLE',
      message: '网络暂时不稳定，请稍后重试',
      retryable: true
    }
  }

  return {
    code: 'CLOUD_CALL_FAILED',
    message: '账本服务暂时不可用，请重试',
    retryable: false
  }
}

function shouldRetry(action, failure, attempt) {
  return attempt === 0 && SAFE_RETRY_ACTIONS[action] === true && failure.retryable === true
}

function toPublicError(failure) {
  const error = new Error(failure.message)
  error.code = failure.code
  return error
}

module.exports = {
  classifyCloudFailure: classifyCloudFailure,
  shouldRetry: shouldRetry,
  toPublicError: toPublicError
}
