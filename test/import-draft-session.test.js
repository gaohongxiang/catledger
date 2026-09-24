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
      if (action === 'financeUpdates.summary') return copy(view)
      view.update.version += 1
      if (action === 'reviewIssues.resolve') { view.issues[0].status = 'resolved'; view.events[0].status = 'ready' }
      return { update: copy(view.update) }
    }, ...overrides }
  return { session: create(options), calls, view, options, store }
}
const review = (id = 'a') => ({ kind: 'review', issueId: id, issueVersion: 1, issueType: 'shared_fields', subjectIds: ['event'], decision: { decision: 'apply_fields', fields: { ledgerAccountId: 'wallet' } } })

test('V2账户决定携带两级版本，小回执后的刷新失败不重发已保存决定', async () => {
  const calls = []
  let fail = true
  const view = { protocolVersion: 2, viewVersion: 'v1', update: { updateId: 'batch', version: 4, status: 'review' }, workbench: {} }
  const f = fixture({ view, async call(action, payload) {
    calls.push({ action, payload: copy(payload) })
    if (action === 'financeUpdates.summary') {
      if (fail) throw Object.assign(new Error('synthetic read timeout'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' })
      return { ...view, viewVersion: 'v2', update: { ...view.update, version: 5 } }
    }
    return { kind: 'operation-receipt', update: { ...view.update, version: 5 } }
  } })
  f.session.enqueue([{ kind: 'account', issueId: 'a', issueVersion: 7, decision: { issueId: 'a', decision: 'exclude_events' } }])
  await assert.rejects(f.session.flush())
  assert.equal(Object.hasOwn(calls[0].payload, 'resultMode'), false)
  assert.equal(calls[0].payload.updateVersion, 4)
  assert.equal(calls[0].payload.decisions[0].issueVersion, 7)
  assert.equal(f.session.status.error, '选择已同步，明细待刷新')
  fail = false
  await f.session.flush()
  assert.equal(calls.filter(call => call.action === 'reviewIssues.resolveAccountMappings').length, 1)
  assert.equal(f.session.state.entries.length, 0)
})

test('确认先持久化，零同步等待，队列完成只读取一次摘要', async () => {
  const f = fixture(); f.session.enqueue([review()])
  assert.equal(f.calls.length, 0)
  assert.equal([...f.store.values()][0].entries.length, 1)
  await f.session.flush()
  assert.deepEqual(f.calls.map(c => c.action), ['reviewIssues.resolve', 'financeUpdates.summary'])
  assert.equal(f.session.state.entries.length, 0)
})

test('断网及进程恢复复用发送前持久化的完整幂等请求', async () => {
  const f = fixture({ async call() { throw Object.assign(new Error('network'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' }) } })
  f.session.enqueue([review()]); await assert.rejects(f.session.flush())
  const payload = copy(f.session.state.flight.payload)
  const sent = []
  const restored = create({ ...f.options, view: { ...f.view, update: { ...f.view.update, version: 3 } }, async call(action, data) {
    sent.push({ action, data: copy(data) }); return action === 'financeUpdates.summary' ? { ...f.view, update: { ...f.view.update, version: 3 } } : { update: { version: 2 } }
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
  const f = fixture({ call: (action) => action === 'financeUpdates.summary' ? Promise.resolve(copy(f.view)) : new Promise(resolve => { release = resolve }) })
  f.session.enqueue([review()]); const first = f.session.flush(); const second = f.session.flush()
  assert.equal(first, second)
  assert.throws(() => f.session.enqueue([review()]), /正在同步/)
  f.session.saveDrafts({ other: { name: '新选择', revision: 1 } })
  release({ update: { version: 2 } }); await first
  assert.equal(f.session.state.drafts.other.name, '新选择')
})

test('失败不丢后续选择，冲突不自动覆盖问题版本，重新核对保留原输入', async () => {
  const f = fixture({ async call(action) { if (action === 'financeUpdates.summary') return copy(f.view); throw Object.assign(new Error('版本冲突'), { code: 'CONFLICT' }) } })
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
  await restored.post(); assert.deepEqual(received, saved.payload)
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

test('历史查重复查明确拒绝后释放原入账请求，保留待整理选择', async () => {
  const f = fixture({ async call() { throw Object.assign(new Error('需要历史核对'), { code: 'HISTORY_REVIEW_REQUIRED' }) } })
  f.session.enqueue([review()])
  await assert.rejects(f.session.post(), { code: 'HISTORY_REVIEW_REQUIRED' })
  assert.equal(f.session.state.postFlight, null)
  assert.equal(f.session.state.entries.length, 1)
})

test('放弃屏障等待在途完成并停止后续发送', async () => {
  let release; let calls = 0
  const f = fixture({ call() { calls += 1; return new Promise(resolve => { release = resolve }) } })
  f.session.enqueue([review(), review('b')]); const sending = f.session.flush(); const stopping = f.session.pause()
  release({ update: { version: 2 } }); await sending; await stopping
  assert.equal(calls, 1)
  f.session.clear(); assert.equal(f.session.state.entries.length, 0)
})


test('摘要读取期间加入的新决定仍在同一flush屏障内处理完', async () => {
  let release; let reads = 0; const writes = []
  const f = fixture({ call(action, data) {
    if (action === 'financeUpdates.summary') {
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


test('旧在途请求只核实原键；不改摘要重发，事实不足保留原草稿', async () => {
  for (const recoverable of [false, true]) {
    const store = new Map()
    const original = { schema: 1, updateId: 'batch', entries: [review()], drafts: {},
      flight: { ids: ['a'], action: 'reviewIssues.resolve', payload: { requestId: 'original-key', resultMode: 'receipt', updateVersion: 1 } } }
    store.set('catledger_import_draft_v1:env:batch', copy(original))
    const sent = []
    const f = fixture({ async call(action, data) {
      sent.push({ action, data })
      if (action === 'financeUpdates.summary') return copy(f.view)
      assert.equal(action, 'imports.commandResult')
      assert.deepEqual(data, { requestId: 'original-key', commandAction: 'reviewIssues.resolve' })
      if (!recoverable) throw Object.assign(new Error('需核对'), { code: 'RECEIPT_RECONCILIATION_REQUIRED' })
      return { protocolVersion: 2, kind: 'operation-receipt', update: { version: 2 } }
    } }, store)
    if (recoverable) { await f.session.flush(); assert.equal(f.session.state.flight, null) }
    else { await assert.rejects(f.session.flush()); assert.deepEqual(f.session.state.flight.payload, original.flight.payload) }
    assert.equal(sent.some(call => call.action === 'reviewIssues.resolve'), false)
  }
})

test('未同步组有界：第九组拒绝且保留此前原键和选择', async () => {
  const f = fixture()
  f.session.enqueue(Array.from({ length: 8 }, (_, i) => review('group-' + i)))
  const before = copy(f.session.state)
  assert.throws(() => f.session.enqueue([review('ninth')]), { code: 'DRAFT_LIMIT_REACHED' })
  assert.deepEqual(f.session.state, before)
  assert.equal(f.calls.length, 0)
})
