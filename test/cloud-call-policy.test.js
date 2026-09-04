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
  assert.equal(policy.shouldRetry('bootstrap', {}, failure, 0), false)
  assert.equal(policy.classifyCloudFailure('Error: appid missing').code, 'APP_CONTEXT_MISSING')
  assert.equal(policy.classifyCloudFailure({ errCode: 41002 }).code, 'APP_CONTEXT_MISSING')
})

test('云函数尚未部署时不伪装成网络波动', function () {
  const failure = policy.classifyCloudFailure({
    errCode: -501000,
    errMsg: 'FunctionName parameter could not be found'
  })

  assert.equal(failure.code, 'CLOUD_FUNCTION_NOT_FOUND')
  assert.equal(failure.message, '导入服务尚未就绪，请稍后再试')
  assert.equal(failure.retryable, false)
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

test('带幂等凭据的写动作遇到瞬时错误只恢复一次', async function () {
  let calls = 0
  const api = loadApi(function () {
    calls += 1
    if (calls === 1) return Promise.reject({ errMsg: 'request:fail connection reset' })
    return Promise.resolve({ result: { ok: true, data: { accounts: [] } } })
  })

  const result = await api.callApi('accounts.createBatch', {
    requestId: '1f4be5fb-755f-4df5-b8ca-ae35d3f76965',
    accounts: [{ type: 'bank', name: '合成账户', currency: 'CNY' }]
  })
  assert.deepEqual(result, { accounts: [] })
  assert.equal(calls, 2)
})

test('导入新编排动作使用原请求号安全恢复一次', function () {
  const failure = { retryable: true }
  const data = { requestId: '1f4be5fb-755f-4df5-b8ca-ae35d3f76965' }
  ;[
    'imports.prepareMany',
    'imports.parseFile',
    'financeUpdates.prepare',
    'financeUpdates.organize'
  ].forEach(function (action) {
    assert.equal(policy.shouldRetry(action, data, failure, 0), true, action)
    assert.equal(policy.shouldRetry(action, data, failure, 1), false, action)
  })
})

test('写动作只有服务端可接受的 UUID 幂等键才允许恢复', function () {
  const failure = { retryable: true }
  assert.equal(policy.shouldRetry('accounts.create', { requestId: '------------------------------------' }, failure, 0), false)
  assert.equal(policy.shouldRetry('accounts.create', {
    requestId: '1f4be5fb-755f-4df5-b8ca-ae35d3f76965'
  }, failure, 0), true)
})

test('服务端明确返回瞬时数据库错误时幂等动作可恢复', async function () {
  let calls = 0
  const api = loadApi(function () {
    calls += 1
    if (calls === 1) {
      return Promise.resolve({ result: {
        ok: false,
        error: { code: 'SERVICE_TEMPORARY_UNAVAILABLE', message: '服务连接短暂中断，请重试' }
      } })
    }
    return Promise.resolve({ result: { ok: true, data: { accountId: 'account-1' } } })
  })

  const result = await api.callApi('accounts.create', {
    requestId: '1b0231a3-f6cf-40ef-a8b4-2880616799e8',
    type: 'bank',
    name: '合成账户'
  })
  assert.equal(result.accountId, 'account-1')
  assert.equal(calls, 2)
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

test('成功回调外壳缺少 result 时仍按传输错误诊断', async function () {
  let calls = 0
  const api = loadApi(function () {
    calls += 1
    return Promise.resolve({
      errCode: 41002,
      errMsg: 'cloud.callFunction:fail Error: appid missing'
    })
  })

  await assert.rejects(
    api.bootstrapAfterConsent(),
    function (error) {
      return error.code === 'APP_CONTEXT_MISSING' && /安全保留/.test(error.message)
    }
  )
  assert.equal(calls, 1)
})
