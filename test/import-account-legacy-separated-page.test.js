const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const { localWorkbench } = require('./helpers/local-workbench')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')

const tap = dataset => ({ currentTarget: { dataset } })
const plain = value => JSON.parse(JSON.stringify(value))
const fullLabel = '合成测试银行信用卡(6106)', aliasLabel = '主卡6106'
const account = (name, type = 'credit') => ({ accountId: randomUUID(), name, type,
  nature: type === 'credit' ? 'liability' : 'asset', currency: 'CNY', version: 1 })

async function choose(page, id, accountId) {
  await page.openAccountChoice(tap({ id }))
  await page.selectAccountChoice(tap({ value: 'account:' + accountId }))
  assert.equal(page.data.accountStepError, '')
}

async function reopen(t, h) {
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('旧拆分显示关系恢复不能调用网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.page = h.createPage({}, false)
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  t.after(() => page.onUnload())
  assert.equal(page.data.pageError, '')
  return { ...h, page, local }
}

async function setupLegacy(t, mode = 'same') {
  const credit = account(fullLabel), other = account('合成备用信用卡'), wallet = account('微信零钱', 'wallet')
  const alipay = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    ...Array.from({ length: 2 }, (_, index) => `2026-09-01 12:00:00,餐饮美食,合成商户,合成商品,1.00,支出,${fullLabel},交易成功,,SYNTHETIC-LEGACY-ALI-${index},,`)].join('\n'))
  const data = await facts({ mapped: false, accounts: [credit, other, wallet], contents: [alipay,
    syntheticBill(5, 'SYNTHETIC-LEGACY-ALIAS', aliasLabel), syntheticBill(3, 'SYNTHETIC-LEGACY-WALLET', '微信零钱')] })
  const h = await localWorkbench(t, data), page = h.page
  await page.setStep({ currentStep: 2 })
  const aliasId = page.data.accountMappings.find(row => row.sourceLabel === aliasLabel).issueId
  const fullId = page.data.accountMappings.find(row => row.sourceLabel === fullLabel).issueId
  await choose(page, aliasId, credit.accountId)
  const jointId = page.data.accountMappings.find(row => row.groupId).issueId
  if (mode !== 'unknown') await page.completeAccountMapping(tap({ id: jointId }))
  await page.separateAccountGroup(tap({ id: jointId }))
  if (mode === 'different') {
    await choose(page, aliasId, other.accountId)
    await page.completeAccountMapping(tap({ id: aliasId }))
  }
  const walletId = page.data.accountMappings.find(row => row.sourceLabel === '微信零钱').issueId
  await page.completeAccountMapping(tap({ id: walletId }))
  assert.equal(page.data.accountStepError, '')
  const separated = page.data.accountMappings.filter(row => [aliasId, fullId].includes(row.issueId))
  assert.equal(separated.length, 2)
  assert.ok(separated.every(row => row.accountSeparatedGroupId === jointId && !row.groupId),
    '有效的新拆分关系优先，不能被旧草稿恢复规则覆盖')
  const before = plain(h.local.model.finalState()), drafts = plain(h.local.state.drafts)
  assert.equal(drafts[aliasId].confirmationSeparate, true)
  assert.equal(drafts[fullId].confirmationSeparate, true)
  // Old versions removed the joint draft after the last child was confirmed.
  // Keep the real saved account choices and only reproduce that old UI shape.
  delete drafts[jointId]
  h.local.saveDrafts(drafts)
  return { ...await reopen(t, h), aliasId, fullId, before, credit, other }
}

test('旧拆分草稿冷恢复：异名同ID保持分卡相邻，现有合回入口只改显示，无须再确认', async t => {
  let h = await setupLegacy(t), page = h.page
  assert.equal(page.data.accountMappings.length, 3, '旧分别确认意图仍保留，不能自动强合')
  assert.deepEqual(plain(page.data.accountMappings.map(row => row.memberCount)), [5, 2, 3])
  const alias = page.data.accountMappings.find(row => row.issueId === h.aliasId)
  const full = page.data.accountMappings.find(row => row.issueId === h.fullId)
  const groupId = alias.accountSeparatedGroupId
  assert.ok(groupId)
  assert.equal(full.accountSeparatedGroupId, groupId)
  assert.equal(alias.restoreGroupId, groupId)
  assert.equal(alias.restoreBlocked, false)
  const descriptor = page.businessData().accountDisplayGroups.find(group => group.groupId === groupId)
  assert.equal(descriptor.memberCount, 7)
  assert.equal(descriptor.separateMemberCount, 7)
  assert.equal(alias.accountSeparatedCountNote, '', '完整旧组已知没有重叠，不提示存在相同交易')
  assert.ok(!full.accountSeparatedCountNote)
  assert.ok(!alias.groupDeduplicated && !full.groupDeduplicated, '分开的原卡不显示去重后前缀')
  // 兼容缺完整分组详情的旧 Page 输入，只给不带数字的可能性说明，不能从当前页推断重叠。
  const data = page.businessData()
  const compatible = page.buildAccountMappingState(data.accountIssues, data.accounts, data.accountDrafts, [], [])
  assert.equal(compatible.mappings.find(row => row.restoreGroupId === groupId).accountSeparatedCountNote,
    '各来源可能包含同一笔交易')
  assert.equal(page.data.accountStepSummary.displayPending, 0)
  assert.deepEqual(plain(h.local.model.finalState()), h.before)
  const revision = h.local.projectionRevision
  await page.restoreAccountGroup(tap({ id: groupId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(page.data.accountMappings.length, 2)
  const joint = page.data.accountMappings.find(row => row.groupId)
  assert.equal(joint.memberCount, 7)
  assert.equal(joint.choiceValue, 'account:' + h.credit.accountId)
  assert.equal(joint.needsConfirmation, false)
  assert.equal(joint.groupDeduplicated, false, '无重叠的5笔和2笔合回后不标去重后')
  assert.equal(joint.groupCountNote, undefined, '合卡不再有单独去重说明')
  assert.equal(joint.groupConfirmationText, '这些交易使用同一账户')
  assert.equal(h.local.projectionRevision, revision)
  assert.deepEqual(plain(h.local.model.finalState()), h.before)
  h = await reopen(t, h)
  assert.equal(h.page.data.accountMappings.length, 2)
  assert.equal(h.page.data.accountMappings.find(row => row.groupId).needsConfirmation, false)
  assert.equal(h.page.data.accountMappings.find(row => row.groupId).groupDeduplicated, false)
  assert.equal(h.page.data.accountMappings.find(row => row.groupId).groupCountNote, undefined)
  assert.deepEqual(plain(h.local.model.finalState()), h.before)
  assert.equal(h.network.length, 0)
})

for (const mode of ['different', 'unknown']) test('旧异名孤立拆分标记不凭名称恢复组：' + mode, async t => {
  const h = await setupLegacy(t, mode)
  assert.equal(h.page.data.accountMappings.length, 3)
  const cards = h.page.data.accountMappings.filter(row => [h.aliasId, h.fullId].includes(row.issueId))
  assert.equal(cards.length, 2)
  assert.ok(cards.every(row => !row.accountSeparatedGroupId && !row.restoreGroupId && !row.groupId))
  if (mode === 'different') assert.notEqual(cards[0].choiceValue, cards[1].choiceValue)
  else assert.ok(cards.every(row => row.needsConfirmation))
  assert.deepEqual(plain(h.local.model.finalState()), h.before)
  assert.equal(h.network.length, 0)
})

test('旧拆分恢复的新显示组不能覆盖同账户已有的有效拆分组', async t => {
  const credit = account(fullLabel), labels = [aliasLabel, fullLabel, '合成来源甲信用卡(7101)', '合成来源乙信用卡(7102)']
  const data = await facts({ mapped: false, accounts: [credit], contents: labels.map((label, index) =>
    syntheticBill([5, 2, 4, 1][index], 'SYNTHETIC-LEGACY-SCOPES-' + index, label)) })
  let h = await localWorkbench(t, data)
  h.local.confirmAccountGroups({ groups: data.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => ({
    issueIds: [issue.issueId], decision: { decision: 'apply_fields', fields: { mappingAccountId: credit.accountId } }
  })) })
  await h.page.applyUpdateView(h.local.view)
  await h.page.setStep({ currentStep: 2 })
  const jointId = h.page.data.accountMappings[0].issueId
  const ids = labels.map(label => h.page.mappingState().rawMappings.find(row => row.sourceLabel === label).issueId)
  await h.page.separateAccountGroup(tap({ id: jointId }))
  const saved = plain(h.local.state.drafts), before = plain(h.local.model.finalState())
  delete saved[jointId]
  // A previously restored legacy group may already use the account-only ID.
  // Its saved range remains authoritative; the other two old flags are orphaned.
  const priorGroupId = 'legacy:account:' + credit.accountId + ':CNY'
  saved[priorGroupId] = { confirmationDisplayMode: 'separated', confirmationIssueIds: ids.slice(0, 2),
    separated: true, separatedMembers: ids.slice(0, 2), dirty: false, localConfirmed: false }
  h.local.saveDrafts(saved)
  h = await reopen(t, h)
  const cards = new Map(h.page.data.accountMappings.map(row => [row.issueId, row]))
  assert.equal(cards.size, 4)
  assert.equal(cards.get(ids[0]).accountSeparatedGroupId, priorGroupId)
  assert.equal(cards.get(ids[1]).accountSeparatedGroupId, priorGroupId)
  const recoveredId = cards.get(ids[2]).accountSeparatedGroupId
  assert.ok(recoveredId)
  assert.notEqual(recoveredId, priorGroupId)
  assert.equal(cards.get(ids[3]).accountSeparatedGroupId, recoveredId)
  assert.equal(h.page.data.accountMappings.filter(row => row.restoreGroupId).length, 2)
  assert.deepEqual(plain(h.local.state.drafts[priorGroupId].confirmationIssueIds), ids.slice(0, 2))
  await h.page.restoreAccountGroup(tap({ id: priorGroupId }))
  assert.equal(h.page.data.accountStepError, '')
  assert.equal(h.page.data.accountMappings.length, 3)
  assert.equal(h.page.data.accountMappings.find(row => row.groupId).memberCount, 7)
  assert.ok(ids.slice(2).every(id => h.local.state.drafts[id].confirmationSeparate))
  assert.deepEqual(plain(h.local.model.finalState()), before)
  assert.equal(h.network.length, 0)
})
