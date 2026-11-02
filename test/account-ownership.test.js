const test = require('node:test')
const assert = require('node:assert/strict')
const ownership = require('../cloudfunctions/catledger-import/src/account-ownership')
const { funds } = require('../cloudfunctions/catledger-import/src/editor-fields')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/manual-field-mask')
const { transactionDrafts } = require('../cloudfunctions/catledger-import/src/finance-update-posting')

const asset = { accountId: '00000000-0000-4000-8000-000000000001', type: 'bank', currency: 'CNY' }
const credit = { accountId: '00000000-0000-4000-8000-000000000002', type: 'credit', currency: 'CNY' }
const other = { accountId: '00000000-0000-4000-8000-000000000003', type: 'wallet', currency: 'CNY' }
const accounts = new Map([asset, credit, other].map(account => [account.accountId, account]))
const options = { accounts }
const ledger = account => ({ kind: 'ledger', accountId: account.accountId })
const external = { kind: 'external' }, unknown = { kind: 'unknown' }
const invalid = operation => assert.throws(operation, error => error.publicCode === 'VALIDATION_ERROR')

function repayment(direction = 'expense', patch = {}) {
  return { eventId: 'fixture-event', economicNature: 'repayment', flowDirection: 'neutral',
    sourceDirection: direction, status: 'needs_action', amountMinor: '12000', currency: 'CNY',
    ledgerAccountId: direction === 'income' ? credit.accountId : asset.accountId,
    counterpartyLedgerAccountId: direction === 'income' ? asset.accountId : credit.accountId,
    categoryId: null, manualFieldMask: 0, reasonCodes: [],
    fieldSources: { rowIds: ['synthetic-source-row'], rawBusiness: '信用卡还款' }, ...patch }
}

test('银行收入方向还款按实际资产到负债解释，读取不写入新决定', () => {
  const event = repayment('income'), before = JSON.stringify(event)
  const result = ownership.resolve(event, options)
  assert.deepEqual(result.source, ledger(asset))
  assert.deepEqual(result.destination, ledger(credit))
  assert.equal(result.economicNature, 'repayment')
  assert.equal(result.flowDirection, 'neutral')
  assert.equal(result.requiresDecision, false)
  assert.deepEqual(result.reasons, [])
  assert.equal(JSON.stringify(event), before)
  assert.equal(event.fieldSources.accountOwnership, undefined)
})

for (const direction of ['expense', 'income']) {
  test(direction + '来源：本人还本人仍只生成全额资产到负债转账', () => {
    const event = repayment(direction)
    const next = ownership.apply(event, { source: ledger(asset), destination: ledger(credit) }, options)
    const result = ownership.resolve(next, options)
    assert.deepEqual(result.reasons, [])
    assert.equal(result.economicNature, 'repayment')
    assert.equal(next.sourceDirection, direction)
    assert.equal(next.amountMinor, event.amountMinor)
    assert.equal(funds(next).sourceAccountId, asset.accountId)
    assert.equal(funds(next).destinationAccountId, credit.accountId)
    const drafts = transactionDrafts(next)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].type, 'transfer')
    assert.equal(drafts[0].sourceAccountId, asset.accountId)
    assert.equal(drafts[0].destinationAccountId, credit.accountId)
    assert.equal(drafts[0].amountMinor, event.amountMinor)
    assert.equal(next.fieldSources.accountOwnership.businessNature, 'repayment')
    assert.equal('accountId' in next.fieldSources.accountOwnership, false)
    assert.equal(next.fieldSources.repaymentOwnership, undefined)
  })

  test(direction + '来源：外部代还本人负债只记收入到真实负债账户', () => {
    const next = ownership.apply(repayment(direction), { source: external, destination: ledger(credit) }, options)
    assert.equal(next.economicNature, 'income')
    assert.equal(next.flowDirection, 'inflow')
    assert.equal(next.ledgerAccountId, credit.accountId)
    assert.equal(next.counterpartyLedgerAccountId, null)
    const result = ownership.resolve(next, options)
    assert.deepEqual(result.source, { kind: 'external', accountId: null })
    assert.deepEqual(result.destination, ledger(credit))
    assert.equal(result.businessNature, 'repayment')
    assert.deepEqual(result.reasons, [])
    const drafts = transactionDrafts(next)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].type, 'income')
    assert.equal(drafts[0].sourceAccountId, null)
    assert.equal(drafts[0].destinationAccountId, credit.accountId)
    assert.equal(drafts[0].amountMinor, '12000')
  })

  test(direction + '来源：本人代还外部债务只记支出，不虚构负债账户', () => {
    const next = ownership.apply(repayment(direction), { source: ledger(asset), destination: external }, options)
    assert.equal(next.economicNature, 'expense')
    assert.equal(next.flowDirection, 'outflow')
    assert.equal(next.ledgerAccountId, asset.accountId)
    assert.equal(next.counterpartyLedgerAccountId, null)
    assert.deepEqual(ownership.resolve(next, options).reasons, [])
    const drafts = transactionDrafts(next)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].type, 'expense')
    assert.equal(drafts[0].sourceAccountId, asset.accountId)
    assert.equal(drafts[0].destinationAccountId, null)
    assert.equal(drafts[0].amountMinor, '12000')
    assert.deepEqual(Object.keys(next.fieldSources).sort(), ['accountOwnership', 'rawBusiness', 'rowIds'])
  })

  test(direction + '来源：两种代还与本人还款往返改选，账户列保持当前唯一权威', () => {
    const event = repayment(direction), before = JSON.stringify(event)
    const income = ownership.apply(event, { source: external, destination: ledger(credit) }, options)
    const expense = ownership.apply(income, { source: ledger(asset), destination: external }, options)
    const restored = ownership.apply(expense, { source: ledger(asset), destination: ledger(credit) }, options)
    const again = ownership.apply(restored, { source: external, destination: ledger(credit) }, options)
    assert.equal(restored.economicNature, 'repayment')
    assert.equal(restored.ledgerAccountId, event.ledgerAccountId)
    assert.equal(restored.counterpartyLedgerAccountId, event.counterpartyLedgerAccountId)
    assert.equal(again.economicNature, 'income')
    assert.equal(again.ledgerAccountId, credit.accountId)
    assert.equal(again.counterpartyLedgerAccountId, null)
    assert.equal(JSON.stringify(event), before)
    assert.equal(income.fieldSources.accountOwnership.destination, 'ledger')
    assert.equal(expense.fieldSources.accountOwnership.destination, 'external')
    assert.equal(JSON.stringify(restored.fieldSources.accountOwnership).includes(asset.accountId), false)
    assert.equal(JSON.stringify(restored.fieldSources.accountOwnership).includes(credit.accountId), false)
  })
}

test('未知端点可以保存草稿，不能猜作外部或提前转换收入', () => {
  const next = ownership.apply(repayment('income'), { source: unknown, destination: ledger(credit) }, options)
  const result = ownership.resolve(next, options)
  assert.equal(next.economicNature, 'repayment')
  assert.equal(next.ledgerAccountId, credit.accountId)
  assert.equal(next.counterpartyLedgerAccountId, null)
  assert.equal(result.source.kind, 'unknown')
  assert.equal(result.requiresDecision, true)
  assert.ok(result.reasons.includes('account_source_required'))
})

test('普通收支、退款和账户齐全的转账没有额外归属确认', () => {
  for (const economicNature of ['expense', 'fee', 'income', 'refund', 'internal_transfer']) {
    const movement = economicNature === 'internal_transfer'
    const event = repayment('expense', { economicNature, ledgerAccountId: asset.accountId,
      counterpartyLedgerAccountId: movement ? other.accountId : null,
      flowDirection: movement ? 'neutral' : ['income', 'refund'].includes(economicNature) ? 'inflow' : 'outflow' })
    const result = ownership.resolve(event, options)
    assert.equal(result.requiresDecision, false, economicNature)
    assert.equal(result.economicNature, economicNature)
    assert.deepEqual(result.reasons, [], economicNature)
  }
})

test('退款保留退款；借款、分期不能因外部端点被变成收支', () => {
  const refund = repayment('income', { economicNature: 'refund', flowDirection: 'inflow',
    ledgerAccountId: asset.accountId, counterpartyLedgerAccountId: null,
    fieldSources: { refundRelation: { originalEventId: 'synthetic-original' } } })
  const next = ownership.apply(refund, { source: external, destination: ledger(asset) }, options)
  assert.equal(next.economicNature, 'refund')
  assert.deepEqual(next.fieldSources.refundRelation, refund.fieldSources.refundRelation)
  const borrow = repayment('expense', { economicNature: 'borrow', ledgerAccountId: credit.accountId, counterpartyLedgerAccountId: asset.accountId })
  invalid(() => ownership.apply(borrow, { source: external, destination: ledger(asset) }, options))
  for (const fieldSources of [{ installment: { component: 'principal', creditStatement: true } },
    { disbursement: { role: 'disbursement' } }, { installmentPlan: { action: 'link', loanId: 'synthetic-plan' } }]) {
    invalid(() => ownership.apply(repayment('income', { fieldSources }), { source: external, destination: ledger(credit) }, options))
  }
})

test('两端外部必须明确无本账本影响；专用排除能还原且不伪装成人工排除', () => {
  const event = repayment('income')
  invalid(() => ownership.apply(event, { source: external, destination: external }, options))
  invalid(() => ownership.apply(event, { source: external, destination: ledger(credit), noLedgerImpact: true }, options))
  const next = ownership.apply(event, { source: external, destination: external, noLedgerImpact: true }, options)
  assert.equal(next.status, 'excluded')
  assert.equal(next.ledgerAccountId, null)
  assert.equal(next.counterpartyLedgerAccountId, null)
  assert.equal(ownership.resolve(next, options).noLedgerImpact, true)
  assert.deepEqual(next.reasonCodes, [ownership.EXTERNAL_REASON])
  assert.equal(next.reasonCodes.includes('manual_exclusion'), false)
  const restored = ownership.apply(next, { source: ledger(asset), destination: ledger(credit) }, options)
  assert.equal(restored.status, 'needs_action')
  assert.equal(restored.economicNature, 'repayment')
  assert.equal(restored.reasonCodes.includes(ownership.EXTERNAL_REASON), false)
  assert.equal(ownership.resolve(restored, options).noLedgerImpact, false)
})

test('旧还款归属只作输入兼容，重新选择后只保留 canonical 决定', () => {
  const event = repayment('expense', { economicNature: 'expense', flowDirection: 'outflow', counterpartyLedgerAccountId: null,
    manualFieldMask: FIELD_MASK.repaymentOwnership | FIELD_MASK.note,
    fieldSources: { repaymentOwnership: { version: 'repayment-ownership-v2', confirmedBy: 'user', owner: 'other', treatment: 'expense' },
      editorOverrides: { version: 1, note: '保留人工备注' } } })
  assert.equal(ownership.read(event).businessNature, 'repayment')
  assert.equal(ownership.read(event).origin, 'legacy')
  const next = ownership.apply(event, { source: ledger(asset), destination: ledger(credit) }, options)
  assert.equal(next.economicNature, 'repayment')
  assert.equal(next.fieldSources.repaymentOwnership, undefined)
  assert.equal(next.fieldSources.accountOwnership.businessNature, 'repayment')
  assert.equal(next.manualFieldMask & FIELD_MASK.repaymentOwnership, 0)
  assert.equal(next.manualFieldMask & FIELD_MASK.note, FIELD_MASK.note)
  assert.equal(next.fieldSources.editorOverrides.note, '保留人工备注')
  const conflicting = { ...next, fieldSources: { ...next.fieldSources, repaymentOwnership: event.fieldSources.repaymentOwnership } }
  assert.equal(ownership.read(conflicting).destination.kind, 'ledger')
  assert.equal(ownership.read(conflicting).origin, 'canonical')
  const malformed = { ...event, fieldSources: { ...event.fieldSources, accountOwnership: { version: 'future-version' } } }
  assert.ok(ownership.resolve(malformed, options).reasons.includes('account_ownership_invalid'))
  assert.equal(ownership.read(malformed).origin, 'canonical')
})

test('旧 pending 不能被只读派生当作已同意支出，明确端点选择后才生效', () => {
  const event = repayment('expense', { economicNature: 'unknown', flowDirection: 'outflow', counterpartyLedgerAccountId: null,
    fieldSources: { repaymentOwnership: { version: 'repayment-ownership-v2', confirmedBy: 'user', owner: 'other', treatment: 'pending' } } })
  const result = ownership.resolve(event, options)
  assert.equal(result.economicNature, 'unknown')
  assert.ok(result.reasons.includes('account_ownership_recheck_required'))
  const next = ownership.apply(event, { source: ledger(asset), destination: external }, options)
  assert.equal(next.economicNature, 'expense')
  assert.deepEqual(ownership.resolve(next, options).reasons, [])
})

test('拒绝未知账户、错误类型、同账户、失效账户和在外部端点伪造账户 ID', () => {
  invalid(() => ownership.apply(repayment(), { source: external, destination: ledger(asset) }, options))
  invalid(() => ownership.apply(repayment(), { source: ledger(credit), destination: external }, options))
  invalid(() => ownership.apply(repayment(), { source: ledger(asset), destination: ledger(asset) }, options))
  invalid(() => ownership.apply(repayment(), { source: ledger({ accountId: 'not-in-user-catalog' }), destination: external }, options))
  invalid(() => ownership.apply(repayment(), { source: { kind: 'external', accountId: asset.accountId }, destination: ledger(credit) }, options))
  for (const patch of [{ archivedAt: '2026-01-01' }, { currency: 'USD' }]) {
    invalid(() => ownership.apply(repayment(), { source: ledger(asset), destination: external },
      { accounts: new Map([[asset.accountId, { ...asset, ...patch }]]) }))
  }
  invalid(() => ownership.apply(repayment(), { source: ledger(asset), destination: external, loanId: 'invented' }, options))
})

test('多账户、原贷款拆分与已确认跨渠道关系留给原入口处理，纯模块不清除凭据', () => {
  for (const fieldSources of [{ paymentResolution: { allocations: [{ accountId: asset.accountId, amountMinor: '12000' }] } },
    { repaymentAllocations: [{ accountId: credit.accountId, amountMinor: '12000' }] },
    { repaymentChannelResolution: { targetAccountId: credit.accountId } },
    { bankChannelResolution: { kind: 'same' } }, { loanRepayment: { loanId: 'synthetic-plan' } }]) {
    const event = repayment('expense', { fieldSources }), before = JSON.stringify(event)
    assert.equal(ownership.resolve(event, options).supported, false)
    invalid(() => ownership.apply(event, { source: ledger(asset), destination: external }, options))
    assert.equal(JSON.stringify(event), before)
  }
})

test('改变收支方向清除不兼容分类，保留原金额、来源、备注和冲突', () => {
  const first = ownership.apply(repayment(), { source: ledger(asset), destination: external }, options)
  const event = { ...first, categoryId: 'expense-category', reasonCodes: ['identity_conflict'],
    fieldSources: { ...first.fieldSources, editorOverrides: { version: 1, note: '' } } }
  const next = ownership.apply(event, { source: external, destination: ledger(credit) }, options)
  assert.equal(next.categoryId, null)
  assert.equal(next.amountMinor, '12000')
  assert.equal(next.sourceDirection, 'expense')
  assert.deepEqual(next.fieldSources.rowIds, ['synthetic-source-row'])
  assert.equal(next.fieldSources.editorOverrides.note, '')
  assert.ok(next.reasonCodes.includes('identity_conflict'))
  assert.equal(next.fieldSources.loanRepayment, undefined)
  assert.equal(next.fieldSources.installmentPlan, undefined)
})
