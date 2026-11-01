const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const editor = require('./helpers/editor-workbench')
const { runtime, fixture } = require('./helpers/paged-workbench')
const model = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
const detail = require('../miniprogram/packages/finance/pages/import-workbench/detail-fields')
const policy = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const ownership = require('../cloudfunctions/catledger-import/src/account-ownership')
const { transactionDrafts } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
const bank = { accountId: '20000000-0000-4000-8000-000000000001', name: '合成储蓄账户', type: 'bank', currency: 'CNY' }
const credit = { accountId: '20000000-0000-4000-8000-000000000002', name: '合成负债账户', type: 'credit', currency: 'CNY' }
const catalog = { accounts: [bank, credit], categories: [] }
function repayment(sourceDirection = 'expense') {
  return { eventId: 'synthetic-event-0', status: 'needs_action', version: 1, economicNature: 'repayment', sourceDirection, flowDirection: 'neutral',
    amountMinor: '10000', localAt: '2026-09-01 12:00:00', currency: 'CNY', categoryId: null, fieldSources: {}, reasonCodes: [],
    ledgerAccountId: sourceDirection === 'income' ? credit.accountId : bank.accountId,
    counterpartyLedgerAccountId: sourceDirection === 'income' ? bank.accountId : credit.accountId }
}
const publicRow = row => ({ ...row, accountOwnership: ownership.read(row), editorFacts: policy.capability(row) })

for (const sourceDirection of ['expense', 'income']) {
  test('真实 Page 两端归属与入账一致，不随账单方向倒置：' + sourceDirection, async t => {
    const { page, row } = await editor.open(t, repayment(sourceDirection), catalog)
    const original = JSON.stringify(row)
    assert.equal(editor.view(page).complete, true)
    assert.equal(editor.view(page).changed, false, '已映射两端不增加一次归属确认')
    assert.deepEqual(editor.plain(editor.view(page).fundsEndpoints.map(endpoint => endpoint.accounts[0].accountId)), [bank.accountId, credit.accountId])
    const confirmed = ownership.apply(row, { source: { kind: 'ledger', accountId: bank.accountId },
      destination: { kind: 'ledger', accountId: credit.accountId } })
    const confirmedFields = detail.accountFields(publicRow(confirmed))
    assert.equal(confirmedFields.find(field => field.key === 'account').accountId, confirmed.ledgerAccountId)
    assert.equal(confirmedFields.find(field => field.key === 'counterparty').accountId, confirmed.counterpartyLedgerAccountId)
    assert.deepEqual(confirmedFields.map(field => field.label), ['付款账户', '还入账户'])
    editor.mode(page, 'sourceKind', 'external')
    const income = editor.plain(editor.view(page).payload)
    assert.equal(income.fields.economicNature, undefined, '界面不提交推导出来的收入性质')
    assert.deepEqual(income.decisions.accountOwnership, { source: { kind: 'external' }, destination: { kind: 'ledger', accountId: credit.accountId } })
    let next = policy.prepare(row, income)
    assert.equal(next.economicNature, 'income')
    assert.equal(next.ledgerAccountId, credit.accountId)
    assert.equal(next.counterpartyLedgerAccountId, null)
    assert.equal(editor.view(page).directionClass, 'row-income')
    assert.deepEqual(transactionDrafts(next).map(item => [item.type, item.destinationAccountId]), [['income', credit.accountId]])
    const reopened = publicRow(next), fresh = model.derive(reopened, model.create(reopened), catalog)
    assert.equal(fresh.natureLabel, '还款')
    assert.equal(fresh.changed, false)
    assert.deepEqual(fresh.routeFields.map(field => [field.ownershipKind, field.accountId || null]), [['external', null], ['ledger', credit.accountId]])
    const shown = detail.fieldsFor(reopened, catalog)
    assert.equal(shown.find(field => field.label === '付款账户').value, '别人的账户')
    assert.equal(shown.find(field => field.label === '还入账户').value, credit.name)
    assert.equal(shown.find(field => field.key === 'account').value, credit.name, '详情 account key 始终对应 ledgerAccountId')
    assert.equal(shown.find(field => field.key === 'counterparty').value, '别人的账户')
    editor.mode(page, 'sourceKind', 'ledger')
    assert.equal(editor.view(page).routeFields[0].accountId, bank.accountId, '本次往返恢复原账本账户')
    editor.mode(page, 'destinationKind', 'external')
    next = policy.prepare(row, editor.plain(editor.view(page).payload))
    assert.equal(next.economicNature, 'expense')
    assert.equal(next.ledgerAccountId, bank.accountId)
    assert.equal(next.counterpartyLedgerAccountId, null)
    assert.equal(editor.view(page).directionClass, 'row-expense')
    assert.deepEqual(transactionDrafts(next).map(item => [item.type, item.sourceAccountId]), [['expense', bank.accountId]])
    assert.deepEqual(detail.accountFields(publicRow(next)).map(field => [field.key, field.accountId]),
      [['account', bank.accountId], ['counterparty', null]])
    assert.equal(JSON.stringify(row), original, '编辑只改草稿，不改原事件')
  })
}

test('同次选择外部端点与收支分类按最终性质保存，重开保留分类', async t => {
  const categories = [
    { categoryId: '20000000-0000-4000-8000-000000000011', name: '合成支出分类', kind: 'expense' },
    { categoryId: '20000000-0000-4000-8000-000000000012', name: '合成收入分类', kind: 'income' }
  ]
  for (const sourceDirection of ['expense', 'income']) for (const nature of ['expense', 'income']) {
    const accounts = [bank, credit], category = categories.find(item => item.kind === nature)
    const { page, row } = await editor.open(t, repayment(sourceDirection), { accounts, categories })
    editor.mode(page, nature === 'expense' ? 'destinationKind' : 'sourceKind', 'external')
    assert.equal(editor.view(page).categoryKind, nature)
    assert.equal(editor.select(page, 'editorCategory', categories.find(item => item.kind !== nature)), false)
    assert.equal(editor.select(page, 'editorCategory', category), true)
    const payload = editor.plain(editor.view(page).payload)
    assert.equal(payload.fields.categoryId, category.categoryId)
    assert.equal(payload.fields.economicNature, undefined)
    const saved = policy.prepare(row, payload)
    assert.equal(saved.economicNature, nature)
    assert.equal(saved.categoryId, category.categoryId, '归属派生收支后不能清除本次明确选择的分类')
    const reopened = publicRow(saved), view = model.derive(reopened, model.create(reopened), { accounts, categories })
    assert.equal(view.categoryKind, nature)
    assert.equal(view.categoryName, category.name)
    assert.equal(view.changed, false)
  }
})

test('双外部必须明确确认无账本影响；改回账本端撤销确认，未知端仍可留待核对', async t => {
  const { page, row } = await editor.open(t, repayment(), catalog)
  editor.mode(page, 'sourceKind', 'external')
  editor.mode(page, 'destinationKind', 'external')
  assert.equal(editor.view(page).bothExternal, true)
  assert.equal(editor.view(page).canSave, false)
  assert.equal(editor.view(page).complete, false)
  editor.mode(page, 'noLedgerImpact', true)
  assert.equal(editor.view(page).canSave, true)
  const decision = editor.plain(editor.view(page).payload)
  const next = policy.prepare(row, decision)
  assert.equal(next.status, 'excluded')
  assert.ok(next.reasonCodes.includes('external_no_ledger_effect'))
  assert.equal(next.reasonCodes.includes('manual_exclusion'), false)
  assert.equal(next.ledgerAccountId, null); assert.equal(next.counterpartyLedgerAccountId, null)
  const restored = model.restore(publicRow(row), decision)
  assert.equal(restored.noLedgerImpact, true)
  assert.deepEqual(model.derive(publicRow(row), restored, catalog).payload.decisions.accountOwnership, decision.decisions.accountOwnership)
  editor.mode(page, 'sourceKind', 'unknown')
  assert.equal(editor.draft(page).noLedgerImpact, false)
  assert.equal(editor.view(page).canSave, true)
  assert.equal(editor.view(page).complete, false)
  assert.deepEqual(editor.plain(editor.view(page).payload.decisions.accountOwnership.source), { kind: 'unknown' })
})

for (const sourceDirection of ['expense', 'income']) for (const side of ['payer', 'payee']) {
  test('扩成多账户再收回保持真实端点：' + sourceDirection + '/' + side, async t => {
    const extra = { accountId: '20000000-0000-4000-8000-000000000003', name: '合成另一账户', currency: 'CNY',
      type: side === 'payer' ? 'bank' : 'other_liability' }
    const { page, row } = await editor.open(t, repayment(sourceDirection), { accounts: [bank, credit, extra] })
    page.addFundsAccount(editor.tap({ endpoint: side }))
    const endpoints = editor.view(page).fundsEndpoints
    assert.deepEqual(editor.plain(endpoints.map(endpoint => endpoint.label)), ['付款账户', '还入账户'])
    assert.equal(endpoints.find(endpoint => endpoint.key === side).accounts[0].accountId, side === 'payer' ? bank.accountId : credit.accountId)
    assert.equal(editor.select(page, 'editorPart1', extra), true)
    page.changeFundsAmount({ ...editor.tap({ index: 0 }), detail: { value: '60.00' } })
    page.changeFundsAmount({ ...editor.tap({ index: 1 }), detail: { value: '40.00' } })
    if (side === 'payer') editor.edit(page, 'evidenceNote', '合成分配说明')
    assert.equal(editor.view(page).complete, true)
    const next = policy.prepare(row, editor.plain(editor.view(page).payload))
    assert.deepEqual(transactionDrafts(next).map(item => [item.sourceAccountId, item.destinationAccountId, String(item.amountMinor)]),
      side === 'payer' ? [[bank.accountId, credit.accountId, '6000'], [extra.accountId, credit.accountId, '4000']]
        : [[bank.accountId, credit.accountId, '6000'], [bank.accountId, extra.accountId, '4000']])
    page.removeFundsAccount(editor.tap({ endpoint: side, index: 1 }))
    assert.equal(editor.draft(page).composition, 'single')
    assert.equal(editor.draft(page).ledgerAccountId, row.ledgerAccountId)
    assert.equal(editor.draft(page).counterpartyLedgerAccountId, row.counterpartyLedgerAccountId)
    assert.deepEqual(editor.plain(editor.view(page).fundsEndpoints.map(endpoint => endpoint.accounts[0].accountId)), [bank.accountId, credit.accountId])
  })
}

test('退款、借款、分期和组合付款不在单笔编辑器里提供归属切换', async t => {
  for (const row of [{ economicNature: 'refund' }, { economicNature: 'borrow' },
    { economicNature: 'expense', paymentResolution: { allocations: [] } },
    { economicNature: 'repayment', installment: { component: 'principal', creditStatement: true } }]) {
    const { page } = await editor.open(t, row)
    assert.ok(editor.view(page).routeFields.every(field => !field.ownershipKind), row.economicNature)
  }
})

test('从还款业务切成同一实际收支时，保留相关账本端而不是清空账户', () => {
  for (const direction of ['income', 'expense']) for (const nature of ['income', 'expense']) {
    const stored = ownership.apply(repayment(direction), nature === 'income'
      ? { source: { kind: 'external' }, destination: { kind: 'ledger', accountId: credit.accountId } }
      : { source: { kind: 'ledger', accountId: bank.accountId }, destination: { kind: 'external' } })
    const row = publicRow(stored), draft = model.change(row, model.create(row), 'economicNature', nature)
    const view = model.derive(row, draft, catalog)
    assert.equal(view.complete, true)
    assert.equal(draft.ledgerAccountId, nature === 'income' ? credit.accountId : bank.accountId)
    const next = policy.prepare(stored, view.payload)
    assert.equal(ownership.read(next).explicit, false)
    assert.equal(next.ledgerAccountId, nature === 'income' ? credit.accountId : bank.accountId)
  }
})

test('普通微信收付款保持默认收支，普通保存不追加外部归属事实', () => {
  for (const nature of ['income', 'expense']) {
    const row = publicRow({ ...repayment(), economicNature: nature, counterpartyLedgerAccountId: null,
      primaryEvidence: { sourceType: 'wechat', counterparty: '合成对方' } })
    const initial = model.create(row)
    assert.equal(model.change(row, initial, 'sourceKind', 'external'), initial)
    const view = model.derive(row, model.change(row, initial, 'note', '合成备注'), catalog)
    assert.equal(view.showOwnership, false)
    assert.equal(view.complete, true)
    assert.equal(view.payload.decisions, undefined)
    assert.deepEqual(view.payload.fields, { note: '合成备注' })
  }
})

test('改经济性质清旧业务锚点，同次选择新端点使用新性质', () => {
  const stored = ownership.apply(repayment(), { source: { kind: 'ledger', accountId: bank.accountId }, destination: { kind: 'external' } })
  const row = publicRow(stored)
  let draft = model.change(row, model.create(row), 'economicNature', 'income')
  let view = model.derive(row, draft, catalog)
  assert.equal(view.payload.decisions.accountOwnership, null)
  let next = policy.prepare(stored, view.payload)
  assert.equal(ownership.read(next).businessNature, 'income')
  assert.equal(ownership.read(next).explicit, false)
  draft = model.change(row, model.create(row), 'economicNature', 'internal_transfer')
  draft = model.change(row, draft, 'destinationKind', 'external')
  view = model.derive(row, draft, catalog)
  next = policy.prepare(stored, view.payload)
  assert.equal(ownership.read(next).businessNature, 'internal_transfer')
  assert.equal(ownership.read(next).destination.kind, 'external')
})

test('旧待处理代还仍需确认端点，读取和修改备注不自动将其完成', () => {
  const row = publicRow({ ...repayment(), economicNature: 'unknown', counterpartyLedgerAccountId: null,
    fieldSources: { repaymentOwnership: { version: 'repayment-ownership-v2', confirmedBy: 'user', owner: 'other', treatment: 'pending' } } })
  const draft = model.create(row), before = JSON.stringify(row)
  const untouched = model.derive(row, draft, catalog)
  assert.equal(untouched.complete, false)
  assert.ok(untouched.missing.includes('确认资金两端归属'))
  assert.equal(model.derive(row, model.change(row, draft, 'note', '留待核对'), catalog).payload.decisions, undefined)
  const confirmed = model.derive(row, model.change(row, draft, 'destinationKind', 'external'), catalog)
  assert.equal(confirmed.complete, true)
  assert.equal(confirmed.payload.decisions.accountOwnership.destination.kind, 'external')
  assert.equal(JSON.stringify(row), before)
})

test('切换外部端点会关闭目录，迟到账户响应不能重新选回账本账户', async t => {
  const { h, page } = await editor.open(t, repayment(), catalog)
  let release
  h.intercept = action => action === 'financeUpdates.options' ? new Promise(resolve => { release = resolve }) : undefined
  const reading = page.openDirectory(editor.tap({ target: 'reviewAccount' }))
  await editor.flush()
  assert.equal(typeof release, 'function')
  editor.mode(page, 'sourceKind', 'external')
  release({ protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [bank], total: 1, nextCursor: null })
  await reading
  assert.equal(page.data.directorySheet, null)
  assert.equal(editor.draft(page).sourceKind, 'external')
  assert.equal(editor.draft(page).ledgerAccountId, '')
  page.invalidateReviewEdit()
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  h.events[0].version = 2
  const before = JSON.stringify(editor.draft(page))
  h.intercept = null
  await page.refreshReviewEdit()
  assert.equal(JSON.stringify(editor.draft(page)), before, '摘要更新保留已编辑两端，等待用户再保存')
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.setReview'), false)
})

test('新账户归属冻结请求恢复后重试保持原请求，不替换为新推导值', async t => {
  const data = fixture(1, true)
  Object.assign(data.events[0], repayment())
  const h = runtime(data), page = h.page
  t.after(() => page.onUnload())
  const frozen = { requestId: randomUUID(), updateId: h.summary.update.updateId, updateVersion: 1,
    eventId: h.events[0].eventId, eventVersion: 1, editorVersion: 1, fields: { note: '冻结前备注' },
    decisions: { accountOwnership: { source: { kind: 'external' }, destination: { kind: 'ledger', accountId: credit.accountId } } }, acknowledgedChanges: [] }
  const envId = require('../miniprogram/config/cloudbase').envId
  h.storage.set('catledger_pending_ledger_v1:' + envId + ':1234567890',
    { schema: 1, target: 'import', action: 'financeUpdates.setReview', payload: frozen })
  h.intercept = action => {
    if (action === 'imports.commandResult') throw Object.assign(Error('结果尚未确认'), { code: 'OPERATION_UNCONFIRMED' })
    if (action === 'financeUpdates.setReview') {
      h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
      return { protocolVersion: 2, kind: 'operation-receipt', update: h.summary.update, event: { status: 'ready' } }
    }
  }
  await page.openReviewEdit(editor.tap({ id: h.events[0].eventId }))
  assert.equal(page.data.reviewEditSheet.pending, true)
  assert.equal(editor.draft(page).sourceKind, 'external')
  editor.mode(page, 'sourceKind', 'ledger')
  assert.equal(editor.draft(page).sourceKind, 'external')
  await page.saveReviewEdit()
  const writes = h.calls.filter(call => call.action === 'financeUpdates.setReview')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].input, frozen)
})
