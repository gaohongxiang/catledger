const assert = require('node:assert/strict')
const test = require('node:test')
const XLSX = require('xlsx')

const { parseEvidenceFile } = require('../src/parsers')
const { normalizeRow } = require('../src/parsers/normalize')
const { bankProfile } = require('../src/profiles/bank')
const { getRowSemantic, resolveRowSemantic } = require('../src/row-semantic-resolver')
const { economicNatureForRow, evaluatePostability } = require('../src/organizer-model')
const { refreshEventSemantic } = require('../src/semantic-plan-upgrade')
const { FIELD_MASK } = require('../src/review/policy')

const source = {
  sourceType: 'bank', sourceFormat: 'bank_xls', bankStatementKind: 'credit',
  rawTransactionType: '', transactionType: 'unknown', direction: 'income',
  item: '支付宝还款', paymentMethod: '****1234', amountMinor: '10000',
  currency: 'CNY', rawStatus: '', economicEffect: 'normal'
}

test('银行正式还款类型与完整摘要识别性质，付款方向和账户缺失不退回性质待确认', () => {
  for (const label of ['还款', '信用卡还款', '自动还款', '支付宝还款', '财付通还款', '微信支付还款', '贷款还款']) {
    for (const direction of ['income', 'expense']) {
      for (const row of [
        { ...source, rawTransactionType: label, item: '合成业务摘要', direction },
        { ...source, rawTransactionType: '', item: label, direction },
        { ...source, rawTransactionType: '转账', item: label, direction }
      ]) {
        const semantic = resolveRowSemantic(row)
        assert.equal(semantic.sourceAction, 'repayment', label)
        assert.equal(economicNatureForRow({ ...row, semantic }), 'repayment')
        assert.equal(semantic.legacy.transactionType, 'transfer')
        assert.ok(!semantic.issues.some(issue => issue.code === 'row_transaction_type_unknown'))
        assert.ok(semantic.issues.some(issue => issue.code === 'account_endpoint_unknown'))
        assert.equal(semantic.fundsProjection, null, '摘要不证明另一端账户或本人归属')
        assert.equal(Boolean(semantic.fromAccountRef), direction === 'expense')
        assert.equal(Boolean(semantic.toAccountRef), direction === 'income')
      }
    }
  }
  const missing = resolveRowSemantic({ ...source, paymentMethod: '' })
  assert.equal(missing.sourceAction, 'repayment')
  assert.equal(missing.ledgerAccountRef, null)
  assert.ok(missing.issues.some(issue => issue.code === 'account_endpoint_unknown'))
})

test('普通商品、对方和备注中的还款字样不能覆盖明确业务类型或推断性质', () => {
  for (const item of ['信用卡还款教程', '支付宝还款指南', '合成还款服务', '支付宝还款-合成商品', '还款手续费', '还款提醒', '合成入账']) {
    assert.equal(resolveRowSemantic({ ...source, item }).sourceAction, null, item)
  }
  for (const patch of [
    { item: '合成商品', counterparty: '支付宝还款' },
    { item: '合成商品', note: '支付宝还款' },
    { item: '', direction: 'income' },
    { item: '', direction: 'expense' },
    { rawTransactionType: '合成业务', item: '支付宝还款' }
  ]) assert.equal(resolveRowSemantic({ ...source, ...patch }).sourceAction, null)
  for (const [rawTransactionType, direction, expected] of [
    ['消费', 'expense', 'purchase'], ['手续费', 'expense', 'fee'],
    ['退款', 'income', 'refund_credit'], ['工资', 'income', 'receipt']
  ]) assert.equal(resolveRowSemantic({ ...source, rawTransactionType, direction }).sourceAction, expected)
})

test('还款退回、返还、退款与冲正证据不形成新还款', () => {
  for (const item of ['支付宝还款退款', '财付通还款退回', '信用卡还款返还', '还款冲正', '还款撤销', '返还']) {
    assert.equal(resolveRowSemantic({ ...source, item }).sourceAction, null, item)
  }
  for (const note of ['还款退款', '退回', '返还', '冲正', '已撤销']) {
    for (const field of ['note', 'sourceNote']) {
      const semantic = resolveRowSemantic({ ...source, rawTransactionType: '信用卡还款', [field]: note })
      assert.equal(semantic.sourceAction, null, field + ':' + note)
      assert.ok(semantic.issues.some(issue => issue.code === 'row_transaction_type_unknown'))
    }
  }
  assert.equal(resolveRowSemantic({ ...source, rawTransactionType: '还款退款' }).sourceAction, null)
  assert.equal(resolveRowSemantic({ ...source, rawTransactionType: '还款', item: '退回' }).sourceAction, null)
})

test('明确还款不绕过失败、冲正与未知状态的入账门禁', () => {
  for (const [status, eligibility, moneyEffect] of [
    ['失败', 'non_postable', 'failed'], ['交易失败', 'non_postable', 'failed'],
    ['冲正', 'non_postable', 'closed'], ['已撤销', 'non_postable', 'closed'],
    ['待处理', 'review_required', 'unknown'], ['还款失败', 'review_required', 'unknown']
  ]) {
    const row = normalizeRow('bank', {
      transactionTime: '2026-09-02 08:35:00', amount: '100.00', direction: '收入',
      transactionType: '', status, item: '支付宝还款', paymentMethod: '****1234'
    }, -480, [], 'bank_csv')
    assert.equal(row.semantic.sourceAction, 'repayment')
    assert.equal(row.semantic.moneyEffect, moneyEffect)
    assert.equal(row.eligibility, eligibility)
    assert.equal(row.semantic.fromAccountRef, null)
    assert.equal(row.semantic.toAccountRef, null)
  }
})

for (const extension of ['csv', 'xls', 'xlsx']) test(`银行 ${extension} 明确摘要保留原始负号、方向和账户，只解除性质未知`, async () => {
  const rows = [['交易日期', '交易金额', '摘要', '尾号4位'], ['20260902 08:35', '-100.00', '支付宝还款', '1234']]
  let content
  if (extension === 'csv') content = Buffer.from(rows.map(row => row.join(',')).join('\r\n'))
  else {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '合成还款')
    content = XLSX.write(book, { type: 'buffer', bookType: extension === 'xls' ? 'biff8' : 'xlsx' })
  }
  const input = { content, extension, timezoneOffsetMinutes: -480 }
  const { bankPreview: preview } = await parseEvidenceFile(input)
  const bankMapping = { ...preview.suggested, schemaVersion: 1, sheetIndex: preview.sheetIndex,
    headerRow: preview.headerRow, headerToken: preview.headerToken, positiveDirection: 'expense', statementKind: 'credit' }
  const document = await parseEvidenceFile({ ...input, bankMapping })
  const [row] = document.rows
  assert.equal(row.raw.amount, '-100.00')
  assert.equal(row.raw.item, '支付宝还款')
  assert.equal(row.raw.paymentMethod, '1234')
  assert.equal(row.normalized.amountMinor, '10000')
  assert.equal(row.normalized.direction, 'income')
  assert.equal(row.semantic.sourceAction, 'repayment')
  assert.ok(row.semantic.toAccountRef)
  assert.equal(row.semantic.fromAccountRef, null)
  assert.equal(row.eligibility, 'review_required')
  assert.deepEqual(row.issues.map(issue => issue.code), ['account_endpoint_unknown'])
})

test('新版银行语义可原位升级旧草稿，账户选择、人工性质与已入账事实保持', () => {
  const oldSemantic = { ...resolveRowSemantic(source), profileVersion: 'bank-profile-v3', policyVersion: 'bank-policy-v3',
    sourceAction: null, issues: [{ code: 'row_transaction_type_unknown', field: 'transaction_type', severity: 'warning' }],
    legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'normal', rule: 'bank.action.review.v1' } }
  const row = { ...source, semantic: oldSemantic }
  assert.equal(getRowSemantic(row).sourceAction, 'repayment')
  const current = { eventId: 'synthetic-event', updateId: 'synthetic-update', version: 3, status: 'needs_action',
    economicNature: 'unknown', flowDirection: 'inflow', amountMinor: '10000', currency: 'CNY',
    localAt: '2026-09-02 08:35:00.000', utcAt: '2026-09-02 00:35:00.000',
    ledgerAccountId: 'synthetic-credit-account', counterpartyLedgerAccountId: null,
    manualFieldMask: FIELD_MASK.ledgerAccountId,
    fieldSources: { rowIds: ['synthetic-row'], semanticBlockers: ['row_transaction_type_unknown'] },
    reasonCodes: ['row_transaction_type_unknown', 'economic_nature_required'] }
  const upgraded = refreshEventSemantic(current, [row])
  assert.equal(upgraded.economicNature, 'repayment')
  assert.equal(upgraded.flowDirection, 'neutral')
  assert.equal(upgraded.ledgerAccountId, current.ledgerAccountId)
  assert.equal(upgraded.counterpartyLedgerAccountId, null)
  assert.deepEqual(upgraded.fieldSources.rowIds, current.fieldSources.rowIds)
  const checked = evaluatePostability(upgraded)
  assert.equal(checked.status, 'needs_action')
  assert.ok(checked.reasonCodes.includes('repayment_account_required'))
  assert.ok(!checked.reasonCodes.includes('row_transaction_type_unknown'))
  assert.ok(!checked.reasonCodes.includes('economic_nature_required'))
  const manual = { ...current, economicNature: 'internal_transfer', manualFieldMask: current.manualFieldMask | FIELD_MASK.economicNature }
  assert.equal(refreshEventSemantic(manual, [row]).economicNature, 'internal_transfer')
  for (const status of ['posted', 'corrected', 'excluded']) {
    const closed = { ...current, status }
    assert.equal(refreshEventSemantic(closed, [row]), closed)
  }
  const profile = bankProfile('xls')
  assert.equal(profile.profileVersion, 'bank-profile-v5')
  assert.equal(profile.policyVersion, 'bank-policy-v5')
  assert.equal(profile.parserVersion, 'bank-parser-v4')
  assert.equal(profile.normalizationVersion, 'bank-normalization-v4')
})
