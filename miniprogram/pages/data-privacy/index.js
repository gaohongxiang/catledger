const api=require('../../services/catledger-api')
const exportsService=require('../../services/export-files')
const session=require('../../services/page-read-session')
const theme=require('../../theme/service')
const login=require('../../services/login-guard')
Page({
  data:{busy:false,rows:0,complete:false,errorMessage:'',statusText:'',loggedIn:false},
  onLoad(){theme.bindPage(this);session.begin(this,['busy','rows','complete','errorMessage','statusText'],[]);this._files=exportsService.createExportFiles(wx)},
  onShow(){this.setData({loggedIn:getApp().hasLoginApproval()});if(this._result&&Date.now()>=this._result.expiresAt)this.clearExport()},
  onUnload(){session.end(this);this._run=(this._run||0)+1;if(this._result)this._files.remove(this._result.files)},
  generate(){
    return login.run(this,()=>this.generateApproved())
  },
  async generateApproved(){
    if(this.data.busy)return
    const validSession=session.begin(this,['busy','rows','complete','errorMessage','statusText'],[]),run=this._run=(this._run||0)+1
    const current=()=>validSession()&&this._run===run
    this.clearExport();this.setData({busy:true,rows:0,statusText:'正在生成完整导出…',errorMessage:''})
    try{
      const result=await this._files.generate({call:(a,d)=>api.callApi(a,d,{force:true}),requestId:api.createRequestId(),isCurrent:current,
        progress:rows=>{if(current())this.setData({rows})}})
      if(current()){this._result=result;this.setData({complete:true,rows:result.rows,statusText:'完整性核对通过。文件仅保留在本机一小时。'})}
    }catch(error){if(current())this.setData({errorMessage:error.message||'导出未完成，请重新生成',statusText:''})}
    finally{if(current())this.setData({busy:false})}
  },
  clearExport(){if(this._result)this._files.remove(this._result.files);this._result=null;this.setData({complete:false,rows:0,statusText:''})},
  share(event){
    const kind=event.currentTarget.dataset.kind,result=this._result
    if(!session.isCurrent(this)||!result||!['jsonl','csv'].includes(kind))return
    if(Date.now()>=result.expiresAt){this.clearExport();this.setData({errorMessage:'导出已过期，请重新生成'});return}
    wx.shareFileMessage({filePath:result.files[kind],fileName:'招财猫记账本导出.'+kind,fail:()=>wx.showToast({title:'未分享文件',icon:'none'})})
  }
})
