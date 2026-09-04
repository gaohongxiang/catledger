const SAFE_READ_ACTIONS = Object.freeze({
  bootstrap: true,
  'accounts.list': true,
  'categories.list': true,
  'dashboard.get': true,
  'economicEvents.correctionImpact': true,
  'economicEvents.evidence': true,
  'financeUpdates.get': true,
  'financeUpdates.undoImpact': true,
  'imports.getFile': true,
  'reviewIssues.get': true,
  'reviewIssues.list': true,
  'statistics.get': true,
  'transactions.list': true,
  'transactions.refundable': true
})
const IDEMPOTENT_MUTATION_ACTIONS = Object.freeze({
  'accounts.archive': true,
  'accounts.correctBalance': true,
  'accounts.create': true,
  'accounts.createBatch': true,
  'accounts.update': true,
  'categories.archive': true,
  'categories.create': true,
  'categories.reorder': true,
  'categories.restore': true,
  'categories.update': true,
  'imports.parseFile': true,
  'imports.prepareMany': true,
  'financeUpdates.organize': true,
  'financeUpdates.prepare': true,
  'reviewIssues.resolveAccountMappings': true,
  'transactions.create': true,
  'transactions.delete': true,
  'transactions.linkRefund': true,
  'transactions.update': true
})

const APP_CONTEXT_PATTERN = /appid missing|(?:^|\s)41002(?:\s|$)|err_code["':\s]*41002|webapi_getwxaasyncsecinfo/i
const FUNCTION_NOT_FOUND_PATTERN = /function(?:name)?[^\n]*(?:not found|does not exist|could not be found)|function_not_found|nosuchfunction|-501000/i
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
      message: '开发工具未加载小程序身份。请重新打开项目；账单已安全保留，再进入导入页会自动继续',
      retryable: false
    }
  }

  if (FUNCTION_NOT_FOUND_PATTERN.test(detail)) {
    return {
      code: 'CLOUD_FUNCTION_NOT_FOUND',
      message: '导入服务尚未就绪，请稍后再试',
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

function classifyServiceFailure(error) {
  return {
    code: error && error.code || 'INTERNAL_ERROR',
    message: error && error.message || '服务暂时不可用，请稍后重试',
    retryable: Boolean(error && error.code === 'SERVICE_TEMPORARY_UNAVAILABLE')
  }
}

function hasIdempotencyKey(data) {
  return Boolean(data && typeof data.requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId))
}

function shouldRetry(action, data, failure, attempt) {
  const safeAction = SAFE_READ_ACTIONS[action] === true ||
    (IDEMPOTENT_MUTATION_ACTIONS[action] === true && hasIdempotencyKey(data))
  return attempt === 0 && safeAction && failure.retryable === true
}

function toPublicError(failure) {
  const error = new Error(failure.message)
  error.code = failure.code
  return error
}

module.exports = {
  classifyCloudFailure: classifyCloudFailure,
  classifyServiceFailure: classifyServiceFailure,
  hasIdempotencyKey: hasIdempotencyKey,
  shouldRetry: shouldRetry,
  toPublicError: toPublicError
}
