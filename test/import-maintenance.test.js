const test = require('node:test')
const assert = require('node:assert/strict')
const { isTimerEvent, isScheduledMaintenance } = require('../cloudfunctions/catledger-import/src/maintenance')
const { classifyServerAge, SERVER_AUTO_RESUME_MS, SERVER_HARD_EXPIRE_MS } = require('../cloudfunctions/catledger-import/src/import-draft-retention')
const { runScheduledMaintenance } = require('../cloudfunctions/catledger-import/src/scheduled-maintenance')
const { createCleanupBudget, withCleanupConnection, FUNCTION_TIMEOUT_MS, SAFETY_MARGIN_MS } = require('../cloudfunctions/catledger-import/src/cleanup-runtime')

test('定时事件只识别明确的 Timer 触发，不把业务动作当维护调用', () => {
  assert.equal(isTimerEvent({ Type: 'Timer', TriggerName: 'cleanup-expired-import-files' }), true)
  assert.equal(isTimerEvent({ type: 'timer' }), true)
  assert.equal(isTimerEvent({ TriggerName: 'cleanup-expired-import-files' }), false)
  assert.equal(isScheduledMaintenance({ Type: 'Timer' }, {}), true)
  assert.equal(isScheduledMaintenance({ Type: 'Timer' }, { OPENID: 'forged-client' }), false)
  assert.equal(isScheduledMaintenance({ action: 'imports.prepareMany' }, {}), false)
  assert.equal(isTimerEvent({ action: 'imports.prepareMany', data: {} }), false)
  assert.equal(isTimerEvent(null), false)
})

test('服务端草稿 24/48 小时边界与正式回执分离', () => {
  assert.equal(classifyServerAge(SERVER_AUTO_RESUME_MS - 1), 'fresh')
  assert.equal(classifyServerAge(SERVER_AUTO_RESUME_MS), 'manual')
  assert.equal(classifyServerAge(SERVER_HARD_EXPIRE_MS - 1), 'manual')
  assert.equal(classifyServerAge(SERVER_HARD_EXPIRE_MS), 'expired')
  assert.equal(classifyServerAge(null), 'fresh')
})

test('部署配置只为导入函数挂载每日清理触发器', () => {
  const config = require('../cloudbaserc.json')
  const importer = config.functions.find(item => item.name === 'catledger-import')
  const api = config.functions.find(item => item.name === 'catledger-api')
  assert.ok(importer && Array.isArray(importer.triggers) && importer.triggers.length === 1)
  assert.deepEqual(importer.triggers[0], { name: 'cleanup-expired-import-files', type: 'timer', config: '0 0 3 * * * *' })
  assert.equal(api.triggers, undefined)
  assert.equal(importer.timeout * 1000, FUNCTION_TIMEOUT_MS)
  assert.ok(SAFETY_MARGIN_MS >= 15000)
})

test('清理轮转续批：一类失败不阻断另一类，输出不包含内部游标或异常信息', async () => {
  const calls = []
  const result = await runScheduledMaintenance({
    async cleanupExpiredDraftsGlobal() { calls.push('drafts'); throw new Error('private-user-and-file') },
    async cleanupExpiredFilesGlobal(limit, { progress }) {
      calls.push('files')
      progress.cursor = { uid: 'private-user', fileID: 'private-file' }
      progress.done = calls.length === 4
      return { checked: limit, deleted: limit, failed: 0 }
    },
    async cleanupBacklogGlobal(kind) {
      if (kind === 'drafts') throw new Error('private-query')
      return { available: true, pending: 2, ready: 1, deferred: 1, oldestPendingAgeMs: 100000 }
    }
  })
  assert.deepEqual(calls, ['drafts', 'files', 'files', 'files'])
  assert.equal(result.drafts.batchFailures, 1)
  assert.equal(result.files.deleted, 15)
  assert.equal(result.files.backlog.deferred, 1)
  assert.deepEqual(result.drafts.backlog, { available: false })
  assert.doesNotMatch(JSON.stringify(result), /private|cursor|fileID|uid/)
})

test('清理按草稿/原件公平轮转，达到批次数上限后让下一次触发继续', async () => {
  const calls = []
  const batch = kind => async () => { calls.push(kind); return { checked: 5, failed: 5 } }
  const result = await runScheduledMaintenance({
    cleanupExpiredDraftsGlobal: batch('drafts'), cleanupExpiredFilesGlobal: batch('files'),
    async cleanupBacklogGlobal() { return { available: true, pending: 100 } }
  }, { maxRounds: 2 })
  assert.deepEqual(calls, ['drafts', 'files', 'drafts', 'files'])
  assert.equal(result.stopReason, 'batch_limit')
  assert.equal(result.files.failed, 10)
})

test('总预算耗尽前不再发起新批，留出独立指标读取预算', async () => {
  let clock = 0
  const calls = []
  const result = await runScheduledMaintenance({
    async cleanupExpiredDraftsGlobal() { calls.push('drafts'); clock += 43000; return { checked: 1, cleaned: 1 } },
    async cleanupExpiredFilesGlobal() { calls.push('files'); return {} },
    async cleanupBacklogGlobal(kind, { budget }) { assert.ok(budget.canStart()); calls.push(kind + '-metrics'); return { available: true } }
  }, { now: () => clock })
  assert.deepEqual(calls, ['drafts', 'drafts-metrics', 'files-metrics'])
  assert.equal(result.stopReason, 'time_budget')
  assert.equal(result.elapsedMs, 43000)
})

test('等待连接和外部删除都受预算约束，超时连接不回池且迟到任务不能继续写', async () => {
  let acquired, returned = 0
  const waiting = withCleanupConnection({ getConnection: () => new Promise(resolve => { acquired = resolve }) },
    createCleanupBudget({ timeoutMs: 1000 }), async () => assert.fail('should not start'), 10)
  await assert.rejects(waiting, { code: 'CLEANUP_TIMEOUT' })
  acquired({ release() { returned += 1 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(returned, 1)

  let unblock, destroyed = 0, writes = 0, released = 0
  const connection = {
    execute() { writes += 1; return Promise.resolve([[]]) },
    rollback() { return Promise.resolve() },
    destroy() { destroyed += 1 }, release() { released += 1 }
  }
  const running = withCleanupConnection({ getConnection: async () => connection }, createCleanupBudget({ timeoutMs: 1000 }),
    async guarded => { await new Promise(resolve => { unblock = resolve }); await guarded.execute('late write') }, 10)
  await assert.rejects(running, { code: 'CLEANUP_TIMEOUT' })
  unblock()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(destroyed, 1)
  assert.equal(released, 0)
  assert.equal(writes, 0)
})

test('在途SQL超时后销毁连接，即使旧查询迟到成功也不能继续提交', async () => {
  let finishQuery, destroyed = 0, released = 0, committed = 0
  const connection = {
    execute() { return new Promise(resolve => { finishQuery = resolve }) },
    commit() { committed += 1; return Promise.resolve() },
    rollback() { return Promise.resolve() },
    destroy() { destroyed += 1 }, release() { released += 1 }
  }
  const running = withCleanupConnection({ getConnection: async () => connection }, createCleanupBudget({ timeoutMs: 1000 }),
    async guarded => { await guarded.execute('synthetic write'); await guarded.commit() }, 10)
  await assert.rejects(running, { code: 'CLEANUP_TIMEOUT' })
  finishQuery([[]])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(destroyed, 1)
  assert.equal(released, 0)
  assert.equal(committed, 0)
})
