const test = require('node:test')
const assert = require('node:assert/strict')
const { fixture, runtime, flush } = require('./helpers/paged-workbench')
const tap = dataset => ({ currentTarget: { dataset } })
const installment = { creditStatement: true, factKind: 'billing', component: 'principal', periodNumber: 3, totalTerms: 6, originKind: 'cash_borrowing' }

test('本金出账列表和原文说明期次，不提供实际还款编辑入口', async t => {
  const data = fixture(1)
  Object.assign(data.events[0], { economicNature: 'repayment', flowDirection: 'neutral', installment })
  const { page } = runtime(data)
  t.after(() => page.onUnload())
  page.data.activeReviewStatus = 'completed'
  await page.setStep({ currentStep: 3 })
  const row = page.data.reviewedEvents[0]
  assert.equal(row.natureLabel, '分期本金出账')
  assert.match(row.displayDetailMeta, /第3期／共6期/)
  await page.openReviewDetails(tap({ id: row.eventId }))
  assert.match(page.data.reviewDetailSheet.installmentNote, /关联或新建分期计划/)
  assert.equal(page.data.reviewDetailSheet.repaymentEditable, false)
  assert.equal(page.data.reviewDetailSheet.reviewEditable, true, '只允许修正来源字段，不开放实际还款')
  assert.equal(page.data.reviewDetailSheet.editor.principal, true)
  assert.equal(page.data.reviewDetailSheet.editor.showOwnership, false)
  assert.equal(page.data.reviewDetailSheet.editor.showLoan, false)
  page.closeReviewDetails()
  await page.openEvidence(tap({ id: row.eventId }))
  assert.equal(page.data.evidenceSheet.repaymentEditable, undefined)
  assert.match(page.data.evidenceSheet.installmentNote, /不记实际还款/)
  assert.match(page.data.evidenceSheet.installmentNote, /关联或新建分期计划/)
})

test('分期本金与人工性质冲突经来源编辑纠正，但不解除来源冲突', async t => {
  const editor = require('./helpers/editor-workbench')
  const { page } = await editor.open(t, { economicNature: 'internal_transfer', installment,
    ledgerAccountId: 'synthetic-credit', counterpartyLedgerAccountId: 'synthetic-target',
    reasonCodes: ['core_fields_conflict'] }, { issueType: 'field_conflict',
    accounts: [{ accountId: 'synthetic-credit', name: '合成信用卡', type: 'credit' }] })
  assert.equal(editor.view(page).principal, true)
  assert.equal(editor.view(page).showLoan, false)
  assert.equal(editor.view(page).natureLabel, '分期本金出账')
  editor.edit(page, 'periodInput', '4')
  const fields = editor.view(page).payload.fields
  assert.equal(fields.economicNature, 'repayment')
  assert.equal(fields.counterpartyLedgerAccountId, null)
  assert.equal(editor.view(page).payload.sourceCorrection.periodNumber, 4)
  assert.equal(editor.view(page).complete, false)
  editor.nature(page, 'expense')
  assert.equal(editor.draft(page).economicNature, 'repayment')
})
