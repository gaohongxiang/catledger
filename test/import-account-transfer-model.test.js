const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const models = require('../miniprogram/packages/finance/services/import-local-model')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')
const clone = value => JSON.parse(JSON.stringify(value))

async function fixture(count = 1) {
  const accounts = ['wallet', 'other_asset', 'wallet', 'other_asset'].map((type, index) => ({
    accountId: randomUUID(), name: '合成端点账户' + index, type, nature: 'asset', currency: 'CNY', version: 1
  }))
  const content = Buffer.from([
    '支付宝(中国)网络技术有限公司 电子客户回单',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    ...Array.from({ length: count }, (_, index) =>
      `2026-09-0${index + 1} 12:00:00,投资理财,余额宝,余额宝-自动转入,${index + 1}.00,不计收支,账户余额,交易成功,,SYNTHETIC-ENDPOINT-${index},,`)
  ].join('\n'))
  const value = await facts({ content, accounts, mapped: false })
  if (count > 1) {
    // 合成旧快照的独立确认范围：同一引用的两笔事件分属不同事项，原引用保持不变。
    const issues = [], members = []
    for (const issue of value.issues) {
      const original = value.members.filter(member => member.issueId === issue.issueId)
      for (const member of original) {
        const issueId = randomUUID()
        issues.push({ ...clone(issue), issueId, memberCount: 1, subjectEventIds: [member.objectId] })
        members.push({ ...member, memberId: randomUUID(), issueId })
      }
    }
    value.issues = issues; value.members = members
  }
  return value
}
function decision(value, eventId, side, accountId) {
  const member = value.members.find(item => item.objectId === eventId && item.memberRole === 'mapping_' + side)
  assert.ok(member)
  return { issueId: member.issueId, decision: 'apply_fields', fields: { mappingAccountId: accountId } }
}
function assertTransfer(model, eventId, from, to) {
  const event = model.events.get(eventId)
  assert.equal(event.ledgerAccountId, from)
  assert.equal(event.counterpartyLedgerAccountId, to)
  assert.equal(event.economicNature, 'internal_transfer')
  assert.equal(event.status, 'ready', event.reasonCodes.join(','))
}
function open(value, records = [], failure = {}) {
  return { records, session: sessions.create({ restored: { facts: value, records }, requestId: randomUUID,
    files: { save(changes) { if (failure.active) throw new Error('synthetic write failure'); records.push({ changes: clone(changes) }) }, touch() {}, close() {} },
    callNetwork() { assert.fail('账户确认不得联网') } }) }
}

test('本机端点确认只作用于当前事件，不把相同引用的独立事项变成共同绑定', async () => {
  const value = await fixture(2), model = models.create(value), [a, b] = value.events.map(event => event.eventId)
  const ids = value.accounts.map(account => account.accountId), before = JSON.stringify(value)
  for (const [eventId, from, to] of [[a, ids[0], ids[1]], [b, ids[2], ids[3]]]) {
    model.mapAccount(decision(value, eventId, 'from', from))
    model.mapAccount(decision(value, eventId, 'to', to))
  }
  model.mapAccount(decision(value, a, 'to', ids[1]))
  assertTransfer(model, a, ids[0], ids[1])
  assertTransfer(model, b, ids[2], ids[3])
  assert.equal(JSON.stringify(value), before)
})

test('端点落盘失败恢复先前选择，未保存的另一端不能泄漏到重试和冷启动', async () => {
  const value = await fixture(), eventId = value.events[0].eventId, ids = value.accounts.map(account => account.accountId)
  const failure = {}, { session, records } = open(value, [], failure)
  const apply = item => session.call('reviewIssues.resolve', { ...item, requestId: randomUUID() })
  apply(decision(value, eventId, 'from', ids[0]))
  failure.active = true
  assert.throws(() => apply(decision(value, eventId, 'to', ids[1])), /synthetic write failure/)
  assert.equal(records.length, 1)
  assert.equal(session.model.events.get(eventId).ledgerAccountId, ids[0])
  assert.equal(session.model.events.get(eventId).counterpartyLedgerAccountId, null)
  failure.active = false
  apply(decision(value, eventId, 'from', ids[2]))
  assert.equal(session.model.events.get(eventId).counterpartyLedgerAccountId, null, '失败决定不能留在内存映射里')
  apply(decision(value, eventId, 'to', ids[1]))
  assertTransfer(session.model, eventId, ids[2], ids[1])
  const restored = open(value, records).session
  assert.equal(restored.model.invalid.size, 0)
  assertTransfer(restored.model, eventId, ids[2], ids[1])
})

test('补充目录使已选账户不可用后仍需重新选择，不能借另一端确认沿用旧合法性', async () => {
  const value = await fixture(), model = models.create(value), eventId = value.events[0].eventId
  const ids = value.accounts.map(account => account.accountId)
  model.mapAccount(decision(value, eventId, 'from', ids[0]))
  model.applySupplement({ accounts: value.accounts.map((account, index) => index === 0
    ? { ...account, archivedAt: '2026-09-02 00:00:00' } : account), categories: value.categories,
    history: [], historyCoverage: value.historyCoverage, issues: [], members: [], problems: [], loans: [], contracts: [], charges: [] })
  assert.throws(() => model.mapAccount(decision(value, eventId, 'to', ids[1])), { code: 'LOCAL_RECHECK_REQUIRED' })
  assert.equal(model.events.get(eventId).counterpartyLedgerAccountId, null)
  model.mapAccount(decision(value, eventId, 'from', ids[2]))
  model.mapAccount(decision(value, eventId, 'to', ids[1]))
  assertTransfer(model, eventId, ids[2], ids[1])
})

test('修改交易中明确选择的账户仍受手工字段保护，后续映射另一端不覆盖它', async () => {
  const value = await fixture(), model = models.create(value), eventId = value.events[0].eventId
  const ids = value.accounts.map(account => account.accountId)
  model.mapAccount(decision(value, eventId, 'from', ids[0]))
  model.edit({ eventId, editorVersion: 1, fields: { ledgerAccountId: ids[2] } })
  model.mapAccount(decision(value, eventId, 'to', ids[1]))
  assertTransfer(model, eventId, ids[2], ids[1])
})

test('排除后重新确认当前端仍保留另一端，改为外部后也不会恢复成双方本人', async () => {
  const value = await fixture(), model = models.create(value), eventId = value.events[0].eventId
  const ids = value.accounts.map(account => account.accountId), from = decision(value, eventId, 'from', ids[0])
  model.mapAccount(from)
  model.mapAccount(decision(value, eventId, 'to', ids[1]))
  model.mapAccount({ issueId: from.issueId, decision: 'exclude_events', fields: {} })
  assert.equal(model.events.get(eventId).status, 'excluded')
  model.mapAccount(decision(value, eventId, 'from', ids[2]))
  assertTransfer(model, eventId, ids[2], ids[1])
  model.mapAccount({ issueId: from.issueId, decision: 'apply_fields', paymentRuleAction: 'external', fields: {} })
  model.mapAccount(decision(value, eventId, 'to', ids[3]))
  const event = model.events.get(eventId)
  assert.equal(event.economicNature, 'income')
  assert.equal(event.ledgerAccountId, ids[3])
  assert.equal(event.counterpartyLedgerAccountId, null)
})
