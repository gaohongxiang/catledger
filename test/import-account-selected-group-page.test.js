const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { facts } = require('./helpers/local-review')
const { syntheticBill } = require('./helpers/local-services')
const { localWorkbench } = require('./helpers/local-workbench')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')

const tap = data => ({ currentTarget: { dataset: data } })
const plain = value => JSON.parse(JSON.stringify(value))
const fullLabel = '合成测试银行信用卡(6106)'
const aliasLabel = '主卡6106'
const account = (name = fullLabel, extra = {}) => ({ accountId: randomUUID(), name,
  type: 'credit', nature: 'liability', currency: 'CNY', version: 1, ...extra })
const alipay = (count, method = fullLabel, prefix = 'SYNTHETIC-SELECTED-ALI') => Buffer.from([
  '支付宝(中国)网络技术有限公司 电子客户回单',
  '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
  ...Array.from({ length: count }, (_, index) => `2026-09-01 12:00:00,餐饮美食,合成商户,合成商品,1.00,支出,${method},交易成功,,${prefix}-${index},,`)
].join('\n'))

async function setup(t, options = {}) {
  const selected = options.selected || account(), accounts = options.accounts || [selected, account('合成备用信用卡')]
  const value = await facts({ mapped: false, accounts,
    contents: options.contents || [alipay(3), syntheticBill(2, 'SYNTHETIC-SELECTED-WX', aliasLabel)] })
  const h = await localWorkbench(t, value)
  await h.page.setStep({ currentStep: 2 })
  assert.equal(h.page.data.pageError, '')
  return { ...h, value, selected, accounts }
}

async function choose(page, issueId, value) {
  await page.openAccountChoice(tap({ id: issueId }))
  assert.ok(page.data.accountChoiceSheet, '打开真实账户选择器')
  await page.selectAccountChoice(tap({ value }))
  assert.equal(page.data.pageError, '')
}

async function coldPage(t, h) {
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('本机选账户和恢复不应补读网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.page = h.createPage({}, false)
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  t.after(() => page.onUnload())
  return { page, local }
}

test('真实 Page：主卡6106手选与有名信用卡同ID立即合为待确认卡，来源和五笔保留，一次确认原子保存', async t => {
  const h = await setup(t), page = h.page
  assert.equal(page.data.accountMappings.length, 2)
  const alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  const before = plain(h.local.model.finalState()), revision = h.local.projectionRevision
  await choose(page, alias.issueId, 'account:' + h.selected.accountId)
  assert.equal(page.data.accountMappings.length, 1)
  const joint = page.data.accountMappings[0]
  assert.equal(joint.label, h.selected.name)
  assert.equal(joint.choiceValue, 'account:' + h.selected.accountId)
  assert.equal(joint.groupReason, 'selected_account')
  assert.equal(joint.groupHint, '已选择同一账户')
  assert.equal(joint.memberCount, 5)
  assert.equal(joint.groupSourceCount, 2)
  assert.equal(joint.needsConfirmation, true)
  assert.equal(joint.groupCandidate, true)
  assert.equal(page.data.accountStepSummary.displayPending, 1)
  assert.equal(h.local.state.drafts[alias.issueId].explicitAccountSelection, true)
  assert.equal(h.local.projectionRevision, revision)
  assert.deepEqual(plain(h.local.model.finalState()), before, '选择和展示合组不写入归属决定')
  assert.equal(h.local.model.choices.accounts.size, 0)
  assert.deepEqual(new Set(page.mappingState().rawMappings.map(row => row.sourceLabel)), new Set([fullLabel, aliasLabel]))
  await page.openAccountRecords(tap({ id: joint.issueId }))
  assert.equal(page.data.accountRecordsSheet.count, 5, page.data.accountRecordsSheet.error)
  assert.equal(new Set(page.data.accountRecordsSheet.records.map(row => row.eventId)).size, 5)
  page.closeAccountRecords()
  const saved = h.files.restore().records.length
  await page.completeAccountMapping(tap({ id: joint.issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.files.restore().records.length, saved + 1)
  assert.equal(h.local.model.choices.accounts.size, 2)
  assert.ok([...h.local.model.events.values()].every(event => event.ledgerAccountId === h.selected.accountId))
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
  assert.equal(h.network.length, 0)
})

test('真实 Page：仅手选但未确认的联合卡冷恢复仍待确认，不会成为已保存账户绑定', async t => {
  const h = await setup(t), alias = h.page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  await choose(h.page, alias.issueId, 'account:' + h.selected.accountId)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.length, 1)
  const card = reopened.page.data.accountMappings[0]
  assert.equal(card.groupHint, '已选择同一账户')
  assert.equal(card.choiceValue, 'account:' + h.selected.accountId)
  assert.equal(card.needsConfirmation, true)
  assert.equal(reopened.local.model.choices.accounts.size, 0)
  assert.equal(reopened.local.state.drafts[alias.issueId].explicitAccountSelection, true)
  assert.equal(h.network.length, 0)
})

test('真实 Page：两个默认建议相同不自动合组，同名新建也不合，真实手选一次才触发', async t => {
  const selected = account(aliasLabel)
  const h = await setup(t, { selected, contents: [alipay(1, aliasLabel), syntheticBill(1, 'SYNTHETIC-DEFAULT-WX', aliasLabel)] })
  assert.equal(h.page.data.accountMappings.length, 2)
  assert.ok(h.page.data.accountMappings.every(card => card.choiceValue === 'account:' + selected.accountId && card.suggestedExisting))
  await h.page.loadActivePage(true)
  assert.equal(h.page.data.accountMappings.length, 2)
  assert.equal(h.local.model.choices.accounts.size, 0)
  await choose(h.page, h.page.data.accountMappings[0].issueId, 'account:' + selected.accountId)
  assert.equal(h.page.data.accountMappings.length, 1)
  assert.equal(h.page.data.accountMappings[0].needsConfirmation, true)
  const empty = await setup(t, { accounts: [], contents: [alipay(1, aliasLabel), syntheticBill(1, 'SYNTHETIC-NEW-WX', aliasLabel)] })
  assert.equal(empty.page.data.accountMappings.length, 2)
  assert.ok(empty.page.data.accountMappings.every(card => card.choiceValue === 'create' && !card.canConfirm))
  assert.equal(empty.local.model.accounts.size, 0)
})

test('真实 Page：主动拆开保留同账户选择，重开不重并，恢复合并仍待确认', async t => {
  const h = await setup(t), alias = h.page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  await choose(h.page, alias.issueId, 'account:' + h.selected.accountId)
  const id = h.page.data.accountMappings[0].issueId
  await h.page.separateAccountGroup(tap({ id }))
  assert.equal(h.page.data.accountMappings.length, 2)
  assert.ok(h.page.data.accountMappings.every(card => card.choiceValue === 'account:' + h.selected.accountId))
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.length, 2)
  assert.ok(reopened.page.data.accountMappings.every(card => !card.groupId))
  await reopened.page.restoreAccountGroup(tap({ id }))
  assert.equal(reopened.page.data.accountMappings.length, 1)
  assert.equal(reopened.page.data.accountMappings[0].needsConfirmation, true)
  assert.equal(reopened.local.model.choices.accounts.size, 0)
})

test('真实 Page：联合卡改选另一个账户后所有原输入保留，拆开后改一张不会再自动并回', async t => {
  const h = await setup(t), page = h.page, alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  await choose(page, alias.issueId, 'account:' + h.selected.accountId)
  const id = page.data.accountMappings[0].issueId, otherId = h.accounts[1].accountId
  await choose(page, id, 'account:' + otherId)
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].choiceValue, 'account:' + otherId)
  assert.equal(page.data.accountMappings[0].needsConfirmation, true)
  for (const row of page.mappingState().rawMappings) {
    assert.equal(page._accountUiDrafts.get(row.issueId).accountId, otherId)
    assert.equal(page._accountUiDrafts.get(row.issueId).explicitAccountSelection, true)
  }
  await page.separateAccountGroup(tap({ id }))
  await choose(page, alias.issueId, 'account:' + h.selected.accountId)
  assert.equal(page.data.accountMappings.length, 2)
  assert.equal(page.data.accountMappings.find(card => card.issueId === alias.issueId).choiceValue, 'account:' + h.selected.accountId)
  assert.equal(page.data.accountMappings.find(card => card.issueId !== alias.issueId).choiceValue, 'account:' + otherId)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.length, 2)
  assert.equal(reopened.local.model.choices.accounts.size, 0)
})

test('真实 Page：已经确认的同账户可纳入，但新来的手选成员仍须确认', async t => {
  const h = await setup(t), page = h.page
  const named = page.data.accountMappings.find(card => card.sourceLabel === fullLabel)
  await page.completeAccountMapping(tap({ id: named.issueId }))
  assert.equal(h.local.model.choices.accounts.size, 1)
  const alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  await choose(page, alias.issueId, 'account:' + h.selected.accountId)
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].needsConfirmation, true)
  assert.equal(page.data.accountStepSummary.displayConfirmed, 0)
  assert.equal(h.local.model.choices.accounts.size, 1)
  const saved = h.files.restore().records.length
  await page.completeAccountMapping(tap({ id: page.data.accountMappings[0].issueId }))
  assert.equal(h.files.restore().records.length, saved + 1)
  assert.equal(h.local.model.choices.accounts.size, 2)
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
})

test('真实 Page：已确认本批新建账户被手选复用时保留创建者和改名能力，冷恢复只有一个草稿账户', async t => {
  const h = await setup(t, { accounts: [], contents: [
    syntheticBill(1, 'SYNTHETIC-REUSE-CREATOR', '合成测试银行储蓄卡(5564)'),
    syntheticBill(1, 'SYNTHETIC-REUSE-OTHER', '合成测试银行储蓄卡(7788)')
  ] }), page = h.page
  const creator = page.data.accountMappings.find(card => card.sourceLabel.includes('5564'))
  await page.completeAccountMapping(tap({ id: creator.issueId }))
  const created = [...h.local.model.accounts.values()].find(row => row.isDraft)
  const other = page.data.accountMappings.find(card => card.issueId !== creator.issueId)
  await choose(page, other.issueId, 'account:' + created.accountId)
  assert.equal(page.data.accountMappings.length, 1)
  const joint = page.data.accountMappings[0], input = page._accountUiDrafts.get(joint.issueId)
  assert.equal(joint.groupHint, '已选择同一账户')
  assert.equal(joint.needsConfirmation, true)
  assert.equal(joint.canConfirm, true)
  assert.equal(input.mode, 'create')
  assert.equal(input.createdAccountId, created.accountId)
  assert.equal(input.creatorIssueId, creator.issueId)
  await page.completeAccountMapping(tap({ id: joint.issueId }))
  page.bindAccountDraftName({ ...tap({ id: joint.issueId }), detail: { value: '合成共同账户新名' } })
  await page.completeAccountMapping(tap({ id: joint.issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.local.model.accounts.get(created.accountId).name, '合成共同账户新名')
  assert.equal(h.local.model.drafts.size, 1)
  const state = h.local.model.finalState()
  assert.equal((state.accountCreations || []).length + state.decisions.accounts.filter(choice => choice.fields?.mappingAccountDraft).length, 1)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.local.model.drafts.size, 1)
  assert.equal(reopened.local.model.accounts.get(created.accountId).name, '合成共同账户新名')
  assert.ok([...reopened.local.model.events.values()].every(event => event.ledgerAccountId === created.accountId))
})

for (const mode of ['create', 'ignore', 'external']) test('真实 Page：已保存账户改为' + mode + '后不能被另一个手选成员按旧ID吸收', async t => {
  const selected = account('合成测试银行储蓄卡(5564)', { type: 'bank', nature: 'asset' })
  const h = await setup(t, { selected, accounts: [selected], contents: [
    syntheticBill(1, 'SYNTHETIC-MODE-OLD', selected.name),
    syntheticBill(1, 'SYNTHETIC-MODE-NEW', '合成测试银行储蓄卡(7788)')
  ] }), page = h.page
  const named = page.data.accountMappings.find(card => card.sourceLabel === selected.name)
  await page.completeAccountMapping(tap({ id: named.issueId }))
  await choose(page, named.issueId, mode)
  const other = page.data.accountMappings.find(card => card.issueId !== named.issueId)
  await choose(page, other.issueId, 'account:' + selected.accountId)
  assert.equal(page.data.accountMappings.length, 2)
  assert.equal(page.data.accountMappings.find(card => card.issueId === named.issueId).choiceValue, mode)
  assert.equal(page.data.accountMappings.find(card => card.issueId === other.issueId).choiceValue, 'account:' + selected.accountId)
  assert.equal(h.local.model.choices.accounts.size, 1)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.length, 2)
  assert.equal(reopened.page.data.accountMappings.find(card => card.issueId === named.issueId).choiceValue, mode)
})

test('真实 Page：账户目录第100项之后的真实同ID选择仍可合组，未触碰默认值随补齐目录更新', async t => {
  const selected = account(fullLabel, { accountId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
  const others = Array.from({ length: 101 }, (_, index) => account('合成目录账户' + index,
    { accountId: '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0') }))
  const h = await setup(t, { selected, accounts: others.concat(selected) }), page = h.page
  const named = page.data.accountMappings.find(card => card.sourceLabel === fullLabel)
  assert.equal(named.choiceValue, 'create', '首次目录尚未读到已有账户')
  const alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  await page.openAccountChoice(tap({ id: alias.issueId }))
  await page.changeChoicePage(tap({ direction: '1' }))
  assert.ok(page._choiceRows.some(row => row.accountId === selected.accountId))
  await page.selectAccountChoice(tap({ value: 'account:' + selected.accountId }))
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].choiceValue, 'account:' + selected.accountId)
  assert.equal(page.data.accountMappings[0].canConfirm, true)
  assert.equal(page.data.accountMappings[0].validationText, '')
  assert.equal(page.data.accountMappings[0].needsConfirmation, true)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.length, 1)
  assert.equal(reopened.page.data.accountMappings[0].choiceValue, 'account:' + selected.accountId)
  assert.equal(reopened.local.model.choices.accounts.size, 0)
})

test('真实 Page：一次手选可跨账户列表页吸收同ID默认卡，返回首屏与冷恢复结果一致', async t => {
  const selected = account(), labels = Array.from({ length: 100 }, (_, index) => '合成独立来源' + index)
  const contents = [alipay(1), ...labels.map((label, index) => syntheticBill(1, 'SYNTHETIC-CROSS-PAGE-' + index, label)),
    Buffer.from(syntheticBill(1, 'SYNTHETIC-CROSS-PAGE-ALIAS', aliasLabel).toString().replace('2026-09-01', '2026-09-03'))]
  const h = await setup(t, { selected, contents }), page = h.page
  assert.equal(page.data.reviewPage.count, 102)
  assert.equal(page.data.accountMappings.length, 100)
  await page.changeReviewPage(tap({ direction: '1' }))
  const alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  assert.ok(alias)
  await choose(page, alias.issueId, 'account:' + selected.accountId)
  assert.equal(page.data.reviewPage.count, 101)
  let joint = page.data.accountMappings.find(card => card.groupReason === 'selected_account')
  if (!joint) {
    await page.changeReviewPage(tap({ direction: '1' }))
    joint = page.data.accountMappings.find(card => card.groupReason === 'selected_account')
  }
  assert.ok(joint, '从末页选择后按完整本批合组，不能只比较当前页')
  assert.equal(joint.memberCount, 2)
  assert.equal(joint.needsConfirmation, true)
  await page.changeReviewPage(tap({ direction: 'first' }))
  await page.changeReviewPage(tap({ direction: '1' }))
  assert.equal(page.data.accountMappings.length, 1)
  await page.changeReviewPage(tap({ direction: 'first' }))
  assert.equal(page.data.reviewPage.count, 101)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.reviewPage.count, 101)
  if (!reopened.page.data.accountMappings.some(card => card.groupReason === 'selected_account')) await reopened.page.changeReviewPage(tap({ direction: '1' }))
  assert.equal(reopened.page.data.accountMappings.find(card => card.groupReason === 'selected_account').choiceValue, 'account:' + selected.accountId)
  assert.equal(reopened.local.model.choices.accounts.size, 0)
})

test('真实 Page：改选B后迟到的A分组读取不能把B改回或覆盖来源', async t => {
  const h = await setup(t), page = h.page, alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  const original = page.loadDirectories
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  let block = true
  page.loadDirectories = async function (...args) {
    const result = await original.apply(this, args)
    if (block) { block = false; entered(); await new Promise(resolve => { release = resolve }) }
    return result
  }
  await page.openAccountChoice(tap({ id: alias.issueId }))
  const first = page.selectAccountChoice(tap({ value: 'account:' + h.selected.accountId }))
  await waiting
  await choose(page, alias.issueId, 'account:' + h.accounts[1].accountId)
  assert.equal(page.data.accountMappings.length, 2)
  release(); await first
  assert.equal(page.data.accountMappings.length, 2)
  const changed = page.data.accountMappings.find(card => card.issueId === alias.issueId)
  assert.equal(changed.choiceValue, 'account:' + h.accounts[1].accountId)
  assert.equal(changed.sourceLabel, aliasLabel)
  assert.equal(h.local.model.choices.accounts.size, 0)
})

test('真实 Page：分组读取中开始输入账户名称，结果到达不重排输入，失焦后保留内容再合组', async t => {
  const h = await setup(t, { contents: [alipay(3), syntheticBill(2, 'SYNTHETIC-INPUT-WX', aliasLabel),
    syntheticBill(1, 'SYNTHETIC-INPUT-OTHER', '合成另外来源')] }), page = h.page
  const alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  const other = page.data.accountMappings.find(card => card.sourceLabel === '合成另外来源')
  const original = page.loadDirectories
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  let block = true
  page.loadDirectories = async function (...args) {
    const result = await original.apply(this, args)
    if (block) { block = false; entered(); await new Promise(resolve => { release = resolve }) }
    return result
  }
  await page.openAccountChoice(tap({ id: alias.issueId }))
  const work = page.selectAccountChoice(tap({ value: 'account:' + h.selected.accountId }))
  await waiting
  page.beginInputEditing(tap({ inputKey: 'synthetic-other-input' }))
  page.bindAccountDraftName({ ...tap({ id: other.issueId }), detail: { value: '合成正在输入的新名' } })
  release(); await work
  assert.equal(page.data.accountMappings.length, 3, '编辑期间不把另一张卡合走而移动输入')
  assert.equal(page._accountUiDrafts.get(other.issueId).name, '合成正在输入的新名')
  await page.finishInputEditing()
  assert.equal(page.data.accountMappings.length, 2)
  assert.equal(page.data.accountMappings.find(card => card.issueId === other.issueId).draftName, '合成正在输入的新名')
  assert.equal(h.local.state.drafts[other.issueId].name, '合成正在输入的新名')
  assert.equal(h.local.model.choices.accounts.size, 0)
})

test('真实 Page：分组响应到达前已经失焦，也会按最新输入重读而不漏掉合组', async t => {
  const h = await setup(t, { contents: [alipay(1), syntheticBill(1, 'SYNTHETIC-BLUR-WX', aliasLabel),
    syntheticBill(1, 'SYNTHETIC-BLUR-OTHER', '合成独立来源')] }), page = h.page
  const alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  const other = page.data.accountMappings.find(card => card.sourceLabel === '合成独立来源')
  const original = page.loadDirectories
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  let block = true
  page.loadDirectories = async function (...args) {
    const result = await original.apply(this, args)
    if (block) { block = false; entered(); await new Promise(resolve => { release = resolve }) }
    return result
  }
  await page.openAccountChoice(tap({ id: alias.issueId }))
  const selecting = page.selectAccountChoice(tap({ value: 'account:' + h.selected.accountId }))
  await waiting
  page.beginInputEditing(tap({ inputKey: 'synthetic-early-blur' }))
  page.bindAccountDraftName({ ...tap({ id: other.issueId }), detail: { value: '合成失焦前输入' } })
  await page.finishInputEditing()
  release(); await selecting
  assert.equal(page.data.accountMappings.length, 2)
  assert.equal(page.data.accountMappings.find(card => card.issueId === other.issueId).draftName, '合成失焦前输入')
  assert.equal(h.local.model.choices.accounts.size, 0)
})

test('真实 Page：旧卡点击等待的重组扩大范围时不顺便确认新增成员', async t => {
  const h = await setup(t), page = h.page, alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  await page.openAccountChoice(tap({ id: alias.issueId }))
  const selecting = page.selectAccountChoice(tap({ value: 'account:' + h.selected.accountId }))
  await page.completeAccountMapping(tap({ id: alias.issueId }))
  await selecting
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].needsConfirmation, true)
  assert.match(page.data.accountStepError, /对应记录已变化/u)
  assert.equal(h.local.model.choices.accounts.size, 0)
})

test('真实 Page：手选存盘失败恢复已保存输入，不能显示未保存的合组结果', async t => {
  const h = await setup(t), page = h.page, alias = page.data.accountMappings.find(card => card.sourceLabel === aliasLabel)
  page.persistAccountDrafts()
  h.lab.fault.fn = operation => { if (operation === 'rename') throw Error('synthetic no space') }
  await choose(page, alias.issueId, 'account:' + h.selected.accountId)
  h.lab.fault.fn = null
  assert.match(page.data.accountStepError, /未保存|空间/u)
  assert.equal(page.data.accountMappings.length, 2)
  assert.equal(h.local.state.drafts[alias.issueId].explicitAccountSelection, undefined)
  assert.equal(h.local.model.choices.accounts.size, 0)
})
