const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {facts}=require('./helpers/local-review')
const {localWorkbench}=require('./helpers/local-workbench')
const tap=data=>({currentTarget:{dataset:data}})
const text=(page,field,value)=>page.changeEditorText({...tap({field}),detail:{value}})

async function compositeRepaymentFacts(count = 1) {
  const accountId = randomUUID()
  const content = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    ...Array.from({ length: count }, (_, index) => `2026-09-0${index + 1} 12:00:00,信用借还,1688先采后付,合成组合还款,10.00,支出,测试银行储蓄卡(1234)&账户余额,交易成功,,SYNTHETIC-TARGET-ACCOUNT-${index},,`)
  ].join('\n'))
  const paymentMethodKey = require('../cloudfunctions/catledger-import/src/identity').buildPaymentMethodKey('alipay', '1688先采后付')
  const value = await facts({ content,
    accounts: [{ accountId, name: '合成还款目标', type: 'credit', nature: 'liability', currency: 'CNY', version: 1 }],
    paymentMappings: [{ sourceType: 'alipay', paymentMethodKey, paymentMethodHint: '1688先采后付',
      mappingAction: 'account', accountId, mappingScope: 'history' }] })
  return { value, accountId, target: value.issues.find(issue => issue.accountContext?.fundsSide === 'payment_target') }
}

test('真实账户页：重新上传的组合还款目标沿用账户，不能误显为本次不计入', async t => {
  const { value, accountId, target } = await compositeRepaymentFacts()
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  const mapping = page.data.accountMappings.find(item => item.issueId === target.issueId)
  assert.equal(page.data.accountMappingsExcluded.length, 0)
  assert.equal(mapping.choiceValue, 'account:' + accountId)
  assert.equal(mapping.needsConfirmation, false)
  assert.equal(h.local.model.events.get(value.events[0].eventId).counterpartyLedgerAccountId, accountId)
  assert.equal(h.local.model.choices.accounts.size, 0, '历史沿用不能伪造本批人工决定')
  assert.equal(h.network.length, 0)
})

test('真实账户页：旧快照已解决但缺账户时重新确认，只有明确保存排除才进入本次不计入', async t => {
  const { value, target } = await compositeRepaymentFacts()
  // v40 曾把目标事项标为已确认，却没把目标账户写进事件和公开账户上下文。
  value.events[0].counterpartyLedgerAccountId = null
  target.accountContext.accountId = null
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  // 旧页面还可能把这个错误的默认值存成未确认的界面草稿。
  page._accountUiDrafts.set(target.issueId, { mode: 'ignore', accountId: '', name: '1688先采后付',
    typeIndex: 3, dirty: false, localConfirmed: false, revision: 0 })
  page.refreshAccountMappings()
  const pending = page.data.accountMappings.find(item => item.issueId === target.issueId)
  assert.equal(page.data.accountMappingsExcluded.length, 0)
  assert.equal(pending.needsConfirmation, true)
  assert.notEqual(pending.choiceValue, 'ignore')
  assert.notEqual(h.local.model.events.get(value.events[0].eventId).status, 'excluded')
  await page.openAccountChoice(tap({ id: target.issueId }))
  page.selectAccountChoice(tap({ value: 'ignore' }))
  assert.equal(page.data.accountMappingsExcluded.length, 0, '未确认的排除选择仍留在待确认')
  await page.completeAccountMapping(tap({ id: target.issueId }))
  await h.flush()
  assert.ok(page.data.accountMappingsExcluded.some(item => item.issueId === target.issueId))
  assert.equal(h.local.model.events.get(value.events[0].eventId).status, 'excluded')
  const factory = require('../miniprogram/packages/finance/services/import-local-session')
  const reopened = factory.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID })
  assert.equal(reopened.model.events.get(value.events[0].eventId).status, 'excluded')
  assert.equal(reopened.model.choices.accounts.size, 1)
  assert.equal(h.network.length, 0)
})

test('真实账户页：代表交易被排除不代表整个账户组排除', async t => {
  const { value, target, accountId } = await compositeRepaymentFacts()
  value.events[0].status = 'excluded'
  value.events[0].reasonCodes = ['manual_exclusion']
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  assert.equal(page.data.accountMappings.find(item => item.issueId === target.issueId).choiceValue, 'account:' + accountId)
  assert.equal(page.data.accountMappingsExcluded.length, 0)
})

test('真实账户页：整组明确排除优先于残留账户', async t => {
  const { value, target } = await compositeRepaymentFacts()
  target.reasonCodes = ['account_mapping_excluded']
  value.events[0].status = 'excluded'
  value.events[0].reasonCodes = ['manual_exclusion', 'account_mapping_excluded']
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  assert.ok(page.data.accountMappingsExcluded.some(item => item.issueId === target.issueId))
})

for (const count of [1, 2]) test('真实账户页：目标账户是否仍需确认按完整成员判断，成员数 ' + count, async t => {
  const { value, target } = await compositeRepaymentFacts(count)
  target.accountContext.accountId = null
  for (const event of value.events) event.counterpartyLedgerAccountId = null
  Object.assign(value.events[0], { economicNature: 'expense', flowDirection: 'outflow', manualFieldMask: 8 })
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  const targetMapping = page.data.accountMappings.find(item => item.issueId === target.issueId)
  if (count === 1) assert.equal(targetMapping, undefined, '整组已改成支出，不再确认无用的还款目标')
  else assert.equal(targetMapping.needsConfirmation, true, '同组另一笔仍在还款，不能按代表记录隐藏')
  assert.equal(page.data.accountMappingsExcluded.length, 0)
})

test('真实账户页：余额一次确认同时覆盖组合付款a和普通付款b，银行卡只覆盖a', async t => {
  const content = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    '2026-09-01 12:00:00,餐饮美食,合成商户,a,10.00,支出,光大银行储蓄卡(1234)&账户余额,交易成功,,SYNTHETIC-GROUP-A,,',
    '2026-09-02 12:00:00,餐饮美食,合成商户,b,2.00,支出,账户余额,交易成功,,SYNTHETIC-GROUP-B,,'
  ].join('\n'))
  const value = await facts({ content, mapped: false })
  const bankId = randomUUID(), walletId = value.accounts[0].accountId
  value.accounts[0].name = '支付宝余额'
  value.accounts.push({ accountId: bankId, name: '光大银行卡', type: 'bank', nature: 'asset', currency: 'CNY', version: 1 })
  const combined = value.events.find(event => event.fieldSources.paymentAccountReferences)
  const single = value.events.find(event => !event.fieldSources.paymentAccountReferences)
  const issues = value.issues.filter(issue => issue.issueType === 'account_mapping')
  assert.equal(issues.length, 2)
  const wallet = issues.find(issue => value.members.some(member => member.issueId === issue.issueId && member.objectId === single.eventId))
  const bank = issues.find(issue => issue !== wallet)
  const h = await localWorkbench(t, value), page = h.page
  await page.setStep({ currentStep: 2 })
  assert.equal(page.data.accountMappings.length, 2)
  for (const [issue, accountId] of [[wallet, walletId], [bank, bankId]]) {
    await page.openAccountChoice(tap({ id: issue.issueId }))
    page.selectAccountChoice(tap({ value: 'account:' + accountId }))
    await page.completeAccountMapping(tap({ id: issue.issueId }))
    await h.flush()
  }
  assert.equal(page.data.accountStepSummary.pending, 0, page.data.accountStepError)
  assert.equal(h.local.model.choices.accounts.size, 2)
  assert.equal(h.local.model.events.get(single.eventId).ledgerAccountId, walletId)
  assert.deepEqual(h.local.model.events.get(combined.eventId).fieldSources.paymentAccounts,
    [{ componentIndex: 0, accountId: bankId }, { componentIndex: 1, accountId: walletId }])
  const factory = require('../miniprogram/packages/finance/services/import-local-session')
  const reopened = factory.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID })
  assert.equal(reopened.model.choices.accounts.size, 2)
  assert.ok([...reopened.model.issues.values()].filter(issue => issue.issueType === 'account_mapping').every(issue => issue.status === 'resolved'))
  assert.equal(reopened.model.events.size, 2)
  assert.equal(h.network.length, 0)
})

test('完整草稿真实 Page/API：账户、字段、分类、证据和退款核对零网络',async t=>{
  const value=await facts({count:5,mapped:false})
  value.categories.push({...value.categories[0],categoryId:randomUUID(),name:'另一分类'})
  const h=await localWorkbench(t,value),page=h.page
  await page.setStep({currentStep:2})
  const mapping=page.data.accountMappings[0]
  assert.ok(mapping,'真实账户页应显示待确认范围')
  assert.ok(page.data.accountMappingsIncluded.length,'账户页不能渲染成 0/0 空状态')
  assert.equal(page.data.accountStepSummary.total,page.data.accountMappings.length)
  assert.equal(mapping.allowFutureIgnore,undefined)
  await page.openAccountChoice(tap({id:mapping.issueId}))
  page.selectAccountChoice(tap({value:'account:'+value.accounts[0].accountId}))
  await page.completeAccountMapping(tap({id:mapping.issueId}))
  await h.flush()
  assert.equal(h.local.model.choices.accounts.size,1,page.data.accountStepError)
  assert.equal(page.data.accountMappings.every(item=>!item.needsConfirmation),true)
  assert.equal(page.data.accountStepSummary.pending,0)
  await page.setStep({currentStep:3})
  const ids=value.events.map(row=>row.eventId)
  await page.openReviewEdit(tap({id:ids[0]}))
  assert.ok(page._reviewEditToken.draft,page.data.reviewEditSheet.error)
  await page._reviewEditToken.evidenceRead
  text(page,'note','真实页面本地保存')
  page.selectEditorDirectory(value.categories[0],'editorCategory')
  await page.saveReviewEdit()
  assert.equal(h.local.model.events.get(ids[0]).fieldSources.editorOverrides.note,'真实页面本地保存',page.data.reviewEditSheet?.error)
  await page.openCategoryEdit(tap({id:ids[0]}))
  assert.equal(page.selectEditedCategory(value.categories[2]),true)
  await page.saveCategoryEdit()
  assert.equal(h.local.model.events.get(ids[0]).categoryId,value.categories[2].categoryId)

  // Opening the existing refund editor must use the downloaded context too.
  h.local.call('financeUpdates.setReview',{eventId:ids[1],editorVersion:1,fields:{economicNature:'refund',amountMinor:'60',occurredLocalAt:'2026-09-02 12:00:00',timezoneOffsetMinutes:-480}})
  page.applyUpdateView(h.local.view)
  await page.openReviewEdit(tap({id:ids[1]}))
  // 打开即列出本批原消费：用户不该再点一次范围才看到候选。
  await page._reviewEditToken.refundRead
  assert.ok(page.data.reviewEditSheet.refundChoices.length, '打开退款编辑器就有本批候选')
  assert.ok(page.data.reviewEditSheet.refundTotal > 0)
  assert.equal(page.data.reviewEditSheet.refundKind, 'event')
  await page.loadEditorRefunds(tap({kind:'event'}))
  assert.ok(page.data.reviewEditSheet.refundChoices.length)
  await page.loadEditorRefunds(tap({kind:'transaction'}))
  assert.equal(page.data.reviewEditSheet.refundHistoryPending,true)
  page.closeReviewEdit()
  const issue=[...h.local.model.issues.values()].find(row=>row.status==='open'&&row.subjectEventIds.includes(ids[4]))
  await page.readIssue(issue.issueId)
  h.local.call('reviewIssues.resolve',{issueId:issue.issueId,decision:'exclude_events',selection:{mode:'include',eventIds:[ids[4]]}})
  page.applyUpdateView(h.local.view)
  await page.openEvidence(tap({id:ids[0]}))
  page.onHide()
  await h.load(require('node:path').resolve(__dirname,'../miniprogram/services/catledger-api.js')).revalidateForeground()
  await page.onShow();await h.flush()
  assert.equal(h.network.length,0,JSON.stringify(h.network))
  assert.ok(h.patches.every(bytes=>bytes<=64*1024))
  assert.equal(h.local.status.saved,true)
  assert.ok(h.files.restore().records.length>0)
  t.diagnostic('真实工作台 + 真实导入 API + 本地路由：网络调用 0')
})

test('本地真实 Page 普通还款拒绝旧计划和本息费入口，只保存整笔还款且零网络', async t => {
  const value = await facts({ count: 2 }), loanId = randomUUID()
  value.loans = [{ loanId, accountId: value.accounts[2].accountId, name: '合成贷款', version: 4 }]
  const h = await localWorkbench(t, value), page = h.page, id = value.events[0].eventId
  h.local.call('financeUpdates.setReview', { eventId: id, editorVersion: 1,
    fields: { economicNature: 'repayment', counterpartyLedgerAccountId: value.accounts[2].accountId, amountMinor: '10000' } })
  page.applyUpdateView(h.local.view); await page.setStep({ currentStep: 3 }); await page.openReviewEdit(tap({ id }))
  assert.equal(page.data.reviewEditSheet.editor.showLoan, false)
  const original = JSON.stringify(page._reviewEditToken.draft)
  page.changeEditorMode(tap({ field: 'loanMode', value: 'associate' }))
  for (const field of ['principalInput', 'interestInput', 'feeInput']) text(page, field, '999')
  for (const target of ['editorLoan', 'editorInterest', 'editorFee']) {
    assert.equal(page.reviewEditorDirectory(target), null)
    assert.equal(page.selectEditorDirectory(value.loans[0], target), false)
  }
  assert.equal(JSON.stringify(page._reviewEditToken.draft), original)
  text(page, 'note', '核对整笔还款')
  await page.saveReviewEdit()
  const decision = h.local.model.choices.events.get(id).editor
  assert.equal(decision.fields.note, '核对整笔还款', page.data.reviewEditSheet?.error)
  assert.equal(decision.decisions.repayment, undefined)
  assert.equal(h.local.model.events.get(id).fieldSources.loanRepayment, undefined)
  assert.equal(h.network.length, 0)
})

test('本地真实 Page 恢复旧还款决定后保留证据，重新保存替换决定并解除冲突', async t => {
  const value = await facts({ count: 1 }), id = value.events[0].eventId
  const h = await localWorkbench(t, value)
  const prior = { key: id, eventId: id, sourceIds: value.evidence.filter(row => row.eventId === id).map(row => row.rowId),
    editor: { editorVersion: 1, fields: { economicNature: 'repayment', amountMinor: '10000',
      counterpartyLedgerAccountId: value.accounts[2].accountId, note: '旧草稿备注' },
    decisions: { repayment: { mode: 'review', draft: { mode: 'associate', loanId: randomUUID(), loanVersion: 2,
      principalMinor: '9000', interestMinor: null, feeMinor: '0', chargeAllocations: [] } } } } }
  h.files.save([{ kind: 'events', key: id, value: prior }])
  h.page.onUnload()
  const factory = require('../miniprogram/packages/finance/services/import-local-session')
  const restored = factory.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork: async () => { assert.fail('普通还款重新核对不能补读网络') } })
  assert.equal(restored.model.invalid.has(id), true)
  assert.deepEqual(restored.model.choices.events.get(id).editor.decisions.repayment, prior.editor.decisions.repayment)
  const path = require('node:path')
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(restored)
  h.summary = restored.view
  const page = h.page = h.createPage()
  t.after(() => page.onUnload())
  await page.setStep({ currentStep: 3 }); await page.openReviewEdit(tap({ id }))
  assert.equal(page._reviewEditToken.row.legacyRepaymentReview, true)
  assert.equal(page._reviewEditToken.row.loanRepayment, null)
  assert.equal(page.data.reviewEditSheet.draft.note, '旧草稿备注')
  assert.equal(page.data.reviewEditSheet.canSave, true)
  assert.deepEqual(restored.model.choices.events.get(id).editor.decisions.repayment, prior.editor.decisions.repayment,
    '只读恢复必须保留旧决定')
  h.wx.showModal = () => assert.fail('保存替换旧决定不另加确认')
  await page.saveReviewEdit()
  assert.equal(restored.model.invalid.has(id), false, page.data.reviewEditSheet?.error)
  const saved = restored.model.choices.events.get(id).editor
  assert.equal(saved.decisions.repayment, null)
  assert.ok(saved.acknowledgedChanges.includes('repayment'))
  assert.equal(saved.fields.note, '旧草稿备注')
  const reopened = factory.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID })
  assert.equal(reopened.model.invalid.has(id), false)
  assert.equal(reopened.model.choices.events.get(id).editor.decisions.repayment, null)
  assert.equal(h.network.length, 0)
})

test('本地真实 Page 分期归属选择、清除和整组状态更新不补读网络',async t=>{
  const value=await facts({count:3})
  const labels=['电销总账分月12期第12期共12期','电销现分按月收12期第12期共12期','分期付款利息第12期共12期']
  value.events.forEach((event,index)=>{
    Object.assign(event,{economicNature:index===2?'fee':'repayment',flowDirection:index===2?'outflow':'neutral',
      ledgerAccountId:value.accounts[1].accountId,categoryId:index===2?value.categories[0].categoryId:null,
      status:'ready',reasonCodes:[],accountGroupingKey:'synthetic-bank|6106',
      display:{item:labels[index],counterparty:'',sourceNote:''},
      primaryEvidence:{...event.primaryEvidence,item:labels[index],sourceType:'bank'},
      fieldSources:{installment:{schema:2,creditStatement:true,factKind:'billing',component:index===2?'interest':'principal',
        periodNumber:12,totalTerms:12,originKind:'unconfirmed',referenceKey:null,referenceLabel:null}}})
  })
  const planner=require('../cloudfunctions/catledger-import/src/organizer-planner')
  planner.applyInstallmentAttribution(value.events)
  const planned=planner.buildReviewIssues(value.update.updateId,value.events,[],[],randomUUID)
  value.issues=planned.issues.map(issue=>({...issue,subjectEventIds:planned.members.filter(row=>row.issueId===issue.issueId&&row.objectType==='event').map(row=>row.objectId)}))
  value.members=planned.members
  const h=await localWorkbench(t,value),page=h.page,id=value.events[2].eventId
  await page.setStep({currentStep:3});await page.openReviewEdit(tap({id}))
  assert.equal(page._reviewEditToken.view.attribution.plans.length,2)
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  // 可选单选：再点已选中的计划即取消归属，回到待核对。
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  assert.equal(page.data.reviewEditSheet.draft.planLabel, '')
  assert.equal(page.data.reviewEditSheet.editor.attribution.required, true)
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  await page.saveReviewEdit()
  assert.equal(h.local.model.events.get(id).fieldSources.editorOverrides.sourceCorrection.planLabel,'电销现分按月收12期',page.data.reviewEditSheet?.error)
  assert.equal(h.local.model.events.get(id).reasonCodes.includes('installment_attribution_required'),false)
  await page.openReviewEdit(tap({id}));page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}));await page.saveReviewEdit()
  assert.equal(h.local.model.events.get(id).fieldSources.editorOverrides.sourceCorrection.planLabel,undefined)
  assert.equal(h.local.model.events.get(id).reasonCodes.includes('installment_attribution_required'),true)
  assert.equal(h.network.length,0)
})

test('真实 Page：待归属利息独立成卡，本金确定后不再陪等',async t=>{
  const value=await facts({count:4})
  const labels=['电销总账分月12期第12期共12期','电销现分按月收12期第12期共12期','分期付款利息第12期共12期','分期付款利息第12期共12期']
  value.events.forEach((event,index)=>{
    const principal=index<2
    Object.assign(event,{economicNature:principal?'repayment':'fee',flowDirection:principal?'neutral':'outflow',
      ledgerAccountId:value.accounts[1].accountId,categoryId:principal?null:value.categories[0].categoryId,
      status:'ready',reasonCodes:[],accountGroupingKey:'synthetic-bank|6106',
      display:{item:labels[index],counterparty:'',sourceNote:''},
      primaryEvidence:{...event.primaryEvidence,item:labels[index],sourceType:'bank'},
      fieldSources:{installment:{schema:2,creditStatement:true,factKind:'billing',component:principal?'principal':'interest',
        periodNumber:12,totalTerms:12,originKind:'unconfirmed',referenceKey:null,referenceLabel:null}}})
  })
  const planner=require('../cloudfunctions/catledger-import/src/organizer-planner')
  planner.applyInstallmentAttribution(value.events)
  const planned=planner.buildReviewIssues(value.update.updateId,value.events,[],[],randomUUID)
  value.issues=planned.issues.map(issue=>({...issue,subjectEventIds:planned.members.filter(row=>row.issueId===issue.issueId&&row.objectType==='event').map(row=>row.objectId)}))
  value.members=planned.members
  const h=await localWorkbench(t,value),page=h.page
  await page.setStep({currentStep:3})
  const principalIds=value.events.slice(0,2).map(event=>event.eventId), interestIds=value.events.slice(2).map(event=>event.eventId)
  // 本金已经确定：不再挂在待核对里陪着等利息，直接回已核对。
  const cards=(page.data.reviewGroups||[]).flatMap(group=>group.issues||[])
  assert.equal(cards.some(card=>(card.subjects||[]).some(row=>principalIds.includes(row.eventId))),false)
  // 待核对只剩两笔没归属的利息，各是一张卡；点它就能选归到哪笔本金。
  assert.equal(cards.length,2)
  assert.equal(cards.every(card=>card.subjects.length===1&&card.subjects[0].rowRoleKey==='interest'),true)
  await page.openReviewEdit(tap({id:interestIds[0]}))
  assert.equal(page.data.reviewEditSheet.editor.attribution.role,'charge',page.data.reviewEditSheet.error)
  assert.equal(page.data.reviewEditSheet.editor.attribution.plans.length,2)
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  await page.saveReviewEdit()
  await h.flush()
  const assigned=h.local.model.events.get(interestIds[0])
  assert.equal(assigned.fieldSources.editorOverrides.sourceCorrection.planLabel,'电销现分按月收12期')
  assert.equal(assigned.reasonCodes.includes('installment_attribution_required'),false)
  // 另一笔还没定：待核对只剩它一条，本金始终不需要人来核对。
  for(const id of principalIds)assert.equal(h.local.model.events.get(id).status,'ready')
  const openIssues=[...h.local.model.issues.values()].filter(issue=>issue.status==='open')
  assert.equal(openIssues.length,1)
  assert.deepEqual(openIssues[0].subjectEventIds||[],[interestIds[1]])
  assert.equal(h.network.length,0)
})

test('真实 Page：只指定一笔时另一笔仍在待核对，本金早已进已核对',async t=>{
  const value=await facts({count:4})
  const labels=['电销总账分月12期第12期共12期','电销现分按月收12期第12期共12期','分期付款利息第12期共12期','分期付款利息第12期共12期']
  value.events.forEach((event,index)=>{
    const principal=index<2
    Object.assign(event,{economicNature:principal?'repayment':'fee',flowDirection:principal?'neutral':'outflow',
      ledgerAccountId:value.accounts[1].accountId,categoryId:principal?null:value.categories[0].categoryId,
      status:'ready',reasonCodes:[],accountGroupingKey:'synthetic-bank|6106',
      display:{item:labels[index],counterparty:'',sourceNote:''},
      primaryEvidence:{...event.primaryEvidence,item:labels[index],sourceType:'bank'},
      fieldSources:{installment:{schema:2,creditStatement:true,factKind:'billing',component:principal?'principal':'interest',
        periodNumber:12,totalTerms:12,originKind:'unconfirmed',referenceKey:null,referenceLabel:null}}})
  })
  const planner=require('../cloudfunctions/catledger-import/src/organizer-planner')
  planner.applyInstallmentAttribution(value.events)
  const planned=planner.buildReviewIssues(value.update.updateId,value.events,[],[],randomUUID)
  value.issues=planned.issues.map(issue=>({...issue,subjectEventIds:planned.members.filter(row=>row.issueId===issue.issueId&&row.objectType==='event').map(row=>row.objectId)}))
  value.members=planned.members
  const h=await localWorkbench(t,value),page=h.page
  await page.setStep({currentStep:3})
  const principalIds=value.events.slice(0,2).map(event=>event.eventId), interestIds=value.events.slice(2).map(event=>event.eventId)
  await page.openReviewEdit(tap({id:interestIds[0]}))
  page.selectEditorInstallmentPlan(tap({plan:'电销总账分月12期'}))
  await page.saveReviewEdit()
  await h.flush()
  // 指定成功：这笔不再待归属，另一笔仍是待核对里唯一的事；两笔本金一直都不在待核对。
  assert.equal(h.local.model.events.get(interestIds[0]).reasonCodes.includes('installment_attribution_required'),false)
  // 事项还开着（同组另一笔没定），但这笔已经退组：不能再按旧成员关系挂 blocking_issue_open，
  // 否则只指定一笔时它停在待核对，用户看到的就是“归属了却没进已核对”。
  assert.equal(h.local.model.events.get(interestIds[0]).status,'ready')
  const pendingCards=(page.data.reviewGroups||[]).flatMap(group=>group.issues||[])
  assert.equal(pendingCards.length,1)
  assert.equal((pendingCards[0].subjects||[]).map(row=>row.eventId).join(','),interestIds[1])
  for(const id of principalIds)assert.equal(h.local.model.events.get(id).status,'ready')
  const openIssues=[...h.local.model.issues.values()].filter(issue=>issue.status==='open'&&issue.primaryReasonCode==='installment_attribution_required')
  assert.equal(openIssues.length,1)
  assert.deepEqual(openIssues[0].subjectEventIds||[],[interestIds[1]])
})

test('真实 Page：利息选计划时在计划行标出本期已被占用的计划，选中照常写入',async t=>{
  const value=await facts({count:4})
  const labels=['电销总账分月12期第12期共12期','电销现分按月收12期第12期共12期','分期付款利息第12期共12期','分期付款利息第12期共12期']
  value.events.forEach((event,index)=>{
    const principal=index<2
    Object.assign(event,{economicNature:principal?'repayment':'fee',flowDirection:principal?'neutral':'outflow',
      ledgerAccountId:value.accounts[1].accountId,categoryId:principal?null:value.categories[0].categoryId,
      status:'ready',reasonCodes:[],accountGroupingKey:'synthetic-bank|6106',
      display:{item:labels[index],counterparty:'',sourceNote:''},
      primaryEvidence:{...event.primaryEvidence,item:labels[index],sourceType:'bank'},
      fieldSources:{installment:{schema:2,creditStatement:true,factKind:'billing',component:principal?'principal':'interest',
        periodNumber:12,totalTerms:12,originKind:'unconfirmed',referenceKey:null,referenceLabel:null}}})
  })
  const planner=require('../cloudfunctions/catledger-import/src/organizer-planner')
  planner.applyInstallmentAttribution(value.events)
  const planned=planner.buildReviewIssues(value.update.updateId,value.events,[],[],randomUUID)
  value.issues=planned.issues.map(issue=>({...issue,subjectEventIds:planned.members.filter(row=>row.issueId===issue.issueId&&row.objectType==='event').map(row=>row.objectId)}))
  value.members=planned.members
  const h=await localWorkbench(t,value),page=h.page
  await page.setStep({currentStep:3})
  const interestIds=value.events.slice(2).map(event=>event.eventId)
  // 第一笔利息先归到「电销现分按月收12期」。
  await page.openReviewEdit(tap({id:interestIds[0]}))
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  await page.saveReviewEdit()
  await h.flush()
  // 第二笔利息打开时，这个计划已占用的金额要写在计划行上；没被占用的计划保持干净。
  await page.openReviewEdit(tap({id:interestIds[1]}))
  const plans=page.data.reviewEditSheet.editor.attribution.plans
  const interestAmount='¥'+(Number(value.events[2].amountMinor)/100).toFixed(2)
  // 整句写明“还有另一笔”，不能只说“本期已有 ¥X 利息”——那会被读成本期利息就是这些钱。
  assert.equal(plans.find(plan=>plan.planName==='电销现分按月收12期').takenBy,'本期已有另一笔 '+interestAmount+' 利息',page.data.reviewEditSheet.error)
  assert.equal(plans.find(plan=>plan.planName==='电销总账分月12期').takenBy,'')
  // 占用已经写在卡面，选它照常写入草稿，不弹框打断。
  h.wx.modal=null
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  assert.equal(h.wx.modal,null)
  assert.equal(page.data.reviewEditSheet.draft.planLabel,'电销现分按月收12期')
  // 再点一次是取消归属，同样安静。
  page.selectEditorInstallmentPlan(tap({plan:'电销现分按月收12期'}))
  assert.equal(page.data.reviewEditSheet.draft.planLabel,'')
  // 选没被占用的计划也一样。
  page.selectEditorInstallmentPlan(tap({plan:'电销总账分月12期'}))
  assert.equal(h.wx.modal,null)
  assert.equal(page.data.reviewEditSheet.draft.planLabel,'电销总账分月12期')
})

test('完整草稿真实 Page：本批与原消费都在本机，退款候选读取零网络',async t=>{
  const value=await facts({count:4,mapped:true})
  const h=await localWorkbench(t,value),page=h.page
  const ids=value.events.map(row=>row.eventId)
  const before=h.network.length
  await page.openReviewEdit(tap({id:ids[1]}))
  await page._reviewEditToken.evidenceRead
  // 打开编辑器不触发任何原消费查询。
  assert.equal(h.network.length,before,'打开退款编辑器不应联网')
  assert.equal(h.calls.filter(call=>call.action==='economicEvents.refundCandidates').length,0)
})
