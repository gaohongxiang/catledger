const api=require('../../services/catledger-api')
const pending=require('../../services/pending-ledger-write')
const session=require('../../services/page-read-session')
const login=require('../../services/login-guard')
const theme=require('../../theme/service')
const money=require('../../utils/money')
const scheduleForm=require('../loan-detail/schedule-form')
const planModel=require('../loan-plan/model')
const model=require('./model')
Page({
  data:{baselineMode:0,baselineModes:['以确认剩余本金接入已有贷款','新现金借款，到账前本金为 0'], sourceNote:'',accountLocked:false,loading:false,saving:false,errorMessage:'',savedMessage:'',hasPending:false,sourceReady:true,sourceLocked:false,loan:null,accounts:[],accountIndex:-1,name:'',principalYuan:'',
    schedule:Object.assign(scheduleForm.blank(),{measurementIndex:1}),paidTerms:'0',baselineDate:'',typeIndex:0,customRecordType:'',
    typeOptions:model.TYPE_OPTIONS,discountOptions:model.DISCOUNT_OPTIONS,methods:scheduleForm.METHOD_OPTIONS,quotes:scheduleForm.QUOTE_OPTIONS,
    discountIndex:0,discountValue:'',feeIndex:0,feeOptions:['一次性费用','每期费用'],advancedOpen:false,previewLoading:false,preview:null,remainingText:'',confirmed:false },
  onLoad(query){this._query=query || {};theme.bindPage(this);this.setData({accountLocked:!!this._query.accountId && !this._query.loanId,baselineDate:this._query.baselineDate || model.today(),sourceReady:(!this._query.accountId && !this._query.sourceTransactionId) || !!this._query.loanId,sourceLocked:!!(this._query.sourceTransactionId || this._query.sourceItemId)})},
  onShow(){return login.run(this,()=>this.load())},
  onUnload(){session.end(this)},
  async load(){
    if(this.data.saving)return
    const current=session.begin(this,Object.keys(this.data),['_preview','_initialized'])
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
        accountId=source.targetAccount.accountId;this.setData({sourceReady:true,...(!this._initialized?{baselineDate:source.transaction.occurredLocalAt.slice(0,10)}:{})})
      }
      if(this._query.sourceItemId && !this._query.loanId){
        this.setData({sourceReady:false})
        const result=await api.callApi('loans.installmentSources',{itemId:this._query.sourceItemId},{force:true});if(!current())return
        const source=result.items[0];if(!source)throw new Error('该账单已关联或状态变化，请返回重新读取')
        accountId=source.accountId
        this.setData({sourceReady:true,sourceNote:'已识别第 '+source.periodNumber+' 期'+({principal:'本金',interest:'利息',fee:'手续费'}[source.component])+' '+money.formatMinor(source.amountMinor)+'。此行仅证明出账，不确认已还。请补齐总本金、首期日期及还款依据。',...(!this._initialized?{name:source.referenceLabel||'信用卡分期',paidTerms:'0',typeIndex:1,'schedule.terms':source.totalTerms?String(source.totalTerms):'',baselineDate:source.occurredDate}:{})})
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
      }
      this._initialized=true
    }catch(error){if(current())this.setData({errorMessage:error.message || '贷款资料暂未读取'})}
    finally{if(current())this.setData({loading:false})}
  },
  invalidate(){this._preview=null;this._previewToken={};this.setData({preview:null,confirmed:false,previewLoading:false,errorMessage:''})},
  input(event){const field=event.currentTarget.dataset.field;if(!['name','principalYuan','paidTerms','customRecordType','discountValue','baselineDate'].includes(field))return;if(this.data.loan&&!['name','customRecordType'].includes(field))return;this.setData({[field]:event.detail.value});if(field==='baselineDate')this.setData({confirmed:false});else if(!['name','customRecordType'].includes(field))this.invalidate()},
  scheduleInput(event){if(this.data.loan)return;const field=event.currentTarget.dataset.field;if(!['terms','ratePercent','repaymentYuan','firstPaymentDate','feeUpfrontYuan','feePerTermYuan'].includes(field))return;this.setData({['schedule.'+field]:event.detail.value});this.invalidate()},
  selectAccount(event){if(!this.data.loan&&!this.data.sourceLocked&&!this.data.accountLocked)this.setData({accountIndex:Number(event.detail.value),confirmed:false})},
  selectBaselineMode(event){if(this.data.loan||this.data.sourceLocked)return;this.setData({baselineMode:Number(event.detail.value)});this.invalidate()},
  selectType(event){this.setData({typeIndex:Number(event.detail.value)})},
  selectMethod(event){if(this.data.loan)return;const index=Number(event.currentTarget.dataset.index);if(this.data.schedule.measurementIndex===0&&this.data.schedule.quoteIndex===3&&index!==0)return;this.setData({schedule:scheduleForm.selectMethod(this.data.schedule,index)});this.invalidate()},
  selectMeasurement(event){if(this.data.loan)return;this.setData({'schedule.measurementIndex':Number(event.currentTarget.dataset.index)});this.invalidate()},
  selectQuote(event){if(this.data.loan)return;this.setData({schedule:scheduleForm.selectQuote(this.data.schedule,event.detail.value)});this.invalidate()},
  selectDiscount(event){if(this.data.loan)return;this.setData({discountIndex:Number(event.detail.value)});this.invalidate()},
  selectFee(event){if(this.data.loan)return;const feeIndex=Number(event.detail.value),old=this.data.feeIndex===0?'feeUpfrontYuan':'feePerTermYuan',next=feeIndex===0?'feeUpfrontYuan':'feePerTermYuan';this.setData({feeIndex,['schedule.'+old]:'',['schedule.'+next]:this.data.schedule[old]});this.invalidate()},
  toggleAdvanced(){this.setData({advancedOpen:!this.data.advancedOpen})},
  confirm(event){this.setData({confirmed:event.detail.value.includes('confirmed')})},
  openAccounts(){wx.navigateTo({url:'/pages/accounts/index'})},
  openPlan(){if(this.data.loan&&!this.data.loading&&!this.data.saving&&!this.data.hasPending)wx.navigateTo({url:'/pages/loan-plan/index?loanId='+encodeURIComponent(this.data.loan.loanId)})},
  cancel(){if(!this.data.saving)wx.navigateBack()},
  async preview(){
    if(this.data.loading||this.data.saving||this.data.previewLoading||!this.data.sourceReady||(this._query.loanId&&!this.data.loan))return
    const current=session.capture(this),token=this._previewToken={}
    this.setData({previewLoading:true,errorMessage:'',confirmed:false})
    try{
      const input=model.previewInput(this.data),result=await api.callApi('loans.previewPlan',input,{force:true})
      if(!current()||this._previewToken!==token)return
      this._preview=result
      this.setData({preview:planModel.previewView(result),remainingText:money.formatMinor(result.summary.remainingPrincipalMinor)})
    }catch(error){if(current()&&this._previewToken===token)this.setData({errorMessage:error.message || '计划暂未核对'})}
    finally{if(current()&&this._previewToken===token)this.setData({previewLoading:false})}
  },
  accept(outcome){
    this.setData({hasPending:false,savedMessage:outcome.recovered?'上次保存已确认成功':'分期记录已保存'})
    if(/^loans\.(create|update)$/.test(outcome.action))wx.redirectTo({url:'/pages/loan-detail/index?loanId='+encodeURIComponent(outcome.result.loanId)+(this._query.sourceTransactionId?'&sourceTransactionId='+encodeURIComponent(this._query.sourceTransactionId):'')})
  },
  async save(){
    if(this.data.loading||this.data.saving||(!this.data.sourceReady&&!pending.pending())||(this._query.loanId&&!this.data.loan))return
    if(!pending.pending()&&!this.data.loan&&!this._preview)return this.preview()
    const current=session.capture(this);this.setData({saving:true,errorMessage:'',savedMessage:''})
    try{
      let data={},action=this.data.loan?'loans.update':'loans.create'
      if(!pending.pending()){
        if(this.data.loan){
          const loan=this.data.loan,input=model.previewInput(this.data);delete input.principalMinor
          if(!String(this.data.name).trim())throw new Error('请填写贷款名称')
          data=Object.assign(input,{loanId:loan.loanId,version:loan.version,name:String(this.data.name).trim(),institution:loan.institution,kind:loan.kind,
            accountId:loan.accountId,baselinePrincipalMinor:loan.baselinePrincipalMinor,baselineDate:loan.baselineDate,startDate:loan.startDate,endDate:loan.endDate,repaymentMethod:loan.repaymentMethod})
        }else {data=model.createPayload(this.data,this._preview);if(this._query.sourceItemId)data.sourceItemId=this._query.sourceItemId}
      }
      const outcome=await pending.send('api',action,data);if(current())this.accept(outcome)
    }catch(error){if(current())this.setData({errorMessage:error.message,hasPending:!!pending.pending()})}
    finally{if(current())this.setData({saving:false})}
  }
})
