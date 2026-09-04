const assert = require('node:assert/strict')
const test = require('node:test')

const { materializeAccountDrafts } = require('../src/account-draft')
const {
  correctionImpactResult,
  createFinanceUpdateMaintenance
} = require('../src/finance-update-maintenance')

const UID = '10000000-0000-4000-8000-000000000001'
const UPDATE_ID = '20000000-0000-4000-8000-000000000001'
const EVENT_ID = '30000000-0000-4000-8000-000000000001'
const CASH_ACCOUNT_ID = '40000000-0000-4000-8000-000000000001'
const REACHABLE_DRAFT_ID = '50000000-0000-4000-8000-000000000001'
const ORPHAN_DRAFT_ID = '50000000-0000-4000-8000-000000000002'
const TRANSACTION_ID = '60000000-0000-4000-8000-000000000001'
const SECOND_TRANSACTION_ID = '60000000-0000-4000-8000-000000000002'
const REQUEST_ID = '70000000-0000-4000-8000-000000000001'

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim()
}

test('A1-R2：posting 只物化服务端最终可达的账户草稿', async function () {
  const insertedAccountIds = []
  const connection = {
    async execute(sql, values) {
      const statement = normalizeSql(sql)
      if (statement.includes('FROM catledger_finance_update_account_drafts')) {
        return [[
          {
            accountId: REACHABLE_DRAFT_ID,
            type: 'wallet',
            nature: 'asset',
            name: '微信余额',
            normalizedName: '微信余额',
            currency: 'CNY'
          },
          {
            accountId: ORPHAN_DRAFT_ID,
            type: 'wallet',
            nature: 'asset',
            name: '已被改选的旧草稿',
            normalizedName: '已被改选的旧草稿',
            currency: 'CNY'
          }
        ], []]
      }
      if (statement.startsWith('INSERT INTO catledger_accounts')) {
        insertedAccountIds.push(values[1])
        return [{ affectedRows: 1 }, []]
      }
      if (statement.startsWith('UPDATE catledger_finance_update_account_drafts')) {
        return [{ affectedRows: 2 }, []]
      }
      throw new Error(`unexpected SQL: ${statement}`)
    }
  }

  await materializeAccountDrafts(connection, UID, UPDATE_ID, [REACHABLE_DRAFT_ID])

  assert.deepEqual(insertedAccountIds, [REACHABLE_DRAFT_ID])
})

function correctionConnection() {
  const state = { rolledBack: false, released: false }
  return {
    state,
    async beginTransaction() {},
    async commit() {},
    async rollback() {
      state.rolledBack = true
    },
    release() {
      state.released = true
    },
    async execute(sql) {
      const statement = normalizeSql(sql)
      if (statement.includes('FROM catledger_user_identities')) return [[{ uid: UID }], []]
      if (statement.startsWith('INSERT INTO catledger_mutation_receipts')) return [{ affectedRows: 1 }, []]
      if (statement.includes('FROM catledger_finance_updates')) {
        return [[{
          updateId: UPDATE_ID,
          status: 'posted',
          version: 1,
          planVersion: 'organizer-plan-v22',
          sourceCount: 1,
          validEvidenceCount: 1,
          duplicateEvidenceCount: 0,
          finalEventCount: 1,
          postedEventCount: 1,
          readyEventCount: 0,
          needsActionEventCount: 0,
          excludedEventCount: 0
        }], []]
      }
      if (statement.includes('FROM catledger_economic_events e')) {
        return [[{
          eventId: EVENT_ID,
          updateId: UPDATE_ID,
          status: 'posted',
          version: 1,
          flowDirection: 'out',
          economicNature: 'expense',
          ledgerAccountId: CASH_ACCOUNT_ID,
          counterpartyLedgerAccountId: null,
          localDate: '2026-09-04',
          localAt: '2026-09-04 12:00:00.000',
          utcAt: '2026-09-04 04:00:00.000',
          timezoneOffsetMinutes: -480,
          amountMinor: '100',
          currency: 'CNY',
          categoryId: null,
          manualFieldMask: 0,
          fieldSources: '{}',
          reasonCodes: '[]',
          sourceDirection: 'expense',
          counterparty: '',
          item: '现金支出',
          sourceNote: ''
        }], []]
      }
      if (statement.includes('FROM catledger_economic_event_transactions links')) {
        return [[{
          linkId: '80000000-0000-4000-8000-000000000001',
          transactionId: TRANSACTION_ID,
          role: 'primary',
          creationMethod: 'created',
          type: 'expense',
          sourceAccountId: CASH_ACCOUNT_ID,
          destinationAccountId: null,
          amountMinor: '100',
          originalTransactionId: null,
          version: 1,
          deletedAt: null
        }], []]
      }
      if (statement.includes('FROM catledger_accounts')) {
        return [[{
          accountId: CASH_ACCOUNT_ID,
          type: 'cash',
          currency: 'CNY',
          archivedAt: null
        }], []]
      }
      if (statement.includes('AS bookBalance')) return [[{ bookBalance: '50' }], []]
      if (statement.includes('AS amountMinor') && statement.includes('original_transaction_id')) {
        return [[{ amountMinor: '0' }], []]
      }
      if (statement.startsWith('UPDATE catledger_transactions')) {
        throw new Error('unsafe transaction update reached before cash guard')
      }
      throw new Error(`unexpected SQL: ${statement}`)
    }
  }
}

test('A1-R3：导入交易修正不得把现金余额从 50 分改成 -50 分', async function () {
  const connection = correctionConnection()
  const maintenance = createFinanceUpdateMaintenance({
    getPool: () => ({ getConnection: async () => connection })
  })

  await assert.rejects(maintenance.correct({
    provider: 'wechat-mini',
    subjectHash: 'subject-a1-cash-guard',
    data: {
      requestId: REQUEST_ID,
      updateId: UPDATE_ID,
      eventId: EVENT_ID,
      updateVersion: 1,
      eventVersion: 1,
      fields: { amountMinor: '200' }
    }
  }), function (error) {
    assert.equal(error.publicCode, 'INSUFFICIENT_CASH_BALANCE')
    return true
  })

  assert.equal(connection.state.rolledBack, true)
  assert.equal(connection.state.released, true)
})

function undoImpactConnection() {
  return {
    release() {},
    async execute(sql) {
      const statement = normalizeSql(sql)
      if (statement.includes('FROM catledger_user_identities')) return [[{ uid: UID }], []]
      if (statement.includes('FROM catledger_finance_updates')) {
        return [[{
          updateId: UPDATE_ID,
          status: 'posted',
          version: 1,
          planVersion: 'organizer-plan-v22',
          sourceCount: 1,
          validEvidenceCount: 1,
          duplicateEvidenceCount: 0,
          finalEventCount: 1,
          postedEventCount: 1,
          readyEventCount: 0,
          needsActionEventCount: 0,
          excludedEventCount: 0
        }], []]
      }
      if (statement.includes('COUNT(DISTINCT CASE WHEN links.creation_method')) {
        return [[{ createdCount: 1, reusedCount: 0, dependentCount: 0 }], []]
      }
      throw new Error(`unexpected SQL: ${statement}`)
    }
  }
}

test('A1-R4：撤销影响预览必须覆盖账户、映射、分类别名和关系副作用', async function () {
  const maintenance = createFinanceUpdateMaintenance({
    getPool: () => ({ getConnection: async () => undoImpactConnection() })
  })

  const impact = await maintenance.undoImpact({
    provider: 'wechat-mini',
    subjectHash: 'subject-a1-undo-impact',
    data: { updateId: UPDATE_ID }
  })

  assert.equal(typeof impact.sideEffectSummary, 'object')
  for (const key of ['accounts', 'accountMappings', 'categoryMappings', 'eventRelations']) {
    assert.ok(Object.prototype.hasOwnProperty.call(impact.sideEffectSummary, key), `missing ${key}`)
  }
})

test('A1-R5：多交易事件预览返回完整集合版本摘要并明确禁止局部修正', function () {
  const impact = correctionImpactResult({
    updateId: UPDATE_ID,
    eventId: EVENT_ID,
    status: 'posted',
    version: 3
  }, [
    {
      transactionId: TRANSACTION_ID,
      role: 'repayment_allocation',
      creationMethod: 'created',
      version: 2,
      deletedAt: null
    },
    {
      transactionId: SECOND_TRANSACTION_ID,
      role: 'repayment_allocation',
      creationMethod: 'created',
      version: 4,
      deletedAt: null
    }
  ])

  assert.equal(impact.canCorrect, false)
  assert.equal(impact.policyVersion, 'correction-policy-v1')
  assert.equal(typeof impact.expectedToken, 'string')
  assert.ok(impact.expectedToken.length > 0)
  assert.deepEqual(impact.transactionSet, [
    {
      transactionId: TRANSACTION_ID,
      role: 'repayment_allocation',
      creationMethod: 'created',
      transactionVersion: 2,
      deleted: false
    },
    {
      transactionId: SECOND_TRANSACTION_ID,
      role: 'repayment_allocation',
      creationMethod: 'created',
      transactionVersion: 4,
      deleted: false
    }
  ])
  assert.ok(impact.conflicts.some((conflict) => conflict.code === 'EVENT_REQUIRES_BATCH_UNDO'))
})
