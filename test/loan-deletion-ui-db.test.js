const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab}=require('./helpers/loan-charges'),{realPage}=require('./helpers/real-page')
const dataEvent=(values={})=>({currentTarget:{dataset:values}})
async function waitFor(check){const until=Date.now()+10000;while(!check()){if(Date.now()>until)throw new Error('合成交互等待超时');await new Promise(r=>setTimeout(r,5))}}
async function detail(h,l){const ui=realPage(h),page=ui.page('loan-detail');page.onLoad({loanId:l.loanId});await page.load();assert.equal(page.data.errorMessage,'');return {ui,page}}
async function remove(h,l){const loan=(await h.api('loans.get',{loanId:l.loanId})).loan,p=await h.api('loans.deleteImpact',{loanId:l.loanId,version:loan.version});return h.api('loans.delete',{requestId:randomUUID(),loanId:l.loanId,version:loan.version,previewToken:p.previewToken,confirmed:true})}
test('贷款整组删除的真实 Page 与隔离 MySQL',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 async function scenario(name,fn){await t.test(name,async()=>{const h=await chargeLab();try{await fn(h)}finally{await h.close()}})}
 await scenario('一次确认、保留编辑草稿；响应丢失沿用原请求，删除后刷新失败不误报失败',async h=>{
  const loan=await h.create();await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:1,repayments:[{periodNumber:1,paid:true}]})
  const {ui,page}=await detail(h,loan);page.data.repaymentDirtyCount=1
  const cancelled=page.archiveInstallment();await waitFor(()=>ui.modals.length===1)
  assert.match(ui.modals[0].content,/1笔费用/);assert.match(ui.modals[0].content,/未保存/)
  ui.modals[0].success({confirm:false});await cancelled;assert.equal(ui.calls.filter(c=>c.action==='loans.delete').length,0);assert.equal(page.data.repaymentDirtyCount,1)
  ui.respond=async(action,data)=>{const response=await h.services.api({action,data});if(action==='loans.delete')throw new Error('合成响应丢失');return response}
  const deleting=page.archiveInstallment();await waitFor(()=>ui.modals.length===2);ui.modals[1].success({confirm:true});await deleting
  assert.equal(page.data.hasPending,true);const original=ui.calls.find(c=>c.action==='loans.delete').data
  ui.respond=async(action,data)=>{if(action==='loans.list')throw new Error('合成列表读取失败');return h.services.api({action,data})}
  page.data.loan.version=999;await page.save()
  assert.equal(page.data.deletedPlan,true);assert.equal(page.data.savedMessage,'已删除，列表待刷新');assert.equal(page.data.errorMessage,'');assert.equal(page.data.hasPending,false)
  assert.equal(ui.calls.filter(c=>c.action==='loans.delete').length,1);assert.equal(ui.calls.find(c=>c.action==='transactions.commandResult').data.requestId,original.requestId)
  assert.equal(ui.modals.length,2);page.onHide();ui.respond=(action,data)=>h.services.api({action,data});await page.load()
  assert.deepEqual(ui.navigation,['back']);assert.equal(ui.calls.filter(c=>c.action==='loans.delete').length,1)
 })
 await scenario('独立退款阻塞显示原业务入口，整组无写入且不弹删除确认',async h=>{
  const loan=await h.create();await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:1,repayments:[{periodNumber:1,paid:true}]})
  const f=(await h.state(loan)).items[0],d={loanId:loan.loanId,chargeId:f.chargeId,operation:'refund',amountMinor:'100',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
  const p=await h.api('loans.chargeImpact',d);await h.api('loans.changeCharge',{...d,requestId:randomUUID(),confirmed:true,previewToken:p.previewToken})
  const {ui,page}=await detail(h,loan);await page.archiveInstallment()
  assert.equal(ui.modals.length,0);assert.equal(ui.calls.filter(c=>c.action==='loans.delete').length,0);assert.equal(page.data.deleteBlockers[0].code,'EXTERNAL_REFUND')
  page.openDeleteBlocker(dataEvent({index:0}));assert.match(ui.navigation[0],/transaction-editor/)
  assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.deleted,false)
 })
 await scenario('隐藏或换会话后的预览不弹窗、不提交；旧客户端归档入口不被页面调用',async h=>{
  const loan=await h.create(),{ui,page}=await detail(h,loan)
  let release;ui.respond=async(action,data)=>{const value=await h.services.api({action,data});if(action==='loans.deleteImpact')await new Promise(r=>release=r);return value}
  const pending=page.archiveInstallment();await waitFor(()=>release);page.onHide();release();await pending
  assert.equal(ui.modals.length,0);assert.equal(ui.calls.filter(c=>['loans.delete','loans.archiveInstallment'].includes(c.action)).length,0)
  ui.respond=(action,data)=>h.services.api({action,data});await page.load();assert.equal(page.data.deletingPreview,false)
 })
 await scenario('已保留费用从账目进入维护和明确新建计划入口，不写已删除计划',async h=>{
  const loan=await h.create({feeUpfrontMinor:'12000'}),txn=await h.expense('2026-01-02','12000')
  const fee=await h.api('loans.recordUpfrontFee',{requestId:randomUUID(),loanId:loan.loanId,version:1,mode:'existing',confirmed:true,transactionId:txn.transactionId,transactionVersion:txn.version})
  await remove(h,loan)
  const ui=realPage(h),page=ui.page('loan-detail');page.onLoad({chargeId:fee.chargeId});await page.load()
  assert.equal(page.data.errorMessage,'');assert.equal(page.data.retainedCharge.chargeId,fee.chargeId)
  await page.openChargeEdit(dataEvent({id:fee.chargeId}));page.chooseChargeOperation({detail:{value:1}})
  page.chargeEditInput({currentTarget:{dataset:{field:'amountYuan'}},detail:{value:'1'}})
  page.chargeEditInput({currentTarget:{dataset:{field:'refundDate'}},detail:{value:'2026-02-01'}})
  page.chargeEditInput({currentTarget:{dataset:{field:'refundAccountIndex'}},detail:{value:page.data.chargeRefundAccounts.findIndex(a=>a.accountId===h.assetAccountId)}})
  await page.previewChargeChange(dataEvent());assert.equal(page.data.chargeImpact.canChange,true)
  const saving=page.confirmChargeChange();await waitFor(()=>ui.modals.length);ui.modals[0].success({confirm:true});await saving
  assert.equal((await h.api('loans.retainedCharge',{chargeId:fee.chargeId})).charge.refundMinor,'100')
  assert(ui.calls.filter(c=>c.action==='loans.changeCharge').every(c=>c.data.detached===true&&!c.data.loanId))
  page.rebuildFromCharge();assert.match(ui.navigation.at(-1),/loan-form\/index\?chargeContractId=/)
 })
})
