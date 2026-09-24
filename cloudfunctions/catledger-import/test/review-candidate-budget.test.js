const test = require('node:test')
const assert = require('node:assert/strict')
const { buildReviewIssues } = require('../src/organizer-planner')

test('规则升级的已确认账户组去重保持成员顺序，读取次数有界', () => {
  const { buildConfirmedAccountIssues } = require('../src/organizer-planner')
  let reads = 0, next = 0
  const events = Array.from({ length: 1000 }, (_, n) => ({
    get eventId() { reads++; return 'event-' + n }, version: 1, reasonCodes: [], fieldSources: {},
    sourceType: 'wechat', paymentMethodKey: 'wallet', ledgerAccountId: 'account'
  }))
  const result = buildConfirmedAccountIssues('update', [...events, events[0]],
    [{ sourceType: 'wechat', paymentMethodKey: 'wallet', mappingAction: 'account', accountId: 'account' }], () => String(++next))
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].status, 'resolved')
  assert.equal(result.issues[0].memberCount, 1000)
  assert.deepEqual(result.members.map(m => m.objectId), Array.from({ length: 1000 }, (_, n) => 'event-' + n))
  assert.ok(reads <= 5000, 'confirmed account reads: ' + reads)
})

test('大账户组完整保留成员，关系读取次数随输入增长而非事件乘关系数', () => {
  const count = 1000
  let reads = 0, next = 0
  const events = Array.from({ length: count }, (_, n) => ({
    get eventId() { reads++; return 'event-' + n }, eventKey: 'key-' + n, version: 1,
    status: 'needs_action', economicNature: 'expense', reasonCodes: ['ledger_account_required'],
    accountGroupingKey: 'wallet', fieldSources: {}
  }))
  const relations = Array.from({ length: count }, (_, n) => ({
    relationId: 'relation-' + n, get sourceEventId() { reads++; return 'event-' + n },
    targetEventId: 'outside', relationType: 'refund_of', status: 'confirmed'
  }))
  const result = buildReviewIssues('update', events, relations, [], () => String(++next))
  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].memberCount, count)
  assert.equal(new Set(result.members.map(member => member.objectId)).size, count)
  assert.ok(reads <= 20 * count, 'candidate lookup budget: ' + reads)
})

const { buildRelations } = require('../src/relation-resolver')
test('不同金额多目标还款不做平方比较，同额候选仍取时间窗内首个后续事件', () => {
  let reads = 0, next = 0
  const events = Array.from({ length: 1000 }, (_, n) => ({
    eventId: 'movement-' + n, eventKey: 'key-' + n, economicNature: 'repayment', status: 'ready',
    currency: 'CNY', get amountMinor() { reads++; return String(n + 1) }, utcAt: '2026-09-01 00:00:00', reasonCodes: []
  }))
  assert.deepEqual(buildRelations('update', events, () => String(++next)), [])
  assert.ok(reads <= 10000, 'movement lookup budget: ' + reads)
  const item = (eventId, utcAt, extra = {}) => ({ eventId, eventKey: eventId, utcAt, status: 'ready',
    economicNature: 'repayment', amountMinor: '100', currency: 'CNY', reasonCodes: [], ...extra })
  const candidates = [item('a', '2026-09-01 00:00:00'), item('skip', '2026-09-01 00:00:00', { status: 'excluded' }),
    item('foreign', '2026-09-01 00:00:00', { currency: 'USD' }), item('b', '2026-09-01 00:00:00'),
    item('c', '2026-09-04 00:00:00'), item('late', '2026-09-07 00:00:01'), item('invalid', 'invalid')]
  assert.deepEqual(buildRelations('update', candidates, () => String(++next)).map(r => [r.sourceEventId,r.targetEventId]), [['a','b'],['b','c']])
})

test('账户组批量保存不保留全部序列化后的事件副本', async () => {
  const { saveEvents } = require('../src/review/event-store')
  let serialized = 0, saved = 0
  const pairs = Array.from({ length: 1000 }, (_, n) => ({ current: { eventId: 'event-' + n, version: 1 }, next: {
    eventId: 'event-' + n, status: 'needs_action', economicNature: 'unknown', currency: 'CNY', reasonCodes: [],
    fieldSources: { toJSON() { serialized++; return { synthetic: 'bounded save' } } }
  } }))
  const connection = { async execute(sql) {
    if (!sql.startsWith('UPDATE catledger_economic_events')) return [[]]
    assert.ok(serialized - saved <= 101, 'save serialization window: ' + (serialized - saved))
    const rows = (sql.split(' END')[0].match(/WHEN/g) || []).length
    saved += rows
    return [{ affectedRows: rows }]
  } }
  await saveEvents(connection, 'synthetic-user', 'synthetic-update', pairs, 'synthetic-action')
  assert.equal(saved, 1000)
})
