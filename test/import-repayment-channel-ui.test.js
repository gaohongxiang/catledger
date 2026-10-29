const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
const { create: createDraftSession } = require('../miniprogram/services/import-draft-session')
const { setup, pair, tap: pairTap } = require('./helpers/pairing-workbench')
const { open, tap, edit, mode, select, draft, view, plain, flush } = require('./helpers/editor-workbench')

const credit = { accountId: 'synthetic-credit', name: '合成信用卡', type: 'credit', currency: 'CNY' }
const bank = { accountId: 'synthetic-bank', name: '合成付款账户', type: 'bank', currency: 'CNY' }
const channel = { version: 1, repaymentMinor: '120000', feeMinor: '360', totalMinor: '120360', targetAccountId: credit.accountId }
const candidate = index => pair(index, { economicNature: 'repayment', pairKind: 'repayment', repayment: {
  ...channel, targetAccountName: credit.name, targetConfirmed: false } })
const resolveCalls = h => h.calls.filter(call => call.action === 'reviewIssues.resolvePairings')
const openPair = page => page.openAmbiguousPairingReview(tap({ issueId: 'synthetic-issue' }))
const decide = (page, decision) => page.decidePairing(pairTap('', decision))
const channelRow = (patch = {}) => ({ economicNature: 'repayment', amountMinor: channel.totalMinor,
  localAt: '2026-09-01 12:00:00', sourceDirection: 'expense', ledgerAccountId: null,
  counterpartyLedgerAccountId: credit.accountId, categoryId: null, evidenceCount: 2,
  repaymentChannel: { ...channel }, repaymentOwnership: { owner: 'self' },
  detailFacts: { accounts: [credit, bank] },
  editorFacts: { version: 1, readonly: false, composition: 'single', timezoneOffsetMinutes: -480, expectedRelations: [] }, ...patch })

test('真实 Page 的还款候选先保存同笔判断，双击只发送一次且不捆绑费用确认', async t => {
  const h = setup(0), page = h.page
  t.after(() => page.onUnload())
  h.pairs = [candidate('fee')]
  await openPair(page)
  const row = page.data.pairingRows[0]
  assert.equal(row.natureLabel, '还款')
  assert.equal(row.selected, false)
  assert.equal(page.data.pairingSelectedCount, 0)
  assert.equal(row.repayment.targetAccountName, credit.name)
  assert.equal(row.repayment.targetConfirmed, false)
  assert.equal(row.repayment.feeText, '¥3.60')
  assert.match(row.reasonText, /先判断是否同一笔.*保存后再核对还入账户及差额/)
  h.wx.showModal = () => assert.fail('同笔判断不先弹出费用确认')
  await Promise.all([decide(page, 'same'), decide(page, 'same')])
  assert.equal(resolveCalls(h).length, 1)
  assert.deepEqual(resolveCalls(h)[0].input.selection.pairs,
    [{ pairKey: row.pairKey, decision: 'same' }])
})

test('普通同笔、不同次还款及零差额同笔都只保存关系判断', async t => {
  for (const kind of ['ordinary', 'distinct', 'zero']) {
    const h = setup(0), page = h.page
    t.after(() => page.onUnload())
    h.pairs = [kind === 'ordinary' ? pair(kind) : candidate(kind)]
    if (kind === 'zero') Object.assign(h.pairs[0].repayment, { feeMinor: '0', totalMinor: channel.repaymentMinor })
    await openPair(page)
    await decide(page, kind === 'distinct' ? 'distinct' : 'same')
    const choice = resolveCalls(h)[0].input.selection.pairs[0]
    assert.equal(h.modal, undefined)
    assert.equal(Object.hasOwn(choice, 'repaymentConfirmed'), false)
  }
})

test('还款同笔直接保存仍隔离离开页面和更换会话后的迟到结果', async t => {
  for (const leave of ['session', 'hidden']) {
    const h = setup(0), page = h.page
    t.after(() => page.onUnload())
    h.pairs = [candidate('first')]
    let release
    h.onPairingCall = action => action === 'reviewIssues.resolvePairings' ? new Promise(resolve => { release = resolve }) : undefined
    await openPair(page)
    const deciding = decide(page, 'same')
    await h.flush()
    await decide(page, 'same')
    assert.equal(resolveCalls(h).length, 1)
    assert.equal(page.data.pairingCanDecide, false)
    if (leave === 'session') h.cache.reset()
    if (leave === 'hidden') page.onHide()
    const before = h.patches.length
    release(undefined)
    await deciding
    assert.equal(resolveCalls(h).length, 1, leave)
    assert.equal(h.patches.length, before, '迟到结果不回填：' + leave)
  }
})

test('还款候选参加全范围建议选择，性质统计使用服务器总数且批量只保存关系', async t => {
  const h = setup(0), page = h.page
  t.after(() => page.onUnload())
  h.pairs = Array.from({ length: 37 }, (_, index) => candidate(index)).concat([pair('expense-a'), pair('expense-b'), pair('refund', { economicNature: 'refund' })])
  h.onPairingCall = (action, input) => {
    if (action !== 'reviewIssues.pairings') return
    const start = Number(input.cursor || 0), size = input.pageSize
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, update: h.summary.update,
      items: plain(h.pairs.slice(start, start + size)), total: h.pairs.length, suggestedTotal: h.pairs.length,
      nextCursor: start + size < h.pairs.length ? String(start + size) : null,
      scopeToken: 'synthetic-repayment-scope-' + h.summary.viewVersion, scopeSourceCount: h.pairs.length * 2,
      scopeNatureCounts: Object.fromEntries(['expense','refund','repayment'].map(nature => [nature, h.pairs.filter(row => row.economicNature === nature).length])) }
  }
  await page.openPairingReview()
  assert.equal(page.data.pairingRows.length, 10)
  assert.equal(page.data.pairingCanConfirm, true)
  assert.equal(page.data.pairingSelectedCount, 40)
  assert.match(page.data.pairingScopeText, /消费 2 组、退款 1 组、还款 37 组/)
  page.selectPairing(pairTap('pair-0'))
  assert.equal(page.data.pairingSelectedCount, 39)
  assert.equal(page.data.pairingRows[0].selected, false)
  page.selectPairing(pairTap('pair-0'))
  assert.equal(page.data.pairingSelectedCount, 40)
  h.wx.showModal = () => assert.fail('批量保存同笔不要求先确认费用')
  await page.confirmPairings()
  assert.equal(resolveCalls(h).length, 1)
  assert.deepEqual(resolveCalls(h)[0].input.selection, { mode: 'all_except', excludedPairKeys: [] })
  assert.equal(h.pairs.length, 0)
})

test('旧已明确确认费用的草稿及跨进程冻结请求仍原样重试，不追加来源原文', async () => {
  const storage = new Map(), calls = []
  let fail = true
  const summary = { protocolVersion: 2, viewVersion: 'v1', update: { updateId: 'synthetic-update', version: 1, status: 'review' }, workbench: {} }
  const options = { view: summary, scope: 'synthetic-scope', autoSync: false,
    read: key => plain(storage.get(key) || null), write: (key, value) => storage.set(key, plain(value)), remove: key => storage.delete(key),
    requestId: () => 'synthetic-fee-request', async call(action, input) {
      calls.push({ action, input: plain(input) })
      if (action === 'financeUpdates.summary') return summary
      if (fail) throw Object.assign(Error('合成网络中断'), { code: 'CLOUD_TEMPORARY_UNAVAILABLE' })
      return { protocolVersion: 2, update: summary.update, pairing: { savedCount: 1, totalCount: 1, remainingCount: 0, batchSavedCount: 1, continuationToken: null } }
    } }
  const key = 'ambiguous:synthetic-issue', session = createDraftSession(options)
  const inputDraft = { mode: 'ambiguous', viewVersion: 'v1', scopeToken: 'synthetic-scope-token', revision: 1,
    pairs: [{ pairKey: 'synthetic-pair', decision: 'same', bankEventId: 'synthetic-bank-event', platformEventId: 'synthetic-platform-event',
      repaymentConfirmed: true, rawText: '不持久化的合成原文', repayment: channel }] }
  session.savePairingDraft(key, inputDraft)
  assert.equal(session.state.pairingDrafts[key].pairs[0].repaymentConfirmed, true)
  assert.equal(Object.hasOwn(session.state.pairingDrafts[key].pairs[0], 'rawText'), false)
  session.enqueuePairing(key, session.state.pairingDrafts[key], 1)
  await assert.rejects(session.flush())
  const frozen = plain(session.state.flight.payload)
  assert.deepEqual(frozen.selection.pairs, [{ pairKey: 'synthetic-pair', decision: 'same', repaymentConfirmed: true }])
  fail = false
  const restored = createDraftSession(options)
  await restored.flush()
  assert.deepEqual(calls.filter(call => call.action === 'reviewIssues.resolvePairings').map(call => call.input), [frozen, frozen])
  assert.equal(restored.pairingTask(key).summaryReady, true)
})

test('还款渠道模型固定金额、时间、归属和目标，两种方向仅付款端可补全', () => {
  for (const direction of ['expense', 'income']) {
    const row = channelRow({ sourceDirection: direction,
      ledgerAccountId: direction === 'income' ? credit.accountId : null,
      counterpartyLedgerAccountId: direction === 'expense' ? credit.accountId : null })
    const target = direction === 'income' ? 'ledgerAccountId' : 'counterpartyLedgerAccountId'
    const payer = direction === 'income' ? 'counterpartyLedgerAccountId' : 'ledgerAccountId'
    const original = model.create(row)
    for (const [key, value] of Object.entries({ amountInput: '999.00', economicNature: 'expense', date: '2026-09-02', time: '10:00:00',
      owner: 'other', composition: 'payment', repaymentDetails: true, [target]: 'synthetic-other-card', parts: [{ accountId: bank.accountId, amountInput: '999.00' }] })) {
      assert.equal(model.change(row, original, key, value), original, key)
      const forged = model.derive(row, { ...original, [key]: value }, { accounts: [credit, bank] })
      assert.equal(forged.canSave, false, '旧输入不能改写固定事实：' + key)
      assert.match(forged.fieldErrors.repaymentChannel, /修改同笔判断/)
    }
    let updated = model.change(row, original, payer, bank.accountId)
    updated = model.change(row, updated, 'note', '合成补充说明')
    const result = model.derive(row, updated, { accounts: [credit, bank] })
    assert.equal(result.canSave, true)
    // 来源组合固定了两端：两组都不能再拆，加号不出现在界面上。
    assert.ok(result.fundsEndpoints.length === 2 && result.fundsEndpoints.every(endpoint => !endpoint.open))
    assert.equal(result.showLoan, false)
    assert.deepEqual(result.payload.fields, { [payer]: bank.accountId, note: '合成补充说明' })
    assert.equal(result.payload.decisions, undefined)
    assert.equal(result.routeFields.find(field => field.label === '还入账户').readonly, true)
    assert.equal(result.routeFields.find(field => field.label === '付款账户').readonly, false)
    assert.equal(model.change(row, original, 'repaymentChannelConfirmed', false), original, '旧已确认记录不能撤销费用确认')
    assert.deepEqual(result.repaymentChannel, { repaymentText: '1200.00', feeText: '3.60', totalText: '1203.60', confirmed: true })
  }
})

test('待确认渠道需明确勾选才形成费用决定，零差额说明无手续费，取消后仍可保存其它字段', () => {
  for (const feeMinor of ['360', '0']) {
    const row = channelRow({ ledgerAccountId: bank.accountId,
      repaymentChannel: { ...channel, confirmed: false, feeMinor, totalMinor: String(BigInt(channel.repaymentMinor) + BigInt(feeMinor)) } })
    const original = model.create(row)
    assert.equal(original.repaymentChannelConfirmed, false)
    const before = model.derive(row, original, { accounts: [credit, bank] })
    assert.equal(before.canSave, false)
    assert.equal(before.complete, false)
    assert.ok(before.missing.includes('还入账户及手续费确认'))
    assert.equal(before.repaymentChannel.confirmed, false)
    assert.equal(before.repaymentChannel.confirmationText,
      '确认还入「合成信用卡」，' + (feeMinor === '0' ? '无手续费' : '差额 ¥3.60 为手续费'))
    assert.equal(model.change(row, original, 'repaymentChannelConfirmed', 'true'), original)
    assert.equal(model.change(row, original, 'amountInput', '100.00'), original)
    assert.equal(model.change(row, original, 'counterpartyLedgerAccountId', 'synthetic-other-credit'), original)
    let changed = model.change(row, original, 'note', '合成待确认备注')
    const unchecked = model.derive(row, changed, { accounts: [credit, bank] })
    assert.equal(unchecked.canSave, true)
    assert.equal(unchecked.complete, false)
    assert.equal(unchecked.payload.decisions, undefined)
    changed = model.change(row, changed, 'repaymentChannelConfirmed', true)
    const checked = model.derive(row, changed, { accounts: [credit, bank] })
    assert.equal(checked.canSave, true)
    assert.equal(checked.complete, true)
    assert.deepEqual(checked.payload.fields, { note: '合成待确认备注' })
    assert.deepEqual(checked.payload.decisions, { repaymentChannel: { confirmed: true } })
    assert.equal(model.restore(row, checked.payload).repaymentChannelConfirmed, true)
    changed = model.change(row, changed, 'repaymentChannelConfirmed', false)
    const cancelled = model.derive(row, changed, { accounts: [credit, bank] })
    assert.equal(cancelled.canSave, true)
    assert.equal(cancelled.complete, false)
    assert.equal(cancelled.payload.decisions, undefined)
  }
})

test('真实 Page 可先保存付款端和备注，勾选确认后才随单笔请求保存费用决定', async t => {
  for (const confirmed of [false, true]) {
    const { h, page } = await open(t, channelRow({ repaymentChannel: { ...channel, confirmed: false } }), { accounts: [credit, bank] })
    assert.equal(draft(page).repaymentChannelConfirmed, false)
    assert.equal(page.data.reviewEditSheet.editor.repaymentChannel.confirmed, false)
    assert.equal(select(page, 'reviewAccount', bank), true)
    edit(page, 'note', '合成还款备注')
    mode(page, 'repaymentChannelConfirmed', true)
    mode(page, 'repaymentChannelConfirmed', false)
    assert.equal(draft(page).repaymentChannelConfirmed, false)
    assert.equal(view(page).payload.decisions, undefined)
    if (confirmed) mode(page, 'repaymentChannelConfirmed', true)
    assert.equal(view(page).canSave, true)
    assert.equal(view(page).complete, confirmed)
    h.wx.showModal = () => assert.fail('单笔勾选通过保存提交，不另开确认弹窗')
    h.intercept = action => {
      if (action !== 'financeUpdates.setReview') return
      h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
      return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update, event: { status: confirmed ? 'ready' : 'needs_action' } }
    }
    await page.saveReviewEdit()
    const writes = h.calls.filter(call => call.action === 'financeUpdates.setReview')
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].input.fields, { ledgerAccountId: bank.accountId, note: '合成还款备注' })
    assert.deepEqual(writes[0].input.decisions, confirmed ? { repaymentChannel: { confirmed: true } } : undefined)
    assert.equal(page.data.reviewEditSheet, null)
  }
})

test('单笔费用确认结果未知时保留勾选并恢复冻结请求，重开和重试不能改写决定', async t => {
  const { h, page } = await open(t, channelRow({ ledgerAccountId: bank.accountId, repaymentChannel: { ...channel, confirmed: false } }), { accounts: [credit, bank] })
  mode(page, 'repaymentChannelConfirmed', true)
  let offline = true
  h.intercept = action => {
    if (action === 'imports.commandResult') throw Object.assign(Error('合成请求尚未完成'), { code: 'OPERATION_UNCONFIRMED' })
    if (action !== 'financeUpdates.setReview') return
    if (offline) throw Error('合成响应中断')
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update, event: { status: 'ready' } }
  }
  await page.saveReviewEdit()
  const first = h.calls.find(call => call.action === 'financeUpdates.setReview').input
  assert.deepEqual(first.decisions, { repaymentChannel: { confirmed: true } })
  assert.equal(page.data.reviewEditSheet.pending, true)
  mode(page, 'repaymentChannelConfirmed', false)
  assert.equal(draft(page).repaymentChannelConfirmed, true)
  page.closeReviewEdit()
  await page.openReviewEdit(tap({ id: 'synthetic-event-0' }))
  assert.equal(page.data.reviewEditSheet.pending, true)
  assert.equal(draft(page).repaymentChannelConfirmed, true)
  mode(page, 'repaymentChannelConfirmed', false)
  assert.equal(draft(page).repaymentChannelConfirmed, true)
  offline = false
  await page.saveReviewEdit()
  assert.deepEqual(h.calls.filter(call => call.action === 'financeUpdates.setReview').map(call => call.input), [first, first])
})

test('真实 Page 隐藏固定编辑入口，旧控件事件不改渠道事实，付款端与备注单笔保存', async t => {
  const { h, page } = await open(t, channelRow(), { accounts: [credit, bank] })
  const prior = plain(draft(page))
  edit(page, 'amountInput', '100.00')
  edit(page, 'date', '2026-10-01')
  mode(page, 'owner', 'other')
  page.addFundsAccount(tap({ endpoint: 'payer' }))
  page.toggleRepaymentDetails()
  assert.equal(select(page, 'reviewCounterparty', { ...credit, accountId: 'synthetic-other-credit' }), false)
  assert.equal(page.reviewEditorDirectory('editorLoan'), null)
  assert.deepEqual(plain(draft(page)), prior)
  assert.equal(select(page, 'reviewAccount', bank), true)
  edit(page, 'note', '合成还款备注')
  assert.equal(view(page).canSave, true)
  await page.openEditorRepaymentJudgment()
  assert.match(page.data.reviewEditSheet.error, /先保存当前修改/)
  assert.equal(page.data.duplicateEditSheet, null)
  h.intercept = action => {
    if (action !== 'financeUpdates.setReview') return
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update, event: { status: 'ready' } }
  }
  await page.saveReviewEdit()
  const writes = h.calls.filter(call => call.action === 'financeUpdates.setReview')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].input.eventId, 'synthetic-event-0')
  assert.deepEqual(writes[0].input.fields, { ledgerAccountId: bank.accountId, note: '合成还款备注' })
  assert.equal(writes[0].input.decisions, undefined)
})

test('渠道详情显示三项金额；无需字段修改即可从编辑器返回现有同笔拆分流程', async t => {
  const { h, page } = await open(t, channelRow(), { accounts: [credit, bank] })
  h.intercept = action => action === 'economicEvents.duplicateReview' ? { protocolVersion: 2, viewVersion: 'v1',
    update: h.summary.update, eventVersion: 1, kind: 'same', canSplit: true, records: [], count: 2 } : undefined
  await page.openEditorRepaymentJudgment()
  assert.equal(page.data.reviewEditSheet, null)
  assert.equal(page.data.duplicateEditSheet.kind, 'same')
  assert.equal(page.data.duplicateEditSheet.canSave, true)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.reviseDuplicate'), false)
  page.closeDuplicateEdit()
  await page.openReviewDetails(tap({ id: 'synthetic-event-0' }))
  assert.deepEqual(plain(page.data.reviewDetailSheet.editor.repaymentChannel), { repaymentText: '1200.00', feeText: '3.60', totalText: '1203.60', confirmed: true })
  assert.equal(page.data.reviewDetailSheet.canEdit, true)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.setReview'), false)
  await flush()
})

async function duplicate(t) {
  const { h, page } = await open(t, channelRow(), { accounts: [credit, bank] })
  page.closeReviewEdit()
  h.intercept = (action, input) => {
    if (h.command) {
      const result = h.command(action, input)
      if (result !== undefined) return result
    }
    if (action === 'economicEvents.duplicateReview') return { protocolVersion: 2, viewVersion: h.summary.viewVersion,
      update: h.summary.update, eventVersion: 1, kind: 'distinct', canMerge: true, count: 1, records: [],
      pairs: [{ ...candidate('reconsider'), otherEventId: 'synthetic-other', otherEventVersion: 2, records: [] }] }
  }
  await page.openDuplicateEdit(tap({ id: 'synthetic-event-0' }))
  return { h, page }
}

test('已选不同笔改回同次还款只保存关系，响应未知重开保持原请求', async t => {
  const { h, page } = await duplicate(t)
  assert.equal(page.data.duplicateEditSheet.repayment.feeText, '¥3.60')
  assert.equal(page.data.duplicateEditSheet.repayment.targetAccountName, credit.name)
  let offline = true
  h.wx.showModal = () => assert.fail('复判同笔不先要求费用确认')
  h.command = action => {
    if (action === 'imports.commandResult') throw Object.assign(Error('合成请求尚未完成'), { code: 'OPERATION_UNCONFIRMED' })
    if (action !== 'financeUpdates.reviseDuplicate') return
    if (offline) throw Error('合成响应中断')
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update }
  }
  await page.saveDuplicateEdit()
  const first = h.calls.find(call => call.action === 'financeUpdates.reviseDuplicate').input
  assert.equal(Object.hasOwn(first, 'repaymentConfirmed'), false)
  assert.equal(first.pairKey, 'pair-reconsider')
  assert.equal(page.data.duplicateEditSheet.pending, true)
  page.closeDuplicateEdit()
  await page.openDuplicateEdit(tap({ id: 'synthetic-event-0' }))
  offline = false
  await page.saveDuplicateEdit()
  assert.deepEqual(h.calls.filter(call => call.action === 'financeUpdates.reviseDuplicate').map(call => call.input), [first, first])
})

test('复判还款写入中双击不重复提交，换会话或隐藏后的结果不回填', async t => {
  for (const leave of ['session', 'hidden']) {
    const { h, page } = await duplicate(t)
    let release
    h.command = action => action === 'financeUpdates.reviseDuplicate' ? new Promise(resolve => { release = () => resolve({ protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update }) }) : undefined
    const saving = page.saveDuplicateEdit()
    await flush()
    await page.saveDuplicateEdit()
    assert.equal(h.calls.filter(call => call.action === 'financeUpdates.reviseDuplicate').length, 1)
    if (leave === 'session') h.cache.reset()
    if (leave === 'hidden') page.onHide()
    const before = h.patches.length
    release()
    await saving
    assert.equal(h.patches.length, before, leave)
  }
})
