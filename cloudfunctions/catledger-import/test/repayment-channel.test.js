const test = require('node:test')
const assert = require('node:assert/strict')
const { buildOrganizePlan } = require('../src/organizer-planner')
const { getRowSemantic } = require('../src/row-semantic-resolver')
const { buildPaymentMethodKey } = require('../src/identity')
const repayment = require('../src/repayment-channel')
const { pairingGraph } = require('../src/review/bank-channel-graph')

function fixture({ bankAmount = '50000', total = '50050' } = {}) {
  const rows = ['bank', 'alipay'].map(sourceType => {
    const bank = sourceType === 'bank', localAt = bank ? '2026-09-02 00:00:00.000' : '2026-09-02 08:35:45.000'
    const row = { rowId: sourceType + '-row', batchId: sourceType + '-batch', importId: sourceType + '-import',
      sourceType, sourceFormat: bank ? 'bank_csv' : 'alipay_app_csv', sourceOrder: bank ? 0 : 1, rowNumber: 1,
      parseState: 'valid', identityId: sourceType + '-identity', identityState: 'new',
      sourceTransactionId: 'SYNTHETIC-' + sourceType, rawTransactionTime: bank ? '2026-09-02' : '2026-09-02 08:35:45',
      localDate: '2026-09-02', localAt, utcAt: bank ? '2026-09-01 16:00:00.000' : '2026-09-02 00:35:45.000',
      timezoneOffsetMinutes: -480, amountMinor: bank ? bankAmount : total, currency: 'CNY',
      direction: bank ? 'income' : 'expense', rawTransactionType: bank ? '' : '信用借还',
      rawStatus: bank ? '' : '还款成功', bankStatementKind: bank ? 'credit' : null,
      paymentMethod: bank ? '9999000011111234' : '余额',
      counterparty: bank ? '' : '合成银行信用卡(1234)', item: bank ? '支付宝还款' : '信用卡还款' }
    row.paymentMethodKey = buildPaymentMethodKey(sourceType, row.paymentMethod)
    row.semantic = getRowSemantic(row)
    row.transactionType = row.semantic.legacy.transactionType; row.economicEffect = row.semantic.legacy.economicEffect
    return row
  })
  let sequence = 0
  const plan = buildOrganizePlan({ updateId: 'synthetic-update', rows, accounts: [], idFactory: () => 'synthetic-' + (++sequence) })
  const bank = plan.events.find(event => event.sourceType === 'bank'), platform = plan.events.find(event => event.sourceType === 'alipay')
  bank.ledgerAccountId = 'credit'; bank.ledgerAccountFacts = { name: '合成银行信用卡1234', type: 'credit', currency: 'CNY' }
  platform.ledgerAccountId = 'wallet'; platform.ledgerAccountFacts = { name: '合成支付宝余额', type: 'wallet', currency: 'CNY' }
  // DB hydration supplies the immutable planning rows rather than only the planner's relation projection.
  bank.relationEvidence.rows = [rows[0]]; platform.relationEvidence.rows = [rows[1]]
  return { bank, platform, rows }
}

test('银行只有日期仍可按同日本人信用卡提示还款差额，但永远不能进入默认建议', () => {
  const { bank, platform } = fixture()
  assert.deepEqual(repayment.pairFacts(bank, platform), { version: 1, totalMinor: '50050', repaymentMinor: '50000',
    feeMinor: '50', targetAccountId: 'credit', targetAccountName: '合成银行信用卡1234', targetConfirmed: false })
  const edges = repayment.edges([bank, platform])
  assert.equal(edges.length, 1)
  const graph = pairingGraph([bank, platform], [bank, platform].map(event => ({ eventId: event.eventId, issueId: 'same-issue' })))
  assert.equal(graph.pairs.length, 1)
  assert.equal(graph.suggestedCount, 0)
  bank.fieldSources.bankChannelDistinctPairs = [edges[0].pairKey]
  assert.equal(repayment.edges([bank, platform]).length, 0, '已明确不同次时不能再次冒出同一候选')
})

test('零差额允许确认，负差额、零本金和无效金额都不能被解释为手续费', () => {
  for (const amount of ['1', '50000', '9223372036854775807']) {
    const { bank, platform } = fixture({ bankAmount: amount, total: amount })
    assert.equal(repayment.pairFacts(bank, platform).feeMinor, '0')
  }
  for (const options of [{ bankAmount: '50051' }, { bankAmount: '0' }, { total: '0' },
    { total: '-1' }, { total: '50.50' }, { total: '9223372036854775808' }]) {
    const { bank, platform } = fixture(options)
    assert.equal(repayment.pairFacts(bank, platform), null, JSON.stringify(options))
  }
})

test('日期、账户角色、卡号、来源身份和用户决定的冲突均阻止候选', async t => {
  const cases = [
    ['跨本地日期', ({ platform }) => { platform.localAt = '2026-09-03 08:35:45.000' }],
    ['原始时间缺失', ({ rows }) => { rows[0].rawTransactionTime = '' }],
    ['银行账户未确认', ({ bank }) => { bank.ledgerAccountId = null }],
    ['银行映射到储蓄账户', ({ bank }) => { bank.ledgerAccountFacts.type = 'bank' }],
    ['信用卡已归档', ({ bank }) => { bank.ledgerAccountFacts.archivedAt = '2026-09-03' }],
    ['付款端是信用账户', ({ platform }) => { platform.ledgerAccountFacts.type = 'credit' }],
    ['付款和还入为同一账户', ({ platform }) => { platform.ledgerAccountId = 'credit' }],
    ['已选另一张信用卡', ({ platform }) => { platform.counterpartyLedgerAccountId = 'other-credit' }],
    ['同名银行但不同尾号', ({ platform }) => { platform.fieldSources.fundsProjection.to.value = '合成银行信用卡(5678)' }],
    ['没有目标账户线索', ({ platform }) => { platform.fieldSources.fundsProjection.to.value = '未知目标' }],
    ['不同币种', ({ bank }) => { bank.currency = 'USD' }],
    ['明确为他人代还', ({ platform }) => { platform.fieldSources.repaymentOwnership = { owner: 'other' } }],
    ['已有贷款拆分', ({ platform }) => { platform.fieldSources.loanRepayment = { repaymentMinor: '50000' } }],
    ['银行是扣款方向', ({ rows }) => { rows[0].direction = 'expense' }],
    ['来源身份冲突', ({ rows }) => { rows[0].identityState = 'identity_conflict' }],
    ['来源已经入账', ({ rows }) => { rows[1].existingTransactionId = 'posted' }],
    ['来源金额不符', ({ rows }) => { rows[0].amountMinor = '49999' }]
  ]
  for (const [name, mutate] of cases) await t.test(name, () => {
    const data = fixture(); mutate(data)
    assert.equal(repayment.pairFacts(data.bank, data.platform), null)
  })
})

function confirmed({ bankAmount = '50000', total = '50050' } = {}) {
  const { platform, rows } = fixture({ bankAmount, total })
  const event = { ...platform, counterpartyLedgerAccountId: 'credit', sourceDirection: 'expense',
    fieldSources: { ...platform.fieldSources, repaymentOwnership: { owner: 'self' }, repaymentChannelResolution: {
      version: repayment.VERSION, confirmedBy: 'user', repaymentConfirmed: true, totalMinor: total,
      repaymentMinor: bankAmount, feeMinor: String(BigInt(total) - BigInt(bankAmount)), targetAccountId: 'credit',
      localAt: platform.localAt, utcAt: platform.utcAt, platformType: 'alipay', bankRowIds: ['bank-row'],
      platformRowIds: ['alipay-row'], basisDigest: repayment.evidenceDigest(rows) } } }
  return { event, rows }
}

test('确认后保持本金、费用和总扣款守恒；零费用不生成空支出', () => {
  const { event, rows } = confirmed()
  assert.ok(repayment.evidenceValid(event, rows))
  const drafts = repayment.drafts(event)
  assert.equal(drafts.length, 2)
  assert.equal(drafts.reduce((sum, draft) => sum + BigInt(draft.amountMinor), 0n), 50050n)
  assert.deepEqual(drafts.map(draft => [draft.type, draft.amountMinor, draft.destinationAccountId]),
    [['transfer', '50000', 'credit'], ['expense', '50', null]])
  const zero = repayment.drafts(confirmed({ total: '50000' }).event)
  assert.equal(zero.length, 1); assert.equal(zero[0].type, 'transfer')
})

test('只有来源和固定事实均未变更的确认，才允许忽略银行净额与平台总额的差异', () => {
  const { event, rows } = confirmed()
  assert.deepEqual(repayment.semanticRows(event, rows).map(row => row.rowId), ['alipay-row'])
  const mutations = [
    value => { value.rows.pop() },
    value => { value.rows[0].rawTransactionTime = '2026-09-03' },
    value => { value.rows[0].amountMinor = '49999' },
    value => { value.rows[1].identityState = 'identity_conflict' },
    value => { value.event.amountMinor = '50051' },
    value => { value.event.counterpartyLedgerAccountId = 'other-credit' },
    value => { value.event.localAt = '2026-09-03 08:35:45.000' },
    value => { value.event.fieldSources.repaymentOwnership.owner = 'other' }
  ]
  for (const mutate of mutations) {
    const value = confirmed(); mutate(value)
    assert.equal(repayment.evidenceValid(value.event, value.rows), false)
    assert.equal(repayment.semanticRows(value.event, value.rows), value.rows)
  }
  event.ledgerAccountId = 'another-wallet'
  assert.ok(repayment.evidenceValid(event, rows), '只修改实际付款账户不改变已确认的本金及费用')
  event.ledgerAccountId = null
  assert.throws(() => repayment.drafts(event), { publicCode: 'UNRESOLVED_IMPORT' })
})
