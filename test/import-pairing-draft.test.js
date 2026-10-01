const test = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../miniprogram/services/import-draft-session')
const copy = value => JSON.parse(JSON.stringify(value))
const key = 'suggested:all'
function fixture(total = 100, overrides = {}, store = new Map()) {
  const view = { protocolVersion: 2, viewVersion: 'v1', update: { updateId: 'synthetic-batch', version: 1, status: 'review' }, workbench: {} }
  const calls = [], receipts = new Map()
  let request = 0, saved = 0
  const options = { view, scope: 'synthetic-env:synthetic-user', autoSync: false,
    read: key => copy(store.get(key) || null), write: (key, value) => store.set(key, copy(value)), remove: key => store.delete(key),
    requestId: () => 'synthetic-request-' + (++request),
    async call(action, input) {
      calls.push({ action, input: copy(input), persisted: copy([...store.values()][0] || null) })
      if (action === 'financeUpdates.summary') return copy(view)
      assert.equal(action, 'reviewIssues.resolvePairings')
      if (receipts.has(input.requestId)) return copy(receipts.get(input.requestId))
      const count = Math.min(100, total - saved); saved += count
      view.update.version++; view.viewVersion = 'v' + view.update.version
      const receipt = { protocolVersion: 2, kind: 'operation-receipt', update: copy(view.update),
        pairing: { savedCount: saved, totalCount: total, remainingCount: total - saved, batchSavedCount: count,
          continuationToken: saved < total ? 'signed-continuation-' + saved : null } }
      receipts.set(input.requestId, copy(receipt)); return receipt
    }, ...overrides }
  const session = create(options)
  const draft = { mode: 'suggested', viewVersion: 'v1', scopeToken: 'signed-scope', revision: 1, total, excludedPairKeys: [], pairs: [] }
  return { session, options, view, draft, store, calls, receipts }
}
function authorize(f, draft = f.draft, total = f.draft.total) { f.session.savePairingDraft(key, draft); f.session.enqueuePairing(key, draft, total) }

test('100 对一次明确确认只发一次有界命令和一次摘要，排除项原样绑定范围', async () => {
  const f = fixture(97), draft = { ...f.draft, total: 100, excludedPairKeys: ['except-1', 'except-2', 'except-3'] }
  f.session.savePairingDraft(key, draft)
  assert.equal(f.calls.length, 0, '预选与持久化不写业务数据')
  f.session.enqueuePairing(key, draft, 97); await f.session.flush()
  assert.deepEqual(f.calls.map(call => call.action), ['reviewIssues.resolvePairings', 'financeUpdates.summary'])
  assert.deepEqual(f.calls[0].input.selection, { mode: 'all_except', excludedPairKeys: draft.excludedPairKeys })
  assert.equal('updateVersion' in f.calls[0].input, false)
  assert.equal('primaryEventId' in f.calls[0].input, false)
  assert.deepEqual(f.calls[0].persisted.flight.payload, f.calls[0].input)
  assert.equal(f.session.pairingTask(key).savedCount, 97)
  assert.equal(f.session.pairingTask(key).summaryReady, true)
})

test('250 对沿可信回执继续三个有界批次，下一请求前先落盘累计进度，仅最终刷新一次', async () => {
  const f = fixture(250); authorize(f); await f.session.flush()
  const writes = f.calls.filter(call => call.action === 'reviewIssues.resolvePairings')
  assert.equal(writes.length, 3)
  assert.equal(f.calls.filter(call => call.action === 'financeUpdates.summary').length, 1)
  for (let index = 1; index < writes.length; index++) {
    assert.equal(writes[index].input.continuationToken, 'signed-continuation-' + index * 100)
    assert.equal(writes[index].persisted.entries[0].progress.savedCount, index * 100)
    assert.equal(writes[index].input.requestId === writes[index - 1].input.requestId, false)
    assert.equal('selection' in writes[index].input, false)
    assert.equal('updateVersion' in writes[index].input, false)
  }
  assert.equal(f.session.pairingTask(key).savedCount, 250)
})

test('第二批超时跨进程恢复原请求号，已保存数量不丢失也不重复计算', async () => {
  const f = fixture(250), original = f.options.call
  let loseResponse = true
  f.options.call = async (action, input) => {
    const result = await original(action, input)
    if (loseResponse && input.continuationToken) throw Object.assign(new Error('synthetic timeout'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' })
    return result
  }
  // create 的 options 为同一对象，因此模拟第二批已成功但响应丢失。
  authorize(f); await assert.rejects(f.session.flush())
  assert.equal(f.session.pairingTask(key).progress.savedCount, 100)
  assert.equal(f.session.pairingTask(key).progress.remainingCount, 150)
  const pending = copy(f.session.state.flight.payload)
  loseResponse = false
  const restored = create(f.options)
  await restored.flush()
  const retries = f.calls.filter(call => call.input.requestId === pending.requestId)
  assert.equal(retries.length, 2); assert.deepEqual(retries[0].input, retries[1].input)
  assert.equal(restored.pairingTask(key).savedCount, 250)
})

test('后续批次冲突保留已存数量和未存选择，普通重试不替换版本或自动重新授权', async () => {
  const f = fixture(250), original = f.options.call
  f.options.call = async (action, input) => {
    if (input.continuationToken) throw Object.assign(new Error('synthetic external change'), { code: 'CONFLICT' })
    return original(action, input)
  }
  authorize(f); await assert.rejects(f.session.flush())
  assert.equal(f.session.pairingTask(key).progress.savedCount, 100)
  assert.equal(f.session.pairingTask(key).progress.remainingCount, 150)
  assert.equal(f.session.state.flight, null)
  assert.equal(f.session.state.pairingDrafts[key].needsRecheck, true)
  assert.match(f.session.status.error, /已保存 100 组.*150/)
  const writes = f.calls.length
  await assert.rejects(f.session.retry(), { code: 'DRAFT_CONFLICT' })
  assert.equal(f.calls.slice(writes).every(call => call.action === 'financeUpdates.summary'), true)
  f.session.discardConflicts()
  assert.equal(f.session.pairingTask(key).savedCount, 100, '通用重新核对入口不能抹掉前批已保存进度')
  const rechecked = { ...f.draft, scopeToken: 'new-signed-scope', viewVersion: 'v2', total: 150, needsRecheck: false }
  f.session.savePairingDraft(key, rechecked); f.session.enqueuePairing(key, rechecked, 150)
  assert.equal(f.session.pairingTask(key).previousSavedCount, 100, '新范围再次授权后仍明确保留前次已保存数量')
})

test('回执未核实与账户切换都保留原请求，不生成下一批', async () => {
  for (const code of ['PAIRING_RECEIPT_INVALID', 'SESSION_CHANGED']) {
    const f = fixture(250, { async call() {
      if (code === 'SESSION_CHANGED') throw Object.assign(new Error('changed'), { code })
      return { protocolVersion: 2, update: { version: 2 }, pairing: { savedCount: 100, totalCount: 250, remainingCount: 150, batchSavedCount: 99, continuationToken: 'unverified' } }
    } })
    authorize(f); await assert.rejects(f.session.flush(), { code })
    assert.equal(f.session.state.flight.payload.requestId, 'synthetic-request-1')
    assert.equal(f.session.pairingTask(key).progress.savedCount, 0)
    assert.equal(f.session.pairingTask(key).error, '')
  }
})

test('可信回执落盘失败时停止后续发送，修复存储后用原请求恢复', async () => {
  const f = fixture(150), originalWrite = f.options.write
  let failReceipt = true
  f.options.write = (key, state) => {
    if (failReceipt && state.entries[0] && state.entries[0].progress.savedCount === 100) throw new Error('synthetic disk full')
    return originalWrite(key, state)
  }
  authorize(f); await assert.rejects(f.session.flush(), { code: 'DRAFT_STORAGE_FAILED' })
  const pending = f.session.state.flight.payload.requestId
  assert.equal(f.calls.filter(call => call.action === 'reviewIssues.resolvePairings').length, 1)
  failReceipt = false; await f.session.flush()
  assert.equal(f.calls.filter(call => call.input.requestId === pending).length, 2)
  assert.equal(f.session.pairingTask(key).savedCount, 150)
})

test('已保存后摘要失败可只重读摘要，后续新增本地选择不会被旧回执清除', async () => {
  const f = fixture(), original = f.options.call
  let failSummary = true
  f.options.call = async (action, input) => {
    if (action === 'financeUpdates.summary' && failSummary) throw Object.assign(new Error('synthetic timeout'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' })
    if (action === 'reviewIssues.resolvePairings') f.session.savePairingDraft(key, { ...f.draft, revision: 2, excludedPairKeys: ['new-local-choice'] })
    return original(action, input)
  }
  authorize(f); await assert.rejects(f.session.flush())
  assert.equal(f.session.pairingTask(key).status, 'saved')
  assert.match(f.session.status.error, /选择已同步，明细待刷新/)
  assert.deepEqual(f.session.state.pairingDrafts[key].excludedPairKeys, ['new-local-choice'])
  failSummary = false; await f.session.flush()
  assert.equal(f.calls.filter(call => call.action === 'reviewIssues.resolvePairings').length, 1)
  assert.deepEqual(f.session.state.pairingDrafts[key].excludedPairKeys, ['new-local-choice'])
})

test('页面隐藏暂停后不再发下一批，恢复继续同一范围且草稿不保存账单原文', async () => {
  const f = fixture(150), original = f.options.call
  let release
  f.options.call = (action, input) => action === 'reviewIssues.resolvePairings' && !input.continuationToken
    ? new Promise(resolve => { release = () => original(action, input).then(resolve) }) : original(action, input)
  authorize(f, { ...f.draft, rawFields: 'sensitive-synthetic-data', counterparty: 'not-in-draft' })
  const sending = f.session.flush(), stopping = f.session.pause()
  await release(); await sending; await stopping
  assert.equal(f.calls.length, 1)
  assert.equal(f.session.pairingTask(key).progress.savedCount, 100)
  assert.doesNotMatch(JSON.stringify([...f.store.values()]), /sensitive-synthetic-data|not-in-draft/)
  f.session.resume(); await f.session.flush()
  assert.equal(f.session.pairingTask(key).savedCount, 150)
})

test('明确不同笔只提交一条边；失效例外保留但必须显式移出范围才能再确认', async () => {
  const f = fixture(1), draft = { ...f.draft, mode: 'ambiguous', total: 4,
    pairs: [{ pairKey: 'bank-a:platform-a', decision: 'distinct', bankEventId: 'bank-a', platformEventId: 'platform-a' }] }
  authorize(f, draft, 1); await f.session.flush()
  assert.deepEqual(f.calls[0].input.selection, { mode: 'include', pairs: [{ pairKey: 'bank-a:platform-a', decision: 'distinct' }] })
  const g = fixture(), rechecked = { ...g.draft, excludedPairKeys: ['still-valid', 'no-longer-valid'], missingPairKeys: ['no-longer-valid'] }
  g.session.savePairingDraft(key, rechecked)
  assert.throws(() => g.session.enqueuePairing(key, rechecked, 99), /先核验/)
  g.session.enqueuePairing(key, { ...rechecked, missingAcknowledged: true }, 99)
  assert.deepEqual(g.session.state.entries[0].selection.excludedPairKeys, ['still-valid'])
  assert.deepEqual(g.session.state.pairingDrafts[key].excludedPairKeys, ['still-valid', 'no-longer-valid'])
})
