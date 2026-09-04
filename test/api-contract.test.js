const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { PUBLIC_ACTIONS, createActionHandlers } = require('../cloudfunctions/catledger-api/src/action-registry')
const contract = require('../shared/catledger-api.json')

const projectRoot = path.resolve(__dirname, '..')

function collectJavaScript(directory) {
  const values = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) values.push(...collectJavaScript(entryPath))
    if (entry.isFile() && entry.name.endsWith('.js')) values.push(entryPath)
  }
  return values
}

function serviceStub(names) {
  return Object.fromEntries(names.map((name) => [name, function stub() {}]))
}

test('shared contract and server action registry stay in exact sync', () => {
  const contractActions = Object.keys(contract.actions).sort()
  const publicActions = [...PUBLIC_ACTIONS].sort()
  assert.equal(new Set(PUBLIC_ACTIONS).size, PUBLIC_ACTIONS.length)
  assert.deepEqual(publicActions, contractActions)

  const handlers = createActionHandlers({
    accountService: serviceStub(['archive', 'correctBalance', 'create', 'createBatch', 'list', 'update']),
    categoryService: serviceStub(['archive', 'assignTransactions', 'create', 'list', 'reorder', 'restore', 'unclassified', 'update']),
    transactionService: serviceStub(['create', 'dashboard', 'linkRefund', 'list', 'refundable', 'remove', 'statistics', 'update'])
  })
  assert.deepEqual(Object.keys(handlers).sort(), contractActions.filter((action) => action !== 'bootstrap'))
  assert.equal(Object.values(handlers).every((handler) => typeof handler === 'function'), true)
})

test('static client API calls are declared by the shared contract', () => {
  const clientFiles = collectJavaScript(path.join(projectRoot, 'miniprogram'))
  const actions = new Set()
  const pattern = /\.callApi\(\s*['"]([^'"]+)['"]/g

  for (const file of clientFiles) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) actions.add(match[1])
  }

  assert.ok(actions.size > 0)
  for (const action of actions) {
    assert.ok(contract.actions[action], `客户端 action 未登记：${action}`)
  }
})

test('mutation contracts expose idempotency and version requirements consistently', () => {
  for (const [action, definition] of Object.entries(contract.actions)) {
    assert.ok(definition.kind, `${action} 缺少 kind`)
    assert.ok(definition.returns, `${action} 缺少 returns`)
    const fields = Array.isArray(definition.data) ? definition.data : []
    if (definition.kind.includes('mutation')) {
      assert.ok(fields.includes('requestId'), `${action} 缺少 requestId`)
    } else {
      assert.equal(fields.includes('requestId'), false, `${action} 只读契约不应包含 requestId`)
    }
    if (definition.kind.includes('versioned')) {
      assert.ok(
        fields.includes('version') || fields.includes('items'),
        `${action} 缺少顶层或逐项版本载体`
      )
    }
  }
})
