const test = require('node:test'), assert = require('node:assert/strict')
const { planLabelOf } = require('../cloudfunctions/catledger-import/src/installment-items')
const { runtime } = require('./helpers/read-runtime')
const event = value => ({ currentTarget: { dataset: value } })
const source = { itemId: 'source', accountId: 'credit', periodNumber: 12, totalTerms: 12, component: 'interest',
  amountMinor: '17600', occurredDate: '2026-08-31', updateId: 'update-a' }

test('计划名只取账单事实：本金摘要去期次，费用行只认人工或整理结论', () => {
  assert.equal(planLabelOf({ item: '电销总账分月12期第12期共12期' }, { component: 'principal' }), '电销总账分月12期')
  // 利息行摘要只有泛称，不能拿“分期付款利息”冒充计划名。
  assert.equal(planLabelOf({ item: '分期付款利息第12期共12期' }, { component: 'interest' }), null)
  const attribution = { installmentAttribution: { role: 'charge', planLabel: '电销总账分月12期' } }
  assert.equal(planLabelOf({ item: '分期付款利息第12期共12期', fieldSources: attribution }, { component: 'interest' }), '电销总账分月12期')
  // 人工归属优先于整理阶段的自动结论。
  const corrected = { ...attribution, editorOverrides: { version: 1, sourceCorrection: { planLabel: '电销现分按月收12期' } } }
  assert.equal(planLabelOf({ item: '分期付款利息第12期共12期', fieldSources: corrected }, { component: 'interest' }), '电销现分按月收12期')
  assert.equal(planLabelOf({ item: '' }, { component: 'principal' }), null)
  assert.equal(planLabelOf({ item: '分期' + 'x'.repeat(200) }, { component: 'principal' }).length, 120)
})

test('待补来源按本批读取，列表显示账单计划名而不是合同编号', async () => {
  const h = runtime(), p = h.page('installment-sources')
  h.respond = (action, data) => action === 'loans.installmentSources' ? { ok: true, data: {
    items: [{ ...source, planLabel: '电销总账分月12期', referenceLabel: 'SYNTHETIC-CONTRACT' }], nextCursor: null } } : undefined
  p.onLoad({ updateId: 'update-a' }); await p.load()
  const read = h.calls.filter(c => c.action === 'loans.installmentSources').at(-1)
  assert.equal(read.data.updateId, 'update-a')
  assert.equal(h.calls.some(c => c.action === 'loans.installmentSources' && c.data.accountId), false)
  assert.equal(p.data.items[0].name, '电销总账分月12期')
  assert.equal(p.data.items[0].label, '利息')
})

test('旧来源没有计划名时退回合同编号，仍没有才显示待确认；归入候选把同名计划排前', async () => {
  const h = runtime(), p = h.page('installment-sources')
  h.respond = action => action === 'loans.installmentSources' ? { ok: true, data: { items: [
    { ...source, itemId: 'legacy', planLabel: null, referenceLabel: 'SYNTHETIC-CONTRACT' },
    { ...source, itemId: 'plain', planLabel: null, referenceLabel: null }], nextCursor: null } }
    : action === 'loans.list' ? { ok: true, data: { items: [
      { loanId: 'other', name: '另一笔分期', kind: 'installment', scheduleTerms: 12, version: 1 },
      { loanId: 'same', name: '电销总账分月12期', kind: 'installment', scheduleTerms: 12, version: 1 }
    ], nextCursor: null } } : undefined
  p.onLoad({}); await p.load()
  assert.deepEqual(p.data.items.map(row => row.name), ['SYNTHETIC-CONTRACT', '待确认所属分期'])
  p.setData({ selected: { ...p.data.items[0], planLabel: '电销总账分月12期' }, choosing: true })
  await p.loadLoans()
  assert.deepEqual(p.data.loans.map(row => row.loanId), ['same', 'other'])
  assert.equal(p.data.loans[0].samePlan, true)
})

test('新建分期把账单计划名带进表单，合同编号只作退路', async () => {
  const h = runtime(), p = h.page('loan-form')
  h.accounts = [{ accountId: 'credit', type: 'credit', name: '合成卡', archived: false }]
  h.respond = action => action === 'loans.installmentSources' ? { ok: true, data: { items: [
    { ...source, component: 'principal', amountMinor: '200000', planLabel: '电销总账分月12期', referenceLabel: 'SYNTHETIC-CONTRACT' }], nextCursor: null } } : undefined
  p.onLoad({ sourceItemId: 'source' }); await p.load()
  assert.equal(p.data.name, '电销总账分月12期')
  assert.equal(p.data.sourceReady, true)
})
