const assert = require('node:assert/strict')
const test = require('node:test')

const { createUserRepository } = require('../src/user-repository')

function createConnection({ identity, identityInsertError }) {
  const state = {
    began: 0,
    committed: 0,
    released: 0,
    rolledBack: 0
  }

  return {
    state,
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
    async execute(sql) {
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
