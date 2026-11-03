const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')

const plain = value => JSON.parse(JSON.stringify(value))
const fullLabel = '合成银行信用卡(6106)', aliasLabel = '主卡6106'
const accountChoice = accountId => ({ decision: 'apply_fields', fields: { mappingAccountId: accountId } })

async function fixture() {
  const accounts = [fullLabel, '合成另一信用卡'].map(name => ({ accountId: randomUUID(), name,
    type: 'credit', nature: 'liability', currency: 'CNY', version: 1 }))
  const alipay = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    ...Array.from({ length: 2 }, (_, index) =>
      `2026-09-02 12:00:00,餐饮美食,合成商户,合成商品,2.00,支出,${fullLabel},交易成功,,SYNTHETIC-EXCLUSION-ALI-${index},,`)
  ].join('\n'))
  const value = await facts({ accounts, mapped: false,
    contents: [alipay, syntheticBill(3, 'SYNTHETIC-EXCLUSION-WX', aliasLabel)] })
  const issueIds = value.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => issue.issueId)
  const alias = value.issues.find(issue => issue.issueType === 'account_mapping' && issue.accountContext.label === aliasLabel)
  return { value, accounts, issueIds, aliasId: alias.issueId, eventId: alias.subjectEventIds[0],
    otherId: alias.subjectEventIds[1] }
}

function open(value, records = [], failure = {}) {
  return { records, session: sessions.create({ restored: { facts: value, records }, requestId: randomUUID,
    files: { save(changes) {
      if (failure.active) throw new Error('synthetic account write failure')
      records.push({ changes: plain(changes) })
    }, touch() {}, close() {} }, callNetwork() { assert.fail('本机确认不应联网') } }) }
}

function confirm(session, issueIds, accountId) {
  return session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(),
    groups: [{ issueIds, decision: accountChoice(accountId) }] })
}

function excludeOne(session, eventId) {
  const issue = [...session.model.issues.values()].find(row => row.issueType === 'category_assignment' && row.subjectEventIds.includes(eventId))
  assert.ok(issue, '使用解析产生的逐笔核对事项')
  session.call('reviewIssues.resolve', { requestId: randomUUID(), issueId: issue.issueId,
    decision: 'exclude_events', eventIds: [eventId] })
}

function ignore(session, issueId) {
  session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [
    { issueId, decision: 'exclude_events', fields: {} }
  ] })
}

function assertExcluded(session, eventId, accountId, reason = 'manual_exclusion') {
  const event = session.model.events.get(eventId)
  assert.equal(event.status, 'excluded')
  assert.ok(event.reasonCodes.includes(reason))
  assert.equal(event.ledgerAccountId, accountId, '归属可以更新，逐笔排除仍保留')
}

for (const target of ['same', 'different']) test('联合账户确认保留逐笔排除：' + target + ' 账户，当场、冷恢复与最终决定一致', async () => {
  const f = await fixture(), original = JSON.stringify(f.value), { session, records } = open(f.value)
  confirm(session, f.issueIds, f.accounts[0].accountId)
  excludeOne(session, f.eventId)
  const review = plain(session.model.finalState().decisions.reviews)
  const selected = f.accounts[target === 'same' ? 0 : 1].accountId
  confirm(session, f.issueIds, selected)
  assertExcluded(session, f.eventId, selected)
  assert.notEqual(session.model.events.get(f.otherId).status, 'excluded')
  assert.ok([...session.model.events.values()].every(event => event.ledgerAccountId === selected))
  const final = session.model.finalState()
  assert.deepEqual(final.decisions.reviews, review, '改归属不删除或伪造逐笔排除决定')
  assert.ok(final.decisions.accounts.every(choice => choice.fields.mappingAccountId === selected))
  const restored = open(f.value, records).session
  assertExcluded(restored, f.eventId, selected)
  assert.notEqual(restored.model.events.get(f.otherId).status, 'excluded')
  assert.deepEqual(restored.model.finalState(), final)
  assert.equal(restored.model.invalid.size, 0)
  assert.equal(JSON.stringify(f.value), original)
})

test('逐笔排除后整卡忽略再恢复，只恢复整卡决定，不恢复独立排除的一笔', async () => {
  const f = await fixture(), { session, records } = open(f.value)
  confirm(session, f.issueIds, f.accounts[0].accountId)
  excludeOne(session, f.eventId)
  ignore(session, f.aliasId)
  assert.equal(session.model.events.get(f.otherId).status, 'excluded')
  confirm(session, f.issueIds, f.accounts[1].accountId)
  assertExcluded(session, f.eventId, f.accounts[1].accountId)
  assert.equal(session.model.events.get(f.eventId).reasonCodes.includes('account_mapping_excluded'), false)
  assert.notEqual(session.model.events.get(f.otherId).status, 'excluded')
  assert.equal(session.model.events.get(f.otherId).reasonCodes.includes('manual_exclusion'), false)
  const restored = open(f.value, records).session
  assertExcluded(restored, f.eventId, f.accounts[1].accountId)
  assert.notEqual(restored.model.events.get(f.otherId).status, 'excluded')
  assert.deepEqual(restored.model.finalState(), session.model.finalState())
})

test('没有逐笔排除的整卡忽略仍可恢复，不能把旧账户排除误当独立排除', async () => {
  const f = await fixture(), { session, records } = open(f.value)
  confirm(session, f.issueIds, f.accounts[0].accountId)
  ignore(session, f.aliasId)
  confirm(session, f.issueIds, f.accounts[1].accountId)
  assert.ok([...session.model.events.values()].every(event => event.status !== 'excluded' &&
    !event.reasonCodes.includes('manual_exclusion') && !event.reasonCodes.includes('account_mapping_excluded')))
  assert.equal(session.model.finalState().decisions.reviews.length, 0)
  const restored = open(f.value, records).session
  assert.ok([...restored.model.events.values()].every(event => event.status !== 'excluded'))
  assert.deepEqual(restored.model.finalState(), session.model.finalState())
})

test('联合归属落盘失败恢复原账户和逐笔排除，重试与冷恢复不泄漏失败选择', async () => {
  const f = await fixture(), failure = {}, { session, records } = open(f.value, [], failure)
  confirm(session, f.issueIds, f.accounts[0].accountId)
  excludeOne(session, f.eventId)
  const final = plain(session.model.finalState()), count = records.length
  failure.active = true
  assert.throws(() => confirm(session, f.issueIds, f.accounts[1].accountId), /synthetic account write failure/)
  assert.equal(records.length, count)
  assertExcluded(session, f.eventId, f.accounts[0].accountId)
  assert.deepEqual(session.model.finalState(), final)
  assertExcluded(open(f.value, records).session, f.eventId, f.accounts[0].accountId)
  failure.active = false
  confirm(session, f.issueIds, f.accounts[1].accountId)
  assertExcluded(session, f.eventId, f.accounts[1].accountId)
  assertExcluded(open(f.value, records).session, f.eventId, f.accounts[1].accountId)
})

