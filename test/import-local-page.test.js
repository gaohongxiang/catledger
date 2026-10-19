const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {facts}=require('./helpers/local-review')
const {localWorkbench}=require('./helpers/local-workbench')
const tap=data=>({currentTarget:{dataset:data}})
const text=(page,field,value)=>page.changeEditorText({...tap({field}),detail:{value}})

test('完整草稿真实 Page/API：账户、字段、分类、证据和退款核对零网络',async t=>{
  const value=await facts({count:5,mapped:false})
  value.categories.push({...value.categories[0],categoryId:randomUUID(),name:'另一分类'})
  const h=await localWorkbench(t,value),page=h.page
  await page.setStep({currentStep:2})
  const mapping=page.data.accountMappings[0]
  assert.ok(mapping,'真实账户页应显示待确认范围')
  assert.equal(mapping.allowFutureIgnore,false)
  await page.openAccountChoice(tap({id:mapping.issueId}))
  page.selectAccountChoice(tap({value:'account:'+value.accounts[0].accountId}))
  await page.completeAccountMapping(tap({id:mapping.issueId}))
  await h.flush()
  assert.equal(h.local.model.choices.accounts.size,1,page.data.accountStepError)
  const confirmedMapping=page.data.accountMappings.find(item=>item.issueId===mapping.issueId)
  assert.equal(confirmedMapping.needsConfirmation,false)
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

test('本地真实 Page 贷款目录、费用分配和本息费编辑不补读网络',async t=>{
  const value=await facts({count:2}),loanId=randomUUID(),contractId=randomUUID(),chargeId=randomUUID()
  value.loans=[{loanId,accountId:value.accounts[2].accountId,name:'合成贷款',version:4,baselinePrincipalMinor:'1080000',baselineDate:'2026-01-01'}]
  value.contracts=[{contractId,loanId,accountId:value.accounts[2].accountId,version:1}]
  value.charges=[{chargeId,contractId,component:'interest',chargeKey:'period:1:interest',periodNumber:1,state:'recorded',outstandingMinor:'800',amountMinor:'800',version:1}]
  const h=await localWorkbench(t,value),page=h.page,id=value.events[0].eventId
  h.local.call('financeUpdates.setReview',{eventId:id,editorVersion:1,fields:{economicNature:'repayment',counterpartyLedgerAccountId:value.accounts[2].accountId,amountMinor:'10000'}})
  page.applyUpdateView(h.local.view);await page.setStep({currentStep:3});await page.openReviewEdit(tap({id}))
  page.changeEditorMode(tap({field:'repaymentMode',value:'loan'}))
  page.changeEditorMode(tap({field:'loanMode',value:'associate'}))
  assert.equal(page.selectEditorDirectory(value.loans[0],'editorLoan'),true,page.data.reviewEditSheet.error)
  text(page,'principalInput','92');text(page,'interestInput','8');text(page,'feeInput','0')
  page.changeEditorMode(tap({field:'interestTreatment',value:'accrued'}))
  await page.loadEditorCharges()
  assert.equal(page.data.reviewEditSheet.chargeChoices.length,1,page.data.reviewEditSheet.chargeError)
  page.selectEditorCharge(tap({id:chargeId}))
  await page.saveReviewEdit()
  const decision=h.local.model.choices.events.get(id).editor.decisions.repayment
  assert.equal(decision.mode,'associate',page.data.reviewEditSheet?.error)
  assert.equal(decision.principalMinor,'9200');assert.equal(decision.interestMinor,'800')
  assert.equal(decision.chargeAllocations[0].chargeId,chargeId)
  assert.equal(h.network.length,0)
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
  await page.saveReviewEdit()
  assert.equal(h.local.model.events.get(id).fieldSources.editorOverrides.sourceCorrection.planLabel,'电销现分按月收12期',page.data.reviewEditSheet?.error)
  assert.equal(h.local.model.events.get(id).reasonCodes.includes('installment_attribution_required'),false)
  await page.openReviewEdit(tap({id}));page.clearEditorInstallmentPlan();await page.saveReviewEdit()
  assert.equal(h.local.model.events.get(id).fieldSources.editorOverrides.sourceCorrection.planLabel,undefined)
  assert.equal(h.local.model.events.get(id).reasonCodes.includes('installment_attribution_required'),true)
  assert.equal(h.network.length,0)
})
