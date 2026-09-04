const assert = require('node:assert/strict')
const test = require('node:test')

const { digestParts } = require('../src/digest')
const { buildPaymentMethodKey } = require('../src/identity')

const {
  publicUpdate,
  publicIssue,
  restoreDraftPaymentMappings,
  selectPaymentMappings,
  selectDraftPaymentMappings,
  selectEventEvidence
} = require('../src/finance-update-repository')

test('服务端公开未入账计划是否过期，客户端无需知道规则版本', function () {
  const update = publicUpdate({
    updateId: 'update-1', status: 'review', version: 3, planVersion: 'organizer-plan-v17',
    sourceCount: 1, validEvidenceCount: 1, duplicateEvidenceCount: 0, finalEventCount: 1,
    postedEventCount: 0, readyEventCount: 1, needsActionEventCount: 0, excludedEventCount: 0
  })
  assert.equal(update.requiresReorganization, true)
})

test('映射仓储返回全部候选，不按数据库结果顺序提前覆盖领域裁决', async function () {
  let call = 0
  const connection = {
    execute: async function () {
      call += 1
      return call === 1
        ? [[{
            sourceType: 'wechat', paymentMethodKey: 'card', paymentMethodHint: '光大银行信用卡(2690)',
            mappingAction: 'account', accountId: 'history-account', accountType: 'credit', mappingScope: 'history'
          }]]
        : [[{
            sourceType: 'wechat', paymentMethodKey: 'card', paymentMethodHint: '光大银行信用卡(2690)',
            mappingAction: 'account', accountId: 'batch-account', accountType: 'credit', mappingScope: 'batch'
          }]]
    }
  }

  const mappings = await selectPaymentMappings(connection, 'user-1', 'update-1')
  assert.deepEqual(mappings.map((mapping) => mapping.mappingScope), ['history', 'history_alias', 'batch'])
})

test('旧原文支付键保留原事实并派生低优先级规范别名', async function () {
  let call = 0
  const label = '支付宝小荷包(合成小荷包)'
  const legacyKey = digestParts('payment-method-v1', 'alipay', label)
  const currentKey = buildPaymentMethodKey('alipay', label)
  assert.notEqual(legacyKey, currentKey)
  const connection = {
    execute: async function () {
      call += 1
      return call === 1 ? [[{
        sourceType: 'alipay', paymentMethodKey: legacyKey, paymentMethodHint: label,
        mappingAction: 'ignore', accountId: null, accountType: null, mappingScope: 'history'
      }]] : [[]]
    }
  }

  const mappings = await selectPaymentMappings(connection, 'user-1', 'update-1')
  assert.deepEqual(mappings.map((mapping) => ({
    key: mapping.paymentMethodKey,
    scope: mapping.mappingScope,
    action: mapping.mappingAction
  })), [
    { key: legacyKey, scope: 'history', action: 'ignore' },
    { key: currentKey, scope: 'history_alias', action: 'ignore' }
  ])
})

test('账户问题列表返回安全且可读的支付账户标题', function () {
  const issue = publicIssue({
    issueId: 'issue-1', issueType: 'account_mapping', status: 'open', version: 1,
    blocking: 1, primaryReasonCode: 'ledger_account_required', memberCount: 3,
    candidateCount: 0, reasonCodes: '[]', subjectEventId: 'event-1',
    subjectEventStatus: 'needs_action', subjectFlowDirection: 'outflow',
    subjectEconomicNature: 'expense', subjectLedgerAccountId: 'account-1',
    subjectLocalAt: '2026-08-01 12:00:00.000', subjectAmountMinor: '1234', subjectCurrency: 'CNY',
    subjectSourceType: 'wechat', subjectPaymentMethod: '招商银行储蓄卡(6225881234567890)',
    subjectFileName: '微信账单.csv', subjectItem: '午餐', subjectCounterparty: '商户', subjectNote: '工作日午餐'
  })
  assert.equal(issue.accountContext.label, '招商银行储蓄卡(****7890)')
  assert.equal(issue.accountContext.sourceType, 'wechat')
  assert.equal(issue.accountContext.defaultIgnored, false)
  assert.doesNotMatch(issue.accountContext.label, /6225881234567890/)
  assert.deepEqual(issue.subject, {
    eventId: 'event-1', status: 'needs_action', flowDirection: 'outflow', economicNature: 'expense',
    ledgerAccountId: 'account-1', counterpartyLedgerAccountId: null, fundsProjection: null,
    repaymentAllocations: [],
    localAt: '2026-08-01 12:00:00.000', amountMinor: '1234', currency: 'CNY',
    primaryEvidence: {
      sourceType: 'wechat', fileName: '微信账单.csv', counterparty: '商户', item: '午餐',
      note: '', paymentMethod: '招商银行储蓄卡(****7890)'
    }
  })
})

test('已保存的忽略规则公开为可覆盖的默认状态', function () {
  const issue = publicIssue({
    issueId: 'issue-2', issueType: 'account_mapping', status: 'open', version: 1,
    blocking: 1, primaryReasonCode: 'ledger_account_required', memberCount: 1,
    candidateCount: 0, reasonCodes: '["source_account_ignored_default"]', subjectEventId: 'event-2',
    subjectEventStatus: 'needs_action', subjectFlowDirection: 'outflow',
    subjectEconomicNature: 'expense', subjectLedgerAccountId: null,
    subjectLocalAt: '2026-08-02 12:00:00.000', subjectAmountMinor: '500', subjectCurrency: 'CNY',
    subjectSourceType: 'alipay', subjectPaymentMethod: '账户余额', subjectFileName: '支付宝.csv',
    subjectItem: '消费', subjectCounterparty: '商户'
  })
  assert.equal(issue.accountContext.defaultIgnored, true)
})

test('派生单端引用覆盖原始斜杠账户展示', function () {
  const paymentMethodKey = buildPaymentMethodKey('wechat', '零钱')
  const issue = publicIssue({
    issueId: 'issue-derived', issueType: 'account_mapping', status: 'resolved', version: 1,
    blocking: 0, primaryReasonCode: 'account_mapping_confirmed', memberCount: 1,
    candidateCount: 0, reasonCodes: '[]', subjectEventId: 'event-derived',
    subjectMemberRole: 'subject', subjectEventStatus: 'ready', subjectFlowDirection: 'inflow',
    subjectEconomicNature: 'income', subjectLedgerAccountId: 'account-change',
    subjectFieldSources: JSON.stringify({ ledgerAccountReference: {
      sourceType: 'wechat', paymentMethodKey, label: '微信零钱', recognized: true,
      role: 'ledger_account', inferenceRule: 'wechat_income_deposited_to_change'
    } }),
    subjectLocalAt: '2026-08-01 12:00:00.000', subjectAmountMinor: '450', subjectCurrency: 'CNY',
    subjectSourceType: 'wechat', subjectPaymentMethod: '/', subjectFileName: '微信账单.xlsx',
    subjectItem: '转账', subjectCounterparty: '合成对方'
  })
  assert.equal(issue.accountContext.label, '微信零钱')
  assert.equal(issue.accountContext.paymentMethodKey, paymentMethodKey)
  assert.equal(issue.accountContext.recognized, true)
})

test('资金流转问题使用真正缺失端作为账户上下文', function () {
  const issue = publicIssue({
    issueId: 'issue-3', issueType: 'transfer_accounts', status: 'open', version: 1,
    blocking: 1, primaryReasonCode: 'transfer_account_required', memberCount: 1,
    candidateCount: 0, reasonCodes: '[]', subjectEventId: 'event-3',
    subjectEventStatus: 'needs_action', subjectFlowDirection: 'neutral',
    subjectEconomicNature: 'internal_transfer', subjectLedgerAccountId: 'balance-account',
    subjectCounterpartyLedgerAccountId: null,
    subjectFieldSources: JSON.stringify({
      fundsProjection: {
        from: { sourceType: 'alipay', paymentMethodKey: 'from-key', label: '支付宝账户余额' },
        to: { sourceType: 'alipay', paymentMethodKey: 'to-key', label: '浙江农商联合银行' }
      }
    }),
    subjectLocalAt: '2026-07-06 13:50:00.000', subjectAmountMinor: '49857', subjectCurrency: 'CNY',
    subjectSourceType: 'alipay', subjectPaymentMethod: '浙江农商联合银行', subjectFileName: '支付宝.csv',
    subjectItem: '提现', subjectCounterparty: ''
  })
  assert.equal(issue.accountContext.label, '浙江农商联合银行')
  assert.equal(issue.subject.counterpartyLedgerAccountId, null)
  assert.equal(issue.subject.fundsProjection.from.label, '支付宝账户余额')
})

test('账户步骤展示支付账户本身，不误显示资金流转的另一端', function () {
  const issue = publicIssue({
    issueId: 'issue-4', issueType: 'account_mapping', status: 'resolved', version: 1,
    blocking: 0, primaryReasonCode: 'account_mapping_confirmed', memberCount: 1,
    candidateCount: 0, reasonCodes: '["account_mapping_confirmed"]', subjectEventId: 'event-4',
    subjectEventStatus: 'needs_action', subjectFlowDirection: 'neutral',
    subjectEconomicNature: 'internal_transfer', subjectLedgerAccountId: 'balance-account',
    subjectCounterpartyLedgerAccountId: null,
    subjectFieldSources: JSON.stringify({
      fundsProjection: {
        from: { sourceType: 'alipay', paymentMethodKey: 'from-key', label: '支付宝账户余额' },
        to: { sourceType: 'alipay', paymentMethodKey: 'to-key', label: '浙江农商联合银行' }
      }
    }),
    subjectLocalAt: '2026-07-06 13:50:00.000', subjectAmountMinor: '49857', subjectCurrency: 'CNY',
    subjectSourceType: 'alipay', subjectPaymentMethod: '余额', subjectFileName: '支付宝.csv',
    subjectItem: '提现-实时提现', subjectCounterparty: '浙江农商联合银行'
  })
  assert.equal(issue.accountContext.label, '支付宝账户余额')
  assert.equal(issue.accountContext.sourceType, 'alipay')
})

test('账户步骤按成员资金端展示映射引用，不按原始支付方式猜方向', function () {
  const issue = publicIssue({
    issueId: 'issue-5', issueType: 'account_mapping', status: 'open', version: 1,
    blocking: 1, primaryReasonCode: 'payment_reference_mapping_required', memberCount: 1,
    candidateCount: 0, reasonCodes: '[]', subjectEventId: 'event-5',
    subjectMemberRole: 'mapping_from', subjectEventStatus: 'needs_action',
    subjectFlowDirection: 'neutral', subjectEconomicNature: 'internal_transfer',
    subjectLedgerAccountId: null, subjectCounterpartyLedgerAccountId: null,
    subjectFieldSources: JSON.stringify({
      fundsProjection: {
        from: { sourceType: 'wechat', paymentMethodKey: 'change-key', label: '微信零钱' },
        to: { sourceType: 'wechat', paymentMethodKey: 'bank-key', label: '浙江农商联合银行储蓄卡(5564)' }
      }
    }),
    subjectLocalAt: '2026-07-08 16:26:00.000', subjectAmountMinor: '1001', subjectCurrency: 'CNY',
    subjectSourceType: 'wechat', subjectPaymentMethod: '浙江农商联合银行储蓄卡(5564)',
    subjectFileName: '微信支付账单.xlsx', subjectItem: '/', subjectCounterparty: '浙江农商联合银行(5564)'
  })

  assert.equal(issue.accountContext.label, '微信零钱')
  assert.equal(issue.accountContext.paymentMethodKey, 'change-key')
  assert.equal(issue.accountContext.fundsSide, 'from')
  assert.equal(issue.accountContext.accountId, null)
})

test('原始证据读取先校验用户事件归属并返回不可变字段', async function () {
  const calls = []
  const connection = {
    execute: async function (sql, values) {
      calls.push({ sql, values })
      if (calls.length === 1) return [[{ eventId: 'event-1', updateId: 'update-1' }]]
      return [[{
        evidenceId: 'evidence-1', evidenceRole: 'primary', rowId: 'row-1', rowNumber: 7,
        sourceLocator: 'csv:7', rawFields: '{"交易类型":"提现","金额":"498.57"}',
        rawSnapshotVersion: 'raw-v1', parserVersion: 'alipay-v1', sourceType: 'alipay', fileName: '支付宝.csv'
      }]]
    }
  }
  const result = await selectEventEvidence(connection, 'user-1', 'event-1')
  assert.equal(result.updateId, 'update-1')
  assert.deepEqual(result.evidence[0].rawFields, { 交易类型: '提现', 金额: '498.57' })
  assert.deepEqual(calls[0].values, ['user-1', 'event-1'])
  assert.deepEqual(calls[1].values, ['user-1', 'update-1', 'event-1'])
})

test('旧规划重建前冻结每个支付工具最新的本批映射决定', async function () {
  const connection = {
    execute: async function () {
      return [[
        { sourceType: 'alipay', paymentMethodKey: 'balance', paymentMethodHint: '余额', mappingAction: 'account', accountId: 'old' },
        { sourceType: 'wechat', paymentMethodKey: 'change', paymentMethodHint: '零钱', mappingAction: 'account', accountId: 'wechat' },
        { sourceType: 'alipay', paymentMethodKey: 'balance', paymentMethodHint: '账户余额', mappingAction: 'account', accountId: 'current' }
      ]]
    }
  }
  const mappings = await selectDraftPaymentMappings(connection, 'user-1', 'update-1')
  assert.deepEqual(mappings.map((mapping) => mapping.accountId).sort(), ['current', 'wechat'])
})

test('旧规划重建后把本批映射重新绑定到新事件', async function () {
  const inserts = []
  const connection = {
    execute: async function (sql, values) {
      inserts.push({ sql, values })
      return [{ affectedRows: 1 }]
    }
  }
  await restoreDraftPaymentMappings(connection, 'user-1', 'update-1', [{
    eventId: 'event-new', sourceType: 'wechat', paymentMethodKey: 'change',
    fieldSources: { fundsProjection: {
      from: { sourceType: 'wechat', paymentMethodKey: 'change', label: '微信零钱' },
      to: { sourceType: 'wechat', paymentMethodKey: null, label: '兴业银行信用卡' }
    } }
  }], [{
    sourceType: 'wechat', paymentMethodKey: 'change', paymentMethodHint: '零钱',
    mappingAction: 'account', accountId: 'wechat-account'
  }], 'action-1')
  assert.equal(inserts.length, 1)
  assert.match(inserts[0].sql, /catledger_finance_update_account_mapping_drafts/)
  assert.deepEqual(inserts[0].values.slice(2), [
    'update-1', 'event-new', 'wechat', 'change', '零钱', 'account', 'wechat-account', 'action-1'
  ])
})
