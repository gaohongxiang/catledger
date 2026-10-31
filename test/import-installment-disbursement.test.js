const test = require('node:test')
const assert = require('node:assert/strict')

const { normalizeRow } = require('../cloudfunctions/catledger-import/src/parsers/normalize')
const { buildOrganizePlan } = require('../cloudfunctions/catledger-import/src/organizer-planner')
const { publicEvent } = require('../cloudfunctions/catledger-import/src/finance-update-repository')
const { refreshEventSemantic } = require('../cloudfunctions/catledger-import/src/semantic-plan-upgrade')
const { applyInstallmentDisbursements, pairsOf } = require('../cloudfunctions/catledger-import/src/installment-disbursement')
const { disbursementRole } = require('../cloudfunctions/catledger-import/src/profiles/bank-installment')
const { groupFor } = require('../cloudfunctions/catledger-import/src/excluded-event-groups')

const CARD = '合成银行信用卡1001'
const ACCOUNTS = [
  { accountId: 'acct-card', name: CARD, type: 'credit', nature: 'liability', currency: 'CNY', version: 1 },
  { accountId: 'acct-savings', name: '合成储蓄卡', type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }
]
// 合成账单文案：放款行只写“现金分期”和期数，对行再补一句“转分期付款”。
const DISBURSEMENT_ITEM = '电销现金分期12期'
const OFFSET_ITEM = '电销现金分期12期 转分期付款'

let seq = 0
function row({ direction = 'expense', item, amount = '6000.00', time = '2026-08-25 10:00:00',
  paymentMethod = CARD, status = '交易成功', kind = 'credit', importId = 'import-1' }) {
  seq += 1
  const normalized = normalizeRow('bank', {
    transactionTime: time, amount, direction: direction === 'income' ? '收入' : '支出',
    status, transactionType: '', counterparty: '', item, paymentMethod, note: '', bankStatementKind: kind,
    installmentFields: { reference: '', period: '', terms: '', component: '' }
  }, -480)
  return { ...normalized.normalized, rowId: 'row-' + seq, batchId: 'batch-1', importId, sourceOrder: 0, rowNumber: seq,
    parseState: normalized.parseState, identityId: 'identity-' + seq, identityState: 'new',
    sourceType: 'bank', sourceFormat: 'bank_xls', bankStatementKind: kind,
    installmentFields: { reference: '', period: '', terms: '', component: '' },
    rawStatus: status, rawTransactionType: '', semantic: normalized.semantic,
    sourceTransactionId: '', sourceOrderId: '', sourceMerchantOrderId: '' }
}
function pair(overrides = {}) {
  return [
    row({ direction: 'expense', item: DISBURSEMENT_ITEM, ...overrides.disbursement }),
    row({ direction: 'income', item: OFFSET_ITEM, ...overrides.offset })
  ]
}
function organize(rows) {
  let id = 0
  return buildOrganizePlan({ updateId: 'update-1', rows, accounts: ACCOUNTS, idFactory: () => 'id-' + (++id) })
}

test('同卡同日同额的一对现金分期放款记成借款，对行只留证据不计入', () => {
  const plan = organize(pair())
  const borrow = plan.events.find(event => event.economicNature === 'borrow')
  const offset = plan.events.find(event => event.eventId !== borrow.eventId)
  assert.equal(borrow.status, 'needs_action')
  assert.equal(borrow.flowDirection, 'neutral')
  // 负债端是这张信用卡，资产端等用户选到账账户。
  assert.equal(borrow.ledgerAccountId, 'acct-card')
  assert.equal(borrow.counterpartyLedgerAccountId, null)
  assert.deepEqual(borrow.reasonCodes, ['borrow_account_required'])
  assert.equal(borrow.fieldSources.disbursement.role, 'disbursement')
  assert.equal(borrow.fieldSources.disbursement.totalTerms, 12)
  assert.equal(borrow.fieldSources.disbursement.planLabel, '电销现金分期')
  // 对行是卡内记账：不产生资金流，原因写明它是什么，不再要求确认账户。
  assert.equal(offset.status, 'excluded')
  assert.deepEqual(offset.reasonCodes, ['economic_nature_required', 'installment_offset_pair'])
  assert.equal(offset.ledgerAccountId, null)
  assert.equal(offset.amountMinor, '600000')
  assert.deepEqual(plan.counts, { sourceCount: 1, validEvidenceCount: 2, duplicateEvidenceCount: 0,
    finalEventCount: 2, postedEventCount: 0, readyEventCount: 0, needsActionEventCount: 1, excludedEventCount: 1 })
  // 待核对只有“选到账账户”这一件事，性质和类型都不再追问。
  const issues = plan.issues.filter(issue => issue.status === 'open' && issue.blocking)
  assert.deepEqual(issues.map(issue => [issue.issueType, issue.primaryReasonCode]), [['transfer_accounts', 'borrow_account_required']])
  assert.equal(groupFor({ reasonCodes: offset.reasonCodes }).label, '分期放款的卡内记账行')
})

test('放款行带着同笔的另一行，对行对外说明自己是分期放款对行', () => {
  const plan = organize(pair())
  const borrow = plan.events.find(event => event.economicNature === 'borrow')
  const exposed = publicEvent({ ...borrow, fieldSources: JSON.stringify(borrow.fieldSources), reasonCodes: '[]' })
  assert.deepEqual(exposed.disbursement, { role: 'disbursement', totalTerms: 12, planLabel: '电销现金分期',
    partner: { rowId: borrow.fieldSources.disbursement.partnerRowId, item: OFFSET_ITEM, localDate: '2026-08-25', amountMinor: '600000' } })
  assert.equal(exposed.installment, undefined)
  // 对行不是“性质待确认”：它已经识别成同一笔分期里的卡内记账行。
  const offset = plan.events.find(event => event.status === 'excluded')
  assert.deepEqual(publicEvent({ ...offset, fieldSources: JSON.stringify(offset.fieldSources), reasonCodes: '[]' }).disbursement,
    { role: 'offset', totalTerms: 12, planLabel: '电销现金分期' })
  const evidence = plan.evidence.filter(link => link.eventId === borrow.eventId)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].evidenceRole, 'primary')
})

test('期数或计划名不同、金额或日期不同、账户不同、非信用卡账单、不同账单文件都不配对', () => {
  const cases = [
    ['金额不同', pair({ offset: { amount: '25999.00' } })],
    ['日期不同', pair({ offset: { time: '2026-08-26 10:00:00' } })],
    ['账户不同', pair({ offset: { paymentMethod: '兴业银行信用卡9999' } })],
    // 两份账单文件是两张卡，账单上只写“银行”时不能靠账户名分辨，按文件隔开。
    ['不同账单文件', pair({ offset: { importId: 'import-2' } })],
    ['不是信用卡账单', pair({ disbursement: { kind: 'standard' }, offset: { kind: 'standard' } })],
    ['账单状态未确认', pair({ disbursement: { status: '处理中' }, offset: { status: '处理中' } })]
  ]
  for (const [name, rows] of cases) {
    const plan = organize(rows)
    assert.equal(plan.events.filter(event => event.status === 'excluded').length, 0, name)
    assert.deepEqual(plan.events.map(event => event.economicNature), ['unknown', 'unknown'], name)
    assert.equal(pairsOf(rows).size, 0, name)
  }
})

test('同额同角色不止一条、或只有一半时不猜', () => {
  const ambiguous = [...pair(), ...pair({ disbursement: { time: '2026-08-25 11:00:00' }, offset: { time: '2026-08-25 11:00:00' } })]
  assert.equal(pairsOf(ambiguous).size, 0)
  const plan = organize(ambiguous)
  assert.equal(plan.events.filter(event => event.economicNature === 'borrow').length, 0)
  // 只有登记行时等待选择计划，不能记成到账或还款。
  const lonely = organize([row({ direction: 'income', item: OFFSET_ITEM })])
  assert.equal(lonely.events[0].economicNature, 'unknown')
  assert.equal(lonely.events[0].status, 'needs_action')
})

test('分期账单行和放款对互不抢占：带第几期的本金行仍按分期出账', () => {
  const billing = row({ direction: 'expense', item: '电销现分按月收12期第3期共12期', amount: '2400.00' })
  assert.equal(disbursementRole(billing), null)
  assert.equal(disbursementRole({ ...billing, item: '电销现金分期12期', direction: 'income' }), null)
  assert.deepEqual(disbursementRole({ ...billing, item: '电销现金分期12期', installmentFields: {} }), { role: 'disbursement', totalTerms: 12, referenceKey: null })
  assert.deepEqual(disbursementRole({ ...billing, item: OFFSET_ITEM, direction: 'income' }), { role: 'offset', totalTerms: 12, referenceKey: null })
  const plan = organize([billing, ...pair()])
  const byItem = Object.fromEntries(plan.events.map(event => [event.display.item, [event.economicNature, event.status]]))
  assert.deepEqual(byItem[DISBURSEMENT_ITEM], ['borrow', 'needs_action'])
  assert.deepEqual(byItem[OFFSET_ITEM], ['unknown', 'excluded'])
  assert.deepEqual(byItem['电销现分按月收12期第3期共12期'], ['repayment', 'ready'])
})

test('重新推导来源语义时放款对结论不丢，也不退回性质待确认', () => {
  const rows = applyInstallmentDisbursements(pair())
  // 改写可以重复应用：对行已经写成“不产生资金流”，仍要按放款对重新配对。
  const again = applyInstallmentDisbursements(rows)
  assert.deepEqual(again.map(row => row.semantic.sourceAction), ['borrow', null])
  assert.equal(pairsOf(again).size, 2)
  const plan = organize(rows)
  const borrow = plan.events.find(event => event.economicNature === 'borrow')
  const disbursementRow = rows[0]
  assert.equal(refreshEventSemantic(borrow, [disbursementRow]), borrow)
  assert.equal(disbursementRow.semantic.sourceAction, 'borrow')
  assert.equal(disbursementRow.semantic.relationHints.disbursement.totalTerms, 12)
})

test('对行在已排除里说清自己是同一笔分期的卡内记账，不显示原因待核对', () => {
  const { exclusionReasonText } = require('../miniprogram/packages/finance/pages/import-workbench/model')
  const offset = organize(pair()).events.find(event => event.status === 'excluded')
  assert.equal(exclusionReasonText(offset), '同一笔电销现金分期的卡内记账行，已并入这笔借款，不重复入账')
})

test('放款对按动作识别，不挑产品名：电销分期、预借现金、各种转分期写法都算', () => {
  const role = (item, direction = 'expense') => disbursementRole(row({ item, direction }))
  // 放款侧：只要求写明分期并带期数。
  for (const item of ['电销分期12期', '预借现金分期6期', '取现分期24期', '随借金12期', '现金借款3期']) {
    assert.deepEqual(role(item), { role: 'disbursement', totalTerms: Number((item.match(/(\d+)期/u) || [])[1]), referenceKey: null }, item)
  }
  // 对行：各行的转期写法都认，但只在收入侧成立。
  for (const item of ['电销分期12期 转分期付款', '现金分期12期 转分期', '分期12期 转入分期']) {
    assert.deepEqual(role(item, 'income'), { role: 'offset', totalTerms: 12, referenceKey: null }, item)
    assert.equal(role(item, 'expense'), null, item)
  }
  // 把已出账欠款或单笔消费转期的不产生资金到账，不是放款。
  for (const item of ['账单分期12期', '消费分期12期', '购物分期12期']) assert.equal(role(item), null, item)
  // 分期账单行（带期次、利息、手续费）仍然不是放款行。
  for (const item of ['电销分期12期 第3期', '分期手续费12期']) assert.equal(role(item), null, item)
})

test('规则升级在原地认出放款对：对行收进已排除，放款行带上同笔事实', () => {
  const rows = applyInstallmentDisbursements(pair())
  // 旧计划里两行各自是“性质待确认”，没有放款对的任何痕迹。
  const legacy = (row, index) => ({ eventId: 'event-' + index, status: 'needs_action', economicNature: 'unknown',
    flowDirection: 'outflow', ledgerAccountId: null, counterpartyLedgerAccountId: null, manualFieldMask: 0,
    fieldSources: { rowIds: [row.rowId], semanticBlockers: ['row_transaction_type_unknown'] },
    reasonCodes: ['economic_nature_required', 'row_transaction_type_unknown'] })
  const [disbursementEvent, offsetEvent] = rows.map(legacy)
  const offset = refreshEventSemantic(offsetEvent, [rows[1]])
  assert.equal(offset.status, 'excluded')
  assert.equal(offset.ledgerAccountId, null)
  assert.deepEqual(offset.reasonCodes, ['economic_nature_required', 'installment_offset_pair'])
  assert.equal(offset.fieldSources.disbursement.role, 'offset')
  assert.equal(offset.fieldSources.disbursement.totalTerms, 12)
  // 升级可以重复执行：第二次没有新事实就不再产生新版本。
  assert.equal(refreshEventSemantic(offset, [rows[1]]), offset)
  const borrow = refreshEventSemantic(disbursementEvent, [rows[0]])
  assert.equal(borrow.economicNature, 'borrow')
  assert.equal(borrow.fieldSources.disbursement.role, 'disbursement')
  assert.equal(borrow.fieldSources.disbursement.planLabel, '电销现金分期')
  assert.equal(borrow.fieldSources.installment, undefined)
})

test('人工改过的对行不被规则升级覆盖', () => {
  const rows = applyInstallmentDisbursements(pair())
  const offsetEvent = { eventId: 'event-offset', status: 'needs_action', economicNature: 'expense', flowDirection: 'outflow',
    ledgerAccountId: 'acct-savings', counterpartyLedgerAccountId: null, manualFieldMask: 1 << 3,
    fieldSources: { rowIds: [rows[1].rowId] }, reasonCodes: ['economic_nature_required'] }
  assert.equal(refreshEventSemantic(offsetEvent, [rows[1]]), offsetEvent)
})

test('非现金分期的放款对同样成组：电销分期两行合成一笔借款', () => {
  const plan = organize([
    row({ direction: 'expense', item: '电销分期12期' }),
    row({ direction: 'income', item: '电销分期12期 转分期付款' })
  ])
  const borrow = plan.events.find(event => event.economicNature === 'borrow')
  const offset = plan.events.find(event => event.status === 'excluded')
  assert.equal(borrow.fieldSources.disbursement.planLabel, '电销分期')
  assert.equal(offset.fieldSources.disbursement.role, 'offset')
  assert.deepEqual(offset.reasonCodes, ['economic_nature_required', 'installment_offset_pair'])
})
