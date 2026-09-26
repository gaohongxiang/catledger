const api=require('../../services/catledger-api'),pending=require('../../services/pending-ledger-write'),session=require('../../services/page-read-session')
const money=require('../../utils/money'),sync=require('../../services/loan-charge-sync')
const ORIGINS=['recorded_consumption','cash_borrowing','historical','new_consumption']
const STATES={planned:'尚未记账',recorded:'已记费用',baseline:'期初已覆盖',covered:'一次性收费已覆盖',suppressed:'已撤销，不自动补回',paused:'暂停待确认',cancelled:'已取消'}
const BASIS={plan:'按确认方案，待银行核对',actual:'实际费用依据',baseline:'历史基准',manual:'人工确认金额'}
const confirm=options=>new Promise(resolve=>wx.showModal({...options,success:r=>resolve(r.confirm),fail:()=>resolve(false)}))
const initial={oneOffOpen:false,periodCharges:[],periodChargeIssues:[],periodChargeNext:null,periodFeesError:'',chargeHasOneOff:false,chargePreview:null,chargeSummary:null,chargeRows:[],chargeNext:null,chargeIssues:[],chargeLoading:false,chargeError:'',chargeFormOpen:false,chargeDraft:null,chargeCategories:[],chargeOrigins:['已入账消费转分期','实际现金借款','历史贷款接入','尚未入账消费'],chargeModes:['按期自动记费','仅确认本次补齐'],chargeHistories:['从起算日继续，不补更早月份','补齐授权范围内的历史缺项'],chargeCoverages:['已核对已有费用，不需另认领','期初余额已含历史费用','认领已入账费用','一次性收费覆盖多期'],chargeExisting:[],chargeExistingIndex:-1,chargeEvidenceNext:null,chargeCoverageRows:[],chargePrior:[],chargePriorIndex:0,chargeEdit:null,chargeImpact:null}
function rowView(item){return {...item,shortLabel:item.component==='interest'?'利息':'手续费',label:(item.periodNumber?'第'+item.periodNumber+'期':'一次性')+(item.component==='interest'?'利息':'费用'),amountText:money.formatMinor(item.amountMinor),stateText:STATES[item.state],basisText:BASIS[item.basis],settledText:money.formatMinor(item.settledMinor),refundText:money.formatMinor(item.refundMinor||'0')}}
const methods={
 async loadCharges(event){
  if(!this.data.loan||!session.isCurrent(this))return
  const current=session.capture(this),token=this._chargeRead={}
  const cursor=event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.chargeNext:null
  this.setData({chargeLoading:true,chargeError:''})
  try{
   const result=await api.callApi('loans.chargePlan',{loanId:this._loanId,pageSize:20,...(cursor?{cursor}:{})},{force:true})
   if(!current()||this._chargeRead!==token)return
   this._chargeView=result
   const auth=result.contract&&result.contract.authorization
   this.setData({chargeHasOneOff:result.oneOffCount>0,chargeRows:result.items.map(rowView),chargeNext:result.nextCursor,chargeIssues:result.issues.map(i=>({...i,amountText:money.formatMinor(i.amountMinor)})),
    chargeSummary:{hasContract:!!result.contract,originKind:result.contract&&result.contract.originKind,authorized:auth&&auth.mode==='auto',unverifiedMinor:result.unverifiedMinor,recorded:result.contract?money.formatMinor(result.recordedMinor):null,unverified:money.formatMinor(result.unverifiedMinor),cutoff:result.cutoff,
     mode:!auth?'尚未授权':auth.mode==='auto'?'已授权按期记费':auth.mode==='once'?'仅本次确认':'已暂停',
     range:auth&&auth.fromDate?auth.fromDate+' 至 '+auth.throughDate:'确认日期与历史覆盖后可开启',
     history:auth&&auth.historyChoice==='continue'?'起算日前未补齐；已有账目保留':'已有费用按明确身份复用'},
    chargePrior:[{contractId:'',label:'新合同'}].concat(result.priorContracts.filter(k=>k.loanId!==this._loanId).map((k,index)=>({...k,label:'认领旧合同 '+(index+1)+'（原管理记录须已归档）'})))})
  }catch(error){if(current()&&this._chargeRead===token)this.setData({chargeError:error.message||'费用资料未能读取'})}
  finally{if(current()&&this._chargeRead===token)this.setData({chargeLoading:false})}
 },
 chooseChargeStop(){
  if(this.data.saving||!this.data.chargeFormOpen||!this.data.chargeSummary||!this.data.chargeSummary.hasContract)return
  const current=session.capture(this),token=this._chargeControlToken={}
  const choices=[...(this.data.chargeSummary.authorized?[{label:'暂时停记，之后再继续',action:'pause'}]:[]),{label:'已经提前结清',action:'settled'},{label:'费用或利率有变化',action:'rate_changed'}]
  wx.showActionSheet({itemList:choices.map(i=>i.label),success:result=>{
   if(!current()||this._chargeControlToken!==token||!this.data.chargeFormOpen||this.data.saving)return
   const choice=choices[result.tapIndex];if(!choice)return
   this._chargeControlToken=null
   return choice.action==='pause'?this.pauseChargePlan():this.endChargePlan({currentTarget:{dataset:{reason:choice.action}}})
  }})
 },
 async loadPeriodCharges(term,token,cursor){
  const current=session.capture(this)
  try{
   const value=await api.callApi('loans.chargePlan',{loanId:this._loanId,periodNumber:term,pageSize:20,...(cursor?{cursor}:{})},{force:true})
   if(!current()||this._periodToken!==token)return
   this.setData({periodCharges:value.items.map(rowView),periodChargeNext:value.nextCursor,
    periodChargeIssues:(value.issues||[]).filter(i=>i.periodNumber===term).map(i=>({...i,amountText:money.formatMinor(i.amountMinor)})),periodFeesError:''})
  }catch(error){if(current()&&this._periodToken===token)this.setData({periodFeesError:error.message||'本期费用暂未读取'})}
 },
 async morePeriodCharges(){if(this.data.periodChargeNext)return this.loadPeriodCharges(this.data.oneOffOpen?0:this.data.selectedPeriod.term,this._periodToken,this.data.periodChargeNext)},
 async openOneOffCharges(){
  const token=this._periodToken={};this.setData({oneOffOpen:true,periodOpen:false,periodCharges:[],periodChargeIssues:[],periodChargeNext:null,periodFeesError:'',periodLoading:true})
  await this.loadPeriodCharges(0,token)
  if(this._periodToken===token&&session.isCurrent(this))this.setData({periodLoading:false})
 },
 closeOneOffCharges(){if(!this.data.saving){this._periodToken={};this.setData({oneOffOpen:false})}},
 invalidateChargePreview(){this._chargeChangeToken={};this._chargePreviewToken={};this._chargePreviewInput=null;this._chargeAuthorizing=false;this.setData({chargePreview:null})},
 openChargeForm(){
  this._chargeControlToken=null
  this._chargeReturnTerm=null
  this.invalidateChargePreview()
  const view=this._chargeView;if(!view||this.data.saving||this.data.loan.archived)return
  const contract=view.contract,auth=contract&&contract.authorization||{},categories=this.data.chargeCategories
  const last=this._detailPreview&&this._detailPreview.periods.slice(-1)[0]
  this.setData({periodOpen:false,oneOffOpen:false,chargeFormOpen:true,chargePreview:null,chargeCoverageRows:[],chargeExisting:[],chargeEvidenceNext:null,chargePriorIndex:0,chargeDraft:{originIndex:contract?ORIGINS.indexOf(contract.originKind):-1,modeIndex:auth.mode==='once'?1:0,historyIndex:auth.historyChoice==='catch_up'?1:0,
   firstChargeDate:auth.firstChargeDate||this.data.loan.firstPaymentDate||'',upfrontChargeDate:auth.upfrontChargeDate||'',fromDate:auth.fromDate||view.cutoff,throughDate:auth.throughDate||last&&last.dueDate||'',
   coverageIndex:-1,baselineCoveredThrough:auth.baselineCoveredThrough||'',referenceLabel:'',fixed:false,
   interestCategoryIndex:categories.findIndex(c=>c.id===auth.interestCategoryId),feeCategoryIndex:categories.findIndex(c=>c.id===auth.feeCategoryId),
   evidenceMonth:(auth.fromDate||view.cutoff).slice(0,7),evidencePeriod:'1',coverThrough:String(this.data.loan.scheduleTerms),componentIndex:0}})
 },
 chargeInput(event){const key=event.currentTarget.dataset.field;if(!this.data.chargeDraft||!Object.prototype.hasOwnProperty.call(this.data.chargeDraft,key))return;this.invalidateChargePreview();this.setData({['chargeDraft.'+key]:key.endsWith('Index')?Number(event.detail.value):key==='fixed'?event.detail.value.includes('fixed'):event.detail.value,chargeImpact:null,chargePreview:null})},
 choosePrior(event){this.invalidateChargePreview();this.setData({chargePriorIndex:Number(event.detail.value)})},
 closeChargeForm(){this._chargeControlToken=null;if(!this.data.saving){this.invalidateChargePreview();this.setData({chargeFormOpen:false,chargeEdit:null,chargeImpact:null});return this.returnToChargePeriod()}},
 returnToChargePeriod(){const term=this._chargeReturnTerm;this._chargeReturnTerm=null;if(term===0)return this.openOneOffCharges();if(term)return this.openInstallment({currentTarget:{dataset:{term}}})},
 async loadChargeEvidence(event){
  if(this.data.saving)return
  const current=session.capture(this),draft=this.data.chargeDraft,token=this._chargeEvidenceToken={}
  const next=event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.chargeEvidenceNext:null
  try{const result=await api.callApi('transactions.list',{month:draft.evidenceMonth,accountId:this.data.loan.accountId,pageSize:40,...(next?{cursor:next}:{})},{force:true})
   if(current()&&token===this._chargeEvidenceToken&&draft===this.data.chargeDraft)this.setData({chargeExisting:result.transactions.filter(t=>t.type==='expense').map(t=>({...t,label:t.occurredLocalAt.slice(0,10)+' · '+money.formatMinor(t.amountMinor)+' · '+(t.note||'支出')})),chargeExistingIndex:-1,chargeEvidenceNext:result.nextCursor,chargeError:''})
  }catch(error){if(current())this.setData({chargeError:error.message})}
 },
 chooseChargeEvidence(event){this.setData({chargeExistingIndex:Number(event.detail.value)})},
 addChargeCoverage(){
  const t=this.data.chargeExisting[this.data.chargeExistingIndex],d=this.data.chargeDraft
  if(!t||!/^\d+$/.test(d.evidencePeriod)||Number(d.evidencePeriod)<0||Number(d.evidencePeriod)>this.data.loan.scheduleTerms){this.setData({chargeError:'请选择已有支出与有效期次'});return}
  const from=Number(d.evidencePeriod),through=d.coverageIndex===3?Number(d.coverThrough):from,component=d.componentIndex===1?'fee':'interest'
  if(!Number.isInteger(through)||through<from||through>this.data.loan.scheduleTerms){this.setData({chargeError:'覆盖截止期无效'});return}
  if(from===0&&(d.coverageIndex!==2||component!=='fee')){this.setData({chargeError:'0期仅用于认领合同一次性手续费'});return}
  const covers=from===0?['upfront:fee']:Array.from({length:through-from+1},(_,i)=>'period:'+(from+i)+':'+component)
  const value={transactionId:t.transactionId,amountMinor:t.amountMinor,chargeDate:t.occurredLocalAt.slice(0,10),component,covers,
   label:(from===0?'合同一次性':'第'+from+(through!==from?'～'+through:'')+'期')+(component==='fee'?'费用':'利息')+' · '+money.formatMinor(t.amountMinor)}
  if(this.data.chargeCoverageRows.some(i=>i.transactionId===t.transactionId)){this.setData({chargeError:'这笔费用已在覆盖列表中'});return}
  this.invalidateChargePreview();this.setData({chargeCoverageRows:this.data.chargeCoverageRows.concat(value),chargeError:''})
 },
 removeChargeCoverage(event){this.invalidateChargePreview();this.setData({chargeCoverageRows:this.data.chargeCoverageRows.filter((_,i)=>i!==Number(event.currentTarget.dataset.index))})},
 async authorizeCharges(){
  if(this.data.saving||this.data.loading||this._chargeAuthorizing)return
  const d=this.data.chargeDraft,current=session.capture(this),token=this._chargePreviewToken={}
  this._chargeAuthorizing=true
  try{
   if(!d||d.originIndex<0||d.coverageIndex<0||!d.fixed)throw new Error('请确认贷款来源、历史覆盖、固定金额与计费日期')
   if([2,3].includes(d.coverageIndex)&&!this.data.chargeCoverageRows.length)throw new Error('请添加要认领的已有费用')
   const categories=this.data.chargeCategories,prior=this.data.chargePrior[this.data.chargePriorIndex]
   const data={loanId:this._loanId,version:this.data.loan.version,confirmed:true,originKind:ORIGINS[d.originIndex],mode:d.modeIndex===1?'once':'auto',historyChoice:d.historyIndex===1?'catch_up':'continue',firstChargeDate:d.firstChargeDate,...(this.data.loan.feeUpfrontMinor!=='0'&&this.data.loan.feeUpfrontMinor?{upfrontChargeDate:d.upfrontChargeDate}:{}),fromDate:d.fromDate,throughDate:d.throughDate,
    fixedConfirmed:true,dateConfirmed:true,coverageConfirmed:true,interestCategoryId:categories[d.interestCategoryIndex]&&categories[d.interestCategoryIndex].id,feeCategoryId:categories[d.feeCategoryIndex]&&categories[d.feeCategoryIndex].id,
    ...(d.referenceLabel?{referenceLabel:d.referenceLabel}:{}),...(prior&&prior.contractId?{contractId:prior.contractId}:{}),...(d.coverageIndex===1?{baselineCoveredThrough:d.baselineCoveredThrough}:{})}
   if(d.coverageIndex===2)data.coverage=this.data.chargeCoverageRows.map(r=>{if(r.covers.length!==1)throw new Error('多期覆盖请选择一次性收费');return {chargeKey:r.covers[0],transactionId:r.transactionId}})
   if(d.coverageIndex===3)data.oneOffCharges=this.data.chargeCoverageRows.map(r=>({...r,key:'covered-'+r.transactionId}))
   const preview=await api.callApi('loans.chargePlan',{loanId:this._loanId,configuration:data,pageSize:20},{force:true})
   if(!current()||this._chargePreviewToken!==token)return
   this.setData({chargePreview:{items:preview.preview.map(i=>({...i,amountText:money.formatMinor(i.amountMinor),stateText:{due:'本次补记',covered:'已有覆盖',existing:'已有记录或停止标记',outside:'范围外不补',future:'未到期'}[i.previewState]})),next:preview.nextCursor,dueCount:preview.duePreviewCount,dueText:money.formatMinor(preview.duePreviewMinor)}})
   this._chargePreviewInput=data
   const content='本次到期缺项 '+preview.duePreviewCount+' 项，共 '+money.formatMinor(preview.duePreviewMinor)+' 元（增加费用与负债）。全期方案费用 '+money.formatMinor(preview.previewAmountMinor)+' 元。授权范围 '+d.fromDate+' 至 '+d.throughDate+'；首期计费 '+d.firstChargeDate+'，以后按月同日（月末取当月末）。已有明确覆盖只认领一次。'+(d.modeIndex===0?'使用时自动补齐到当天。':'仅本次确认后补齐。')+' 不生成银行卡扣款或已还进度。'
   if(!await confirm({title:'确认费用授权与历史范围',content,confirmText:'确认授权'})||!current()||this._chargePreviewToken!==token)return
   this.setData({saving:true,chargeError:''})
   const outcome=await pending.send('api','loans.configureCharges',data,{exact:true})
   if(!current())return
   this.setData({chargeFormOpen:false})
   await sync.beforePage(this,current,d.modeIndex===1?{contractId:outcome.result.contractId}:{})
   if(current()){this._forceLoanRead=true;this._detailReady=false;this._detailForce=true;await this.load()}
  }catch(error){if(current()&&this._chargePreviewToken===token)this.setData({chargeError:error.message,hasPending:!!pending.pending()})}
  finally{if(this._chargePreviewToken===token){this._chargeAuthorizing=false;if(current())this.setData({saving:false})}}
 },
 async moreChargePreview(){const input=this._chargePreviewInput,current=session.capture(this),cursor=this.data.chargePreview&&this.data.chargePreview.next;if(!input||!cursor)return;try{const result=await api.callApi('loans.chargePlan',{loanId:this._loanId,configuration:input,cursor,pageSize:20},{force:true});if(current()&&input===this._chargePreviewInput)this.setData({'chargePreview.items':result.preview.map(i=>({...i,amountText:money.formatMinor(i.amountMinor),stateText:{due:'本次补记',covered:'已有覆盖',existing:'已有记录或停止标记',outside:'范围外不补',future:'未到期'}[i.previewState]})),'chargePreview.next':result.nextCursor})}catch(error){if(current())this.setData({chargeError:error.message})}},
 async syncChargesNow(){const current=session.capture(this);if(this.data.saving)return;this.setData({saving:true});try{const auth=this._chargeView&&this._chargeView.contract;await sync.beforePage(this,current,auth&&auth.authorization.mode==='once'?{contractId:auth.contractId}:{});if(current()){this._forceLoanRead=true;this._detailReady=false;await this.load()}}finally{if(current())this.setData({saving:false})}},
 async pauseChargePlan(){const current=session.capture(this);if(await confirm({title:'暂停后续记费',content:'已入账费用保留，确认新的金额和起算范围后可再授权。',confirmText:'暂停记费'})&&current())return this.installmentWrite('loans.pauseCharges',{loanId:this._loanId,version:this.data.loan.version})},
 async endChargePlan(event){const reason=event.currentTarget.dataset.reason,current=session.capture(this);if(!await confirm({title:reason==='rate_changed'?'利率变化，暂停未来费用':'停止未来费用',content:'仅处理未来未记费用，已记费用和实际付款保留。退款需另外登记真实退还。',confirmText:'确认'})||!current())return;return this.installmentWrite('loans.endCharges',{loanId:this._loanId,version:this.data.loan.version,reason,confirmed:true})},
 async openChargeEdit(event){
  const current=session.capture(this),scope=this._periodToken,id=event.currentTarget.dataset.id,issue=this.data.periodChargeIssues.concat(this.data.chargeIssues).find(i=>i.eventId===id)
  let item=this.data.periodCharges.concat(this.data.chargeRows).find(i=>i.chargeId===id)
  if(issue){try{const view=await api.callApi('loans.chargePlan',{loanId:this._loanId,periodNumber:issue.periodNumber},{force:true});if(!current()||this._periodToken!==scope)return;item=view.items.find(i=>i.component===issue.component&&i.chargeKey==='period:'+issue.periodNumber+':'+issue.component)}catch(error){if(current())this.setData({chargeError:error.message});return}}
  if(!item){this.setData({chargeError:'请先确认这期收费覆盖，再核对账单'});return}
  const keys=item.state==='suppressed'?['restore']:['planned','paused','recorded'].includes(item.state)?['adjust',...(item.state==='recorded'&&!issue?['refund']:[]),...(item.state==='planned'?['pause']:[]),...(['planned','paused'].includes(item.state)?['cancel']:[]),'suppress']:[]
  if(issue)keys.push('distinct')
  const labels={adjust:'更正费用金额',refund:'登记实际退费',suppress:'撤销这笔费用',restore:'重新补记',pause:'暂停本项记费',cancel:'减免或取消未来费用',distinct:'这是另一笔新增收费'}
  this._chargeReturnTerm=this.data.oneOffOpen?0:this.data.periodOpen&&this.data.selectedPeriod?this.data.selectedPeriod.term:null
  this.setData({periodOpen:false,oneOffOpen:false,chargeError:'',chargeEdit:{...rowView(item),eventId:issue&&issue.eventId||'',updateId:issue&&issue.updateId||'',amountYuan:money.minorToYuan(issue?issue.amountMinor:item.amountMinor),refundDate:this._chargeView.cutoff,refundAccountIndex:-1,operation:keys[0]||'',operationIndex:0,options:keys.map(operation=>({operation,label:labels[operation]}))},chargeImpact:null})
 },
 chooseChargeOperation(event){this._chargeChangeToken={};const i=Number(event.detail.value),d=this.data.chargeEdit;if(d&&d.options[i])this.setData({'chargeEdit.operationIndex':i,'chargeEdit.operation':d.options[i].operation,chargeImpact:null})},
 chargeEditInput(event){this._chargeChangeToken={};const field=event.currentTarget.dataset.field;if(['amountYuan','refundDate','refundAccountIndex'].includes(field))this.setData({['chargeEdit.'+field]:field==='refundAccountIndex'?Number(event.detail.value):event.detail.value,chargeImpact:null})},
 async previewChargeChange(event){
  const d=this.data.chargeEdit,current=session.capture(this),token=this._chargeChangeToken={};if(!d||this.data.saving)return
  try{const operation=event.currentTarget.dataset.operation||d.operation,data={loanId:this._loanId,chargeId:d.chargeId,operation,...(d.eventId?{eventId:d.eventId}:{}),...(['adjust','distinct','refund'].includes(operation)?{amountMinor:money.yuanToMinor(d.amountYuan)}:{})}
   if(operation==='refund'){const account=this.data.chargeRefundAccounts[d.refundAccountIndex];if(!account)throw new Error('请选择实际收到退款的账户');Object.assign(data,{destinationAccountId:account.accountId,occurredLocalAt:d.refundDate+'T12:00:00',timezoneOffsetMinutes:-480})}
   const result=await api.callApi('loans.chargeImpact',data,{force:true});if(current()&&this._chargeChangeToken===token){this._chargeChange=data;this.setData({chargeImpact:{...result,deltaText:money.formatMinor(result.deltaMinor),additionalText:money.formatMinor(result.nextPostingMinor||'0')}})}
  }catch(error){if(current()&&this._chargeChangeToken===token)this.setData({chargeError:error.message})}
 },
 async confirmChargeChange(){const impact=this.data.chargeImpact;if(!impact||!impact.canChange||this.data.saving)return;const current=session.capture(this);if(!await confirm({title:'确认这笔费用变化',content:'账本费用净变化 '+impact.deltaText+' 元。'+(this._chargeChange.operation==='distinct'?'另有待导入收费 '+impact.additionalText+' 元。':'')+'本金与银行卡付款不会自动改变。',confirmText:'确认处理'})||!current())return
  const saved=await this.installmentWrite('loans.changeCharge',{...this._chargeChange,confirmed:true,previewToken:impact.previewToken});if(saved&&current()){this.setData({chargeEdit:null,chargeImpact:null});return this.returnToChargePeriod()}
 },
 openChargeIssueSource(){const item=this.data.chargeEdit;if(item&&item.updateId)wx.navigateTo({url:'/pages/import-workbench/index?updateId='+encodeURIComponent(item.updateId)+'&evidenceEventId='+encodeURIComponent(item.eventId)})}
}
module.exports={initial,methods,rowView}
