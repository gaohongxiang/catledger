const test = require('node:test')
const assert = require('node:assert/strict')
const { installmentEvidence } = require('../cloudfunctions/catledger-import/src/profiles/bank-installment')
const { resolveRowSemantic } = require('../cloudfunctions/catledger-import/src/row-semantic-resolver')
const { refreshEventSemantic } = require('../cloudfunctions/catledger-import/src/semantic-plan-upgrade')
const { evaluatePostability, classifyReviewIssue } = require('../cloudfunctions/catledger-import/src/organizer-model')
const requiredReasons = event => evaluatePostability(event).reasonCodes
const { FIELD_MASK, applyFields, resolvedReasons } = require('../cloudfunctions/catledger-import/src/review/policy')
const { publicEvent } = require('../cloudfunctions/catledger-import/src/finance-update-repository')
const row = { sourceType: 'bank', sourceFormat: 'bank_xls', bankStatementKind: 'credit', direction: 'expense',
  item: '电销现分按月收6期第3期共6期', paymentMethod: '合成信用卡', rawStatus: '' }

test('两个固定银行本金摘要和连写利息保留期次，只证明出账，不推断合同', () => {
  for (const [item, component, originKind] of [
    ['电销现分按月收6期第3期共6期', 'principal', 'cash_borrowing'],
    ['电销总账分月6期第3期共6期', 'principal', 'unconfirmed'],
    ['分期付款利息第3期共6期', 'interest', 'unconfirmed']
  ]) {
    const result = installmentEvidence({ ...row, item })
    assert.deepEqual(result, { schema: 2, creditStatement: true, factKind: 'billing', originKind,
      periodNumber: 3, totalTerms: 6, component, referenceKey: null, referenceLabel: null })
    const semantic = resolveRowSemantic({ ...row, item })
    assert.equal(semantic.sourceAction, component === 'principal' ? 'installment_principal' : 'fee')
  }
  assert.equal(installmentEvidence({ ...row, item: '电销现分按月收６期第３期共６期' }).periodNumber, 3)
})

test('无信用卡上下文、只有模糊缩写、期号冲突及真实放款扣款不识别为本金出账', () => {
  for (const change of [{ bankStatementKind: 'standard' }, { bankStatementKind: null },
    { item: '电销现分' }, { item: '电销现分按月收6期第7期共6期' },
    { item: '电销现分按月收5期第3期共6期' }, { item: '电销现分按月收6期第0期共6期' },
    { note: '实际扣款' }, { note: '放款到账' }, { note: '分期利息' },
    { installmentFields: { component: 'interest' } }, { installmentFields: { period: '4' } }]) {
    assert.equal(installmentEvidence({ ...row, ...change }), null)
  }
  assert.equal(resolveRowSemantic({ ...row, direction: 'income' }).relationHints.installment, null)
})

const current = { eventId: 'event', updateId: 'update', version: 4, status: 'needs_action',
  economicNature: 'internal_transfer', flowDirection: 'neutral', amountMinor: '9000', currency: 'CNY',
  localAt: '2026-09-02 10:00:00', utcAt: '2026-09-02 02:00:00', ledgerAccountId: 'chosen-credit',
  counterpartyLedgerAccountId: null, manualFieldMask: FIELD_MASK.ledgerAccountId,
  fieldSources: { rowIds: ['source-row'], primaryEvidenceId: 'source-evidence', lastUserActionId: 'chosen' },
  reasonCodes: ['transfer_account_required'] }

test('旧草稿原位变为本金出账，保留已选账户和证据且不再要求转账另一端', () => {
  const next = refreshEventSemantic(current, [row])
  assert.equal(next.economicNature, 'repayment')
  assert.equal(next.fieldSources.installment.component, 'principal')
  for (const key of ['eventId', 'updateId', 'version', 'amountMinor', 'ledgerAccountId', 'manualFieldMask']) assert.equal(next[key], current[key])
  for (const key of ['rowIds', 'primaryEvidenceId', 'lastUserActionId']) assert.deepEqual(next.fieldSources[key], current.fieldSources[key])
  assert.deepEqual(requiredReasons(next), [])
  assert.deepEqual(classifyReviewIssue({ ...next, reasonCodes: ['same_event_candidate', 'relation_ambiguous'] }),
    { issueType: 'same_event', primaryReason: 'relation_ambiguous' })
  const exposed = publicEvent({ ...next, fieldSources: JSON.stringify(next.fieldSources), reasonCodes: '[]' })
  assert.equal(exposed.installment.totalTerms, 6)
  assert.equal('referenceLabel' in exposed.installment, false)
  assert.equal('referenceKey' in exposed.installment, false)
})

test('已有人工转账决定保留并阻断入账，明确选择本金出账后才清除对端和分类', () => {
  const manual = { ...current, counterpartyLedgerAccountId: 'previous-target',
    manualFieldMask: current.manualFieldMask | FIELD_MASK.economicNature | FIELD_MASK.counterpartyLedgerAccountId }
  const next = refreshEventSemantic(manual, [row])
  assert.equal(next.economicNature, 'internal_transfer')
  assert.equal(next.counterpartyLedgerAccountId, manual.counterpartyLedgerAccountId)
  assert.ok(requiredReasons(next).includes('core_fields_conflict'))
  const confirmed = applyFields({ ...next, reasonCodes: resolvedReasons('field_conflict', next.reasonCodes) },
    { economicNature: 'repayment', flowDirection: 'neutral', counterpartyLedgerAccountId: null, categoryId: null })
  assert.deepEqual(requiredReasons(confirmed), [])
  for (const economicNature of ['expense', 'borrow', 'internal_transfer']) {
    assert.ok(requiredReasons({ ...confirmed, economicNature }).includes('core_fields_conflict'))
  }
})

test('已排除或已入账事件不升级；新来源信息补全后再次整理无变化', () => {
  for (const status of ['posted', 'corrected', 'excluded']) {
    const closed = { ...current, status }
    assert.equal(refreshEventSemantic(closed, [row]), closed)
  }
  const freshRow = { ...row, semantic: resolveRowSemantic(row) }
  const next = refreshEventSemantic(current, [freshRow])
  assert.equal(refreshEventSemantic(next, [freshRow]), next)
})
