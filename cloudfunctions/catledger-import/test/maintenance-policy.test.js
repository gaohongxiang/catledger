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
