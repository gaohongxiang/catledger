const test = require('node:test')
const assert = require('node:assert/strict')
const { create, project } = require('../miniprogram/services/import-draft-session')
const model = require('../miniprogram/pages/import-workbench/model')
const copy = value => JSON.parse(JSON.stringify(value))
function fixture(overrides = {}, store = new Map()) {
  let number = 0
  const view = { update: { updateId: 'batch', version: 1, status: 'review' },
    issues: [{ issueId: 'a', issueType: 'shared_fields', version: 1, status: 'open', blocking: true, subjectEventIds: ['event'] }],
    events: [{ eventId: 'event', status: 'needs_action', economicNature: 'expense', amountMinor: '100', categoryId: null }] }
  const calls = []
  const options = { view, scope: 'env', autoSync: false,
    read: key => copy(store.get(key) || null), write: (key, value) => store.set(key, copy(value)), remove: key => store.delete(key),
    requestId: () => 'request-' + (++number),
    async call(action, data) {
      calls.push({ action, data: copy(data) })
      if (action === 'financeUpdates.get') return copy(view)
      view.update.version += 1
      if (action === 'reviewIssues.resolve') { view.issues[0].status = 'resolved'; view.events[0].status = 'ready' }
      return { update: copy(view.update) }
    }, ...overrides }
  return { session: create(options), calls, view, options, store }
}
const review = (id = 'a') => ({ kind: 'review', issueId: id, issueVersion: 1, issueType: 'shared_fields', subjectIds: ['event'], decision: { decision: 'apply_fields', fields: { ledgerAccountId: 'wallet' } } })

test('确认先持久化，零同步等待，队列完成只读取一次完整视图', async () => {
  const f = fixture(); f.session.enqueue([review()])
  assert.equal(f.calls.length, 0)
  assert.equal([...f.store.values()][0].entries.length, 1)
  await f.session.flush()
  assert.deepEqual(f.calls.map(c => c.action), ['reviewIssues.resolve', 'financeUpdates.get'])
  assert.equal(f.session.state.entries.length, 0)
})

test('断网及进程恢复复用发送前持久化的完整幂等请求', async () => {
  const f = fixture({ async call() { throw Object.assign(new Error('network'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' }) } })
  f.session.enqueue([review()]); await assert.rejects(f.session.flush())
  const payload = copy(f.session.state.flight.payload)
  const sent = []
  const restored = create({ ...f.options, view: { ...f.view, update: { ...f.view.update, version: 3 } }, async call(action, data) {
    sent.push({ action, data: copy(data) }); return action === 'financeUpdates.get' ? { ...f.view, update: { ...f.view.update, version: 3 } } : { update: { version: 2 } }
  } })
  await restored.flush()
  assert.deepEqual(sent[0].data, payload)
  assert.equal(restored.state.entries.length, 0)
})

test('账户确认合并为一个请求，未发送前修改会撤回旧确认', async () => {
  const f = fixture()
  const entries = ['a', 'b'].map(issueId => ({ kind: 'account', issueId, revision: 0, decision: { issueId, operation: 'resolve', decision: 'exclude_events' } }))
  const drafts = { a: { revision: 0, localConfirmed: true }, b: { revision: 0, localConfirmed: true } }
  f.session.enqueue(entries, drafts)
  f.session.saveDrafts({ ...drafts, a: { revision: 1, localConfirmed: false } })
  await f.session.flush()
  assert.equal(f.calls[0].data.decisions.length, 1)
  assert.equal(f.calls[0].data.decisions[0].issueId, 'b')
  assert.equal(f.session.state.drafts.a.revision, 1)
  assert.equal(f.session.state.drafts.b, undefined)
})

test('在途请求不可改写，其他项可继续确认，多次flush不重复提交', async () => {
  let release
  const f = fixture({ call: (action) => action === 'financeUpdates.get' ? Promise.resolve(copy(f.view)) : new Promise(resolve => { release = resolve }) })
  f.session.enqueue([review()]); const first = f.session.flush(); const second = f.session.flush()
  assert.equal(first, second)
  assert.throws(() => f.session.enqueue([review()]), /正在同步/)
  f.session.saveDrafts({ other: { name: '新选择', revision: 1 } })
  release({ update: { version: 2 } }); await first
  assert.equal(f.session.state.drafts.other.name, '新选择')
})

test('失败不丢后续选择，冲突不自动覆盖问题版本，重新核对保留原输入', async () => {
  const f = fixture({ async call(action) { if (action === 'financeUpdates.get') return copy(f.view); throw Object.assign(new Error('版本冲突'), { code: 'CONFLICT' }) } })
  f.session.enqueue([review(), review('b')]); await assert.rejects(f.session.flush())
  assert.equal(f.session.state.entries.length, 2)
  assert.equal(f.session.status.conflicts, 1)
  assert.equal(f.session.state.entries[0].issueVersion, 1)
  f.session.discardConflicts()
  assert.equal(f.session.state.conflictedChoices[0].decision.fields.ledgerAccountId, 'wallet')
  assert.equal(f.session.state.entries[0].issueId, 'b')
})

test('本地存储失败时不发送请求或虚报确认成功', () => {
  const f = fixture({ write() { throw new Error('disk full') } })
  assert.throws(() => f.session.enqueue([review()]), /本机草稿未保存/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.session.state.entries.length, 0)
})

test('批次及环境隔离，只有已验证的同一批次恢复草稿', () => {
  const f = fixture(); f.session.enqueue([review()])
  const other = create({ ...f.options, scope: 'other-env' })
  assert.equal(other.state.entries.length, 0)
  const otherBatch = create({ ...f.options, view: { ...f.view, update: { ...f.view.update, updateId: 'other-batch' } } })
  assert.equal(otherBatch.state.entries.length, 0)
  assert.throws(() => f.session.accept(otherBatch.view), /批次不一致/)
})

test('入账响应丢失后跨进程复用原请求，正式写入仍只经过post', async () => {
  const f = fixture({ async call() { throw Object.assign(new Error('network'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' }) } })
  await assert.rejects(f.session.post())
  const saved = copy(f.session.state.postFlight)
  let received
  const restored = create({ ...f.options, async call(action, data) { assert.equal(action, 'financeUpdates.post'); received = data; return { update: { status: 'posted' } } } })
  await restored.post(); assert.deepEqual(received, saved)
})

test('本地投影只改变选择展示，金额和正式就绪状态不在客户端重算', () => {
  const f = fixture(); const e = review()
  const projected = project(f.view, [e])
  assert.equal(projected.events[0].amountMinor, '100')
  assert.equal(projected.events[0].status, 'needs_action')
  assert.equal(f.view.issues[0].status, 'open')
  const rows = model.organizerRecordState(projected.events, projected.issues, [])
  assert.equal(rows.reviewStatusTabs[0].count, 0)
  const conflicted = project(f.view, [{ ...e, error: '重新核对' }])
  assert.equal(model.organizerRecordState(conflicted.events, conflicted.issues, []).reviewStatusTabs[0].count, 1)
})

test('放弃屏障等待在途完成并停止后续发送', async () => {
  let release; let calls = 0
  const f = fixture({ call() { calls += 1; return new Promise(resolve => { release = resolve }) } })
  f.session.enqueue([review(), review('b')]); const sending = f.session.flush(); const stopping = f.session.pause()
  release({ update: { version: 2 } }); await sending; await stopping
  assert.equal(calls, 1)
  f.session.clear(); assert.equal(f.session.state.entries.length, 0)
})


test('完整视图读取期间加入的新决定仍在同一flush屏障内处理完', async () => {
  let release; let reads = 0; const writes = []
  const f = fixture({ call(action, data) {
    if (action === 'financeUpdates.get') {
      reads += 1
      return reads === 1 ? new Promise(resolve => { release = resolve }) : Promise.resolve(copy(f.view))
    }
    writes.push(data.issueId); f.view.update.version += 1
    return Promise.resolve({ update: copy(f.view.update) })
  } })
  f.session.enqueue([review()]); const sending = f.session.flush()
  await Promise.resolve(); await Promise.resolve()
  f.session.enqueue([review('b')]); release(copy(f.view)); await sending
  assert.deepEqual(writes, ['a', 'b'])
  assert.equal(f.session.state.entries.length, 0)
})
