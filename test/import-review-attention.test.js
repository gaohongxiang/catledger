const test = require('node:test')
const assert = require('node:assert/strict')
const { reviewAttention, VERSION } = require('../cloudfunctions/catledger-import/src/review-attention')
const presentation = require('../miniprogram/pages/import-workbench/presentation')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const issue = (id, type, reason, extra = {}) => ({ issueId: id, issueType: type, primaryReasonCode: reason,
  status: 'open', version: 2, blocking: true, memberCount: 1, candidateCount: 0, ...extra })
const event = extra => ({ eventId: 'synthetic-event', status: 'needs_action', version: 1, economicNature: 'unknown',
  ledgerAccountId: 'synthetic-card', sourceDirection: 'expense', amountMinor: '100', localAt: '2026-10-01 12:00:00.000',
  reasonCodes: [], ...extra })
const labels = result => result.reviewAttention.steps.map(step => step.label)
const tap = data => ({ currentTarget: { dataset: data } })

test('先判断同笔，再确认性质；已知缺口一次列全，入口与首项一致', () => {
  const row = event({ reasonCodes: ['economic_nature_required', 'same_event_candidate', 'ledger_account_required', 'category_required'] })
  const nature = issue('nature', 'shared_fields', 'economic_nature_required')
  const pair = issue('pair', 'same_event', 'bank_channel_same_event_candidate')
  const result = reviewAttention(row, [nature, pair])
  assert.equal(result.pendingIssue.issueId, 'pair')
  assert.equal(result.reviewAttention.issueId, 'pair')
  assert.deepEqual(labels(result), ['判断是否同一笔', '性质待确认', '资金账户待确认'])
  const card = presentation.pendingCard({ ...row, ...result }, false)
  assert.equal(card.label, '判断是否同一笔 · 性质待确认 · 资金账户待确认')
  assert.equal(card.batchDecision, '处理')
  assert.equal(card.issueId, 'pair')
})

for (const [reason, expected] of [['row_status_unknown', '账单状态待核对'], ['identity_conflict', '来源身份冲突待核对'],
  ['core_fields_conflict', '交易信息冲突待核对'], ['refund_source_conflict', '退款与原订单状态冲突']]) {
  test(reason + '优先于早创建的同笔问题', () => {
    const result = reviewAttention(event({ reasonCodes: [reason] }), [issue('old', 'same_event', 'same_event_candidate'), issue('new', 'shared_fields', reason)])
    assert.equal(result.pendingIssue.issueId, 'new'); assert.equal(labels(result)[0], expected)
  })
}

test('金额和时间是比对前提，未补齐时先处理基础信息', () => {
  const result = reviewAttention(event({ amountMinor: null, localAt: null, reasonCodes: ['core_fields_missing'] }),
    [issue('pair', 'same_event', 'same_event_candidate'), issue('basic', 'shared_fields', 'core_fields_missing')])
  assert.equal(result.pendingIssue.issueId, 'basic')
  assert.equal(labels(result)[0], '金额／时间待补齐')
})

test('缺判重所需账户时先补账户；账户具备后不固定账户优先', () => {
  const issues = [issue('pair', 'same_event', 'same_event_candidate'), issue('account', 'account_mapping', 'ledger_account_required')]
  assert.equal(reviewAttention(event({ ledgerAccountId: null }), issues).pendingIssue.issueId, 'account')
  assert.equal(reviewAttention(event(), issues).pendingIssue.issueId, 'pair')
})

for (const [direction, expected] of [['expense', '还入账户待确认'], ['income', '付款账户待确认']]) {
  test('还款账户标签跟随原账单方向：' + direction, () => {
    const row = event({ economicNature: 'repayment', sourceDirection: direction,
      reasonCodes: ['repayment_account_required', 'repayment_allocation_amount_mismatch', 'repayment_allocation_required'] })
    const result = reviewAttention(row, [issue('accounts', 'transfer_accounts', 'repayment_account_required')])
    assert.deepEqual(labels(result), [expected, '还款分配待补齐'])
    assert.equal(presentation.pendingCard({ ...row, ...result }, false).label, '还款｜' + expected + ' · 还款分配待补齐')
  })
}

test('未知性质、未确认本人归属时不提前称还入账户', () => {
  for (const row of [event({ reasonCodes: ['repayment_account_required'] }), event({ economicNature: 'repayment',
    repaymentOwnershipRequired: true, reasonCodes: ['repayment_ownership_required', 'repayment_account_required'] })]) {
    const result = reviewAttention(row, [issue('entry', 'transfer_accounts', row.reasonCodes[0])])
    assert.ok(!labels(result).some(label => label.includes('还入账户')))
  }
})

test('同组其他成员的错误码不能变成当前笔的待办；分类不计阻断', () => {
  const row = event({ economicNature: 'expense', reasonCodes: ['category_required'] })
  const result = reviewAttention(row, [issue('pair', 'same_event', 'same_event_candidate', {
    reasonCodes: ['repayment_allocation_required', 'refund_relation_required', 'row_status_unknown'] }),
    issue('category', 'category_assignment', 'category_required', { blocking: false })])
  assert.deepEqual(labels(result), ['判断是否同一笔'])
})

test('同优先级保留服务端稳定顺序，重复成员去重，排除关闭问题', () => {
  const older = issue('b', 'same_event', 'same_event_candidate')
  const newer = issue('a', 'same_event', 'same_event_candidate')
  const result = reviewAttention(event(), [issue('closed', 'shared_fields', 'row_status_unknown', { status: 'resolved' }), older, older, newer])
  assert.equal(result.pendingIssue.issueId, 'b')
  assert.equal(result.reviewAttention.steps.filter(step => step.key === 'same_event').length, 1)
})

test('已确定性质不是待办；确认后重算不保留已消失的性质和同笔事项', () => {
  const row = event({ economicNature: 'expense', reasonCodes: ['ledger_account_required'] })
  const result = reviewAttention(row, [issue('account', 'account_mapping', 'ledger_account_required')])
  const card = presentation.pendingCard({ ...row, ...result }, false)
  assert.equal(card.label, '支出｜付款账户待确认')
  assert.ok(!card.label.includes('性质待确认'))
})

test('分期本金只按来源处理，不伪造实际还款和强制计划待办', () => {
  const row = event({ economicNature: 'repayment', installment: { creditStatement: true, component: 'principal', periodNumber: 3 },
    reasonCodes: ['ledger_account_required', 'repayment_account_required', 'loan_repayment_required'] })
  const result = reviewAttention(row, [issue('account', 'account_mapping', 'ledger_account_required')])
  assert.deepEqual(labels(result), ['所属信用卡待确认'])
  assert.match(presentation.pendingCard({ ...row, ...result }, false).label, /^分期本金出账｜/)
})

test('仅有缺口而没有真实入口时不伪造 issueId；原数据不被修改', () => {
  const row = event({ reasonCodes: ['economic_nature_required', 'ledger_account_required'] }), before = JSON.stringify(row)
  const result = reviewAttention(row, [])
  assert.equal(result.pendingIssue, null); assert.equal(result.reviewAttention.issueId, null)
  assert.equal(presentation.pendingCard({ ...row, ...result }, false).issueId, '')
  assert.equal(JSON.stringify(row), before)
})

test('旧服务端和错配的提示摘要安全退回当前入口，未知性质只显示一次', () => {
  const row = event({ pendingIssue: issue('nature', 'shared_fields', 'economic_nature_required') })
  for (const attention of [undefined, { version: VERSION, issueId: 'other', steps: [{ key: 'accounts', label: '不应展示' }] }]) {
    const card = presentation.pendingCard({ ...row, reviewAttention: attention }, false)
    assert.equal(card.label, '性质待确认'); assert.equal(card.batchDecision, '处理'); assert.equal(card.issueId, 'nature')
  }
})

test('同组数移到左侧且只在连续组首行显示；原决定范围不变', () => {
  const rows = [1, 2].map(n => event({ eventId: 'e' + n, economicNature: 'expense', pendingIssue: issue('group', 'same_event', 'same_event_candidate', { memberCount: 29 }) }))
  const cards = presentation.linkGroupRows(rows.map(row => presentation.pendingCard(row, false)))
  assert.equal(cards[0].label, '支出｜判断是否同一笔（同组 29 笔）')
  assert.equal(cards[1].label, '支出｜判断是否同一笔')
  assert.ok(cards.every(card => card.groupCount === undefined && card.scopeCount === 29 && card.issueId === 'group'))
  assert.deepEqual(cards.map(card => card.groupPos), ['first', 'last'])
  assert.equal(presentation.pendingCard(rows[0], true).groupCount, 29)
})

test('真实 Page 的列表提示与处理按钮读取同一入口；刷新后进入下一项', async () => {
  const h = runtime(fixture(2)), page = h.page
  let pairing = true
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.list') return
    const rows = h.events.map(row => ({ ...row, economicNature: 'unknown', reasonCodes: ['economic_nature_required'] }))
    const items = rows.map(row => ({ ...row, ...reviewAttention(row, pairing ? [issue('nature', 'shared_fields', 'economic_nature_required'),
      issue('pair', 'same_event', 'same_event_candidate')] : [issue('nature', 'shared_fields', 'economic_nature_required')]) }))
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items, total: 2, nextCursor: null }
  }
  await page.setStep({ currentStep: 3 })
  let selected
  page.openIssue = ev => { selected = ev.currentTarget.dataset.id }
  let card = page.data.reviewGroups[0].issues[0]
  assert.match(card.label, /^判断是否同一笔 · 性质待确认/)
  page.openPendingRecord(tap({ id: card.eventId, issueId: card.issueId })); assert.equal(selected, 'pair')
  pairing = false
  h.summary = { ...h.summary, viewVersion: 'synthetic-updated-attention', update: { ...h.summary.update, version: 2 } }
  await page.applyUpdateView(h.summary, false, false, false, true); await flush()
  card = page.data.reviewGroups[0].issues[0]
  assert.equal(card.label, '性质待确认')
  page.openPendingRecord(tap({ id: card.eventId, issueId: card.issueId })); assert.equal(selected, 'nature')
  assert.ok(h.patches.every(bytes => bytes <= 65536))
  page.onUnload()
})

test('普通字段编辑不能冒充同笔处理入口', () => {
  const result = reviewAttention(event({ reasonCodes: ['same_event_candidate', 'economic_nature_required'] }),
    [issue('fields', 'shared_fields', 'legacy_unknown_reason'), issue('pair', 'same_event', 'same_event_candidate')])
  assert.equal(result.pendingIssue.issueId, 'pair')
  assert.equal(result.reviewAttention.steps[0].key, 'same_event')
})

test('五十笔长摘要与多项待核对同时出现，提示不截断且原生更新不超预算', async () => {
  const h = runtime(fixture(50, true))
  const reasons = ['row_status_unknown', 'source_profile_unknown', 'row_amount_invalid', 'identity_conflict', 'account_mapping_conflict',
    'core_fields_conflict', 'same_event_candidate', 'row_transaction_type_unknown', 'core_fields_missing', 'repayment_ownership_required',
    'repayment_account_required', 'payment_components_ambiguous', 'repayment_allocation_required', 'loan_repayment_required', 'installment_origin_required']
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.list') return
    const items = h.events.map(row => {
      const source = { ...row, eventId: row.eventId.padEnd(36, '0'), economicNature: 'repayment', reasonCodes: reasons,
        primaryEvidence: { sourceType: 'bank', item: '合成商品'.repeat(100), counterparty: '合成商户'.repeat(100) } }
      return { ...source, ...reviewAttention(source, [issue('synthetic-same-event'.padEnd(36, '0'), 'same_event', 'same_event_candidate', { memberCount: 50 })]) }
    })
    return { protocolVersion: 2, viewVersion: h.summary.viewVersion, items, total: 50, nextCursor: null }
  }
  await h.page.setStep({ currentStep: 3 })
  assert.equal(h.page.data.pageError, '')
  assert.equal(h.page.data.reviewGroups[0].issues.length, 50)
  assert.match(h.page.data.reviewGroups[0].issues[0].label, /分期来源／组成待确认/)
  assert.ok(h.patches.every(bytes => bytes <= 65536))
  assert.equal(h.page.businessData().events[0].primaryEvidence.item.length, 400)
  h.page.onUnload()
})
