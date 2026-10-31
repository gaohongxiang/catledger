const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { normalizeRow } = require('../cloudfunctions/catledger-import/src/parsers/normalize')
const { buildOrganizePlan } = require('../cloudfunctions/catledger-import/src/organizer-planner')
const { applyInstallmentDisbursements, pairsOf } = require('../cloudfunctions/catledger-import/src/installment-disbursement')
const business = require('../cloudfunctions/catledger-import/src/installment-business')
const { workbenchSummary } = require('../cloudfunctions/catledger-import/src/workbench-summary')
const editor = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const rules = require('../cloudfunctions/catledger-import/src/organizer-model')
const local = require('../miniprogram/packages/finance/services/import-local-model')
const read = require('../miniprogram/packages/finance/services/import-local-read')
const { facts } = require('./helpers/local-review')

const accounts = [
  { accountId: '00000000-0000-4000-8000-000000000001', name: '合成信用卡', type: 'credit', nature: 'liability', currency: 'CNY', version: 1 },
  { accountId: '00000000-0000-4000-8000-000000000002', name: '合成储蓄卡', type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }
]
const label = '合成现金分期'
function row(role, { terms = 6, name = label, reference = '' } = {}) {
  const item = name + (terms ? terms + '期' : '') + (role === 'offset' ? ' 转分期付款' : '')
  const raw = { transactionTime: '2026-09-03 10:00:00', amount: '6000.00', direction: role === 'offset' ? '收入' : '支出',
    status: '交易成功', transactionType: '', item, counterparty: '', paymentMethod: accounts[0].name,
    bankStatementKind: 'credit', installmentFields: { reference, period: '', terms: '', component: '' } }
  const result = normalizeRow('bank', raw, -480)
  return { ...result.normalized, rowId: randomUUID(), identityId: randomUUID(), batchId: 'batch', importId: 'import',
    sourceOrder: 0, rowNumber: 1, sourceType: 'bank', sourceFormat: 'bank_csv', bankStatementKind: 'credit',
    parseState: result.parseState, semantic: result.semantic, rawStatus: raw.status, installmentFields: raw.installmentFields }
}
function plan(rows) { return buildOrganizePlan({ updateId: 'update', rows, accounts }) }
const decision = { action: 'link', loanId: 'loan', planLabel: label, totalTerms: 6, principalMinor: '600000', startMonth: '2026-10', accountId: '00000000-0000-4000-8000-000000000001' }
async function modelFor(rows) {
  const value = await facts({ count: rows.length, accounts }), planned = plan(rows)
  const source = value.sources[0]
  Object.assign(source, { batchId: 'batch', sourceType: 'bank', sourceFormat: 'bank_csv' })
  Object.assign(value, { rows, events: planned.events, issues: planned.issues.map(issue => ({ ...issue,
    subjectEventIds: planned.members.filter(member => member.issueId === issue.issueId && member.objectType === 'event' && member.memberRole !== 'candidate').map(member => member.objectId) })),
    members: planned.members, evidence: planned.evidence, relations: planned.relations,
    raw: rows.map(row => ({ rowId: row.rowId, fields: { item: row.item, marker: row.rowId } })),
    historyCoverage: { duplicates: planned.events.map(event => ({ ...event })), refunds: [] } })
  value.update.updateId = 'update'
  const model = local.create(value)
  return { model, reader: read.create(model), planned }
}

test('缺少放款行时只登记分期：未关联与先不挂继续待核对，关联后不需分类', () => {
  const event = plan([row('offset')]).events[0]
  assert.equal(event.fieldSources.disbursement.role, 'registration')
  assert.equal(event.economicNature, 'unknown')
  assert.equal(event.flowDirection, 'neutral')
  assert.equal(event.ledgerAccountId, accounts[0].accountId)
  assert.equal(event.fieldSources.installment, undefined)
  assert.deepEqual(event.reasonCodes, ['installment_plan_required'])
  for (const action of [undefined, 'skip']) {
    const next = action ? editor.prepare(event, { editorVersion: 1, fields: { installmentPlan: { ...decision, action } } }) : event
    assert.equal(rules.evaluatePostability(next).status, 'needs_action')
  }
  const next = editor.prepare(event, { editorVersion: 1, fields: { installmentPlan: decision } })
  assert.equal(rules.evaluatePostability(next).status, 'ready')
  assert.equal(workbenchSummary([next], [], [], 0, 0).categoryEventCount, 0)
  for (const fields of [{ economicNature: 'income' }, { categoryId: 'category' }, { counterpartyLedgerAccountId: 'bank' }]) {
    assert.throws(() => editor.prepare(event, { editorVersion: 1, fields }), error => error.publicCode === 'VALIDATION_ERROR')
  }
})

test('有同卡同日同额候选但期数、名称或合同冲突时不合卡，也不冒充独立登记', () => {
  for (const [left, right] of [
    [{}, { terms: 12 }], [{}, { name: '另一现金分期' }],
    [{ reference: 'SYNTHETIC-A' }, { reference: 'SYNTHETIC-B' }]
  ]) {
    const rows = [row('disbursement', left), row('offset', right)]
    assert.equal(pairsOf(rows).size, 0)
    assert.ok(applyInstallmentDisbursements(rows).every(row => !row.semantic.relationHints?.disbursement))
    assert.equal(business.visibleEvents(plan(rows).events).length, 2)
  }
})

test('合卡只改变展示：列表和摘要1笔，原事件与原证据均保留2份', async () => {
  const { model, reader, planned } = await modelFor([row('disbursement'), row('offset')])
  const main = [...model.events.values()].find(event => event.economicNature === 'borrow')
  const offset = [...model.events.values()].find(event => event.status === 'excluded')
  const before = JSON.stringify(planned.evidence)
  assert.equal(model.events.size, 2)
  assert.equal(reader.read('economicEvents.list', {}).items.length, 1)
  assert.equal(reader.read('economicEvents.list', { status: 'excluded' }).total, 0)
  assert.equal(reader.read('economicEvents.list', { view: 'excluded_groups' }).total, 0)
  const summary = reader.summary()
  assert.equal(summary.workbench.recordSummary.totalCount, 1)
  assert.equal(summary.workbench.recordSummary.excludedCount, 0)
  assert.equal(summary.coverage.dataRows, 2)
  assert.equal(summary.coverage.rowConservationPassed, true)
  assert.equal(model.publicRow(main.eventId).evidenceCount, 2)
  const evidence = reader.read('economicEvents.evidence', { eventId: main.eventId })
  assert.equal(evidence.items.length, 2)
  const paired = evidence.items.find(link => link.eventId === offset.eventId)
  const text = reader.read('economicEvents.detail', { eventId: main.eventId, evidenceId: paired.evidenceId }).part
  assert.equal(JSON.parse(text).marker, paired.rowId)
  assert.equal(JSON.stringify(planned.evidence), before)
  assert.equal(model.byEvent.get(main.eventId).length, 1)
  assert.equal(model.byEvent.get(offset.eventId).length, 1)
  assert.throws(() => reader.read('economicEvents.detail', { eventId: main.eventId, evidenceId: 'unrelated' }), error => error.code === 'NOT_FOUND')
})

test('主行人工改判后摘要、排除页签与证据范围同步展开，不再藏对行', async () => {
  const { model, reader } = await modelFor([row('disbursement'), row('offset')])
  const main = [...model.events.values()].find(event => event.economicNature === 'borrow')
  assert.equal(reader.summary().workbench.recordSummary.totalCount, 1)
  model.edit({ eventId: main.eventId, editorVersion: 1, fields: { economicNature: 'expense', ledgerAccountId: accounts[1].accountId } })
  assert.equal(reader.summary().workbench.recordSummary.totalCount, 2)
  assert.equal(reader.read('economicEvents.list', { status: 'excluded' }).total, 1)
  assert.equal(model.publicRow(main.eventId).evidenceCount, 1)
})

test('人工处理、已有交易、历史重复或冲突的配对来源不能隐藏', () => {
  for (const change of [
    (main, offset) => { offset.manualFieldMask = 1 },
    (main, offset) => { offset.hasTransaction = true },
    (main, offset) => { offset.reasonCodes.push('user_excluded') },
    main => { main.reasonCodes.push('already_posted') },
    main => { main.fieldSources.semanticBlockers = ['source_group_conflict'] },
    (main, offset) => { offset.fieldSources.disbursement.partnerRowId = 'unrelated' }
  ]) {
    const events = plan([row('disbursement'), row('offset')]).events
    change(events.find(event => event.economicNature === 'borrow'), events.find(event => event.status === 'excluded'))
    assert.equal(business.visibleEvents(events).length, 2)
  }
})

test('缺总期数的独立登记仍可人工选计划，没有计划的快照正常返回空候选', async () => {
  const { model, reader } = await modelFor([row('offset', { terms: null })])
  const event = [...model.events.values()][0]
  assert.equal(event.fieldSources.disbursement.totalTerms, null)
  assert.deepEqual(reader.read('loans.planCandidates', { accountId: '00000000-0000-4000-8000-000000000001' }).items, [])
  model.edit({ eventId: event.eventId, editorVersion: 1, fields: { installmentPlan: decision } })
  assert.equal(model.events.get(event.eventId).status, 'ready')
  assert.equal(reader.read('economicEvents.list', { view: 'category_pending' }).total, 0)
  assert.equal(reader.read('economicEvents.list', { view: 'category_none' }).total, 1)
})
