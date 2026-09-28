const api=require('../../services/catledger-api'),session=require('../../services/page-read-session'),pending=require('../../services/pending-ledger-write')
const {rowView}=require('./charge-actions')
module.exports={
  async loadRetainedCharge(){
    const current=session.begin(this,Object.keys(this.data),['_chargeChange','_chargeView','_retainedView'])
    this.setData({loading:true,errorMessage:'',hasPending:!!pending.pending()})
    try{
      const [catalog,result]=await Promise.all([api.callApi('catalog.get'),api.callApi('loans.retainedCharge',{chargeId:this._retainedChargeId},{force:true})])
      if(!current())return
      this._retainedView=result;this._chargeView=result
      this.setData({retainedCharge:rowView(result.charge),chargeRows:[rowView(result.charge)],chargeCategories:catalog.categories.filter(c=>c.kind==='expense'&&!c.archived),
        chargeRefundAccounts:catalog.accounts.filter(a=>!a.archived&&(['cash','bank','wallet','other_asset'].includes(a.type)||a.accountId===result.accountId))})
    }catch(error){if(current())this.setData({errorMessage:error.message||'费用暂未读取'})}
    finally{if(current())this.setData({loading:false})}
  },
  rebuildFromCharge(){
    if(!session.isCurrent(this)||this.data.saving||this.data.loading||!this._retainedView)return
    wx.navigateTo({url:'/pages/loan-form/index?chargeContractId='+encodeURIComponent(this._retainedView.contractId)+'&accountId='+encodeURIComponent(this._retainedView.accountId)})
  }
}
