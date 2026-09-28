const api=require('../../services/catledger-api')
const pending=require('../../services/pending-ledger-write')
const session=require('../../services/page-read-session')
const confirm=options=>new Promise(resolve=>wx.showModal({...options,success:r=>resolve(r.confirm),fail:()=>resolve(false)}))
module.exports={
  async archiveInstallment(){
    if(!session.isCurrent(this)||this.data.saving||this.data.loading||this.data.deletingPreview||!this.data.loan||this.data.loan.deleted)return
    if(pending.pending()){this.setData({hasPending:true,errorMessage:'上次操作尚待核实，请先重试上次操作。'});return}
    const current=session.capture(this),token=this._deletePreview={}
    this.setData({deletingPreview:true,errorMessage:'',deleteBlockers:[]})
    try{
      const impact=await api.callApi('loans.deleteImpact',{loanId:this._loanId,version:this.data.loan.version},{force:true})
      if(!current()||this._deletePreview!==token)return
      if(!impact.canDelete){this.setData({deleteBlockers:impact.blockers});return}
      const n=impact.counts,parts=[]
      if(n.drawdowns)parts.push(n.drawdowns+'笔放款')
      if(n.repayments)parts.push(n.repayments+'笔还款')
      if(n.fees)parts.push(n.fees+'笔费用')
      const content='删除此计划，'+(parts.length?'将撤销其新增的'+parts.join('和')+'；':'将解除管理关系；')+'已有账目及已核实的导入记录保留，余额和统计将更新。'+(this.data.repaymentDirtyCount?'未保存的已还选择不会提交。':'')
      if(!await confirm({title:'删除贷款／分期',content,confirmText:'删除',confirmColor:'#A94B40'})||!current()||this._deletePreview!==token)return
      this.setData({saving:true})
      const outcome=await pending.send('api','loans.delete',{loanId:impact.loanId,version:impact.version,previewToken:impact.previewToken,confirmed:true},{exact:true})
      if(current())return this.acceptDeletedPlan(outcome)
    }catch(error){if(current())this.setData({errorMessage:error.message||'删除结果尚待核实',hasPending:!!pending.pending()})}
    finally{if(current()&&this._deletePreview===token)this.setData({saving:false,deletingPreview:false})}
  },
  async acceptDeletedPlan(outcome){
    if(outcome.action!=='loans.delete'||outcome.result.loanId!==this._loanId||!outcome.result.deleted)return false
    this.setData({deletedPlan:true,hasPending:false,savedMessage:'已删除',errorMessage:'',deleteBlockers:[],periodOpen:false,chargeEdit:null,repaymentDirtyCount:0})
    if(this._repaymentAlert&&typeof wx.disableAlertBeforeUnload==='function')wx.disableAlertBeforeUnload()
    this._repaymentAlert=false
    await this.refreshDeletedList()
    return true
  },
  async refreshDeletedList(){
    if(!session.isCurrent(this)||!this.data.deletedPlan)return
    const current=session.capture(this)
    try{
      await api.callApi('loans.list',{}, {force:true})
      if(!current())return
      this.setData({savedMessage:'已删除'})
      wx.showToast({title:'已删除',icon:'success'})
      wx.navigateBack()
    }catch(error){if(current())this.setData({savedMessage:'已删除，列表待刷新',errorMessage:''})}
  },
  openDeleteBlocker(event){
    if(!session.isCurrent(this)||this.data.saving)return
    const blocker=this.data.deleteBlockers[Number(event.currentTarget.dataset.index)]
    if(blocker)wx.navigateTo({url:blocker.entry.url})
  }
}
