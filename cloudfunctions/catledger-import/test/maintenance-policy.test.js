const assert = require('node:assert/strict')
const test = require('node:test')
const { materializeAccountDrafts } = require('../src/account-draft')
const { correctionImpactResult } = require('../src/finance-update-maintenance')

test('只物化最终可达草稿，旧选择不能成为正式账户', async () => {
  const inserted = []
  const connection = { async execute(sql, values) {
    if (sql.includes('SELECT draft_account_id')) return [[{ accountId: 'used' }, { accountId: 'obsolete' }]]
    if (sql.includes('INSERT INTO catledger_accounts')) inserted.push(values[1])
    return [{ affectedRows: 1 }]
  } }
  await materializeAccountDrafts(connection, 'user', 'update', new Set(['used']))
  assert.deepEqual(inserted, ['used'])
})

test('外部修改了关联交易版本时不能继续修正', () => {
  const impact = correctionImpactResult({ status: 'posted', version: 1 }, [
    { transactionId: 'tx', creationMethod: 'created', version: 2, linkedVersion: 1, deletedAt: null }
  ])
  assert.equal(impact.canCorrect, false)
})

test('聚合还款允许完整集合维护，普通多交易事件禁止局部维护', () => {
  const event = { status: 'posted', version: 1, economicNature: 'repayment',
    fieldSources: { fundsProjection: { to: { referenceKind: 'aggregate' } } } }
  const transactions = ['a', 'b'].map((transactionId) => ({ transactionId, creationMethod: 'created', version: 1, linkedVersion: 1, deletedAt: null }))
  assert.equal(correctionImpactResult(event, transactions).canCorrect, true)
  assert.equal(correctionImpactResult({ ...event, economicNature: 'expense' }, transactions).canCorrect, false)
})

for (const [feeMinor, expectedCount] of [['0', 1], ['50', 2]]) {
  test(`已确认渠道还款含${expectedCount}条交易时均须整批撤销，不能单事件更正`, () => {
    const { VERSION, drafts } = require('../src/repayment-channel')
    const localAt = '2026-09-02 08:35:45.000', utcAt = '2026-09-02 00:35:45.000'
    const totalMinor = String(50000n + BigInt(feeMinor))
    const event = { eventId: 'event', status: 'posted', version: 2, economicNature: 'repayment',
      flowDirection: 'neutral', sourceDirection: 'expense', currency: 'CNY', amountMinor: totalMinor,
      ledgerAccountId: 'payer', counterpartyLedgerAccountId: 'credit', localAt, utcAt,
      fieldSources: { repaymentOwnership: { owner: 'self' }, repaymentChannelResolution: {
        version: VERSION, confirmedBy: 'user', repaymentConfirmed: true,
        totalMinor, repaymentMinor: '50000', feeMinor, targetAccountId: 'credit', localAt, utcAt
      } } }
    const transactions = drafts(event).map((draft, index) => ({ ...draft, transactionId: `tx-${index}`,
      origin: 'import', creationMethod: 'created', version: 1, linkedVersion: 1, deletedAt: null }))
    assert.equal(transactions.length, expectedCount)
    const impact = correctionImpactResult(event, transactions)
    assert.equal(impact.canCorrect, false)
    assert.deepEqual(impact.conflicts, ['WHOLE_UPDATE_UNDO_REQUIRED'])
    assert.deepEqual(impact.transactionIds, transactions.map(row => row.transactionId))
    if (expectedCount === 1) {
      const ordinary = { ...event, fieldSources: { repaymentOwnership: { owner: 'self' } } }
      assert.equal(correctionImpactResult(ordinary, transactions).canCorrect, true)
    }
  })
}

test('现金变化投影不会因修正入口绕过负余额约束', () => {
  const { accountImpacts, cashDeficits } = require('../src/maintenance-policy')
  const impacts = accountImpacts([{ sourceAccountId: 'cash', amountMinor: '100' }], [{ sourceAccountId: 'cash', amountMinor: '201' }])
  assert.deepEqual(impacts, [{ accountId: 'cash', oldMinor: '-100', newMinor: '-201', deltaMinor: '-101' }])
  assert.deepEqual(cashDeficits(impacts, [{ accountId: 'cash', type: 'cash', balanceMinor: '100' }]), ['cash'])
})

test('撤销只撤回本批独占规则，保留后续版本', () => {
  const { reversibleMappings } = require('../src/maintenance-policy')
  const saved = [{ after: { mappingId: 'own', version: 1 }, before: null }, { after: { mappingId: 'later', version: 1 }, before: null }]
  const current = [{ mappingId: 'own', version: 1 }, { mappingId: 'later', version: 2 }]
  assert.deepEqual(reversibleMappings(saved, current, new Set()).revert.map((item) => item.after.mappingId), ['own'])
})
