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
const label = '合成测试银行储蓄卡(5564)'
const alipay = (count, method = label) => Buffer.from([
  '支付宝(中国)网络技术有限公司 电子客户回单',
  '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
  ...Array.from({ length: count }, (_, index) => `2026-09-01 12:00:00,餐饮美食,合成商户,合成商品,1.00,支出,${method},交易成功,,SYNTHETIC-JOINT-PAGE-ALI-${index},,`)
].join('\n'))
async function setup(t, options = {}) {
  const value = await facts({ contents: [alipay(3), syntheticBill(2, 'SYNTHETIC-JOINT-PAGE-WX', label), ...(options.extra || [])],
    mapped: false, accounts: options.accounts || [] })
  const h = await localWorkbench(t, value)
  await h.page.setStep({ currentStep: 2 })
  return { ...h, value }
}
async function coldPage(t, h) {
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('本机账户确认和恢复不能补读网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.page = h.createPage({}, false)
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  t.after(() => page.onUnload())
  return { page, local }
}

test('真实 Page 联合候选：3笔支付宝和2笔微信为1卡，待确认不写归属，明细覆盖两个来源', async t => {
  const h = await setup(t), page = h.page
  assert.equal(page.data.accountMappings.length, 1, page.data.pageError)
  const card = page.data.accountMappings[0]
  assert.equal(card.memberCount, 5)
  assert.equal(card.groupSourceCount, 2)
  assert.equal(card.groupCandidate, true)
  assert.equal(card.needsConfirmation, true)
  assert.equal(card.typeLocked, true)
  assert.match(card.groupSourceText, /支付宝 3 笔/u)
  assert.match(card.groupSourceText, /微信 2 笔/u)
  assert.equal(card.groupIssueIds, undefined)
  assert.equal(card.groupSources, undefined)
  assert.equal(page.businessData().accountIssues.length, 2)
  assert.equal(page.mappingState().rawMappings.length, 2)
  assert.equal(page.data.accountStepSummary.pending, 2)
  assert.equal(page.data.accountStepSummary.displayPending, 1)
  assert.equal(page.data.accountStepSummary.displayTotal, 1)
  assert.equal(page.data.accountStepSummary.suggestedCreate, 1)
  assert.equal(h.local.model.choices.accounts.size, 0)
  assert.ok([...h.local.model.events.values()].every(event => !event.ledgerAccountId))
  await page.openAccountRecords(tap({ id: card.issueId }))
  assert.equal(page.data.accountRecordsSheet.count, 5, page.data.accountRecordsSheet.error)
  assert.equal(new Set(page.data.accountRecordsSheet.records.map(row => row.eventId)).size, 5)
  assert.equal(h.network.length, 0)
})

test('真实 Page 联合新建：单次保存两个原决定、只新建一个账户，改名与冷启动维持身份', async t => {
  const h = await setup(t), page = h.page, card = page.data.accountMappings[0]
  const before = h.files.restore().records.length
  await page.completeAccountMapping(tap({ id: card.issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.files.restore().records.length, before + 1, 'UI草稿和多个原决定必须一起保存')
  assert.equal(h.local.model.choices.accounts.size, 2)
  const choices = [...h.local.model.choices.accounts.values()]
  assert.equal(choices.filter(choice => choice.fields.mappingAccountDraft).length, 1)
  assert.equal(choices.filter(choice => choice.fields.mappingAccountId).length, 1)
  const created = [...h.local.model.accounts.values()].filter(account => account.isDraft)
  assert.equal(created.length, 1)
  const id = created[0].accountId
  assert.ok([...h.local.model.events.values()].every(event => event.ledgerAccountId === id))
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountMappings[0].needsConfirmation, false)
  assert.equal(page.data.accountMappings[0].groupCandidate, false)
  assert.equal(page.data.accountStepSummary.pending, 0)
  assert.equal(page.data.accountStepSummary.displayConfirmed, 1)
  page.bindAccountDraftName({ ...tap({ id: card.issueId }), detail: { value: '合成共同银行卡' } })
  await page.completeAccountMapping(tap({ id: card.issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.local.model.accounts.get(id).name, '合成共同银行卡')
  assert.equal([...h.local.model.accounts.values()].filter(account => account.isDraft).length, 1)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.local.model.invalid.size, 0)
  assert.equal(reopened.page.data.accountMappings.length, 1)
  assert.equal(reopened.page.data.accountMappings[0].needsConfirmation, false)
  assert.equal(reopened.local.model.accounts.get(id).name, '合成共同银行卡')
  assert.ok([...reopened.local.model.events.values()].every(event => event.ledgerAccountId === id))
  assert.equal(h.network.length, 0)
})

test('真实 Page 共享新建拆开后创建者改外部，另一来源继续引用同一草稿并可冷启动', async t => {
  const h = await setup(t), page = h.page, joint = page.data.accountMappings[0]
  await page.completeAccountMapping(tap({ id: joint.issueId }))
  const created = [...h.local.model.accounts.values()].find(account => account.isDraft)
  await page.separateAccountGroup(tap({ id: joint.issueId }))
  const creator = [...h.local.model.choices.accounts.values()].find(choice => choice.fields.mappingAccountDraft)
  const reuse = [...h.local.model.choices.accounts.values()].find(choice => choice.fields.mappingAccountId)
  await page.openAccountChoice(tap({ id: creator.key }))
  page.selectAccountChoice(tap({ value: 'external' }))
  await page.completeAccountMapping(tap({ id: creator.key }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.local.model.choices.accounts.get(creator.key).paymentRuleAction, 'external')
  assert.equal(h.local.model.choices.accounts.get(reuse.key).fields.mappingAccountId, created.accountId)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.local.model.invalid.size, 0)
  assert.ok(reopened.local.model.accounts.has(created.accountId))
  assert.equal(reopened.page.data.accountMappings.find(card => card.issueId === reuse.key).choiceValue, 'account:' + created.accountId)
  assert.equal(reopened.page.data.accountMappings.find(card => card.issueId === reuse.key).needsConfirmation, false)
})

test('真实 Page 全部建议：联合卡只计1项新建，取消不改原决定，确认整次保存', async t => {
  const h = await setup(t, { extra: [syntheticBill(1, 'SYNTHETIC-JOINT-OTHER', '微信零钱')] }), page = h.page
  assert.equal(page.data.accountStepSummary.suggested, 2)
  assert.equal(page.data.accountStepSummary.suggestedCreate, 2)
  h.wx.showModal = options => { h.modal = options; options.success({ confirm: false }) }
  await page.confirmAllAccountMappings()
  assert.equal(h.modal.content, '将确认 2 项建议，其中新建 2 个账户。')
  assert.equal(h.local.model.choices.accounts.size, 0)
  assert.equal([...h.local.model.accounts.values()].filter(row => row.isDraft).length, 0)
  h.wx.showModal = options => options.success({ confirm: true })
  const before = h.files.restore().records.length
  await page.confirmAllAccountMappings()
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.files.restore().records.length, before + 1)
  assert.equal(h.local.model.choices.accounts.size, 3)
  assert.equal([...h.local.model.accounts.values()].filter(row => row.isDraft).length, 2)
  assert.equal(page.data.accountStepSummary.pending, 0)
})

test('真实 Page 分别确认保留原选择，在本批重开仍拆分，不能用同名独立创建静默合并', async t => {
  const h = await setup(t), page = h.page, original = page.businessData().accountIssues.map(issue => issue.issueId)
  const revision = h.local.projectionRevision
  await page.separateAccountGroup(tap({ id: page.data.accountMappings[0].issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(page.data.accountMappings.length, 2)
  assert.equal(h.local.projectionRevision, revision, '拆分是本批显示偏好，不能改原事实版本')
  assert.equal(h.local.model.choices.accounts.size, 0)
  for (const id of original) assert.equal(h.local.state.drafts[id].confirmationSeparate, true)
  assert.ok(page.data.accountMappings.every(card => !card.groupId && !card.canConfirm))
  const reopened = await coldPage(t, h)
  assert.equal(reopened.page.data.accountMappings.length, 2)
  assert.ok(reopened.page.data.accountMappings.every(card => !card.groupId))
  const first = reopened.page.data.accountMappings[0]
  reopened.page.bindAccountDraftName({ ...tap({ id: first.issueId }), detail: { value: '合成来源甲卡' } })
  await reopened.page.completeAccountMapping(tap({ id: first.issueId }))
  assert.equal(reopened.page.data.accountStepError, '')
  const second = reopened.page.data.accountMappings.find(card => card.issueId !== first.issueId)
  reopened.page.bindAccountDraftName({ ...tap({ id: second.issueId }), detail: { value: '合成来源乙卡' } })
  await reopened.page.completeAccountMapping(tap({ id: second.issueId }))
  assert.equal(reopened.page.data.accountStepError, '')
  assert.equal(new Set([...reopened.local.model.events.values()].map(event => event.ledgerAccountId)).size, 2)
})

test('真实 Page 弹窗期间原决定或显示成员变化时不确认旧建议', async t => {
  const h = await setup(t), page = h.page
  let modal
  h.wx.showModal = options => { modal = options }
  const waiting = page.confirmAllAccountMappings()
  assert.ok(modal)
  const card = page.data.accountMappings[0]
  page.bindAccountDraftName({ ...tap({ id: card.issueId }), detail: { value: '弹窗期间更改' } })
  modal.success({ confirm: true })
  await waiting
  assert.match(page.data.accountStepError, /已变化/u)
  assert.equal(h.local.model.choices.accounts.size, 0)
  assert.equal(page._accountUiDrafts.get(card.issueId).name, '弹窗期间更改')
})

test('真实 Page 原来源建议到不同账户时保留待选，不能靠合组任意取推荐', async t => {
  const labels = ['合成测试银行储蓄卡(5564)', '合成测试银行借记卡(5564)']
  const accounts = labels.map(name => ({ accountId: randomUUID(), name, type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }))
  const value = await facts({ contents: [alipay(3, labels[0]), syntheticBill(2, 'SYNTHETIC-JOINT-CONFLICT', labels[1])], mapped: false, accounts })
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(new Set(page.mappingState().rawMappings.map(row => row.recommendedAccountId)).size, 2)
  const joint = page.data.accountMappings[0]
  assert.equal(joint.choiceValue, 'pending')
  assert.equal(joint.canConfirm, false)
  assert.match(joint.validationText, /建议不同/u)
  assert.equal(page.data.accountStepSummary.suggested, 0)
  await page.confirmAllAccountMappings()
  assert.equal(h.local.model.choices.accounts.size, 0)
  await page.openAccountChoice(tap({ id: joint.issueId }))
  page.selectAccountChoice(tap({ value: 'account:' + accounts[1].accountId }))
  await page.completeAccountMapping(tap({ id: joint.issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.ok([...h.local.model.events.values()].every(event => event.ledgerAccountId === accounts[1].accountId))
  assert.equal([...h.local.model.accounts.values()].filter(row => row.isDraft).length, 0)
})

test('真实 Page 候选只提供共同合法账户类型，单类型锁定和原外部提示保留', async t => {
  const accounts = ['bank', 'wallet', 'credit'].map(type => ({ accountId: randomUUID(), name: '合成' + type,
    type, nature: type === 'credit' ? 'liability' : 'asset', currency: 'CNY', version: 1 }))
  const h = await setup(t, { accounts }), page = h.page, card = page.data.accountMappings[0]
  assert.deepEqual(plain(card.typeOptions).map(row => row.value), ['bank'])
  await page.openAccountChoice(tap({ id: card.issueId }))
  assert.deepEqual(plain(page.data.accountChoiceResults).map(row => row.accountId), [accounts[0].accountId])
  page.selectAccountChoice(tap({ value: 'account:' + accounts[2].accountId }))
  assert.equal(page._accountUiDrafts.get(card.issueId).mode, 'create', '非法类型不应进入草稿')
  // 原用户追加的复杂资金提示：联合卡任一来源携带真实复杂结构即继续提示。
  page.businessData().accountIssues[1].subject.paymentAccounts = [{ accountId: accounts[0].accountId, amountMinor: '100' }]
  page.selectAccountChoice(tap({ value: 'external' }))
  assert.equal(page.data.accountMappings[0].choiceValue, 'external')
  assert.match(page.data.accountMappings[0].ownershipNote, /资金关系还要在整理页补齐/u)
})

test('真实 Page 类型建议冲突保持待选择，多种合法类型不能取第一项现金', t => {
  const h = require('./helpers/paged-workbench').runtime(), page = h.page
  t.after(() => page.onUnload())
  page._draftSession = null; page._businessData = null
  const types = ['cash', 'bank', 'wallet', 'credit', 'other_asset', 'other_liability']
  const issues = ['bank', 'wechat'].map((sourceType, index) => ({ issueId: 'synthetic-type-conflict-' + index,
    issueType: 'account_mapping', status: 'open', version: 1, memberCount: 1,
    accountContext: { recognized: true, label: '合成号码5564', sourceType, expectedAccountType: null,
      allowedAccountTypes: types, currency: 'CNY', canExternal: true }, subject: { eventId: 'synthetic-type-event-' + index, economicNature: 'expense' } }))
  const group = { groupId: 'synthetic-type-group', issueIds: issues.map(issue => issue.issueId), anchorIssueId: issues[0].issueId,
    label: '合成号码5564', allowedAccountTypes: types, currency: 'CNY', memberCount: 2, sourceCount: 2, sources: [], candidate: true, canExternal: true }
  Object.assign(page.data, { accountIssues: issues, accountDisplayGroups: [group], accounts: [], accountDrafts: [] })
  const state = page.refreshAccountMappings()
  assert.equal(state.mappings.length, 1)
  assert.equal(state.mappings[0].choiceValue, 'pending')
  assert.equal(state.mappings[0].draftTypeIndex, -1)
  assert.equal(state.mappings[0].canConfirm, false)
  assert.match(state.mappings[0].validationText, /类型不同/u)
  assert.equal(state.summary.suggested, 0)
})

test('真实 Page 联合输入拆分后保留，落盘失败不生成半个联合决定', async t => {
  const h = await setup(t), page = h.page, joint = page.data.accountMappings[0]
  page.bindAccountDraftName({ ...tap({ id: joint.issueId }), detail: { value: '共同输入待核对' } })
  await page.separateAccountGroup(tap({ id: joint.issueId }))
  assert.ok(page.data.accountMappings.every(card => card.draftName === '共同输入待核对' && card.dirty))
  assert.equal(h.local.model.choices.accounts.size, 0)
  const other = await setup(t), otherCard = other.page.data.accountMappings[0]
  const before = JSON.stringify(other.local.model.finalState())
  other.lab.fault.fn = name => { if (name === 'rename') throw Error('synthetic storage fault') }
  await other.page.completeAccountMapping(tap({ id: otherCard.issueId }))
  other.lab.fault.fn = null
  assert.ok(other.page.data.accountStepError)
  assert.equal(JSON.stringify(other.local.model.finalState()), before)
  assert.equal(other.local.model.choices.accounts.size, 0)
  assert.equal(other.page.data.accountMappings[0].needsConfirmation, true)
})

test('真实 Page 大联合组的setData只含短来源摘要，原范围保留在业务对象', async t => {
  const contents = Array.from({ length: 121 }, (_, index) => syntheticBill(1, 'SYNTHETIC-JOINT-LARGE-' + index, label))
  const value = await facts({ contents, mapped: false, accounts: [] }), h = await localWorkbench(t, value)
  await h.page.setStep({ currentStep: 2 })
  const card = h.page.data.accountMappings[0]
  assert.equal(h.page.data.accountMappings.length, 1)
  assert.equal(card.memberCount, 121)
  assert.equal(card.groupSourceCount, 121)
  assert.equal(h.page.mappingState().mappings[0].groupIssueIds.length, 121)
  assert.ok(Buffer.byteLength(JSON.stringify(card)) < 4000)
  assert.equal(card.groupIssueIds, undefined)
  assert.equal(card.groupSources, undefined)
  assert.ok(Math.max(...h.patches) < 48 * 1024)
})

test('真实 Page 联合确认保存后读取尚未返回，隐藏页面不能继续重绘或启动下一次读取', async t => {
  const h = await setup(t), page = h.page, apply = page.applyUpdateView, load = page.loadActivePage
  let release, blocked = false, loads = 0
  const pending = new Promise(resolve => { release = resolve })
  page.loadActivePage = function (...args) { loads++; return load.apply(this, args) }
  page.applyUpdateView = function (...args) {
    const result = apply.apply(this, args)
    return args[1] ? result : Promise.resolve(result).then(() => { blocked = true; return pending })
  }
  const work = page.completeAccountMapping(tap({ id: page.data.accountMappings[0].issueId }))
  for (let attempt = 0; attempt < 20 && !blocked; attempt++) await h.flush()
  assert.equal(blocked, true)
  assert.equal(h.local.model.choices.accounts.size, 2, '决定已在旧会话原子保存')
  page.onHide()
  const previousLoads = loads, previousPatches = h.patches.length
  release()
  await work
  assert.equal(loads, previousLoads)
  assert.equal(h.patches.length, previousPatches, '隐藏后不清busy、不覆盖错误、不重绘旧账户页')
})

test('真实 Page 批量确认最后读取迟到失败，不能覆盖另一个登录会话的状态', async t => {
  const h = await setup(t), page = h.page, apply = page.applyUpdateView, load = page.loadActivePage
  let reject, phase = 'initial'
  const pending = new Promise((resolve, failure) => { reject = failure })
  page.applyUpdateView = function (...args) {
    const result = apply.apply(this, args)
    return args[1] ? result : Promise.resolve(result).then(() => { phase = 'saved' })
  }
  page.loadActivePage = function (...args) {
    if (phase === 'saved') { phase = 'blocked'; return pending }
    return load.apply(this, args)
  }
  const work = page.confirmAllAccountMappings()
  for (let attempt = 0; attempt < 20 && phase !== 'blocked'; attempt++) await h.flush()
  assert.equal(phase, 'blocked')
  assert.equal(h.local.model.choices.accounts.size, 2)
  h.app.globalData.uid = 'synthetic-other-owner'
  page._viewEpoch++
  page.setData({ accountStepError: '新会话的提示', accountStepBusy: true, accountStepProgressText: '新会话的操作' })
  const previousPatches = h.patches.length
  reject(Error('synthetic late read error'))
  await work
  assert.equal(h.patches.length, previousPatches)
  assert.equal(page.data.accountStepError, '新会话的提示')
  assert.equal(page.data.accountStepBusy, true)
  assert.equal(page.data.accountStepProgressText, '新会话的操作')
})

test('真实 Page 拆分偏好随剩余联合子组明细读取传入，不重新合入已拆来源', async t => {
  const accountId = randomUUID(), account = { accountId, name: '合成共同卡', type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }
  const other = '合成测试银行储蓄卡(7788)'
  const value = await facts({ mapped: false, accounts: [account], contents: [
    syntheticBill(1, 'SYNTHETIC-DETAIL-SPLIT-A1', label), syntheticBill(1, 'SYNTHETIC-DETAIL-SPLIT-A2', label),
    syntheticBill(1, 'SYNTHETIC-DETAIL-SPLIT-B1', other), syntheticBill(1, 'SYNTHETIC-DETAIL-SPLIT-B2', other)] })
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  await page.separateAccountGroup(tap({ id: page.data.accountMappings[0].issueId }))
  h.local.confirmAccountGroups({ groups: value.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => ({
    issueIds: [issue.issueId], decision: { decision: 'apply_fields', fields: { mappingAccountId: accountId } }
  })) })
  await page.applyUpdateView(h.local.view)
  await page.loadActivePage(true)
  assert.equal(page.data.accountMappings.length, 3)
  const joint = page.data.accountMappings.find(card => card.groupId)
  assert.equal(joint.memberCount, 2)
  await page.openAccountRecords(tap({ id: joint.issueId }))
  assert.equal(Boolean(page.data.accountRecordsSheet.error), false)
  assert.equal(page.data.accountRecordsSheet.count, 2)
  assert.equal(page.data.accountRecordsSheet.records.length, 2)
})

test('真实 Page 联合范围扩大时旧选择仍待核对，覆盖确认同次清理旧group草稿', async t => {
  const accounts = ['合成账户甲', '合成账户乙'].map(name => ({ accountId: randomUUID(), name, type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }))
  const value = await facts({ mapped: false, accounts, contents: [
    syntheticBill(1, 'SYNTHETIC-SCOPE-A1', label), syntheticBill(1, 'SYNTHETIC-SCOPE-A2', label),
    syntheticBill(1, 'SYNTHETIC-SCOPE-B1', '合成测试银行储蓄卡(7788)'), syntheticBill(1, 'SYNTHETIC-SCOPE-B2', '合成测试银行储蓄卡(7788)')] })
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  const first = page.data.accountMappings[0].issueId
  const select = async (id, accountId) => { await page.openAccountChoice(tap({ id })); page.selectAccountChoice(tap({ value: 'account:' + accountId })) }
  await select(first, accounts[0].accountId)
  await page.completeAccountMapping(tap({ id: first }))
  await select(first, accounts[1].accountId)
  const second = page.data.accountMappings.find(card => card.issueId !== first).issueId
  await select(second, accounts[0].accountId)
  await page.completeAccountMapping(tap({ id: second }))
  const expanded = page.data.accountMappings[0]
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(expanded.memberCount, 4)
  assert.equal(expanded.choiceValue, 'pending')
  assert.equal(expanded.needsConfirmation, true)
  assert.equal(page.data.accountStepSummary.displayPending, 1)
  const priorIds = page._accountUiDrafts.get(first).confirmationIssueIds
  assert.ok(priorIds.every(id => page._accountUiDrafts.get(id).accountId === accounts[1].accountId && page._accountUiDrafts.get(id).dirty))
  assert.ok([...h.local.model.events.values()].every(event => event.ledgerAccountId === accounts[0].accountId), '未确认输入不能成为业务决定')
  await select(expanded.issueId, accounts[1].accountId)
  const before = h.files.restore().records.length
  await page.completeAccountMapping(tap({ id: expanded.issueId }))
  assert.equal(h.files.restore().records.length, before + 1)
  assert.equal(h.local.state.drafts[first], undefined)
  assert.equal(h.local.state.drafts[second], undefined)
  assert.equal(page.data.accountStepSummary.pending, 0)
  assert.ok([...h.local.model.events.values()].every(event => event.ledgerAccountId === accounts[1].accountId))
})

test('真实 Page 共享新建未确认改名遇范围扩大，拆开核对仍只有原创建者改名', async t => {
  const value = await facts({ mapped: false, accounts: [], contents: [
    syntheticBill(1, 'SYNTHETIC-SCOPE-NAME-A1', label), syntheticBill(1, 'SYNTHETIC-SCOPE-NAME-A2', label),
    syntheticBill(1, 'SYNTHETIC-SCOPE-NAME-B1', '合成测试银行储蓄卡(7788)'), syntheticBill(1, 'SYNTHETIC-SCOPE-NAME-B2', '合成测试银行储蓄卡(7788)')] })
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  const first = page.data.accountMappings[0].issueId
  await page.completeAccountMapping(tap({ id: first }))
  const created = [...h.local.model.accounts.values()].find(account => account.isDraft)
  page.bindAccountDraftName({ ...tap({ id: first }), detail: { value: '待确认的新卡名' } })
  page.flushAccountDraftSync()
  const second = page.data.accountMappings.find(card => card.issueId !== first).issueId
  await page.openAccountChoice(tap({ id: second }))
  page.selectAccountChoice(tap({ value: 'account:' + created.accountId }))
  await page.completeAccountMapping(tap({ id: second }))
  const expanded = page.data.accountMappings[0]
  assert.equal(expanded.choiceValue, 'pending')
  assert.equal(page.data.accountMappings.length, 1)
  await page.separateAccountGroup(tap({ id: expanded.issueId }))
  const pending = page.data.accountMappings.filter(card => card.dirty)
  assert.equal(pending.length, 2)
  assert.equal(pending.filter(card => card.choiceValue === 'create').length, 1)
  assert.equal(pending.find(card => card.choiceValue === 'create').draftName, '待确认的新卡名')
  for (const card of pending) await page.completeAccountMapping(tap({ id: card.issueId }))
  assert.equal(page.data.accountStepError, '')
  assert.equal(h.local.model.accounts.get(created.accountId).name, '待确认的新卡名')
  assert.equal([...h.local.model.accounts.values()].filter(account => account.isDraft).length, 1)
  assert.equal([...h.local.model.choices.accounts.values()].filter(choice => choice.fields.mappingAccountDraft).length, 1)
  assert.equal(h.local.state.drafts[first], undefined)
  assert.equal(page.data.accountStepSummary.pending, 0)
  const reopened = await coldPage(t, h)
  assert.equal(reopened.local.model.invalid.size, 0)
  assert.equal(reopened.local.model.accounts.get(created.accountId).name, '待确认的新卡名')
})

test('真实 Page 101张显示卡按100卡分页，离页输入阻止继续和入账，拆分偏好不被翻页清理', async t => {
  const labels = Array.from({ length: 101 }, (_, index) => '合成银行储蓄卡(' + String(5000 + index) + ')')
  const accounts = labels.map(name => ({ accountId: randomUUID(), name, type: 'bank', nature: 'asset', currency: 'CNY', version: 1 }))
  const contents = [syntheticBill(1, 'SYNTHETIC-PAGE-GATE-A1', labels[0]), syntheticBill(1, 'SYNTHETIC-PAGE-GATE-A2', labels[0]),
    ...labels.slice(1).map((name, index) => Buffer.from(syntheticBill(1, 'SYNTHETIC-PAGE-GATE-OTHER-' + index, name)
      .toString().replace('2026-09-01', '2026-09-02')))]
  const value = await facts({ contents, accounts, mapped: false }), h = await localWorkbench(t, value), page = h.page
  h.local.confirmAccountGroups({ groups: value.issues.filter(issue => issue.issueType === 'account_mapping').map(issue => ({
    issueIds: [issue.issueId], decision: { decision: 'apply_fields', fields: {
      mappingAccountId: accounts.find(account => account.name === issue.accountContext.label).accountId
    } }
  })) })
  await page.applyUpdateView(h.local.view)
  await page.setStep({ currentStep: 2 })
  assert.equal(page.data.pageError, '')
  assert.equal(page.data.accountMappings.length, 100)
  assert.equal(page.data.reviewPage.count, 101)
  const joint = page.data.accountMappings.find(card => card.groupId)
  await page.openAccountChoice(tap({ id: joint.issueId }))
  page.selectAccountChoice(tap({ value: 'account:' + accounts[1].accountId }))
  await page.changeReviewPage(tap({ direction: '1' }))
  assert.equal(page.data.accountMappings.length, 1)
  assert.equal(page.data.accountStepSummary.displayPending, 0)
  assert.equal(page.data.accountStepSummary.pendingOutside, true)
  assert.ok(page.data.accountStepSummary.pending > 0)
  assert.equal(page._accountUiDrafts.get(joint.issueId).dirty, true)
  await page.goToStep(tap({ step: 3 }))
  assert.equal(page.data.currentStep, 2)
  await page.postUpdate()
  assert.equal(page.data.currentStep, 2)
  assert.match(page.data.errorMessage, /确认保留的账户选择/u)
  assert.equal(h.local.state.postFlight, null)
  assert.equal(h.network.length, 0)
  await page.openAccountChoice(tap({ id: joint.issueId }))
  page.selectAccountChoice(tap({ value: 'account:' + accounts[0].accountId }))
  await page.completeAccountMapping(tap({ id: joint.issueId }))
  assert.equal(page.data.accountStepSummary.pending, 0)
  const originalIds = page.mappingState().mappings.find(card => card.groupId).groupIssueIds
  await page.separateAccountGroup(tap({ id: page.data.accountMappings.find(card => card.groupId).issueId }))
  await page.changeReviewPage(tap({ direction: '1' }))
  assert.equal(page.data.accountMappings.length, 2)
  assert.ok(originalIds.every(id => page._accountUiDrafts.get(id).confirmationSeparate))
  await page.changeReviewPage(tap({ direction: 'first' }))
  assert.equal(page.data.accountMappings.length, 100)
  assert.ok(page.data.accountMappings.every(card => !card.groupId))
  assert.ok(originalIds.every(id => h.local.state.drafts[id].confirmationSeparate))
  assert.ok(Math.max(...h.patches) <= 64 * 1024, '每次原生桥接仍遵守原预算，未放宽100卡分页和单项限制')
})
