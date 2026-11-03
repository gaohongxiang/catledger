const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { accountGroupCountsFacts } = require('./helpers/account-group-counts')
const { localWorkbench } = require('./helpers/local-workbench')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')

const plain = value => JSON.parse(JSON.stringify(value))
const tap = dataset => ({ currentTarget: { dataset } })
const separatedNote = '各来源有相同交易'
const originalSourceLabels = ['主卡6106', '合成测试银行信用卡(6106)'].sort()

async function setup(t, options = {}) {
  const fixture = await accountGroupCountsFacts(options), { credit, wechat, alipay, value } = fixture
  const h = await localWorkbench(t, value)
  assert.equal(value.rows.length, options.duplicateWechat ? 72 : 71)
  assert.equal(value.events.length, 71, '同来源同交易号的重复导出先自然归成同一事件')
  h.local.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions:
    [...h.local.model.issues.values()].filter(issue => issue.issueType === 'account_mapping').map(issue => ({
      issueId: issue.issueId, decision: 'apply_fields', fields: { mappingAccountId:
        /零钱/.test(issue.accountContext.label) ? wechat.accountId : /余额/.test(issue.accountContext.label) ? alipay.accountId : credit.accountId }
    })) })
  // Neither wallet repayment identifies a concrete credit card in its source.
  // The user supplies the receiving account before explicitly confirming pairs.
  for (const event of [...h.local.model.events.values()]) if (event.economicNature === 'repayment' && event.sourceType !== 'bank') {
    h.local.call('financeUpdates.setReview', { requestId: randomUUID(), eventId: event.eventId, eventVersion: event.version,
      editorVersion: 1, fields: { counterpartyLedgerAccountId: credit.accountId } })
  }
  if (options.beforePairing) {
    await h.page.applyUpdateView(h.local.view)
    await h.page.setStep({ currentStep: 2 })
    return { ...h, ...fixture }
  }
  const pairs = [], first = h.local.call('reviewIssues.pairings', { mode: 'suggested', pageSize: 100 })
  pairs.push(...first.items)
  let cursor = first.nextCursor
  while (cursor) {
    const next = h.local.call('reviewIssues.pairings', { mode: 'suggested', pageSize: 100, cursor })
    pairs.push(...next.items); cursor = next.nextCursor
  }
  assert.equal(pairs.length, 31)
  assert.equal(pairs.filter(pair => pair.pairKind === 'repayment').length, 2)
  h.local.call('reviewIssues.resolvePairings', { requestId: randomUUID(), scopeToken: first.scopeToken,
    selection: { mode: 'explicit', pairs: pairs.map(pair => ({ pairKey: pair.pairKey, decision: 'same',
      ...(pair.pairKind === 'repayment' ? { repaymentConfirmed: true } : {}) })) } })
  assert.equal(h.local.model.events.size, 40)
  await h.page.applyUpdateView(h.local.view)
  await h.page.setStep({ currentStep: 2 })
  return { ...h, ...fixture }
}

function joined(page, credit, sourceCount = 2) {
  const card = page.data.accountMappings.find(item => item.groupId && item.choiceValue === 'account:' + credit.accountId)
  assert.ok(card)
  assert.equal(card.memberCount, 40, '合卡按不同交易计数，不把已确认同笔的两份凭据相加')
  assert.equal(card.needsConfirmation, false)
  assert.equal(card.groupSourceCount, sourceCount)
  assert.deepEqual(card.groupSourceText.split(' · ').sort(), originalSourceLabels,
    '合卡列出拆开时的原账户来源名，不用平台名或所选账户标题替代')
  const descriptor = page.businessData().accountDisplayGroups.find(group => group.groupId === card.groupId)
  assert.ok(descriptor)
  const originals = page.mappingState().rawMappings.filter(mapping => descriptor.issueIds.includes(mapping.issueId))
  assert.deepEqual([...new Set(originals.map(mapping => mapping.sourceLabel.trim()).filter(Boolean))].sort(),
    originalSourceLabels, '原卡来源名称在合卡后仍完整保留')
  assert.deepEqual(plain(Object.fromEntries(descriptor.sourceCounts.map(source => [source.sourceType, source.count]))),
    { bank: 40, wechat: 29 }, '平台内部仍按本账户的事件并集计数，同平台多份文件不相加')
  assert.equal(card.groupDeduplicated, true, '原卡范围有交集时，主笔数才标记去重后')
  assert.equal(card.groupCountNote, undefined, '合卡不再保留另一行去重说明')
  assert.equal(card.groupConfirmationText, '这些交易使用同一账户')
  return card
}

function separated(page, credit) {
  const cards = page.data.accountMappings.filter(card => card.choiceValue === 'account:' + credit.accountId)
  assert.deepEqual(plain(cards.map(card => card.memberCount)), [40, 29])
  assert.deepEqual(plain(cards.map(card => card.sourceLabel).sort()), originalSourceLabels)
  assert.ok(cards.every(card => card.accountSeparatedGroupId && !card.needsConfirmation))
  assert.ok(cards.every(card => !card.groupDeduplicated), '分卡保留原范围笔数，不显示合卡的去重后前缀')
  assert.equal(cards[0].accountSeparatedCountNote, separatedNote)
  assert.ok(!cards[1].accountSeparatedCountNote, '组计数说明只在拆分组首卡展示一次')
  return cards
}

async function cold(t, h) {
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('本机恢复不得访问网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.createPage({}, false)
  h.page = page; h.local = local
  t.after(() => page.onUnload())
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
}

test('真实账户合卡40笔：来源仅文字，主笔数标记去重后，内部去重与40笔详情一致', async t => {
  const h = await setup(t), financial = plain(h.local.model.finalState()), card = joined(h.page, h.credit)
  const originals = h.page.mappingState().rawMappings.filter(mapping => mapping.choiceValue === 'account:' + h.credit.accountId)
  assert.deepEqual(plain(originals.map(mapping => mapping.memberCount).sort((a, b) => b - a)), [40, 29])
  const sets = originals.map(mapping => new Set(h.local.model.issues.get(mapping.issueId).subjectEventIds))
  assert.equal([...sets[0]].filter(id => sets[1].has(id)).length, 29)
  await h.page.openAccountRecords(tap({ id: card.issueId }))
  assert.equal(h.page.data.accountRecordsSheet.count, 40)
  assert.equal(h.page.data.accountRecordsSheet.error || '', '')
  const ids = [], options = h.page.businessData().accountConfirmationOptions
  let cursor = null
  do {
    const result = h.local.call('reviewIssues.members', { ...options, accountConfirmationGroupId: card.issueId,
      memberKind: 'event', pageSize: 8, cursor })
    ids.push(...result.items.map(member => member.objectId)); cursor = result.nextCursor
  } while (cursor)
  assert.equal(ids.length, 40)
  assert.equal(new Set(ids).size, 40)
  assert.equal(h.local.model.evidence.size, 71, '所有原始证据保留，来源标签筛选不丢凭据')
  assert.deepEqual(plain(h.local.model.finalState()), financial)
  assert.equal(h.network.length, 0)
})

test('真实40/29来源拆开、旧草稿冷恢复及合回：简洁说明稳定，金融事实不变', async t => {
  const h = await setup(t), financial = plain(h.local.model.finalState()), card = joined(h.page, h.credit)
  await h.page.separateAccountGroup(tap({ id: card.issueId }))
  separated(h.page, h.credit)
  assert.deepEqual(plain(h.local.model.finalState()), financial)
  await cold(t, h)
  let children = separated(h.page, h.credit)
  // 旧版本可能只留下原事项的拆分标记；正常冷恢复应读取完整组，不能猜当前页的总数。
  const drafts = plain(h.local.state.drafts), splitId = children[0].accountSeparatedGroupId
  assert.ok(drafts[splitId])
  delete drafts[splitId]
  h.local.saveDrafts(drafts)
  await cold(t, h)
  children = separated(h.page, h.credit)
  assert.match(children[0].accountSeparatedGroupId, /^legacy:account:/)
  assert.ok(children.every(child => h.local.state.drafts[child.issueId].confirmationSeparate))
  assert.equal(h.local.model.evidence.size, 71)
  assert.deepEqual(plain(h.local.model.finalState()), financial)
  await h.page.restoreAccountGroup(tap({ id: children[0].restoreGroupId }))
  joined(h.page, h.credit)
  assert.deepEqual(plain(h.local.model.finalState()), financial)
  await cold(t, h)
  joined(h.page, h.credit)
  assert.deepEqual(plain(h.local.model.finalState()), financial)
  assert.equal(h.network.length, 0)
})

test('同一微信消费在两份文件重复导出：来源文件各保留，微信笔数按事件去重', async t => {
  const h = await setup(t, { duplicateWechat: true }), financial = plain(h.local.model.finalState())
  const card = joined(h.page, h.credit, 3)
  const repeated = [...h.local.model.events.values()].find(event => h.local.model.evidenceFor(event.eventId)
    .filter(link => h.local.model.rows.get(link.rowId).sourceType === 'wechat').length === 2)
  assert.ok(repeated, '真实同订单重复导出仍有两份微信证据')
  const details = h.local.accountConfirmationDetails({ ...h.page.businessData().accountConfirmationOptions,
    groupIds: [card.groupId] })
  const sources = details.groups[0].sources.filter(source => source.sourceType === 'wechat')
  assert.deepEqual(sources.map(source => source.count).sort((a, b) => b - a), [29, 1])
  assert.equal(new Set(sources.map(source => source.sourceId)).size, 2)
  assert.equal(h.local.model.evidence.size, 72)
  await cold(t, h)
  joined(h.page, h.credit, 3)
  assert.deepEqual(plain(h.local.model.finalState()), financial)
  assert.equal(h.network.length, 0)
})

test('同平台重复导出但原卡交易尚无交集：保留所有来源，不给69笔合卡标去重后', async t => {
  const h = await setup(t, { duplicateWechat: true, beforePairing: true })
  const card = h.page.data.accountMappings.find(item => item.groupId && item.choiceValue === 'account:' + h.credit.accountId)
  assert.ok(card)
  assert.equal(card.memberCount, 69)
  assert.equal(card.groupSourceCount, 3)
  assert.equal(card.groupDeduplicated, false, '同一原卡的重复文件，不代表不同原卡之间有重叠')
  assert.equal(card.groupCountNote, undefined)
  assert.deepEqual(card.groupSourceText.split(' · ').sort(), originalSourceLabels)
  const descriptor = h.page.businessData().accountDisplayGroups.find(group => group.groupId === card.groupId)
  assert.equal(descriptor.separateMemberCount, descriptor.memberCount)
  assert.equal(descriptor.sourceCounts.find(source => source.sourceType === 'wechat').count, 29)
  assert.deepEqual(plain(descriptor.sources.filter(source => source.sourceType === 'wechat').map(source => source.count).sort((a, b) => b - a)), [29, 1])
  assert.equal(h.local.model.events.size, 71)
  assert.equal(h.local.model.evidence.size, 72)
  assert.equal(h.local.model.choices.pairings.size, 0)
  await h.page.openAccountRecords(tap({ id: card.issueId }))
  assert.equal(h.page.data.accountRecordsSheet.count, 69)
  assert.equal(h.page.data.accountRecordsSheet.error || '', '')
  assert.equal(h.network.length, 0)
})
