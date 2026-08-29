const assert = require('node:assert/strict')
const test = require('node:test')

const { createHandler, hashWechatSubject } = require('../src/handler')

function createLogger() {
  const entries = []
  return {
    entries,
    error(entry) {
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
    { action: 'bootstrap', uid: 'client-user' },
    { action: 'bootstrap', openid: 'client-openid' },
    { action: 'bootstrap', data: { OPENID: 'client-openid' } }
  ]

  for (const event of variants) {
    const result = await handler(event)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_REQUEST')
  }
  assert.equal(called, false)
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
    logger
  })

  const result = await handler({ action: 'bootstrap' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.deepEqual(logger.entries, [{
    event: 'catledger-api-failure',
    code: 'INTERNAL_ERROR',
    databaseCode: undefined
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
    logger
  })

  const result = await handler({ action: 'bootstrap' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INTERNAL_ERROR')
  assert.deepEqual(logger.entries, [{
    event: 'catledger-api-failure',
    code: 'INTERNAL_ERROR',
    databaseCode: 'ER_ACCESS_DENIED_ERROR'
  }])
  assert.doesNotMatch(JSON.stringify(logger.entries), new RegExp(rawOpenid))
})
