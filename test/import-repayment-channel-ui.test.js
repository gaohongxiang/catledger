const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../miniprogram/pages/import-workbench/review-editor-model')
const { create: createDraftSession } = require('../miniprogram/services/import-draft-session')
const { setup, pair, tap: pairTap, pageDirection } = require('./helpers/pairing-workbench')
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

test('真实 Page 的还款差额不预选，显示目标及差额，只有明确确认才发送费用标记', async t => {
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
  assert.match(row.reasonText, /同日.*平台付款.*待核对差额/)
  page.selectPairing(pairTap(row.pairKey, 'same'))
  await page.confirmPairings()
  assert.equal(resolveCalls(h).length, 0, '旧的普通同笔选择入口不能隐含费用确认')
  h.wx.showModal = options => { h.modal = options; options.success({ confirm: false }) }
  await decide(page, 'same')
  assert.match(h.modal.content, /同次还款.*差额 ¥3\.60 为手续费.*合成信用卡/)
  assert.match(h.modal.content, /还款到账 ¥1,200\.00.*合计扣款 ¥1,203\.60/)
  assert.equal(resolveCalls(h).length, 0)
  assert.equal(page.data.pairingRows[0].selected, false)
  h.wx.showModal = options => options.success({ confirm: true })
  await decide(page, 'same')
  assert.deepEqual(resolveCalls(h)[0].input.selection.pairs,
    [{ pairKey: row.pairKey, decision: 'same', repaymentConfirmed: true }])
})

test('普通同笔和不同次还款不附带手续费授权，零差额说明无手续费', async t => {
  for (const kind of ['ordinary', 'distinct', 'zero']) {
    const h = setup(0), page = h.page
    t.after(() => page.onUnload())
    h.pairs = [kind === 'ordinary' ? pair(kind) : candidate(kind)]
    if (kind === 'zero') Object.assign(h.pairs[0].repayment, { feeMinor: '0', totalMinor: channel.repaymentMinor })
    await openPair(page)
    await decide(page, kind === 'distinct' ? 'distinct' : 'same')
    const choice = resolveCalls(h)[0].input.selection.pairs[0]
    if (kind === 'zero') {
      assert.match(h.modal.content, /无手续费/)
      assert.equal(choice.repaymentConfirmed, true)
    } else {
      assert.equal(h.modal, undefined)
      assert.equal(Object.hasOwn(choice, 'repaymentConfirmed'), false)
    }
  }
})

test('确认弹窗的迟到结果不能跨页面、批次版本或会话写入，也不重复打开确认', async t => {
  for (const leave of ['close', 'page', 'version', 'session', 'hidden']) {
    const h = setup(0), page = h.page
    t.after(() => page.onUnload())
    h.pairs = [candidate('first'), candidate('second')]
    let modal, shown = 0
    h.wx.showModal = options => { modal = options; shown++ }
    await openPair(page)
    const deciding = decide(page, 'same')
    await decide(page, 'same')
    assert.equal(shown, 1)
    assert.equal(page.data.pairingCanDecide, false)
    if (leave === 'close') page.closePairingReview()
    if (leave === 'page') await page.changePairingPage(pageDirection(1))
    if (leave === 'version') await page.applyUpdateView({ ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }, true)
    if (leave === 'session') h.cache.reset()
    if (leave === 'hidden') page.onHide()
    const before = h.patches.length
    modal.success({ confirm: true })
    await deciding
    assert.equal(resolveCalls(h).length, 0, leave)
    if (leave !== 'page') assert.equal(h.patches.length, before, '过期确认不回填：' + leave)
  }
})

test('还款候选不会进入批量默认选择', async t => {
  const h = setup(0), page = h.page
  t.after(() => page.onUnload())
  h.pairs = [candidate('unexpected-batch')]
  await page.openPairingReview()
  assert.equal(page.data.pairingCanConfirm, false)
  assert.equal(page.data.pairingSelectedCount, 0)
  assert.match(page.data.pairingError, /逐笔确认/)
  await page.confirmPairings()
  assert.equal(resolveCalls(h).length, 0)
})

test('费用确认的草稿白名单和跨进程冻结请求都保留明确授权，重试不追加来源原文', async () => {
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
      owner: 'other', composition: 'payment', repaymentMode: 'loan', [target]: 'synthetic-other-card', parts: [{ accountId: bank.accountId, amountInput: '999.00' }] })) {
      assert.equal(model.change(row, original, key, value), original, key)
      const forged = model.derive(row, { ...original, [key]: value }, { accounts: [credit, bank] })
      assert.equal(forged.canSave, false, '旧输入不能改写固定事实：' + key)
      assert.match(forged.fieldErrors.repaymentChannel, /修改同笔判断/)
    }
    let updated = model.change(row, original, payer, bank.accountId)
    updated = model.change(row, updated, 'note', '合成补充说明')
    const result = model.derive(row, updated, { accounts: [credit, bank] })
    assert.equal(result.canSave, true)
    assert.equal(result.showStructure, false)
    assert.equal(result.showLoan, false)
    assert.deepEqual(result.payload.fields, { [payer]: bank.accountId, note: '合成补充说明' })
    assert.equal(result.payload.decisions, undefined)
    assert.equal(result.routeFields.find(field => field.label === '还入账户').readonly, true)
    assert.equal(result.routeFields.find(field => field.label === '付款账户').readonly, false)
    assert.deepEqual(result.repaymentChannel, { repaymentText: '1200.00', feeText: '3.60', totalText: '1203.60' })
  }
})

test('真实 Page 隐藏固定编辑入口，旧控件事件不改渠道事实，付款端与备注单笔保存', async t => {
  const { h, page } = await open(t, channelRow(), { accounts: [credit, bank] })
  const prior = plain(draft(page))
  edit(page, 'amountInput', '100.00')
  edit(page, 'date', '2026-10-01')
  mode(page, 'owner', 'other')
  mode(page, 'composition', 'payment')
  mode(page, 'repaymentMode', 'loan')
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
  assert.deepEqual(plain(page.data.reviewDetailSheet.editor.repaymentChannel), { repaymentText: '1200.00', feeText: '3.60', totalText: '1203.60' })
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

test('已选不同笔改回同次还款仍需确认手续费和目标，响应未知重开保持原请求', async t => {
  const { h, page } = await duplicate(t)
  assert.equal(page.data.duplicateEditSheet.repayment.feeText, '¥3.60')
  assert.equal(page.data.duplicateEditSheet.repayment.targetAccountName, credit.name)
  h.wx.showModal = options => { h.modal = options; options.success({ confirm: false }) }
  await page.saveDuplicateEdit()
  assert.match(h.modal.content, /差额 ¥3\.60 为手续费.*合成信用卡/)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.reviseDuplicate'), false)
  h.wx.showModal = options => options.success({ confirm: true })
  let offline = true, confirmations = 0
  h.wx.showModal = options => { confirmations++; options.success({ confirm: true }) }
  h.command = action => {
    if (action === 'imports.commandResult') throw Object.assign(Error('合成请求尚未完成'), { code: 'OPERATION_UNCONFIRMED' })
    if (action !== 'financeUpdates.reviseDuplicate') return
    if (offline) throw Error('合成响应中断')
    h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
    return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update }
  }
  await page.saveDuplicateEdit()
  const first = h.calls.find(call => call.action === 'financeUpdates.reviseDuplicate').input
  assert.equal(first.repaymentConfirmed, true)
  assert.equal(first.pairKey, 'pair-reconsider')
  assert.equal(page.data.duplicateEditSheet.pending, true)
  page.closeDuplicateEdit()
  await page.openDuplicateEdit(tap({ id: 'synthetic-event-0' }))
  offline = false
  await page.saveDuplicateEdit()
  assert.equal(confirmations, 1, '结果未知只恢复已授权请求，不发起新授权')
  assert.deepEqual(h.calls.filter(call => call.action === 'financeUpdates.reviseDuplicate').map(call => call.input), [first, first])
})

test('复判的费用确认在关闭、换会话或版本失效后不提交，也不重复确认', async t => {
  for (const leave of ['close', 'session', 'version']) {
    const { h, page } = await duplicate(t)
    let confirmation, count = 0
    h.wx.showModal = options => { confirmation = options; count++ }
    const saving = page.saveDuplicateEdit()
    await page.saveDuplicateEdit()
    assert.equal(count, 1)
    if (leave === 'close') page.closeDuplicateEdit()
    if (leave === 'session') h.cache.reset()
    if (leave === 'version') await page.applyUpdateView({ ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }, true)
    confirmation.success({ confirm: true })
    await saving
    assert.equal(h.calls.some(call => call.action === 'financeUpdates.reviseDuplicate'), false, leave)
  }
})
