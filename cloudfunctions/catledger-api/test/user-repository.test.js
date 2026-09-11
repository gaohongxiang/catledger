const assert = require('node:assert/strict')
const test = require('node:test')

const { createUserRepository } = require('../src/user-repository')

function createConnection({ identity, identityInsertError, userInsertError }) {
  const state = {
    began: 0,
    committed: 0,
    released: 0,
    rolledBack: 0
  }

  return {
    state,
    attemptedUids: [],
    async beginTransaction() {
      state.began += 1
    },
    async commit() {
      state.committed += 1
    },
    async rollback() {
      state.rolledBack += 1
    },
    release() {
      state.released += 1
    },
    async execute(sql, values) {
      if (sql.includes('INSERT INTO catledger_users')) {
        this.attemptedUids.push(values[0])
        if (userInsertError) throw userInsertError
      }
      if (sql.includes('SELECT uid')) {
        return [[identity].filter(Boolean)]
      }
      if (sql.includes('INSERT INTO catledger_user_identities') && identityInsertError) {
        throw identityInsertError
      }
      if (sql.includes('SELECT category_id')) {
        return [[{
          id: 'category-1',
          kind: 'expense',
          systemKey: 'food',
          name: '餐饮',
          sortOrder: 10
        }]]
      }
      return [{}]
    }
  }
}

for (const code of ['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ECONNRESET']) {
  test(`bootstrap retries the transaction after ${code}`, async () => {
    const error = new Error(code)
    error.code = code
    const first = createConnection({ identityInsertError: error })
    const second = createConnection({ identity: { uid: 'winner-uid' } })
    const connections = [first, second]
    const repository = createUserRepository({
      getPool: () => ({
        async getConnection() {
          return connections.shift()
        }
      }),
      defaultCategories: [{
        kind: 'expense',
        systemKey: 'food',
        name: '餐饮',
        sortOrder: 10
      }]
    })

    const result = await repository.bootstrap({
      provider: 'wechat-mini',
      subjectHash: 'subject-hash'
    })

    assert.equal(result.isNewUser, false)
    assert.equal(result.uid, 'winner-uid')
    assert.equal(result.categories.length, 1)
    assert.equal(connections.length, 0)
    assert.deepEqual(first.state, {
      began: 1,
      committed: 0,
      released: 1,
      rolledBack: 1
    })
    assert.deepEqual(second.state, {
      began: 1,
      committed: 1,
      released: 1,
      rolledBack: 0
    })
  })
}

test('bootstrap does not retry a non-transactional failure', async () => {
  const error = new Error('query failed')
  error.code = 'ER_BAD_FIELD_ERROR'
  const connection = createConnection({ identityInsertError: error })
  let connectionRequests = 0
  const repository = createUserRepository({
    getPool: () => ({
      async getConnection() {
        connectionRequests += 1
        return connection
      }
    })
  })

  await assert.rejects(repository.bootstrap({
    provider: 'wechat-mini',
    subjectHash: 'subject-hash'
  }), error)

  assert.equal(connectionRequests, 1)
  assert.deepEqual(connection.state, {
    began: 1,
    committed: 0,
    released: 1,
    rolledBack: 1
  })
})


test('短UID撞到现有用户时回滚并重取新ID，不能复用其他用户身份', async () => {
  const duplicate = Object.assign(new Error('synthetic collision'), { code: 'ER_DUP_ENTRY' })
  const first = createConnection({ userInsertError: duplicate })
  const second = createConnection({})
  const connections = [first, second]
  const ids = ['1234567890', '2345678901']
  const repository = createUserRepository({
    getPool: () => ({ async getConnection() { return connections.shift() } }),
    generateUid: () => ids.shift()
  })
  const result = await repository.bootstrap({ provider: 'wechat-mini', subjectHash: 'synthetic-subject' })
  assert.equal(result.uid, '2345678901')
  assert.equal(result.isNewUser, true)
  assert.deepEqual(first.attemptedUids, ['1234567890'])
  assert.deepEqual(second.attemptedUids, ['2345678901'])
  assert.equal(first.state.rolledBack, 1)
  assert.equal(first.state.committed, 0)
  assert.equal(second.state.committed, 1)
})

test('连续短UID冲突超过重试上限时失败，所有尝试均回滚', async () => {
  const duplicate = Object.assign(new Error('synthetic collision'), { code: 'ER_DUP_ENTRY' })
  const connections = Array.from({ length: 5 }, () => createConnection({ userInsertError: duplicate }))
  let attempts = 0
  const repository = createUserRepository({
    getPool: () => ({ async getConnection() { return connections[attempts++] } }),
    generateUid: () => '1234567890'
  })
  await assert.rejects(repository.bootstrap({ provider: 'wechat-mini', subjectHash: 'synthetic-subject' }), duplicate)
  assert.equal(attempts, 5)
  assert.ok(connections.every(connection => connection.state.rolledBack === 1 && connection.state.committed === 0))
})

test('重复登录读取已存ID，不重新生成编号', async () => {
  const connection = createConnection({ identity: { uid: '3456789012' } })
  const repository = createUserRepository({
    getPool: () => ({ async getConnection() { return connection } }),
    generateUid: () => { throw new Error('must not regenerate an existing UID') }
  })
  const result = await repository.bootstrap({ provider: 'wechat-mini', subjectHash: 'synthetic-subject' })
  assert.equal(result.uid, '3456789012')
  assert.equal(result.isNewUser, false)
})
