const api=require('../../../../services/catledger-api')
const pending=require('../../../../services/pending-ledger-write')
const session=require('../../../../services/page-read-session')
const login=require('../../../../services/login-guard')
const theme=require('../../../../theme/service')
const money=require('../../../../utils/money')
const scheduleForm=require('../../../../services/loan-schedule-form')
const planModel=require('../loan-plan/model')
// 后端结构化报错里带的字段名 → 本页高亮键。用于把「请检查填写内容」变成点名的红框。
const FIELD_HIGHLIGHTS={principalMinor:'principal', scheduleTerms:'terms', scheduleMethod:'method', quoteType:'quote', ratePpm:'rate', repaymentMinor:'repayment', firstPaymentDate:'date', feeUpfrontMinor:'feeUpfront', feePerTermMinor:'feePerTerm', principalRounding:'rounding', discountKind:'discount', discountValue:'discount'}
function scheduleErrors(page,error){
  const keys=[...(Array.isArray(error&&error.fields)?error.fields:[])].map(f=>FIELD_HIGHLIGHTS[f]).filter(Boolean)
  const highlight={}
  for(const key of [...new Set(keys)]) highlight[key]=true
  return { fieldErrors: highlight, errorFields: [...new Set(keys)] }
}
const model=require('./model')
const businessInitialData = {baselineMode:0,baselineModes:['常规分期（按账单/合同）','新现金借款，到账前本金为 0'], sourceNote:'',accountLocked:false,loading:false,saving:false,errorMessage:'',savedMessage:'',hasPending:false,sourceReady:true,sourceLocked:false,loan:null,accounts:[],accountIndex:-1,name:'',principalYuan:'',
    schedule:Object.assign(scheduleForm.blank(),{measurementIndex:1}),paidTerms:'0',showFirstPaymentDate:false,typeIndex:0,customRecordType:'',
    typeOptions:model.TYPE_OPTIONS,discountOptions:model.DISCOUNT_OPTIONS,methods:scheduleForm.METHOD_OPTIONS,quotes:scheduleForm.QUOTE_OPTIONS,roundings:scheduleForm.ROUNDING_OPTIONS,
    discountIndex:0,discountValue:'',feeIndex:0,feeOptions:['一次性费用','每期费用'],advancedOpen:false,previewLoading:false,preview:null,remainingText:'',confirmed:false,structureDirty:false,fieldErrors:{},errorFields:[] }

Page(theme.page({
  data:businessInitialData,
  onLoad(query){this._query=query || {};const sourceDriven=!!(this._query.sourceTransactionId || this._query.sourceItemId);this._sourceDriven=sourceDriven;
    // 首期还款日在所有场景都显示、可改：有账单来源时按第N期日期反推做初值，编辑时用已存值，用户可随时调整。
    this.setData({accountLocked:!!this._query.accountId && !this._query.loanId,sourceReady:(!this._query.accountId && !this._query.sourceTransactionId) || !!this._query.loanId,sourceLocked:sourceDriven,showFirstPaymentDate:true})},
  onShow(){return login.run(this,()=>this.load())},
  onHide(){session.end(this)},
  onUnload(){session.end(this)},
  async load(){
    if(this.data.saving)return
    const current=session.begin(this,Object.keys(businessInitialData),['_preview','_initialized'])
    this.setData({loading:true,errorMessage:'',hasPending:!!pending.pending(),...(!this._query.loanId && (this.data.accountLocked || this.data.sourceLocked) ? {sourceReady:false} : {})})
    try{
      if(pending.pending()) {try{const recovered=await pending.verify();if(current()&&recovered){this.accept(recovered);return}}catch(error){if(current())this.setData({errorMessage:error.message,hasPending:!!pending.pending()})}}
      const catalog=await api.callApi('catalog.get');if(!current())return
      getApp().globalData.uid=catalog.uid
      const accounts=catalog.accounts.filter(a=>!a.archived&&['credit','other_liability'].includes(a.type))
      const selected=this.data.accounts[this.data.accountIndex];let accountId=this.data.accountLocked ? this._query.accountId : selected && selected.accountId || this._query.accountId
      if(this._query.sourceTransactionId && !this._query.loanId){
        this.setData({sourceReady:false})
        const source=await api.callApi('loans.transaction',{transactionId:this._query.sourceTransactionId},{force:true});if(!current())return
        if(source.state!=='candidate'||source.targetAccount.inactive)throw new Error('原还款状态已变化，请返回重新核对')
        accountId=source.targetAccount.accountId;this.setData({sourceReady:true,...(!this._initialized?{schedule:{...this.data.schedule,firstPaymentDate:source.transaction.occurredLocalAt.slice(0,10)}}:{})})
      }
      if(this._query.sourceItemId && !this._query.loanId){
        this.setData({sourceReady:false})
        const result=await api.callApi('loans.installmentSources',{itemId:this._query.sourceItemId},{force:true});if(!current())return
        const source=result.items[0];if(!source)throw new Error('该账单已关联或状态变化，请返回重新读取')
        accountId=source.accountId
        // 同一期次的主息两条来源各存一行，拼在一起展示"第N期 本金X · 利息Y"。
        let relate={principal:null,interest:null,fee:null}
        try {
          const all=await api.callApi('loans.installmentSources',{accountId:source.accountId,pageSize:40},{force:true})
          if(current()){
            const same=(all.items||[]).filter(it=>it.periodNumber===source.periodNumber && (it.planLabel||it.referenceLabel||'')===(source.planLabel||source.referenceLabel||''))
            for(const c of ['principal','interest','fee']){const hit=same.find(it=>it.component===c);if(hit)relate[c]=hit.amountMinor}
          }
        } catch(e){ /* 取不到其它组件时退化为单组件展示 */ }
        if(relate[source.component]==null)relate[source.component]=source.amountMinor
        const parts=[]
        for(const c of ['principal','interest','fee'])if(relate[c]!=null)parts.push({principal:'本金',interest:'利息',fee:'手续费'}[c]+' '+money.formatMinor(relate[c]))
        this.setData({sourceReady:true,sourceNote:'已识别第 '+source.periodNumber+' 期 '+parts.join(' · ')+'。已还期数、总期数按账单带出；借款金额请按合同/账单填写。',
        ...(!this._initialized?{name:source.planLabel||source.referenceLabel||'信用卡分期',typeIndex:1,
          // 已还期数 = 账单出现的期次（第 N 期账单 → 第 1~N 期视为已还），用户可改。
          paidTerms:String(Math.max(0,Number(source.periodNumber))),
          // 总期数按账单带出；首期还款日 = 第N期发生日 - (N-1)期，不向用户收集，一起写进 schedule。
          schedule:{...this.data.schedule,terms:source.totalTerms?String(source.totalTerms):this.data.schedule.terms,
            ...(source.occurredDate && Number(source.periodNumber) ? {firstPaymentDate:model.firstPaymentFromPeriod(source.occurredDate,source.periodNumber)} : {})},
          // 不预填「借款金额」：账单只给某一期本金，×期数只对等本等息近似，
          // 等额本息/本金会算错。借款金额是用户按合同/账单确认的必填项，留空让用户填。
          }:{})})
      }
      const accountIndex=accounts.findIndex(a=>a.accountId===accountId)
      this.setData({accounts,accountIndex})
      if(this._query.sourceItemId && accountIndex<0){this.setData({sourceReady:false});throw new Error('该账单的信用卡账户已停用，请先恢复账户')}
      if(this.data.accountLocked){
        this.setData({sourceReady:accountIndex>=0})
        if(accountIndex<0)throw new Error('原负债账户已停用或不可用，请返回账户管理')
      }
      if(this._query.loanId && !this._initialized){
        const result=await api.callApi('loans.get',{loanId:this._query.loanId},{force:true});if(!current())return
        if(!result.loan.installmentSetup)throw new Error('此贷款请从原资料页编辑')
        this.setData(Object.assign(model.fields(result.loan),{loan:result.loan,accountIndex:accounts.findIndex(a=>a.accountId===result.loan.accountId)}))
        // 记住载入时的地基字段，用于判断是否触发重算（而非仅改名）。
        this._loadedBase = this._structureKey()
      }
      this._initialized=true
    }catch(error){if(current())this.setData({errorMessage:error.message || '贷款资料暂未读取'})}
    finally{if(current())this.setData({loading:false})}
  },
  invalidate(){this._preview=null;this._previewToken={};this.setData({preview:null,confirmed:false,previewLoading:false,errorMessage:'',fieldErrors:{},errorFields:[],structureDirty:this.structureDirty()})},
  input(event){const field=event.currentTarget.dataset.field;if(!['name','principalYuan','paidTerms','customRecordType','discountValue'].includes(field))return;
    // 编辑已有计划：名称/类型随时可改；本金、已还期数、优惠等会触发期次重算（保存时走 rebuildPlan 预览确认）。
    this.setData({[field]:event.detail.value});if(!['name','customRecordType'].includes(field))this.invalidate()},
  scheduleInput(event){const field=event.currentTarget.dataset.field;if(!['terms','ratePercent','repaymentYuan','optionalDailyRate','firstPaymentDate','feeUpfrontYuan','feePerTermYuan'].includes(field))return;let schedule=Object.assign({},this.data.schedule,{[field]:event.detail.value});if(field==='firstPaymentDate'&&schedule.interestStartDate)schedule=scheduleForm.syncFirstPeriod(schedule,'date');this.setData({schedule});this.invalidate()},
  // 起息日选择：写入后按首还日反算首期天数，两个字段联动不矛盾。
  scheduleDateInput(event){const next=scheduleForm.syncFirstPeriod(Object.assign({},this.data.schedule,{interestStartDate:event.detail.value,firstPaymentDate:this.data.schedule.firstPaymentDate}),'date');this.setData({schedule:next});this.invalidate()},
  // 首期天数输入：写入后按首还日反推起息日，两个字段联动不矛盾。
  scheduleDaysInput(event){const next=scheduleForm.syncFirstPeriod(Object.assign({},this.data.schedule,{firstPeriodDays:event.detail.value,firstPaymentDate:this.data.schedule.firstPaymentDate}),'days');this.setData({schedule:next});this.invalidate()},
  selectAccount(event){if(!this.data.loan&&!this.data.sourceLocked&&!this.data.accountLocked){this.setData({accountIndex:Number(event.detail.value),confirmed:false});this.invalidate()}},
  selectBaselineMode(event){if(this.data.loan||this.data.sourceLocked)return;this.setData({baselineMode:Number(event.detail.value)});this.invalidate()},
  selectType(event){this.setData({typeIndex:Number(event.detail.value)})},
  selectMethod(event){const index=Number(event.currentTarget.dataset.index);const quote=scheduleForm.QUOTE_OPTIONS[this.data.schedule.quoteIndex];if(this.data.schedule.measurementIndex===0&&quote&&quote.value==='installment'&&index!==0)return;this.setData({schedule:scheduleForm.selectMethod(this.data.schedule,index)});this.invalidate()},
  selectMeasurement(event){this.setData({schedule:scheduleForm.selectMeasurement(this.data.schedule,Number(event.currentTarget.dataset.index))});this.invalidate()},
  selectQuote(event){const index=Number(event.currentTarget.dataset.index);const opt=scheduleForm.QUOTE_OPTIONS[index];if(opt&&opt.value==='installment'&&this.data.schedule.methodIndex!==0)return;this.setData({schedule:scheduleForm.selectQuote(this.data.schedule,index)});this.invalidate()},
  selectRounding(event){const index=Number(event.currentTarget.dataset.index);this.setData({schedule:scheduleForm.selectRounding(this.data.schedule,index)});this.invalidate()},
  selectDiscount(event){this.setData({discountIndex:Number(event.detail.value)});this.invalidate()},
  selectFee(event){const feeIndex=Number(event.detail.value),old=this.data.feeIndex===0?'feeUpfrontYuan':'feePerTermYuan',next=feeIndex===0?'feeUpfrontYuan':'feePerTermYuan';this.setData({feeIndex,['schedule.'+old]:'',['schedule.'+next]:this.data.schedule[old]});this.invalidate()},
  toggleAdvanced(){this.setData({advancedOpen:!this.data.advancedOpen})},
  confirm(event){this.setData({confirmed:event.detail.value.includes('confirmed')})},
  openAccounts(){wx.navigateTo({url:'/pages/accounts/index'})},
  cancel(){if(!this.data.saving)wx.navigateBack()},
  async preview(){
    if(this.data.loading||this.data.saving||this.data.previewLoading||!this.data.sourceReady||(this._query.loanId&&!this.data.loan))return
    const current=session.capture(this),token=this._previewToken={}
    this.setData({previewLoading:true,errorMessage:'',confirmed:false})
    try{
      const input=model.previewInput(this.data),result=await api.callApi('loans.previewPlan',input,{force:true})
      if(!current()||this._previewToken!==token)return
      this._preview=result
      // 逐期表直接展示后端按「已还期数/账单锚点」切好的剩余计划；剩余本金取 summary 的未还本金合计。
      this.setData({preview:planModel.previewView(result,24),remainingText:money.formatMinor(result.summary.remainingPrincipalMinor)})
    }catch(error){if(current()&&this._previewToken===token)this.setData({errorMessage:error.message || '计划暂未核对',...scheduleErrors(this,error)})}
    finally{if(current()&&this._previewToken===token)this.setData({previewLoading:false})}
  },
  accept(outcome){
    this.setData({hasPending:false,savedMessage:outcome.recovered?'上次保存已确认成功':'分期记录已保存'})
    if(/^loans\.(create|update|rebuildPlan)$/.test(outcome.action))wx.redirectTo({url:'/packages/loans/pages/loan-detail/index?loanId='+encodeURIComponent(outcome.result.loanId)+(this._query.sourceTransactionId?'&sourceTransactionId='+encodeURIComponent(this._query.sourceTransactionId):'')})
  },
  // 结构键：决定期次「地基」的字段组合。编辑时与载入快照比较判断是否需重算。
  _structureKey(){
    const s=this.data.schedule||{}
    return JSON.stringify({principalYuan:String(this.data.principalYuan||''),terms:String(s.terms||''),paidTerms:String(this.data.paidTerms||''),
      methodIndex:s.methodIndex,measurementIndex:s.measurementIndex,quoteIndex:s.quoteIndex,ratePercent:String(s.ratePercent||''),repaymentYuan:String(s.repaymentYuan||''),
      feeUpfrontYuan:String(s.feeUpfrontYuan||''),feePerTermYuan:String(s.feePerTermYuan||''),firstPaymentDate:String(s.firstPaymentDate||''),
      discountIndex:this.data.discountIndex,discountValue:String(this.data.discountValue||''),typeIndex:this.data.typeIndex,customRecordType:String(this.data.customRecordType||'')})
  },
  structureDirty(){ return !!this.data.loan && this._loadedBase != null && this._structureKey() !== this._loadedBase },
  async save(){
    if(this.data.loading||this.data.saving||(!this.data.sourceReady&&!pending.pending())||(this._query.loanId&&!this.data.loan))return
    // 编辑已有计划：地毯字段有改动 → 先核对重算预览，再走 rebuildPlan（一次原子命令，含名称）。
    if(this.data.loan && !pending.pending() && this.structureDirty() && !this.data.preview){
      return this.preview()
    }
    if(!pending.pending()&&!this.data.loan&&!this._preview)return this.preview()
    const current=session.capture(this);this.setData({saving:true,errorMessage:'',savedMessage:''})
    try{
      let data={},action
      if(this.data.loan && !pending.pending() && this.structureDirty()){
        // 重算：提交名字 + 全部地基字段 + setup。
        const input=model.previewInput(this.data)
        data=Object.assign({},input,{
          loanId:this.data.loan.loanId, version:this.data.loan.version, confirmed:true,
          name:String(this.data.name).trim(), institution:this.data.loan.institution,
          scheduleMethod:input.scheduleMethod, scheduleTerms:input.scheduleTerms, measurementKind:input.measurementKind,
          quoteType:input.quoteType, ratePpm:input.ratePpm, repaymentMinor:input.repaymentMinor,
          feePerTermMinor:input.feePerTermMinor, feeUpfrontMinor:input.feeUpfrontMinor,
          firstPaymentDate:input.firstPaymentDate, installmentSetup:input.installmentSetup })
        delete data.principalMinor
        action='loans.rebuildPlan'
        if(!String(this.data.name).trim())throw new Error('请填写贷款名称')
      } else if(!pending.pending()){
        if(this.data.loan){
          const loan=this.data.loan,input=model.previewInput(this.data);delete input.principalMinor
          if(!String(this.data.name).trim())throw new Error('请填写贷款名称')
          data=Object.assign(input,{loanId:loan.loanId,version:loan.version,name:String(this.data.name).trim(),institution:loan.institution,kind:loan.kind,
            accountId:loan.accountId,baselinePrincipalMinor:loan.baselinePrincipalMinor,baselineDate:loan.baselineDate,startDate:loan.startDate,endDate:loan.endDate,repaymentMethod:loan.repaymentMethod})
          action='loans.update'
        }else {data=model.createPayload(this.data,this._preview);if(this._query.sourceItemId)data.sourceItemId=this._query.sourceItemId;if(this._query.chargeContractId)data.chargeContractId=this._query.chargeContractId;action='loans.create'}
      }
      const outcome=await pending.send('api',action,data);if(current())this.accept(outcome)
    }catch(error){if(current())this.setData({errorMessage:error.message,hasPending:!!pending.pending(),...scheduleErrors(this,error)})}
    finally{if(current())this.setData({saving:false})}
  }
}))
