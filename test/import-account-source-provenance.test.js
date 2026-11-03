const test = require('node:test')
const assert = require('node:assert/strict')
const { accountGroupCountsFacts } = require('./helpers/account-group-counts')
const local = require('../miniprogram/packages/finance/services/import-local-model')
const confirmations = require('../miniprogram/packages/finance/services/import-account-confirmations')
const accountSources = require('../miniprogram/packages/finance/services/import-account-sources')
const snapshot = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const plain = value => JSON.parse(JSON.stringify(value))

async function paired() {
  const fixture = await accountGroupCountsFacts(), { value, credit, wechat, alipay } = fixture
  const model = local.create(value)
  for (const issue of model.issues.values()) if (issue.issueType === 'account_mapping') {
    model.mapAccount({ issueId: issue.issueId, decision: 'apply_fields', fields: { mappingAccountId:
      /零钱/.test(issue.accountContext.label) ? wechat.accountId : /余额/.test(issue.accountContext.label)
        ? alipay.accountId : credit.accountId } })
  }
  for (const event of [...model.events.values()]) if (event.economicNature === 'repayment' && event.sourceType !== 'bank') {
    model.edit({ eventId: event.eventId, editorVersion: 1, fields: { counterpartyLedgerAccountId: credit.accountId } })
  }
  let count = 0
  while (model.pairs.size && count < 40) {
    model.pair({ pairKey: model.pairs.keys().next().value, decision: 'same', repaymentConfirmed: true }); count++
  }
  assert.equal(count, 31)
  assert.equal(model.events.size, 40)
  return { ...fixture, model }
}

function accountEntries(model) {
  return confirmations.buildIndex(model, [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping'))
}

function assertSources(model, credit) {
  const index = accountEntries(model), entries = [...index.entries.values()].filter(entry => entry.accountId === credit.accountId)
  assert.deepEqual(entries.map(entry => new Set(entry.members.map(member => member.eventId)).size).sort((a, b) => b - a), [40, 29])
  for (const entry of entries) {
    assert.equal(new Set(entry.members.map(member => member.sourceId)).size, 1)
    assert.deepEqual([...new Set(entry.members.map(member => member.sourceType))], [/主卡/.test(entry.label) ? 'bank' : 'wechat'])
  }
  const group = index.groups.find(group => group.accountId === credit.accountId)
  assert.equal(group.memberCount, 40)
  assert.equal(group.sourceCount, 2)
  assert.deepEqual(Object.fromEntries(group.sources.map(source => [source.sourceType, source.count])), { bank: 40, wechat: 29 })
}

test('配对后账户来源来自原成员，银行信用卡不吸入微信零钱或支付宝余额还款凭据', async () => {
  const { model, credit, value } = await paired(), before = plain(model.finalState())
  assertSources(model, credit)
  assert.equal(model.evidence.size, 71)
  assert.deepEqual(model.finalState(), before)
  assert.equal(value.events.length, 71, '配对前快照与原成员仍保持不变')
})

test('已配对快照编码并重新建模：仅凭持久mergeOrigins和引用仍保留账户原来源', async () => {
  const { model, credit, value } = await paired()
  // Persisted server facts already point members at the merged events. There is
  // no pre-pair local member map or local pairing log to recover provenance from.
  const saved = plain({ ...value, events: [...model.events.values()], issues: [...model.issues.values()],
    members: [...model.members.values()].flat(), evidence: [...model.evidence.values()], relations: [...model.relations.values()] })
  assert.equal(saved.events.length, 40)
  assert.ok(saved.events.some(event => event.fieldSources.mergeOrigins?.length))
  const restored = local.create(snapshot.decode(snapshot.encode(saved)))
  assert.equal(restored.choices.pairings.size, 0)
  assertSources(restored, credit)
  assert.equal(restored.evidence.size, 71)
  assertSources(local.create(snapshot.decode(snapshot.encode(plain(saved)))), credit)
})

function projectionFixture({ legacy = false, missingReferences = false, missingMemberId = false } = {}) {
  // A source-only projection fixture has no amounts, account choices or financial
  // rules: two persisted same-platform origins must not be matched by their name.
  const reference = index => ({ sourceType: 'wechat', paymentMethodKey: legacy ? 'legacy-shared-key' : 'payment-' + index,
    ...(legacy ? {} : { bindingKey: 'scope-' + index, accountIdentityKey: 'account-reference-v3:scope-' + index }) })
  const refs = [reference(0), reference(1)], rows = refs.map((_, index) => ({ rowId: 'row-' + index,
    batchId: 'batch-' + index, sourceType: 'wechat' }))
  const origins = refs.map((ref, index) => ({ rowIds: [rows[index].rowId], event: { eventId: 'original-' + index,
    fieldSources: { rowIds: [rows[index].rowId], ...(missingReferences ? {} : { ledgerAccountReference: ref }) } } }))
  const event = { eventId: 'merged', fieldSources: { rowIds: rows.map(row => row.rowId), mergeOrigins: origins,
    ledgerAccountReference: refs[0], bankChannelAccountContexts: { second: refs[1] } } }
  const members = refs.map((_, index) => ({ ...(missingMemberId ? {} : { memberId: 'member-' + index }),
    issueId: index ? 'second' : 'first', objectType: 'event', objectId: event.eventId, memberRole: 'subject' }))
  const evidence = rows.map(row => ({ eventId: event.eventId, rowId: row.rowId, evidenceRole: 'supporting' }))
  const model = { facts: { events: [event], members, evidence, sources: rows.map((row, index) => ({ batchId: row.batchId,
    sourceId: 'source-' + index, sourceType: 'wechat', fileName: '合成来源' + index + '.csv' })) },
    rows: new Map(rows.map(row => [row.rowId, row])), evidenceFor: () => evidence }
  return { model, event, members, refs }
}

test('已合并同平台多文件按精确引用定位，各原卡不认领另一文件', () => {
  const { model, event, members, refs } = projectionFixture(), sourceFor = accountSources.create(model)
  for (let index = 0; index < 2; index++) assert.deepEqual(sourceFor(members[index], event, refs[index]),
    [{ sourceId: 'source-' + index, sourceType: 'wechat', fileName: '合成来源' + index + '.csv' }])
})

test('旧来源缺精确引用或同平台多个文件只有相同旧付款键，保留平台但不冒认文件', () => {
  for (const options of [{ missingReferences: true }, { legacy: true }]) {
    const { model, event, members, refs } = projectionFixture(options), sourceFor = accountSources.create(model)
    assert.deepEqual(sourceFor(members[0], event, refs[0]), [{ sourceId: '', sourceType: 'wechat', fileName: '' }])
  }
})

test('缺memberId不命中另一原成员，仍按当前精确引用定位', () => {
  const { model, event, members, refs } = projectionFixture({ missingMemberId: true })
  model.facts.events = event.fieldSources.mergeOrigins.map(origin => origin.event)
  model.facts.members = members.map((member, index) => ({ ...member, issueId: 'first', objectId: 'original-' + index }))
  assert.deepEqual(accountSources.create(model)({ ...members[0], issueId: 'first' }, event, refs[0]),
    [{ sourceId: 'source-0', sourceType: 'wechat', fileName: '合成来源0.csv' }])
})

test('更旧快照连合并来源都缺失时，混合平台凭据不能全部成为账户来源', () => {
  const { model, event, members, refs } = projectionFixture()
  delete event.fieldSources.mergeOrigins
  model.facts.sources[1].sourceType = 'alipay'
  model.rows.get('row-1').sourceType = 'alipay'
  assert.deepEqual(accountSources.create(model)(members[0], event, refs[0]),
    [{ sourceId: '', sourceType: 'wechat', fileName: '' }])
})
