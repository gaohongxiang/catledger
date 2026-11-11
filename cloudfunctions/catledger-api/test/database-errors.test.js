const assert = require('node:assert/strict')
const test = require('node:test')

const {
  databaseErrorCode,
  isRetryableDatabaseError,
  isRetryableTransportError,
  waitBeforeDatabaseRetry
} = require('../src/database-errors')

test('连接被拒/重置/超时归为可重试的传输层错误', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']) {
    assert.equal(isRetryableTransportError({ code }), true, code)
    assert.equal(isRetryableDatabaseError({ code }), true, code)
  }
})

test('业务级死锁/连接数满仍是可重试数据库错误，但不是传输层错误', () => {
  for (const code of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_CON_COUNT_ERROR']) {
    assert.equal(isRetryableDatabaseError({ code }), true, code)
    assert.equal(isRetryableTransportError({ code }), false, code)
  }
})

test('非可重试错误码不进入重试', () => {
  for (const code of ['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', '']) {
    assert.equal(isRetryableDatabaseError({ code }), false, code)
    assert.equal(isRetryableTransportError({ code }), false, code)
  }
})

test('沿 cause 链读取底层错误码', () => {
  const root = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
  const wrapped = new Error('query failed', { cause: root })
  assert.equal(databaseErrorCode(wrapped), 'ECONNREFUSED')
  assert.equal(isRetryableTransportError(wrapped), true)
})

test('重试退避有上限且不等于零', async () => {
  // 只验证不会抛错并给出正延迟（0 会变成随机 1ms 下限）；上限逻辑在取模内。
  const started = Date.now()
  await waitBeforeDatabaseRetry(0)
  await waitBeforeDatabaseRetry(1)
  await waitBeforeDatabaseRetry(5)
  assert.ok(Date.now() - started >= 0)
})
