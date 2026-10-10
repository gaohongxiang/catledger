const test = require('node:test')
const assert = require('node:assert/strict')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const tap = id => ({ currentTarget: { dataset: { id } } })
async function setup() {
  const h = runtime(fixture(2)), page = h.page
  await page.setStep({ currentStep: 3, activeReviewStatus: 'completed' })
  h.intercept = async (action, input) => {
    if (h.custom) { const result = await h.custom(action, input); if (result !== undefined) return result }
    if (action === 'economicEvents.evidence') return { viewVersion: h.summary.viewVersion, items: [], total: 0, nextCursor: null }
    if (action === 'financeUpdates.setReview') {
      const row = h.events.find(item => item.eventId === input.eventId)
      Object.assign(row, input.fields, { version: row.version + 1 })
      h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
      return { protocolVersion: 2, kind: 'operation-receipt', action, update: h.summary.update }
    }
  }
  return h
}

test('普通单来源已核对交易可修改：不要求重复或同笔历史，打开和取消不写入', async () => {
  const h = await setup(), page = h.page, eventId = h.events[0].eventId
  await page.openReviewDetails(tap(eventId))
  assert.equal(page.data.reviewDetailSheet.reviewEditable, true)
  assert.equal(page.data.reviewDetailSheet.canEdit, false)
  await page.openReviewEdit(tap(eventId))
  assert.equal(page.data.reviewEditSheet.economicNature, 'expense')
  assert.equal(page.data.reviewEditSheet.attention.some(item => item.label === '交易信息待核对'), false)
  page.changeReviewedNature({ detail: { value: 1 } })
  assert.equal(page.data.reviewEditSheet.canSave, true)
  page.closeReviewEdit()
  assert.equal(page.data.reviewDetailSheet.eventId, eventId)
  assert.equal(h.calls.some(item => item.action === 'financeUpdates.setReview'), false)
  assert.equal(h.events[0].economicNature, 'expense')
  page.onUnload()
})

test('修改类型和账户只提交当前笔的变化，保存成功更新已核对列表并关闭编辑', async () => {
  const h = await setup(), page = h.page, original = JSON.stringify(h.events[1])
  await page.openReviewEdit(tap(h.events[0].eventId))
  page.changeReviewedNature({ detail: { value: 1 } })
  page.selectReviewedAccount({ accountId: 'other-account', name: '另一合成账户' }, 'reviewAccount')
  await page.saveReviewEdit()
  const call = h.calls.find(item => item.action === 'financeUpdates.setReview')
  assert.deepEqual(call.input.fields, { economicNature: 'income', ledgerAccountId: 'other-account', categoryId: null })
  assert.equal(call.input.eventId, h.events[0].eventId)
  assert.equal(JSON.stringify(h.events[1]), original)
  assert.equal(page.data.reviewEditSheet, null)
  assert.equal(page.data.reviewDetailSheet, null)
  assert.equal(page.data.activeReviewStatus, 'completed')
  page.onUnload()
})

test('转账要求两个不同账户，背景更新保留选择并阻止旧版本提交', async () => {
  const h = await setup(), page = h.page
  await page.openReviewEdit(tap(h.events[0].eventId))
  page.changeReviewedNature({ detail: { value: 3 } })
  assert.equal(page.data.reviewEditSheet.editor.complete, false, '缺对端可保留合法草稿，但不是可入账结果')
  page.selectReviewedAccount({ accountId: h.events[0].ledgerAccountId, name: '同一账户' }, 'reviewCounterparty')
  assert.equal(page.data.reviewEditSheet.canSave, false)
  page.selectReviewedAccount({ accountId: 'other-account', name: '另一账户' }, 'reviewCounterparty')
  assert.equal(page.data.reviewEditSheet.canSave, true)
  await page.applyUpdateView({ ...h.summary, viewVersion: 'new-view' }, true)
  assert.equal(page.data.reviewEditSheet.stale, true)
  assert.equal(page.data.reviewEditSheet.counterpartyLedgerAccountId, 'other-account')
  await page.saveReviewEdit()
  assert.equal(h.calls.some(item => item.action === 'financeUpdates.setReview'), false)
  page.onUnload()
})

test('已核对流入还款的付款端显示在上，目录选择与保存仍对应原字段', async () => {
  const h = await setup(), page = h.page
  Object.assign(h.events[0], { economicNature: 'repayment', sourceDirection: 'income', counterpartyLedgerAccountId: 'original-payer' })
  const eventId = h.events[0].eventId, receiver = h.events[0].ledgerAccountId
  try {
    await page.openReviewEdit(tap(eventId))
    assert.deepEqual(Array.from(page.data.reviewEditSheet.accountFields, field => [field.key, field.label]),
      [['counterparty', '付款账户'], ['account', '还入账户']])
    await page.openDirectory({ currentTarget: { dataset: { target: 'reviewCounterparty' } } })
    assert.equal(page.data.directorySheet.title, '选择付款账户')
    page.closeDirectory()
    page.selectReviewedAccount({ accountId: 'changed-payer', name: '合成付款卡', type: 'bank' }, 'reviewCounterparty')
    assert.equal(page.data.reviewEditSheet.ledgerAccountId, receiver)
    await page.saveReviewEdit()
    assert.deepEqual(h.calls.find(call => call.action === 'financeUpdates.setReview').input.fields,
      { counterpartyLedgerAccountId: 'changed-payer', categoryId: null })
    assert.equal(h.calls.find(call => call.action === 'financeUpdates.setReview').input.editorVersion, 1)
  } finally { page.onUnload() }
})

test('结果未知时保留原请求，先恢复修改再允许整批入账；已保存后刷新失败不重复写', async () => {
  const h = await setup(), page = h.page
  let attempts = 0
  h.custom = action => {
    if (action === 'financeUpdates.setReview' && !attempts++) throw Object.assign(Error('合成断网'), { code: 'NETWORK_ERROR' })
    if (action === 'imports.commandResult') throw Object.assign(Error('结果未知'), { code: 'OPERATION_UNCONFIRMED' })
  }
  await page.openReviewEdit(tap(h.events[0].eventId))
  page.changeReviewedNature({ detail: { value: 1 } })
  await page.saveReviewEdit()
  assert.equal(page.data.reviewEditSheet.pending, true)
  page.closeReviewEdit()
  await page.postUpdate()
  assert.equal(page.data.reviewEditSheet.pending, true)
  assert.equal(h.calls.some(item => item.action === 'financeUpdates.post'), false)
  h.custom = action => action === 'financeUpdates.summary' ? Promise.reject(Error('摘要暂不可用'))
    : action === 'imports.commandResult' ? Promise.reject(Object.assign(Error('结果未知'), { code: 'OPERATION_UNCONFIRMED' })) : undefined
  await page.saveReviewEdit()
  assert.equal(page.data.reviewEditSheet.saved, true)
  const writes = h.calls.filter(item => item.action === 'financeUpdates.setReview')
  assert.deepEqual(writes[0].input, writes[1].input)
  h.custom = null
  await page.refreshReviewEdit()
  assert.equal(page.data.reviewEditSheet, null)
  assert.equal(h.calls.filter(item => item.action === 'financeUpdates.setReview').length, 2)
  page.onUnload()
})

test('关闭、隐藏、换会话后的迟到读取不能回填已核对编辑框', async () => {
  for (const leave of ['closeReviewEdit', 'onHide', 'session']) {
    const h = await setup(), page = h.page
    let release
    page._businessData.events = []
    h.custom = (action, input) => action === 'economicEvents.detail' && !input.evidenceId ? new Promise(resolve => { release = resolve }) : undefined
    const opening = page.openReviewEdit(tap(h.events[0].eventId))
    await flush()
    if (leave === 'session') h.cache.reset()
    else page[leave]()
    const patches = h.patches.length
    release({ viewVersion: h.summary.viewVersion, part: JSON.stringify(h.events[0]), nextCursor: null })
    await opening
    assert.equal(h.patches.length, patches)
    page.onUnload()
  }
})
