const test = require('node:test')
const assert = require('node:assert/strict')
const { buildFinalDetail, presentAccountRows, presentFinalRecord } = require('../miniprogram/packages/finance/pages/import-workbench/final-detail')
const { record } = require('../miniprogram/packages/finance/pages/import-workbench/presentation')
const model = require('../miniprogram/packages/finance/pages/import-workbench/model')
const data = {
  events: [
    { eventId: 'a', status: 'ready', economicNature: 'expense', amountMinor: '100', categoryId: 'food', ledgerAccountId: 'wallet' },
    { eventId: 'b', status: 'ready', economicNature: 'income', amountMinor: '300', categoryId: null, ledgerAccountId: 'wallet', version: 2 },
    { eventId: 'c', status: 'ready', economicNature: 'repayment', amountMinor: '200', ledgerAccountId: 'wallet', counterpartyLedgerAccountId: 'credit', repaymentAllocations: [{ accountId: 'loan', amountMinor: '100' }] },
    { eventId: 'x', status: 'excluded', economicNature: 'income', amountMinor: '999', ledgerAccountId: 'excluded-account' }
  ], accounts: [{ accountId: 'wallet', name: '钱包', type: 'wallet' }, { accountId: 'credit', name: '信用卡', type: 'credit' }],
  accountDrafts: [{ accountId: 'loan', name: '贷款', type: 'other_liability' }],
  categories: [{ categoryId: 'food', name: '餐饮' }], issues: []
}
test('所有交易汇总弹窗集合与性质、分类及本次入账计数一致', () => {
  const expected = { expense: 1, income: 1, refund: 0, internal_transfer: 0, borrow: 0, repayment: 1,
    categorized: 1, uncategorized: 1, no_category: 1, all: 3 }
  for (const [kind, count] of Object.entries(expected)) {
    const sheet = buildFinalDetail(kind, data)
    assert.equal(sheet.count, count, kind)
    assert.equal(sheet.records.some(event => event.eventId === 'x'), false)
  }
  assert.equal(buildFinalDetail('invalid', data), null)
})
test('账户弹窗覆盖多目标还款账户，计数与汇总一致且可定位关联记录', () => {
  const affected = buildFinalDetail('affected_accounts', data)
  assert.equal(affected.count, model.finalSummary(data.events, data.accountDrafts).affectedAccountCount)
  assert.equal(affected.count, 3)
  assert.equal(buildFinalDetail('new_accounts', data).count, 1)
  assert.deepEqual(buildFinalDetail('account', data, 'loan').records.map(event => event.eventId), ['c'])
  assert.equal(buildFinalDetail('account', data, 'loan').title, '贷款')
})
test('受影响账户行保留笔数和类型，交易明细用目录里的账户名', () => {
  const rows = presentAccountRows([{ accountId: 'wallet', name: '微信零钱', type: 'wallet', count: 4 }])
  assert.equal(rows[0].count, 4)
  assert.equal(rows[0].typeLabel, '平台钱包')
  const named = buildFinalDetail('repayment', { ...data, accounts: data.accounts })
  assert.equal(named.records[0].accountText.includes('未命名账户'), false)
  assert.match(named.records[0].accountText, /钱包/)
})
test('已分类明细写出分类名，有上级时带上上级', () => {
  const plain = buildFinalDetail('categorized', data)
  assert.equal(plain.records[0].categoryName, '餐饮')
  const nested = buildFinalDetail('categorized', {
    ...data,
    events: [{ ...data.events[0], categoryName: '外卖', parentCategoryName: '餐饮' }]
  })
  assert.equal(nested.records[0].categoryName, '餐饮 / 外卖')
  assert.equal(record(nested.records[0]).categoryName, '餐饮 / 外卖')
})
test('未分类明细保留分类方向和版本，投影后仍能直接选择', () => {
  const row = buildFinalDetail('uncategorized', data).records[0]
  assert.equal(row.categoryKind, 'income')
  assert.equal(row.version, 2)
  const shown = presentFinalRecord(row)
  assert.equal(shown.categoryKind, 'income')
  assert.equal(shown.version, 2)
  assert.equal(buildFinalDetail('categorized', data).records[0].categoryKind, undefined)
})
test('重新投影可更新排除与分类决定，不改变已有数据', () => {
  const before = JSON.stringify(data)
  const next = { ...data, events: data.events.map(event => event.eventId === 'b' ? { ...event, categoryId: 'food' } : event) }
  assert.equal(buildFinalDetail('uncategorized', next).count, 0)
  assert.equal(buildFinalDetail('categorized', next).count, 2)
  assert.equal(JSON.stringify(data), before)
})
