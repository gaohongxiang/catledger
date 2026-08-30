const test = require('node:test')
const assert = require('node:assert/strict')

const policy = require('../miniprogram/services/cloud-call-policy')

function loadApi(callFunction) {
  global.wx = { cloud: { callFunction: callFunction } }
  global.getApp = function () {
    return { hasLoginApproval: function () { return true } }
  }
  const modulePath = require.resolve('../miniprogram/services/catledger-api')
  delete require.cache[modulePath]
  return require(modulePath)
}

test.afterEach(function () {
  delete global.wx
  delete global.getApp
})

test('AppID 上下文缺失返回可诊断错误且不允许重试', function () {
  const failure = policy.classifyCloudFailure({
    errCode: 41002,
    errMsg: 'webapi_getwxaasyncsecinfo:fail appid missing'
  })

  assert.equal(failure.code, 'APP_CONTEXT_MISSING')
  assert.equal(failure.retryable, false)
  assert.equal(policy.shouldRetry('bootstrap', failure, 0), false)
  assert.equal(policy.classifyCloudFailure('Error: appid missing').code, 'APP_CONTEXT_MISSING')
  assert.equal(policy.classifyCloudFailure({ errCode: 41002 }).code, 'APP_CONTEXT_MISSING')
})

test('只读请求遇到瞬时网络错误自动重试一次', async function () {
  let calls = 0
  const api = loadApi(function () {
    calls += 1
    if (calls === 1) {
      return Promise.reject({ errMsg: 'request:fail timeout' })
    }
    return Promise.resolve({ result: { ok: true, data: { accounts: [] } } })
  })

  const result = await api.callApi('accounts.list')
  assert.deepEqual(result, { accounts: [] })
  assert.equal(calls, 2)
})

test('通用调用层不会自动重放写动作', async function () {
  let calls = 0
  const api = loadApi(function () {
    calls += 1
    return Promise.reject({ errMsg: 'request:fail timeout' })
  })

  await assert.rejects(
    api.callApi('transactions.delete', { transactionId: 'transaction-id' }),
    function (error) { return error.code === 'CLOUD_TEMPORARY_UNAVAILABLE' }
  )
  assert.equal(calls, 1)
})

test('AppID 上下文错误不会被通用文案吞掉', async function () {
  let calls = 0
  const api = loadApi(function () {
    calls += 1
    return Promise.reject({ errMsg: 'cloud.callFunction:fail Error: appid missing' })
  })

  await assert.rejects(
    api.bootstrapAfterConsent(),
    function (error) {
      return error.code === 'APP_CONTEXT_MISSING' && /重新打开项目/.test(error.message)
    }
  )
  assert.equal(calls, 1)
})
