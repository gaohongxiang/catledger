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

test('本地真实 Page 贷款目录、费用分配和本息费编辑不补读网络',async t=>{
  const value=await facts({count:2}),loanId=randomUUID(),contractId=randomUUID(),chargeId=randomUUID()
  value.loans=[{loanId,accountId:value.accounts[2].accountId,name:'合成贷款',version:4,baselinePrincipalMinor:'1080000',baselineDate:'2026-01-01'}]
  value.contracts=[{contractId,loanId,accountId:value.accounts[2].accountId,version:1}]
  value.charges=[{chargeId,contractId,component:'interest',chargeKey:'period:1:interest',periodNumber:1,state:'recorded',outstandingMinor:'800',amountMinor:'800',version:1}]
  const h=await localWorkbench(t,value),page=h.page,id=value.events[0].eventId
  h.local.call('financeUpdates.setReview',{eventId:id,editorVersion:1,fields:{economicNature:'repayment',counterpartyLedgerAccountId:value.accounts[2].accountId,amountMinor:'10000'}})
  page.applyUpdateView(h.local.view);await page.setStep({currentStep:3});await page.openReviewEdit(tap({id}))
  page.toggleRepaymentDetails()
  page.changeEditorMode(tap({field:'loanMode',value:'associate'}))
  assert.equal(page.selectEditorDirectory(value.loans[0],'editorLoan'),true,page.data.reviewEditSheet.error)
  text(page,'principalInput','92');text(page,'interestInput','8');text(page,'feeInput','0')
  // 没保存过时默认“没记过，记一笔”；三选一里直接点“记过，只冲抵”。
  page.setEditorTreatment(tap({field:'interestTreatment',value:'accrued'}))
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
  for(const id of principalIds)assert.equal(h.local.model.events.get(id).status,'ready')
  const openIssues=[...h.local.model.issues.values()].filter(issue=>issue.status==='open'&&issue.primaryReasonCode==='installment_attribution_required')
  assert.equal(openIssues.length,1)
  assert.deepEqual(openIssues[0].subjectEventIds||[],[interestIds[1]])
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
