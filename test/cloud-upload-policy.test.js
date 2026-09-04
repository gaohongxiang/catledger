const assert = require('node:assert/strict')
const test = require('node:test')

const uploadPolicy = require('../miniprogram/services/cloud-upload-policy')

function task() {
  return { onProgressUpdate: function () {}, abort: function () {} }
}

test('微信上传超时只显示稳定中文错误，不透传 SDK 脏信息', function () {
  const failure = uploadPolicy.classifyUploadFailure({
    message: 'cloud.uploadFile:fail undefined . uploadFile:fail timeout'
  })
  assert.deepEqual(failure, {
    code: 'UPLOAD_TIMEOUT', message: '上传超时，请重试', retryable: true
  })
})

test('瞬时上传超时会沿用同一路径自动补传一次', async function () {
  let calls = 0
  let retries = 0
  const result = await uploadPolicy.uploadWithRetry({
    cloudPath: 'private/import.csv',
    filePath: '/tmp/import.csv',
    retryDelayMs: 0,
    uploadFile: function (options) {
      calls += 1
      if (calls === 1) options.fail({ errMsg: 'uploadFile:fail timeout' })
      else options.success({ fileID: 'cloud://private/import.csv' })
      return task()
    },
    onRetry: function () { retries += 1 }
  })

  assert.equal(result.fileID, 'cloud://private/import.csv')
  assert.equal(calls, 2)
  assert.equal(retries, 1)
})

test('上传任务没有任何回调时会主动中止并在三次尝试后收口为超时失败', async function () {
  let aborted = 0
  await assert.rejects(uploadPolicy.uploadWithRetry({
    cloudPath: 'private/import.csv',
    filePath: '/tmp/import.csv',
    timeoutMs: 5,
    retryDelayMs: 0,
    uploadFile: function () {
      return {
        onProgressUpdate: function () {},
        abort: function () { aborted += 1 }
      }
    }
  }), function (error) {
    return error.code === 'UPLOAD_TIMEOUT' && error.message === '上传超时，请重试'
  })
  assert.equal(aborted, 3)
})

test('Android 上传只触发 complete 时也能正常收口', async function () {
  const result = await uploadPolicy.uploadWithRetry({
    cloudPath: 'private/import.csv',
    filePath: '/tmp/import.csv',
    uploadFile: function (options) {
      options.complete({ fileID: 'cloud://private/import.csv' })
      return task()
    }
  })
  assert.equal(result.fileID, 'cloud://private/import.csv')
})

test('瞬时错误最多独立尝试三次并按次数上报重试状态', async function () {
  let calls = 0
  const retries = []
  const result = await uploadPolicy.uploadWithRetry({
    cloudPath: 'private/import.csv',
    filePath: '/tmp/import.csv',
    retryDelayMs: 0,
    uploadFile: function (options) {
      calls += 1
      if (calls < 3) options.fail({ errMsg: 'uploadFile:fail network error' })
      else options.success({ fileID: 'cloud://private/import.csv' })
      return task()
    },
    onRetry: function (failure, retry) { retries.push([failure.code, retry.attempt, retry.maxAttempts]) }
  })
  assert.equal(result.fileID, 'cloud://private/import.csv')
  assert.equal(calls, 3)
  assert.deepEqual(retries, [
    ['UPLOAD_NETWORK_ERROR', 2, 3],
    ['UPLOAD_NETWORK_ERROR', 3, 3]
  ])
})

test('非瞬时上传错误不会盲目重放', async function () {
  let calls = 0
  await assert.rejects(uploadPolicy.uploadWithRetry({
    cloudPath: 'private/import.csv',
    filePath: '/tmp/import.csv',
    retryDelayMs: 0,
    uploadFile: function (options) {
      calls += 1
      options.fail({ errMsg: 'uploadFile:fail permission denied' })
      return task()
    }
  }), function (error) {
    return error.code === 'UPLOAD_FAILED' && error.message === '上传失败，请重试'
  })
  assert.equal(calls, 1)
})
