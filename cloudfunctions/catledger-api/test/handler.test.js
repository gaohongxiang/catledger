const assert = require('node:assert/strict')
const test = require('node:test')

const { createHandler, hashWechatSubject } = require('../src/handler')

function createLogger() {
  const entries = []
  return {
    entries,
    error(entry) {
      entries.push(entry)
    },
    warn(entry) {
      entries.push(entry)
    }
  }
}

test('only bootstrap is exposed', async () => {
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'raw-openid' }),
    repository: {},
    logger: createLogger()
  })

  const result = await handler({ action: 'health' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'UNSUPPORTED_ACTION')
  assert.doesNotMatch(JSON.stringify(result), /raw-openid/)
})

test('bootstrap rejects identity fields supplied by the client', async () => {
  let called = false
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-openid' }),
    repository: {
      async bootstrap() {
        called = true
      }
    },
    logger: createLogger()
  })

  const variants = [
    { action: 'bootstrap', data: { OPENID: 'client-openid' } },
    { action: 'bootstrap', data: { nested: { openId: 'client-openid' } } }
  ]

  for (const event of variants) {
    const result = await handler(event)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_REQUEST')
  }
  assert.equal(called, false)
})

test('oversized nested public data is rejected without recursive stack growth', async () => {
  let data = {}
  for (let index = 0; index < 1100; index += 1) data = { child: data }
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-openid' }),
    repository: { async bootstrap() { throw new Error('must not run') } },
    logger: createLogger()
  })
  const result = await handler({ action: 'bootstrap', data })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'VALIDATION_ERROR')
})

test('runtime identity fields outside public data do not look like client input', async () => {
  let called = false
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-openid' }),
    repository: {
      async bootstrap() {
        called = true
        return { isNewUser: false, categories: [] }
      }
    },
    logger: createLogger()
  })

  const result = await handler({
    action: 'bootstrap',
    OPENID: 'platform-injected-openid',
    userInfo: { openId: 'platform-injected-openid' }
  })

  assert.equal(result.ok, true)
  assert.equal(called, true)
})

test('ledger actions receive only trusted identity and public data', async () => {
  let input
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-ledger-user' }),
    repository: {},
    services: {
      'accounts.list': async (value) => {
        input = value
        return { accounts: [] }
      }
    },
    logger: createLogger()
  })

  const result = await handler({ action: 'accounts.list', data: { includeArchived: true } })

  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { accounts: [] })
  assert.deepEqual(input, {
    provider: 'wechat-mini',
    subjectHash: hashWechatSubject('trusted-ledger-user'),
    data: { includeArchived: true }
  })
  assert.doesNotMatch(JSON.stringify(result), /trusted-ledger-user|subjectHash|uid/)
})

test('ledger actions return stable public service errors', async () => {
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-ledger-user' }),
    repository: {},
    services: {
      'accounts.create': async () => {
        const error = new Error('private validation details')
        error.publicCode = 'VALIDATION_ERROR'
        throw error
      }
    },
    logger: createLogger()
  })

  const result = await handler({ action: 'accounts.create', data: {} })
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'VALIDATION_ERROR',
      message: '请检查填写内容'
    }
  })
})

test('bootstrap ignores request properties outside the public contract', async () => {
  let input
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-openid' }),
    repository: {
      async bootstrap(value) {
        input = value
        return {
          isNewUser: false,
          categories: []
        }
      }
    },
    logger: createLogger()
  })

  const result = await handler({
    action: 'bootstrap',
    unexpected: true
  })

  assert.equal(result.ok, true)
  assert.deepEqual(input, {
    provider: 'wechat-mini',
    subjectHash: hashWechatSubject('trusted-openid')
  })
})

test('bootstrap hashes the trusted subject and returns no server identity', async () => {
  const rawOpenid = 'sensitive-wechat-openid'
  let input
  const logger = createLogger()
  const handler = createHandler({
    getWxContext: () => ({ OPENID: rawOpenid }),
    repository: {
      async bootstrap(value) {
        input = value
        return {
          isNewUser: true,
          categories: [
            {
              id: 'category-1',
              kind: 'expense',
              systemKey: 'food',
              name: '餐饮',
              sortOrder: 10
            }
          ]
        }
      }
    },
    logger
  })

  const result = await handler({ action: 'bootstrap' })
  assert.deepEqual(input, {
    provider: 'wechat-mini',
    subjectHash: hashWechatSubject(rawOpenid)
  })
  assert.equal(input.subjectHash.length, 64)
  assert.doesNotMatch(JSON.stringify(result), /sensitive-wechat-openid|subjectHash|uid/)
  assert.deepEqual(logger.entries, [])
})

test('bootstrap requires trusted WeChat identity', async () => {
  const handler = createHandler({
    getWxContext: () => ({}),
    repository: {},
    logger: createLogger()
  })

  const result = await handler({ action: 'bootstrap' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'AUTH_REQUIRED')
})

test('bootstrap sanitizes failures while reading the trusted context', async () => {
  const logger = createLogger()
  const handler = createHandler({
    getWxContext() {
      throw new Error('sensitive context failure')
    },
    repository: {},
    logger,
    now: () => 100
  })

  const result = await handler({ action: 'bootstrap' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.deepEqual(logger.entries, [{
    event: 'catledger-api-failure',
    action: 'bootstrap',
    traceId: 'unavailable',
    code: 'INTERNAL_ERROR',
    databaseCode: undefined,
    elapsedMs: 0
  }])
  assert.doesNotMatch(JSON.stringify(result), /sensitive context failure/)
})

test('bootstrap logs only sanitized database diagnostics', async () => {
  const rawOpenid = 'never-log-this-openid'
  const logger = createLogger()
  const handler = createHandler({
    getWxContext: () => ({ OPENID: rawOpenid }),
    repository: {
      async bootstrap() {
        const error = new Error(`failure for ${rawOpenid}`)
        error.code = 'ER_ACCESS_DENIED_ERROR'
        throw error
      }
    },
    logger,
    now: () => 100
  })

  const result = await handler({ action: 'bootstrap' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.deepEqual(logger.entries, [{
    event: 'catledger-api-failure',
    action: 'bootstrap',
    traceId: 'unavailable',
    code: 'INTERNAL_ERROR',
    databaseCode: 'ER_ACCESS_DENIED_ERROR',
    elapsedMs: 0
  }])
  assert.doesNotMatch(JSON.stringify(logger.entries), new RegExp(rawOpenid))
})

test('瞬时数据库错误返回可重试码且日志只包含诊断元数据', async () => {
  const logger = createLogger()
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'never-log-openid' }),
    repository: {},
    services: {
      'accounts.list': async () => {
        const error = new Error('private SQL and bindings')
        error.code = 'ECONNRESET'
        throw error
      }
    },
    logger,
    now: () => 100
  })

  const result = await handler(
    { action: 'accounts.list', data: { privateValue: 'never-log-data' } },
    { request_id: 'trace-1' }
  )

  assert.equal(result.error.code, 'SERVICE_TEMPORARY_UNAVAILABLE')
  assert.deepEqual(logger.entries, [{
    event: 'catledger-api-failure',
    action: 'accounts.list',
    traceId: 'trace-1',
    code: 'SERVICE_TEMPORARY_UNAVAILABLE',
    databaseCode: 'ECONNRESET',
    elapsedMs: 0
  }])
  assert.doesNotMatch(JSON.stringify(logger.entries), /never-log-openid|never-log-data|private SQL/)
})

test('慢请求日志包含动作、追踪号和耗时', async () => {
  const logger = createLogger()
  const clock = [10, 1510]
  const handler = createHandler({
    getWxContext: () => ({ OPENID: 'trusted-openid' }),
    repository: {},
    services: { 'accounts.list': async () => ({ accounts: [] }) },
    logger,
    now: () => clock.shift(),
    slowThresholdMs: 1000
  })

  const result = await handler({ action: 'accounts.list' }, { requestId: 'trace-2' })
  assert.equal(result.ok, true)
  assert.deepEqual(logger.entries, [{
    event: 'catledger-api-slow',
    action: 'accounts.list',
    traceId: 'trace-2',
    elapsedMs: 1500
  }])
})
