const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')
const { rebase } = require('../miniprogram/packages/finance/services/import-local-decisions')
const creations = require('../cloudfunctions/catledger-import/src/account-creation-facts')
const { validateState } = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const { validateChoices } = require('../cloudfunctions/catledger-import/src/local-review-submit')
const clone = value => JSON.parse(JSON.stringify(value))
const make = name => ({ decision: 'apply_fields', fields: { mappingAccountDraft: { name, type: 'bank', currency: 'CNY' } } })
const external = { decision: 'apply_fields', paymentRuleAction: 'external', fields: {} }

async function sourceFacts(count = 2) {
  const value = await facts({ content: syntheticBill(count, 'SYNTHETIC-SHARED', '合成银行储蓄卡(9900000000001122)'), mapped: false, accounts: [] })
  const original = value.issues.find(issue => issue.issueType === 'account_mapping')
  const members = value.members.filter(member => member.issueId === original.issueId)
  // 合成旧快照：同卡的真实成员原来分属两个事项，不改变来源引用或资金事实。
  const first = { ...clone(original), issueId: randomUUID() }, second = { ...clone(original), issueId: randomUUID() }
  const groups = [members.slice(0, count - 1), members.slice(count - 1)]
  value.issues = value.issues.filter(issue => issue !== original).concat([first, second].map((issue, index) => ({ ...issue,
    subjectEventIds: groups[index].map(member => member.objectId), memberCount: groups[index].length })))
  value.members = value.members.filter(member => member.issueId !== original.issueId)
    .concat(groups.flatMap((items, index) => items.map(member => ({ ...member, issueId: [first, second][index].issueId }))))
  return value
}
function open(data, records = [], failure) {
  const files = { save(changes) { if (failure?.active) throw new Error('synthetic disk failure'); records.push({ changes: clone(changes) }) }, touch() {}, close() {} }
  return { records, files, session: sessions.create({ restored: { facts: data, records }, files, requestId: randomUUID }) }
}
const ids = data => data.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => issue.issueId)
const choice = (session, issueId) => session.model.choices.accounts.get(issueId)

test('联合新建一次原子日志保存全部原事项、一个草稿和可恢复的真实回显', async () => {
  const data = await sourceFacts(), { session, records } = open(data), issueIds = ids(data)
  const receipt = session.confirmAccountGroup({ issueIds, decision: make('合成共用卡'), drafts: Object.fromEntries(issueIds.map(id => [id, { typeIndex: 1 }])) })
  assert.equal(records.length, 1)
  assert.equal(records[0].changes.filter(row => row.kind === 'accounts').length, 2)
  assert.equal(records[0].changes.filter(row => row.kind === 'accountCreation').length, 1)
  assert.equal(session.model.drafts.size, 1)
  const [group] = receipt.accountGroups, id = group.accountId
  assert.equal(group.createdAccountId, id)
  assert.ok(issueIds.includes(group.creatorIssueId))
  assert.ok([...session.model.events.values()].every(event => event.ledgerAccountId === id))
  assert.equal(session.state.drafts[group.creatorIssueId].mode, 'create')
  for (const issueId of issueIds) {
    assert.equal(session.state.drafts[issueId].localConfirmed, true)
    assert.deepEqual(session.state.drafts[issueId].accountFacts, { accountId: id, name: '合成共用卡', type: 'bank', currency: 'CNY' })
  }
  const restored = open(data, records).session
  assert.equal(restored.model.invalid.size, 0)
  assert.equal(restored.model.drafts.size, 1)
  assert.ok([...restored.model.events.values()].every(event => event.ledgerAccountId === id))
})

test('创建者改外部，剩余引用在冷启动和旧日志恢复后仍复用同一草稿', async () => {
  const data = await sourceFacts(), { session, records } = open(data), issueIds = ids(data)
  const group = session.confirmAccountGroup({ issueIds, decision: make('合成保留卡') }).accountGroups[0]
  const survivor = issueIds.find(id => id !== group.creatorIssueId)
  session.confirmAccountGroup({ issueIds: [group.creatorIssueId], decision: external })
  for (const history of [records, records.map(record => ({ changes: record.changes.filter(row => row.kind !== 'accountCreation') }))]) {
    const restored = open(data, history).session, state = restored.model.finalState()
    assert.equal(restored.model.invalid.size, 0)
    assert.equal(restored.model.drafts.size, 1)
    assert.equal(choice(restored, survivor).fields.mappingAccountId, group.accountId)
    assert.equal(restored.model.events.get(data.members.find(member => member.issueId === survivor).objectId).ledgerAccountId, group.accountId)
    assert.equal(state.accountCreations.length, 1)
    assert.equal(state.decisions.accounts.filter(item => creations.draftOf(item)).length, 0)
    assert.equal(validateState(state), state)
    validateChoices(state, data)
  }
})

test('原创建者改名、界面拆组与换快照保留创建事实和显式复用，输入日志不改写', async () => {
  const data = await sourceFacts(), { session, records } = open(data), issueIds = ids(data)
  const group = session.confirmAccountGroup({ issueIds, decision: make('合成原名') }).accountGroups[0]
  const separate = Object.fromEntries(issueIds.map(id => [id, { ...session.state.drafts[id], confirmationSeparate: true }]))
  session.saveDrafts(separate, 2)
  session.confirmAccountGroup({ issueIds: [group.creatorIssueId], decision: make('合成改名'), drafts: separate })
  assert.equal(session.model.drafts.size, 1)
  assert.equal(session.model.drafts.get(group.accountId).name, '合成改名')
  assert.ok([...session.model.events.values()].every(event => event.ledgerAccountId === group.accountId))
  session.confirmAccountGroup({ issueIds: [group.creatorIssueId], decision: external })
  const next = clone(data); next.snapshotId = randomUUID()
  const before = JSON.stringify(records), changes = rebase(records, data, next), restored = open(next, [{ changes }]).session
  assert.equal(JSON.stringify(records), before)
  assert.equal(restored.model.invalid.size, 0)
  assert.equal(restored.model.drafts.size, 1)
  assert.equal([...restored.model.drafts.values()][0].name, '合成改名')
  const fact = restored.model.finalState().accountCreations[0], nextId = creations.accountId(fact, next.snapshotId)
  assert.equal([...restored.model.drafts.keys()][0], nextId)
  assert.notEqual(nextId, group.accountId, '沿用既有跨快照ID派生并完整迁移别名')
  for (const issueId of issueIds) assert.equal(restored.state.drafts[issueId].confirmationSeparate, true)
})

test('原创建组按真实成员拆成两个事项后仍为一个创建事实，不扩大归属覆盖', async () => {
  const data = await sourceFacts(3), { session, records } = open(data)
  const creator = data.issues.find(issue => issue.memberCount === 2), survivor = data.issues.find(issue => issue.memberCount === 1)
  session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: creator.issueId, ...make('合成可拆组卡') }] })
  const id = [...session.model.drafts.keys()][0]
  session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: survivor.issueId, decision: 'apply_fields', fields: { mappingAccountId: id } }] })
  const next = clone(data); next.snapshotId = randomUUID()
  const originalMembers = next.members.filter(member => member.issueId === creator.issueId)
  const replacements = originalMembers.map(member => ({ ...clone(creator), issueId: randomUUID(), subjectEventIds: [member.objectId], memberCount: 1 }))
  next.issues = next.issues.filter(issue => issue.issueId !== creator.issueId).concat(replacements)
  originalMembers.forEach((member, index) => { member.issueId = replacements[index].issueId })
  next.actions.push({ actionType: 'semantic_upgrade', decision: { accountIssueMappings: replacements.map(issue => ({ fromIssueId: creator.issueId, toIssueId: issue.issueId })) } })
  const restored = open(next, [{ changes: rebase(records, data, next) }]).session
  assert.equal(restored.model.invalid.size, 0)
  assert.equal(restored.model.drafts.size, 1)
  assert.equal(restored.model.finalState().accountCreations.length, 1)
  assert.equal(new Set([...restored.model.events.values()].map(event => event.ledgerAccountId)).size, 1)
})

test('联合确认的成员失败或落盘失败整体恢复，不留下半个选择或草稿', async () => {
  const data = await sourceFacts(), failure = { active: false }, { session, records } = open(data, [], failure), issueIds = ids(data)
  assert.throws(() => session.confirmAccountGroups({ groups: [{ issueIds: [issueIds[0]], decision: make('合成先建卡') }],
    decisions: [{ issueId: issueIds[1], ...make('错误类型'), fields: { mappingAccountDraft: { name: '错误类型', type: 'wallet', currency: 'CNY' } } }] }))
  assert.equal(records.length, 0); assert.equal(session.model.drafts.size, 0); assert.equal(session.model.choices.accounts.size, 0)
  failure.active = true
  assert.throws(() => session.confirmAccountGroup({ issueIds, decision: make('合成落盘卡') }), /synthetic disk failure/)
  assert.equal(records.length, 0); assert.equal(session.model.drafts.size, 0); assert.equal(session.model.choices.accounts.size, 0)
  assert.ok([...session.model.events.values()].every(event => event.ledgerAccountId === null))
})

test('未使用创建不进入最终提交；冻结未知请求保持原文并禁止联合修改', async () => {
  const data = await sourceFacts(), { session, records } = open(data), issueIds = ids(data)
  session.confirmAccountGroup({ issueIds, decision: make('合成不使用卡') })
  session.confirmAccountGroup({ issueIds, decision: external })
  assert.equal(session.model.finalState().accountCreations, undefined)
  const flight = { phase: 'submitting', payload: { requestId: randomUUID() }, value: session.model.finalState() }, frozen = JSON.stringify(flight)
  records.push({ changes: [{ kind: 'ui', key: 'postFlight', value: clone(flight) }] })
  const restored = open(data, records).session
  assert.throws(() => restored.confirmAccountGroup({ issueIds, decision: make('不能修改') }), { code: 'OPERATION_UNCONFIRMED' })
  assert.equal(JSON.stringify(restored.state.postFlight), frozen)
})

test('合法接口已物化同一创建ID时恢复仅复用正式账户，属性不覆盖且不重造草稿', async () => {
  const data = await sourceFacts(), { session, records } = open(data), issueIds = ids(data)
  const group = session.confirmAccountGroup({ issueIds, decision: make('合成已物化账户') }).accountGroups[0]
  session.confirmAccountGroup({ issueIds: [group.creatorIssueId], decision: external })
  const next = clone(data), formal = { accountId: group.accountId, name: '合成已物化账户', type: 'bank', nature: 'asset', currency: 'CNY', version: 7 }
  next.accounts.push(formal)
  const restored = open(next, records).session
  assert.equal(restored.model.invalid.size, 0)
  assert.equal(restored.model.drafts.size, 0)
  assert.deepEqual(restored.model.accounts.get(group.accountId), formal)
  assert.equal(restored.model.finalState().accountCreations, undefined)
  next.accounts[0].name = '已在目录改名'
  assert.ok(open(next, records).session.model.invalid.size > 0, '不能覆盖正式账户的新属性')
})

test('跨页留下未确认账户输入时入账不冻结、不落盘、不联网，输入保留', async () => {
  const data = await sourceFacts(), { session, records, files } = open(data), issueIds = ids(data)
  session.confirmAccountGroup({ issueIds, decision: make('合成已确认账户') })
  session.saveDrafts({ ...session.state.drafts, [issueIds[0]]: { ...session.state.drafts[issueIds[0]],
    name: '其他页尚未确认的输入', dirty: true, localConfirmed: false } }, 2)
  const before = JSON.stringify(records), input = clone(session.state.drafts[issueIds[0]])
  let networkCalls = 0
  const restored = sessions.create({ restored: { facts: data, records }, files, requestId: randomUUID,
    callNetwork: async () => { networkCalls++; throw new Error('unexpected network') } })
  assert.equal(restored.model.invalid.size, 0)
  await assert.rejects(restored.post(), { code: 'LOCAL_RECHECK_REQUIRED' })
  assert.equal(restored.state.postFlight, null)
  assert.equal(networkCalls, 0)
  assert.equal(JSON.stringify(records), before)
  assert.deepEqual(restored.state.drafts[issueIds[0]], input)
})

test('旧未知冻结请求恢复不被未确认UI输入拦截，继续原请求核实且原文不变', async () => {
  const data = await sourceFacts(), { session, records } = open(data), issueIds = ids(data)
  session.confirmAccountGroup({ issueIds, decision: make('合成原冻结账户') })
  const flight = { payload: { requestId: randomUUID(), updateId: data.update.updateId, snapshotId: data.snapshotId }, value: session.model.finalState() }
  records.push({ changes: [{ kind: 'draft', key: issueIds[0], value: { mode: 'create', name: '未确认界面输入', dirty: true, localConfirmed: false } },
    { kind: 'ui', key: 'postFlight', value: clone(flight) }] })
  const frozen = JSON.stringify(flight), calls = [], receipt = { action: 'financeUpdates.post', updateId: data.update.updateId, status: 'posted' }
  const restored = sessions.create({ restored: { facts: data, records }, requestId: randomUUID,
    files: { save(changes) { records.push({ changes: clone(changes) }) }, clear() { return true }, touch() {}, close() {} },
    saveReceipt() {}, cleanup() {}, callNetwork: async (action, request) => { calls.push([action, clone(request)]); return receipt } })
  assert.deepEqual(await restored.post(), receipt)
  assert.deepEqual(calls, [['imports.commandResult', { requestId: flight.payload.requestId, commandAction: 'financeUpdates.post' }]])
  assert.equal(JSON.stringify(restored.state.postFlight), frozen)
})
