const test = require('node:test')
const assert = require('node:assert/strict')
const { rebase } = require('../miniprogram/packages/finance/services/import-local-decisions')
const identity = require('../miniprogram/packages/finance/domain/import-review/local-review-identity')
function facts(snapshotId, issueIds) {
  return { snapshotId, accountDrafts: [], actions: [], issues: [...new Set(issueIds)].map(issueId => ({ issueId, issueType: 'account_mapping', status: 'open', primaryReasonCode: 'payment_reference_mapping_required' })),
    members: issueIds.map((issueId, i) => ({ issueId, objectType: 'event', objectId: 'event-' + i, memberRole: 'subject' })),
    evidence: issueIds.map((_, i) => ({ eventId: 'event-' + i, rowId: 'row-' + i, evidenceRole: 'primary' })) }
}
function fixture() {
  const oldFacts = facts('old-snapshot', ['old-a','old-b']), next = facts('new-snapshot', ['new-group','new-group'])
  next.actions = [{ actionType: 'semantic_upgrade', decision: { accountIssueMappings: ['old-a','old-b'].map(fromIssueId => ({ fromIssueId, toIssueId: 'new-group' })) } }]
  const choices = ['old-a','old-b'].map((issueId, i) => ({ kind: 'accounts', key: issueId, value: { key: issueId, issueId,
    eventIds: ['event-' + i], sourceIds: ['row-' + i], decision: 'apply_fields', fields: { ledgerAccountId: 'same-account' } } }))
  return { oldFacts, next, choices }
}
test('按服务端迁移关系合并一致决定，保持完整来源范围和输入不变', () => {
  const { oldFacts, next, choices } = fixture(), records = [{ changes: choices }], before = JSON.stringify({ oldFacts, next, records })
  const result = rebase(records, oldFacts, next)
  assert.equal(result.length, 1); assert.equal(result[0].key, 'new-group')
  assert.deepEqual(result[0].value.eventIds, ['event-0','event-1'])
  assert.deepEqual(result[0].value.sourceIds, ['row-0','row-1'])
  assert.equal(result[0].value.needsRecheck, undefined)
  assert.equal(JSON.stringify({ oldFacts, next, records }), before)
})
test('冲突、未覆盖成员或来源变化须重新核对，旧决定仍完整可恢复', () => {
  for (const mode of ['conflict','partial','evidence']) {
    const { oldFacts, next, choices } = fixture()
    if (mode === 'conflict') choices[1].value.fields.ledgerAccountId = 'different-account'
    if (mode === 'partial') choices.pop()
    if (mode === 'evidence') next.evidence[1].rowId = 'replacement-row'
    const result = rebase([{ changes: choices }], oldFacts, next)
    assert.equal(result[0].value.needsRecheck, true)
    assert.deepEqual(result[0].value.previousChoices, choices.map(row => row.value))
    assert.equal(result[0].key, 'new-group', '后续新选择覆盖同一key，不永久保留旧阻塞key')
  }
})
test('完整成员按角色核对，同一事件两个成分不可由单个旧选择覆盖', () => {
  const { oldFacts, next, choices } = fixture()
  for (const value of [oldFacts,next]) value.members[1].objectId = 'event-0'
  oldFacts.members[0].memberRole = next.members[0].memberRole = 'payment_component_0'
  oldFacts.members[1].memberRole = next.members[1].memberRole = 'payment_component_1'
  assert.equal(rebase([{ changes: [choices[0]] }], oldFacts, next)[0].value.needsRecheck, true)
})
test('重建本地草稿账户ID贯穿事件、分配、配对成员编辑和界面草稿，原文不改写', () => {
  const { oldFacts, next, choices } = fixture(), draft = { name: '合成信用账户', type: 'credit', currency: 'CNY' }
  const oldId = identity.accountId(oldFacts.snapshotId, draft.name, draft.type), newId = identity.accountId(next.snapshotId, draft.name, draft.type)
  for (const choice of choices) choice.value.fields = { mappingAccountDraft: draft }
  const editor = { fields: { ledgerAccountId: oldId, note: oldId }, decisions: { paymentResolution: { allocations: [{ accountId: oldId }] } } }
  const records = [{ changes: [...choices, { kind: 'events', key: 'event-0', value: { eventId: 'event-0', editor } },
    { kind: 'pairings', key: 'pair', value: { memberEditors: { 'event-0': editor } } },
    { kind: 'draft', key: 'draft', value: { accountId: oldId } }, { kind: 'ui', key: 'postFlight', value: { requestId: 'unknown' } },
    { kind: 'receipt', key: 'receipt', value: { status: 'posted' } }] }]
  const result = rebase(records, oldFacts, next), get = kind => result.find(row => row.kind === kind).value
  assert.equal(get('events').editor.fields.ledgerAccountId, newId)
  assert.equal(get('events').editor.decisions.paymentResolution.allocations[0].accountId, newId)
  assert.equal(get('events').editor.fields.note, oldId)
  assert.equal(get('pairings').memberEditors['event-0'].fields.ledgerAccountId, newId)
  assert.equal(get('draft').accountId, newId)
  assert.ok(result.every(row => row.kind !== 'receipt' && row.key !== 'postFlight'))
})
test('只迁移日志最终状态，多级迁移可抵达当前事项', () => {
  const { oldFacts, next, choices } = fixture()
  next.actions[0].decision.accountIssueMappings[0].toIssueId = 'middle'
  next.actions.push({ actionType: 'semantic_upgrade', decision: { accountIssueMappings: [{ fromIssueId: 'middle', toIssueId: 'new-group' }] } })
  const result = rebase([{ changes: [...choices, { kind: 'events', key: 'event-0', value: { editor: 'old' } }] },
    { changes: [{ kind: 'events', key: 'event-0', value: null }] }], oldFacts, next)
  assert.equal(result.length, 1); assert.equal(result[0].value.needsRecheck, undefined)
})

test('账户界面草稿随事项迁移，冲突及部分覆盖保留原编辑并待确认', () => {
  for (const mode of ['same','conflict','partial']) {
    const { oldFacts, next } = fixture(), changes = ['old-a','old-b'].map(key => ({ kind: 'draft', key,
      value: { mode: 'account', accountId: 'chosen', name: '', typeIndex: 0, dirty: true, localConfirmed: false } }))
    if (mode === 'conflict') changes[1].value.accountId = 'different'
    if (mode === 'partial') changes.pop()
    const result = rebase([{ changes }], oldFacts, next)
    assert.equal(result.length, 1); assert.equal(result[0].key, 'new-group')
    assert.equal(result[0].value.mode, mode === 'same' ? 'account' : 'pending')
    assert.equal(result[0].value.localConfirmed, false)
    if (mode !== 'same') assert.deepEqual(result[0].value.previousDrafts.map(row => row.value), changes.map(row => row.value))
  }
})

test('账户同义字段可归并，但同一账户的其他配置差异不能被丢弃', () => {
  const { oldFacts, next, choices } = fixture()
  choices[1].value.fields = { mappingAccountId: 'same-account' }
  assert.equal(rebase([{ changes: choices }], oldFacts, next)[0].value.needsRecheck, undefined)
  choices[1].value.fields.paymentAccounts = [{ componentIndex: 0, accountId: 'same-account' }]
  assert.equal(rebase([{ changes: choices }], oldFacts, next)[0].value.needsRecheck, true)
  for (const choice of choices) choice.value.fields = { mappingAccountDraft: { name: '同名账户', type: 'credit', currency: 'CNY' } }
  choices[1].value.fields.mappingAccountDraft.currency = 'USD'
  assert.equal(rebase([{ changes: choices }], oldFacts, next)[0].value.needsRecheck, true)
})

test('历史自动忽略释放后待确认，同批本机明确保存的排除或新建账户继续生效', async t => {
  const { randomUUID } = require('node:crypto')
  const { planAccountIssueUpgrade } = require('../cloudfunctions/catledger-import/src/account-plan-upgrade')
  const { releaseLegacyIgnore } = require('../cloudfunctions/catledger-import/src/legacy-ignore-release')
  const sessionFactory = require('../miniprogram/packages/finance/services/import-local-session')
  for (const mode of ['history-only', 'unconfirmed-draft', 'explicit-ignore', 'explicit-create']) await t.test(mode, async () => {
    const old = await require('./helpers/local-review').facts({ count: 2, mapped: false })
    old.ruleVersion = old.update.planVersion = 'organizer-plan-v38'
    const issue = old.issues.find(row => row.issueType === 'account_mapping')
    issue.status = 'resolved'; issue.blocking = false; issue.primaryReasonCode = 'payment_reference_ignored_by_history'
    old.events = old.events.map(event => ({ ...event, status: 'excluded', reasonCodes: ['source_account_ignored_default'] }))
    const records = [], files = { save(changes) { records.push({ changes: structuredClone(changes) }) }, touch() {}, close() {} }
    const oldSession = sessionFactory.create({ restored: { facts: old, records }, files, requestId: randomUUID })
    if (mode === 'unconfirmed-draft') records.push({ changes: [{ kind: 'draft', key: issue.issueId,
      value: { mode: 'ignore', localConfirmed: false, dirty: true } }] })
    if (mode.startsWith('explicit-')) oldSession.call('reviewIssues.resolveAccountMappings', {
      requestId: randomUUID(), decisions: [{ issueId: issue.issueId,
        decision: mode === 'explicit-ignore' ? 'exclude_events' : 'apply_fields',
        fields: mode === 'explicit-ignore' ? {} : { ledgerAccountDraft: { name: '合成新账户', type: 'wallet', currency: 'CNY' } } }]
    })
    const next = structuredClone(old)
    next.snapshotId = randomUUID(); next.ruleVersion = next.update.planVersion = require('../cloudfunctions/catledger-import/src/domain-versions').PLAN_VERSION
    next.events = old.events.map(event => ({ ...releaseLegacyIgnore(event), version: event.version + 1 }))
    const plan = planAccountIssueUpgrade({ updateId: old.update.updateId, previousEvents: old.events,
      events: next.events, issues: old.issues, members: old.members })
    next.issues = next.issues.filter(row => !plan.supersededIssueIds.includes(row.issueId)).concat(plan.issues.map(row => ({ ...row,
      subjectEventIds: [...new Set(plan.members.filter(member => member.issueId === row.issueId).map(member => member.objectId))] })))
    next.members = next.members.filter(row => !plan.supersededIssueIds.includes(row.issueId)).concat(plan.members)
    next.actions.push({ actionType: 'semantic_upgrade', decision: { accountIssueMappings: plan.accountIssueMappings } })
    const before = JSON.stringify({ old, records }), adopted = rebase(records, old, next)
    const current = sessionFactory.create({ restored: { facts: next, records: [{ changes: adopted }] }, files, requestId: randomUUID })
    assert.equal(current.model.invalid.size, 0)
    assert.equal(current.model.issues.get(plan.issues[0].issueId).status, mode.startsWith('explicit-') ? 'resolved' : 'open')
    assert.equal([...current.model.events.values()].every(event => event.status === 'excluded'), mode === 'explicit-ignore')
    if (mode === 'explicit-create') {
      const created = [...current.model.drafts.values()][0]
      assert.ok(created.creationKey, '新确认的创建身份随决定恢复')
      assert.ok([...current.model.events.values()].every(event =>
        event.ledgerAccountId === identity.accountId(next.snapshotId, '合成新账户', 'wallet', created.creationKey)))
    }
    if (!mode.startsWith('explicit-')) assert.equal(current.model.choices.accounts.size, 0)
    if (mode === 'unconfirmed-draft') assert.equal(current.state.drafts[plan.issues[0].issueId].localConfirmed, false)
    assert.equal(JSON.stringify({ old, records }), before, '重整不能改写旧快照和决定日志')
  })
})

test('真实session冲突不能提交，按新事项重选或按原事件保存后可恢复且重启不复发', async t => {
  const { randomUUID } = require('node:crypto'), sessionFactory = require('../miniprogram/packages/finance/services/import-local-session')
  for (const mode of ['mapped','unrouted','event-only']) await t.test(mode, async () => {
    const next = await require('./helpers/local-review').facts({ count: 2, mapped: false })
    const group = next.issues.find(row => row.issueType === 'account_mapping')
    const old = JSON.parse(JSON.stringify(next)); old.snapshotId = randomUUID()
    const previousIds = [randomUUID(), randomUUID()], oldMembers = old.members.filter(row => row.issueId === group.issueId)
    old.issues = old.issues.filter(row => row.issueId !== group.issueId).concat(previousIds.map(issueId => ({ ...group, issueId })))
    old.members = old.members.filter(row => row.issueId !== group.issueId).concat(oldMembers.map((member, index) => ({ ...member, issueId: previousIds[index] })))
    if (mode === 'mapped') next.actions.push({ actionType: 'semantic_upgrade', decision: { accountIssueMappings: previousIds.map(fromIssueId => ({ fromIssueId, toIssueId: group.issueId })) } })
    if (mode === 'event-only') { next.issues = next.issues.filter(row => row.issueId !== group.issueId); next.members = next.members.filter(row => row.issueId !== group.issueId) }
    const choices = previousIds.map((issueId, index) => ({ kind: 'accounts', key: issueId, value: { key: issueId, issueId, eventIds: [oldMembers[index].objectId],
      sourceIds: old.evidence.filter(row => row.eventId === oldMembers[index].objectId).map(row => row.rowId), decision: 'apply_fields', fields: { ledgerAccountId: next.accounts[index].accountId } } }))
    const records = [{ changes: rebase([{ changes: choices }], old, next) }]
    let network = 0
    const options = { files: { save(changes) { records.push({ changes: JSON.parse(JSON.stringify(changes)) }) }, touch() {}, close() {} },
      restored: { facts: next, records }, requestId: randomUUID, callNetwork: async () => { network++; throw Error('unexpected submission') } }
    const session = sessionFactory.create(options)
    assert.equal(session.model.invalid.size, 2)
    await assert.rejects(session.post(), { code: 'LOCAL_RECHECK_REQUIRED' }); assert.equal(network, 0)
    if (mode === 'event-only') for (const event of next.events) session.call('financeUpdates.setReview', { requestId: randomUUID(), eventId: event.eventId, editorVersion: 1, fields: { ledgerAccountId: next.accounts[0].accountId } })
    else session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: group.issueId, decision: 'apply_fields', fields: { ledgerAccountId: next.accounts[0].accountId } }] })
    assert.equal(session.model.invalid.size, 0)
    assert.ok([...session.model.choices.accounts.keys()].every(key => !previousIds.includes(key)))
    const restored = sessionFactory.create(options)
    assert.equal(restored.model.invalid.size, 0)
    assert.ok([...restored.model.choices.accounts.values(), ...restored.model.choices.events.values()].every(choice => !choice.needsRecheck))
  })
})
