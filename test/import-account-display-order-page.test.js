const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const { localWorkbench } = require('./helpers/local-workbench')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')
const display = require('../miniprogram/packages/finance/pages/import-workbench/account-display-groups')
const tap = dataset => ({ currentTarget: { dataset } })
const plain = value => JSON.parse(JSON.stringify(value))
const shared = '合成排序银行储蓄卡(5564)'
const label = tail => '合成排序银行储蓄卡(' + tail + ')'
const account = name => ({ accountId: randomUUID(), name, type: 'bank', nature: 'asset', currency: 'CNY', version: 1 })

async function setup(t, options = {}) {
  const specs = options.specs || [[3, shared], [2, shared], [7, label(7000)], [4, label(4000)], [10, label(9000)]]
  const accounts = options.accounts || [...new Set(specs.map(([, name]) => name))].map(account).concat(account('合成共同目标'))
  const value = await facts({ mapped: false, accounts, contents: specs.map(([count, name], index) =>
    syntheticBill(count, 'SYNTHETIC-DISPLAY-ORDER-' + index, name)) })
  const h = await localWorkbench(t, value)
  await h.page.setStep({ currentStep: 2 })
  assert.equal(h.page.data.pageError, '')
  return { ...h, value, accounts }
}

async function choose(page, id, value) {
  await page.openAccountChoice(tap({ id }))
  assert.equal(page.data.accountChoiceSheet?.issueId, id)
  await page.selectAccountChoice(tap({ value }))
  assert.equal(page.data.pageError, '')
}

async function coldPage(t, h) {
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('本批排序和显示分组不能调用网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.page = h.createPage({}, false)
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  t.after(() => page.onUnload())
  return { page, local }
}

async function confirmAllSources(h) {
  h.local.confirmAccountGroups({ groups: h.value.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => ({
    issueIds: [issue.issueId], decision: { decision: 'apply_fields', fields: {
      mappingAccountId: h.accounts.find(row => row.name === issue.accountContext.label).accountId
    } }
  })) })
  await h.page.applyUpdateView(h.local.view)
  await h.page.setStep({ currentStep: 2 })
}

function adjacent(page, ids) {
  const positions = ids.map(id => page.data.accountMappings.findIndex(row => row.issueId === id)).sort((a, b) => a - b)
  assert.ok(positions[0] >= 0)
  assert.equal(positions[positions.length - 1] - positions[0], ids.length - 1)
}

test('真实 Page：完整组待确认优先和总笔数降序；拆开改账户及确认后仍相邻，最后一项确认不丢组关系', async t => {
  const h = await setup(t), page = h.page
  const largestId = page.data.accountMappings.find(row => row.memberCount === 10).issueId
  await page.completeAccountMapping(tap({ id: largestId }))
  assert.deepEqual(plain(page.data.accountMappings.map(row => row.memberCount)), [7, 5, 4, 10])
  const groupId = page.data.accountMappings.find(row => row.memberCount === 5).issueId
  const ids = page.mappingState().mappings.find(row => row.issueId === groupId).groupIssueIds.slice()
  await page.separateAccountGroup(tap({ id: groupId }))
  assert.deepEqual(plain(page.data.accountMappings.map(row => row.memberCount)), [7, 3, 2, 4, 10])
  adjacent(page, ids)
  await page.completeAccountMapping(tap({ id: ids[0] }))
  adjacent(page, ids)
  assert.equal(page.data.accountMappings.find(row => row.restoreGroupId === groupId).restoreBlocked, false)
  const target = h.accounts.find(row => row.name === '合成共同目标')
  await choose(page, ids[1], 'account:' + target.accountId)
  await page.completeAccountMapping(tap({ id: ids[1] }))
  assert.deepEqual(plain(page.data.accountMappings.map(row => row.memberCount)), [7, 4, 10, 3, 2])
  adjacent(page, ids)
  assert.equal(h.local.state.drafts[groupId].confirmationDisplayMode, 'separated')
  assert.equal(h.local.state.drafts[groupId].dirty, false)
  const reopened = await coldPage(t, h)
  adjacent(reopened.page, ids)
  assert.equal(reopened.local.state.drafts[groupId].confirmationDisplayMode, 'separated')
  assert.equal(h.network.length, 0)
})

test('真实 Page：同一已确认账户恢复合并只改显示，不制造待确认或重复写入决定', async t => {
  const h = await setup(t), page = h.page
  await confirmAllSources(h)
  const groupId = page.data.accountMappings.find(row => row.memberCount === 5).issueId
  await page.separateAccountGroup(tap({ id: groupId }))
  const before = plain(h.local.model.finalState()), revision = h.local.projectionRevision
  await page.restoreAccountGroup(tap({ id: groupId }))
  assert.equal(page.data.accountStepError, '')
  const card = page.data.accountMappings.find(row => row.issueId === groupId)
  assert.equal(card.memberCount, 5)
  assert.equal(card.needsConfirmation, false)
  assert.equal(h.local.state.drafts[groupId].dirty, false)
  assert.equal(h.local.state.drafts[groupId].localConfirmed, true)
  assert.equal(h.local.projectionRevision, revision)
  assert.deepEqual(plain(h.local.model.finalState()), before)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.find(row => row.issueId === groupId).needsConfirmation, false)
  assert.equal(reopened.page.data.accountStepSummary.pending, 0)
})

test('真实 Page：已确认A/B合回保留原决定，共同选择为空；离页与冷恢复继续拦截入账，选C一次确认才改两边', async t => {
  const specs = [[3, shared], [2, shared], ...Array.from({ length: 101 }, (_, index) => [1, label(2000 + index)])]
  const h = await setup(t, { specs }), page = h.page
  await confirmAllSources(h)
  const groupId = page.data.accountMappings.find(row => row.memberCount === 5).issueId
  const ids = page.mappingState().mappings.find(row => row.issueId === groupId).groupIssueIds.slice()
  await page.separateAccountGroup(tap({ id: groupId }))
  const b = h.accounts.find(row => row.name === label(2000)), c = h.accounts.find(row => row.name === '合成共同目标')
  await choose(page, ids[1], 'account:' + b.accountId)
  await page.completeAccountMapping(tap({ id: ids[1] }))
  const before = plain(h.local.model.finalState())
  await page.restoreAccountGroup(tap({ id: groupId }))
  assert.equal(page.data.accountStepError, '')
  const joined = page.data.accountMappings.find(row => row.issueId === groupId)
  assert.equal(joined.choiceValue, 'pending')
  assert.equal(joined.needsConfirmation, true)
  assert.equal(h.local.state.drafts[groupId].dirty, true)
  assert.equal(h.local.state.drafts[groupId].localConfirmed, false)
  assert.deepEqual(plain(h.local.model.finalState()), before)
  const otherId = page.data.accountMappings.find(row => row.issueId !== groupId).issueId
  await page.completeAccountMapping(tap({ id: otherId }))
  assert.equal(h.local.state.drafts[groupId].dirty, true, '确认无关卡不能清掉A/B重新选择的门禁')
  await page.changeReviewPage(tap({ direction: '1' }))
  assert.equal(page.data.accountStepSummary.displayPending, 0)
  assert.equal(page.data.accountStepSummary.pendingOutside, true)
  await page.postUpdate()
  assert.equal(page.data.currentStep, 2)
  assert.match(page.data.errorMessage, /确认保留的账户选择/u)
  assert.equal(h.local.state.postFlight, null)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.find(row => row.issueId === groupId).choiceValue, 'pending')
  assert.equal(reopened.local.state.drafts[groupId].dirty, true)
  const originalDecisions = plain(reopened.local.model.finalState())
  await choose(reopened.page, groupId, 'account:' + c.accountId)
  assert.deepEqual(plain(reopened.local.model.finalState()), originalDecisions)
  const saved = h.files.restore().records.length
  await reopened.page.completeAccountMapping(tap({ id: groupId }))
  assert.equal(reopened.page.data.accountStepError, '')
  assert.equal(h.files.restore().records.length, saved + 1)
  assert.ok(ids.every(id => reopened.local.model.choices.accounts.get(id).fields.mappingAccountId === c.accountId))
  assert.equal(reopened.page.data.accountStepSummary.pending, 0)
  assert.equal(h.network.length, 0)
})

test('真实 Page：恢复AB时可完整加入已手选同账户的C；旧AB点击不能确认ABC，再拆合不残留重叠范围', async t => {
  const h = await setup(t, { specs: [[3, shared], [2, shared], [1, label(7788)]] }), page = h.page
  const groupId = page.data.accountMappings.find(row => row.groupId).issueId
  await page.separateAccountGroup(tap({ id: groupId }))
  const cId = page.data.accountMappings.find(row => row.sourceLabel === label(7788)).issueId
  const target = h.accounts.find(row => row.name === shared)
  await choose(page, cId, 'account:' + target.accountId)
  const before = plain(h.local.model.finalState())
  await page.restoreAccountGroup(tap({ id: groupId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(page.data.accountMappings.length, 1)
  const expandedId = page.data.accountMappings[0].issueId
  assert.notEqual(expandedId, groupId)
  assert.equal(page.data.accountMappings[0].memberCount, 6)
  assert.equal(page.data.accountMappings[0].needsConfirmation, true)
  assert.deepEqual(plain(h.local.model.finalState()), before)
  await page.completeAccountMapping(tap({ id: groupId }))
  assert.match(page.data.accountStepError, /对应记录已变化/u)
  assert.deepEqual(plain(h.local.model.finalState()), before)
  await page.separateAccountGroup(tap({ id: expandedId }))
  assert.equal(page.data.accountMappings.length, 3)
  assert.equal(display.readOptions(page._accountUiDrafts).displayGroups.length, 1)
  await page.restoreAccountGroup(tap({ id: expandedId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].memberCount, 6)
  assert.equal(h.local.model.choices.accounts.size, 0)
})

test('真实 Page：拆分组一张不计入时仍在主列表相邻，全组已不计入才一起移到下方', async t => {
  const h = await setup(t), page = h.page
  const groupId = page.data.accountMappings.find(row => row.memberCount === 5).issueId
  const ids = page.mappingState().mappings.find(row => row.issueId === groupId).groupIssueIds.slice()
  await page.separateAccountGroup(tap({ id: groupId }))
  await choose(page, ids[0], 'ignore')
  await page.completeAccountMapping(tap({ id: ids[0] }))
  assert.ok(ids.every(id => page.data.accountMappingsIncluded.some(row => row.issueId === id)))
  assert.ok(ids.every(id => !page.data.accountMappingsExcluded.some(row => row.issueId === id)))
  adjacent(page, ids)
  await choose(page, ids[1], 'ignore')
  await page.completeAccountMapping(tap({ id: ids[1] }))
  assert.ok(ids.every(id => page.data.accountMappingsExcluded.some(row => row.issueId === id)))
  assert.ok(page.data.accountMappingsExcluded.some(row => row.restoreGroupId === groupId))
  assert.equal(h.local.state.drafts[groupId].confirmationDisplayMode, 'separated')
})

test('真实 Page：联合新建名称和类型编辑失焦后完整重排，创建与共享改名始终只有一个账户', async t => {
  const selected = account('合成已有账户')
  const h = await setup(t, { specs: [[3, '合成来源甲'], [2, '合成来源乙']], accounts: [selected] }), page = h.page
  const ids = page.data.accountMappings.map(row => row.issueId)
  for (const id of ids) await choose(page, id, 'account:' + selected.accountId)
  const groupId = page.data.accountMappings[0].issueId
  await choose(page, groupId, 'create')
  page.beginInputEditing(tap({ inputKey: 'synthetic-new-account' }))
  page.bindAccountDraftName({ ...tap({ id: groupId }), detail: { value: '合成共同新账户' } })
  await page.finishInputEditing()
  assert.equal(page.data.accountMappings.length, 1)
  const cashIndex = page.data.accountMappings[0].typeOptions.findIndex(option => option.value === 'cash')
  await page.changeAccountDraftType({ ...tap({ id: groupId }), detail: { value: cashIndex } })
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].draftTypeLabel, '现金')
  await page.completeAccountMapping(tap({ id: groupId }))
  assert.equal(page.data.accountStepError, '')
  const created = [...h.local.model.accounts.values()].find(row => row.isDraft)
  page.beginInputEditing(tap({ inputKey: 'synthetic-rename-shared' }))
  page.bindAccountDraftName({ ...tap({ id: groupId }), detail: { value: '合成共同账户改名' } })
  await page.finishInputEditing()
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].needsConfirmation, true)
  assert.equal(page._accountUiDrafts.get(groupId).createdAccountId, created.accountId)
  await page.completeAccountMapping(tap({ id: groupId }))
  assert.equal(page.data.accountStepError, '')
  const reopened = await coldPage(t, h)
  assert.equal(reopened.local.model.drafts.size, 1)
  assert.equal(reopened.local.model.accounts.get(created.accountId).name, '合成共同账户改名')
  assert.ok([...reopened.local.model.events.values()].every(event => event.ledgerAccountId === created.accountId))
})

test('真实 Page：恢复合并保存失败或冻结提交时保留拆分关系与原决定', async t => {
  const h = await setup(t), page = h.page
  const groupId = page.data.accountMappings.find(row => row.memberCount === 5).issueId
  await page.separateAccountGroup(tap({ id: groupId }))
  const before = plain(h.local.model.finalState())
  h.lab.fault.fn = operation => { if (operation === 'rename') throw Error('synthetic no space') }
  await page.restoreAccountGroup(tap({ id: groupId }))
  h.lab.fault.fn = null
  assert.ok(page.data.accountStepError)
  assert.equal(h.local.state.drafts[groupId].confirmationDisplayMode, 'separated')
  assert.deepEqual(plain(h.local.model.finalState()), before)
  h.local.state.postFlight = { requestId: 'synthetic-frozen-request', payload: { synthetic: true } }
  const frozen = plain(h.local.state.postFlight)
  await page.restoreAccountGroup(tap({ id: groupId }))
  assert.ok(page.data.accountStepError)
  assert.equal(h.local.state.drafts[groupId].confirmationDisplayMode, 'separated')
  assert.deepEqual(plain(h.local.state.postFlight), frozen)
  assert.deepEqual(plain(h.local.model.finalState()), before)
  h.local.state.postFlight = null
})
