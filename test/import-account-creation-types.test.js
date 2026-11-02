const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const identity = require('../cloudfunctions/catledger-import/src/local-review-identity')
const binding = require('../cloudfunctions/catledger-import/src/account-binding')
const { ledgerAccountReference } = require('../cloudfunctions/catledger-import/src/account-reference')
const types = require('../cloudfunctions/catledger-import/src/account-type-policy')
const { publicIssue, publicEvent } = require('../cloudfunctions/catledger-import/src/review-presentation')
const localModel = require('../miniprogram/packages/finance/services/import-local-model')
const localRead = require('../miniprogram/packages/finance/services/import-local-read')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')
const { rebase } = require('../miniprogram/packages/finance/services/import-local-decisions')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const { runtime } = require('./helpers/paged-workbench')
const plain = value => JSON.parse(JSON.stringify(value))

function cardContent() {
  let index = 0
  return Buffer.from(syntheticBill(2).toString().replace(/微信零钱/g, () =>
    ['合成银行信用卡9900000000001122', '合成银行信用卡9900000000011122'][index++]))
}
const accountIssues = model => [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping')
const create = (model, issue, name, type = 'credit') => model.mapAccount({ issueId: issue.issueId,
  decision: 'apply_fields', fields: { mappingAccountDraft: { name, type, currency: 'CNY' } } })
function pageFor(t, issues, accounts = []) {
  const h = runtime(), page = h.page
  page._businessData = null; page._draftSession = null
  h.accounts = accounts; h.accountDrafts = []
  Object.assign(page.data, { update: { updateId: 'synthetic-update' }, accountIssues: issues, accounts, accountDrafts: [] })
  t.after(() => page.onUnload())
  return page
}

test('同尾号完整卡号保持独立创建：真实 Page 批量建议不合并同名新建', async t => {
  const data = await facts({ content: cardContent(), mapped: false, accounts: [] }), model = localModel.create(data)
  const items = localRead.create(model).read('reviewIssues.list', { group: 'accounts', pageSize: 100 }).items
  assert.equal(items.length, 2)
  assert.equal(items[0].accountContext.label, items[1].accountContext.label)
  assert.notEqual(items[0].accountContext.bindingKey, items[1].accountContext.bindingKey)
  const page = pageFor(t, items), state = page.refreshAccountMappings()
  assert.deepEqual(plain(state.mappings.map(item => [item.choiceValue, item.canConfirm])), [['create', false], ['create', false]])
  assert.equal(state.summary.suggested, 0)
  assert.ok(state.mappings.every(item => /同名/.test(item.validationText)))
  await page.confirmAllAccountMappings()
  assert.ok([...page._accountUiDrafts.values()].every(value => !value.localConfirmed))
})

test('本机不同创建重名拒绝，改名保留原ID，明确复用才共用账户', async () => {
  const data = await facts({ content: cardContent(), mapped: false, accounts: [] }), model = localModel.create(data)
  const [first, second] = accountIssues(model), name = first.accountContext.label
  const firstChange = create(model, first, name)[0], key = firstChange.value.fields.mappingAccountDraft.creationKey
  const firstId = identity.accountId(data.snapshotId, name, 'credit', key)
  assert.match(key, /^[a-f0-9]{64}$/)
  assert.equal(model.drafts.size, 1)
  assert.throws(() => create(model, second, name), { code: 'ACCOUNT_NAME_CONFLICT' })
  assert.equal(model.drafts.size, 1)
  assert.equal(model.events.get(second.subjectEventIds[0]).ledgerAccountId, null)
  create(model, first, '合成信用卡甲')
  assert.equal(model.drafts.size, 1)
  assert.equal(model.drafts.get(firstId).name, '合成信用卡甲')
  create(model, second, name)
  assert.equal(model.drafts.size, 2)
  assert.notEqual(model.events.get(second.subjectEventIds[0]).ledgerAccountId, firstId)
  const reuse = localModel.create(data), issues = accountIssues(reuse)
  create(reuse, issues[0], name)
  const accountId = [...reuse.drafts.keys()][0]
  reuse.mapAccount({ issueId: issues[1].issueId, decision: 'apply_fields', fields: { mappingAccountId: accountId } })
  assert.equal(reuse.drafts.size, 1)
  assert.ok([...reuse.events.values()].every(event => event.ledgerAccountId === accountId))
})

test('配对后同一事件的两个subject引用创建身份仍分离，改名不影响身份', () => {
  const eventId = randomUUID(), bankIssueId = randomUUID(), platformIssueId = randomUUID(), snapshotId = randomUUID()
  const ref = (sourceType, paymentMethodKey) => ({ sourceType, paymentMethodKey, bindingKey: paymentMethodKey })
  const events = [{ eventId, fieldSources: { ledgerAccountReference: ref('wechat', 'synthetic-platform-card'),
    bankChannelAccountContexts: { [bankIssueId]: ref('bank', 'synthetic-bank-card') } } }]
  const member = issueId => [{ issueId, objectId: eventId, objectType: 'event', memberRole: 'subject' }]
  const bankKey = identity.accountCreationKey(member(bankIssueId), events)
  const platformKey = identity.accountCreationKey(member(platformIssueId), events)
  assert.notEqual(bankKey, platformKey)
  assert.notEqual(identity.accountId(snapshotId, '同名合成卡', 'credit', bankKey), identity.accountId(snapshotId, '同名合成卡', 'credit', platformKey))
  assert.equal(identity.accountId(snapshotId, '合成卡原名', 'credit', bankKey), identity.accountId(snapshotId, '合成卡新名', 'credit', bankKey))
})

test('本机新建不能覆盖已有正式账户，即使同名同型；显式选择仍可用', async () => {
  const account = { accountId: randomUUID(), name: '微信零钱', type: 'wallet', nature: 'asset', currency: 'CNY' }
  const data = await facts({ count: 1, mapped: false, accounts: [account] }), model = localModel.create(data), issue = accountIssues(model)[0]
  assert.throws(() => create(model, issue, '　微信零钱　', 'wallet'), { code: 'ACCOUNT_NAME_CONFLICT' })
  assert.equal(model.drafts.size, 0)
  assert.throws(() => model.mapAccount({ issueId: issue.issueId, decision: 'apply_fields', fields: { mappingAccountId: account.accountId,
    mappingAccountDraft: { name: '合成另一钱包', type: 'wallet', currency: 'CNY' } } }), { code: 'LOCAL_RECHECK_REQUIRED' })
  assert.equal(model.drafts.size, 0)
  model.mapAccount({ issueId: issue.issueId, decision: 'apply_fields', fields: { mappingAccountId: account.accountId } })
  assert.equal(model.events.get(issue.subjectEventIds[0]).ledgerAccountId, account.accountId)
})

test('新创建日志重启和换快照保持独立身份、别名引用；旧keyless日志仍可恢复', async () => {
  const data = await facts({ count: 1, mapped: false, accounts: [] }), records = []
  const files = { save(changes) { records.push({ changes: plain(changes) }) }, touch() {}, close() {} }
  const session = sessions.create({ restored: { facts: data, records }, files, requestId: randomUUID })
  const issue = accountIssues(session.model)[0]
  session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: issue.issueId,
    decision: 'apply_fields', fields: { mappingAccountDraft: { name: '合成钱包甲', type: 'wallet', currency: 'CNY' } } }] })
  const saved = session.model.choices.accounts.get(issue.issueId), key = saved.fields.mappingAccountDraft.creationKey
  const id = identity.accountId(data.snapshotId, '合成钱包甲', 'wallet', key)
  session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: issue.issueId,
    decision: 'apply_fields', fields: { mappingAccountDraft: { name: '合成钱包乙', type: 'wallet', currency: 'CNY' } } }] })
  const restored = sessions.create({ restored: { facts: data, records }, files, requestId: randomUUID })
  assert.equal(restored.model.events.get(issue.subjectEventIds[0]).ledgerAccountId, id)
  assert.equal(restored.model.drafts.get(id).name, '合成钱包乙')
  const next = plain(data); next.snapshotId = randomUUID()
  const moved = rebase(records, data, next), current = sessions.create({ restored: { facts: next, records: [{ changes: moved }] }, files, requestId: randomUUID })
  assert.equal(current.model.events.get(issue.subjectEventIds[0]).ledgerAccountId, identity.accountId(next.snapshotId, '合成钱包乙', 'wallet', key))
  const legacy = { ...saved, fields: { mappingAccountDraft: { name: '旧合成钱包', type: 'wallet', currency: 'CNY' } } }
  const old = sessions.create({ restored: { facts: data, records: [{ changes: [{ kind: 'accounts', key: issue.issueId, value: legacy }] }] }, files, requestId: randomUUID })
  assert.equal(old.model.events.get(issue.subjectEventIds[0]).ledgerAccountId, identity.accountId(data.snapshotId, '旧合成钱包', 'wallet'))
  assert.equal(old.model.choices.accounts.get(issue.issueId).fields.mappingAccountDraft.creationKey, undefined)
})

function sourceIssue(reference, role, nature, fields = {}) {
  const sources = role === 'payment_target' ? { paymentAccountReferences: [{ ...reference, memberRole: role }] }
    : { ledgerAccountReference: reference }
  return publicIssue({ issueId: randomUUID(), issueType: 'account_mapping', status: 'open', version: 1, memberCount: 1,
    subjectEventId: randomUUID(), subjectEventStatus: 'needs_action', subjectMemberRole: role, subjectEconomicNature: nature,
    subjectCurrency: 'CNY', subjectSourceType: reference.sourceType, subjectFieldSources: { ...sources, ...fields } })
}

test('真实 Page 默认、候选、类型选项使用来源与实际资金角色的同一规则', async t => {
  const wallet = ledgerAccountReference('wechat', '微信零钱通')
  const credit = binding.scopeReference(ledgerAccountReference('bank', '合成银行(1122)'),
    { sourceType: 'bank', bankStatementKind: 'credit', importId: 'synthetic-file', currency: 'CNY' })
  const target = ledgerAccountReference('wechat', '合成银行(1122)')
  for (const [reference, role, nature, expected, wrong] of [[wallet, 'subject', 'expense', 'other_asset', 'wallet'],
    [credit, 'subject', 'expense', 'credit', 'bank'], [target, 'payment_target', 'repayment', 'credit', 'wallet']]) {
    const issue = sourceIssue(reference, role, nature)
    assert.equal(issue.accountContext.defaultAccountType, expected)
    const invalid = { accountId: randomUUID(), name: issue.accountContext.label, type: wrong, currency: 'CNY' }
    const valid = { accountId: randomUUID(), name: '人工已建账户', type: expected, currency: 'CNY' }
    const page = pageFor(t, [issue], [invalid, valid]), mapping = page.refreshAccountMappings().mappings[0]
    assert.equal(page.data.accountTypeOptions[mapping.draftTypeIndex].value, expected)
    assert.equal(mapping.choiceValue, 'create', '同名但类型错误的账户不能被建议')
    await page.openAccountChoice({ currentTarget: { dataset: { id: issue.issueId } } })
    assert.deepEqual(plain(page.data.accountChoiceResults.map(row => row.accountId)), [valid.accountId])
    assert.equal(mapping.typeOptions.some(option => option.value === wrong), false)
  }
})

test('类型保护在本机写入复核，不依赖UI；实际银行转入方向与标题一致', async () => {
  const data = await facts({ count: 1, mapped: false, accounts: [], content: Buffer.from(syntheticBill(1).toString().replace('微信零钱', '微信零钱通')) })
  const model = localModel.create(data), issue = accountIssues(model)[0]
  assert.throws(() => create(model, issue, '合成零钱通', 'wallet'), { code: 'LOCAL_RECHECK_REQUIRED' })
  assert.equal(model.drafts.size, 0)
  create(model, issue, '合成零钱通', 'other_asset')
  assert.equal([...model.drafts.values()][0].type, 'other_asset')
  const event = { economicNature: 'internal_transfer', sourceDirection: 'income', ledgerAccountId: null, counterpartyLedgerAccountId: null,
    fieldSources: { fundsProjection: { kind: 'bank_transfer', accountOrder: 'actual', from: null, to: null } } }
  assert.equal(types.actualSide(event, 'subject'), 'destination')
  assert.equal(publicEvent(event).transferOwnershipPending, true)
  assert.equal(publicEvent(event).accountOrder, 'actual')
})

module.exports = { cardContent }
