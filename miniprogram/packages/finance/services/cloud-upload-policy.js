const DEFAULT_TIMEOUT_MS = 60 * 1000
const DEFAULT_RETRY_DELAY_MS = 600
const DEFAULT_MAX_ATTEMPTS = 3

const TIMEOUT_PATTERN = /timed?\s*out|timeout/i
const TRANSIENT_PATTERN = /network|request:fail|connection (?:closed|reset)|socket|temporar(?:y|ily)/i

function errorText(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  return [error.errCode, error.errMsg, error.message]
    .filter(function (item) { return item !== undefined && item !== null })
    .join(' ')
}

function classifyUploadFailure(error) {
  const detail = errorText(error)
  if (TIMEOUT_PATTERN.test(detail)) {
    return { code: 'UPLOAD_TIMEOUT', message: '上传超时，请重试', retryable: true }
  }
  if (TRANSIENT_PATTERN.test(detail)) {
    return { code: 'UPLOAD_NETWORK_ERROR', message: '网络不稳定，上传失败，请重试', retryable: true }
  }
  return { code: 'UPLOAD_FAILED', message: '上传失败，请重试', retryable: false }
}

function toPublicError(failure) {
  const error = new Error(failure.message)
  error.code = failure.code
  return error
}

function timeoutError() {
  const error = new Error('uploadFile:fail timeout')
  error.code = 'UPLOAD_TIMEOUT'
  return error
}

function wait(delayMs) {
  return new Promise(function (resolve) { setTimeout(resolve, delayMs) })
}

function uploadOnce(options) {
  return new Promise(function (resolve, reject) {
    let settled = false
    let task = null
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS

    function finish(handler, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      handler(value)
    }

    const timer = setTimeout(function () {
      const pendingTask = task
      finish(reject, timeoutError())
      if (pendingTask && typeof pendingTask.abort === 'function') {
        try { pendingTask.abort() } catch (error) {}
      }
    }, timeoutMs)

    const uploadFile = options.uploadFile || function (params) { return wx.cloud.uploadFile(params) }
    try {
      task = uploadFile({
        cloudPath: options.cloudPath,
        filePath: options.filePath,
        success: function (result) { finish(resolve, result) },
        fail: function (error) { finish(reject, error) },
        // 个别 Android 微信版本会出现进度到 100%，但 success/fail 没有
        // 正常收口。complete 作为同一任务的最终兜底，settled 防止重复处理。
        complete: function (result) {
          if (result && result.fileID) finish(resolve, result)
          else finish(reject, result || new Error('uploadFile:fail incomplete'))
        }
      })
      if (task && typeof task.onProgressUpdate === 'function' && typeof options.onProgress === 'function') {
        task.onProgressUpdate(function (progress) {
          if (!settled) options.onProgress(Math.max(0, Math.min(100, Number(progress.progress) || 0)))
        })
      }
    } catch (error) {
      finish(reject, error)
    }
  })
}

async function uploadWithRetry(options) {
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, Math.floor(options.maxAttempts))
    : DEFAULT_MAX_ATTEMPTS
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await uploadOnce(options)
    } catch (error) {
      const failure = classifyUploadFailure(error)
      if (attempt + 1 < maxAttempts && failure.retryable) {
        if (typeof options.onRetry === 'function') {
          options.onRetry(failure, { attempt: attempt + 2, maxAttempts: maxAttempts })
        }
        await wait(retryDelayMs * Math.pow(2, attempt))
        continue
      }
      throw toPublicError(failure)
    }
  }
}

module.exports = {
  classifyUploadFailure: classifyUploadFailure,
  uploadOnce: uploadOnce,
  uploadWithRetry: uploadWithRetry
}
