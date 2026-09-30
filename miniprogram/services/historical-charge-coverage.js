const api=require('./catledger-api'),session=require('./page-read-session'),money=require('../utils/money')
const {addMinor}=require('../utils/minor-arithmetic')
const initial={historyCoverageRows:[],historyCoverageByPeriod:{},historyCoverageSelections:[],historyCoverageSuggested:0,historyCoverageEditor:null,historyCoverageCandidates:[],historyCoverageNext:null,historyCoverageLoading:false,historyCoverageError:''}
const label=t=>t.occurredLocalAt.slice(0,10)+' · '+money.formatMinor(t.amountMinor)+' · '+(t.note||t.category&&t.category.name||'支出')
function selectedRows(periods,upfrontMinor){
 return periods.flatMap(row=>{
  const term=row.periodNumber,items=['interest','fee'].filter(component=>String(row[component+'Minor']||'0')!=='0'&&!(row.recordedComponents||[]).includes(component)).map(component=>({
   chargeKey:'period:'+term+':'+component,periodNumber:term,component,amountMinor:String(row[component+'Minor']),dueDate:row.dueDate}))
  if(term===1&&upfrontMinor&&upfrontMinor!=='0')items.push({chargeKey:'upfront:fee',periodNumber:1,component:'fee',amountMinor:upfrontMinor,dueDate:row.dueDate,upfront:true})
  return items.map(item=>({...item,amountText:money.formatMinor(item.amountMinor),title:'第 '+term+' 期'+(item.upfront?'一次性费用':item.component==='interest'?'利息':'手续费')}))
 })
}
const methods={
 resetHistoricalCoverage(){this._historyCoverageToken={};this._historyRecommendToken={};this._historyCoverageAccount=null;this.setData({...initial})},
 async prepareHistoricalCoverage(periods,accountId,upfrontMinor){
  if(!session.isCurrent(this))return
  if(this._historyCoverageAccount&&this._historyCoverageAccount!==accountId)this.resetHistoricalCoverage()
  this._historyCoverageAccount=accountId
  const current=session.capture(this),token=this._historyRecommendToken={}
  const rows=selectedRows(periods,upfrontMinor),selected=this.data.historyCoverageSelections||[]
  this.setData({historyCoverageRows:rows.map(row=>({...row,selectedLabel:(selected.find(s=>s.covers.includes(row.chargeKey))||{}).label||''})),historyCoverageSuggested:0})
  this.updateHistoricalCoverageLabels()
  if(!rows.length||!accountId)return
  const unique=new Map(rows.map(row=>[row.dueDate.slice(0,7)+':'+row.amountMinor,{month:row.dueDate.slice(0,7),amountMinor:row.amountMinor}]))
  try{
   const result=await api.callApi('transactions.refundable',{accountId,feeCandidate:true,chargeCandidates:Array.from(unique.values()),pageSize:40},{force:true})
   if(!current()||this._historyRecommendToken!==token)return
   this.setData({historyCoverageSuggested:result.transactions.length})
  }catch(error){if(current()&&this._historyRecommendToken===token)this.setData({historyCoverageError:'已有费用暂未读取，点「选已记」可重试。'})}
 },
 openHistoricalCoverage(event){
  if(this.data.saving||this.data.loading||!session.isCurrent(this))return
  const {key,term}=event.currentTarget.dataset
  const row=this.data.historyCoverageRows.find(r=>key?r.chargeKey===key:r.periodNumber===Number(term))
  if(!row)return
  const components=this.data.historyCoverageRows.filter(r=>r.periodNumber===row.periodNumber).map(r=>({key:r.chargeKey,label:r.upfront?'一次性费用':r.component==='interest'?'利息':'手续费'}))
  this.setData({historyCoverageEditor:{...row,components,advanced:false,month:row.dueDate.slice(0,7),allDates:false,search:'',multiple:false,through:String(row.periodNumber)},historyCoverageCandidates:[],historyCoverageNext:null,historyCoverageError:''})
  return this.loadHistoricalCandidates()
 },
 stopHistoricalTap(){},
 changeHistoricalMonth(event){this.historicalCoverageInput(event);return this.loadHistoricalCandidates()},
 toggleHistoricalFilter(event){
  const editor=this.data.historyCoverageEditor,key=event.currentTarget.dataset.field
  if(!editor||this.data.saving||!['allDates','advanced','multiple'].includes(key))return
  if(key==='advanced'){this.setData({'historyCoverageEditor.advanced':!editor.advanced});return}
  this.historicalCoverageInput({currentTarget:{dataset:{field:key}},detail:{value:!editor[key]}})
  if(key==='allDates'||!this.data.historyCoverageEditor.multiple)return this.loadHistoricalCandidates()
 },
 historicalCoverageInput(event){
  if(this.data.saving||!this.data.historyCoverageEditor)return
  const key=event.currentTarget.dataset.field
  if(!['month','allDates','search','multiple','through'].includes(key))return
  this._historyCoverageToken={}
  this.setData({['historyCoverageEditor.'+key]:event.detail.value,historyCoverageCandidates:[],historyCoverageNext:null,historyCoverageLoading:false,historyCoverageError:''})
 },
 historicalCoverageTarget(){
  const editor=this.data.historyCoverageEditor
  if(!editor)throw new Error('请先选择本期费用')
  const through=editor.multiple?Number(editor.through):editor.periodNumber
  if(!Number.isInteger(through)||through<editor.periodNumber||through>600||editor.upfront&&editor.multiple)throw new Error('请填写有效的覆盖期次')
  const rows=this.data.historyCoverageRows.filter(row=>editor.multiple?!row.upfront&&row.component===editor.component&&row.periodNumber>=editor.periodNumber&&row.periodNumber<=through:row.chargeKey===editor.chargeKey)
  if(rows.length!==through-editor.periodNumber+1)throw new Error('只能覆盖本次勾选已还且尚未记录的同类费用')
  return {rows,amountMinor:rows.reduce((sum,row)=>addMinor(sum,row.amountMinor),'0')}
 },
 async loadHistoricalCandidates(event){
  if(this.data.saving||this.data.historyCoverageLoading||!this.data.historyCoverageEditor||!session.isCurrent(this))return
  const current=session.capture(this),token=this._historyCoverageToken={},editor=this.data.historyCoverageEditor
  const cursor=event&&event.currentTarget&&event.currentTarget.dataset.next?this.data.historyCoverageNext:null
  this.setData({historyCoverageLoading:true,historyCoverageError:''})
  try{
   const target=this.historicalCoverageTarget()
   const result=await api.callApi('transactions.refundable',{accountId:this._historyCoverageAccount,feeCandidate:true,amountMinor:target.amountMinor,pageSize:20,...editor.allDates?{}:{month:editor.month},...editor.search?{search:editor.search}:{},...cursor?{cursor}:{}},{force:true})
   if(current()&&this._historyCoverageToken===token)this.setData({historyCoverageCandidates:result.transactions.map(t=>({...t,label:label(t),dateText:t.occurredLocalAt.slice(0,10),amountText:money.formatMinor(t.amountMinor),noteText:t.note||t.category&&t.category.name||'支出'})),historyCoverageNext:result.nextCursor||null,'historyCoverageEditor.totalText':money.formatMinor(target.amountMinor)})
  }catch(error){if(current()&&this._historyCoverageToken===token)this.setData({historyCoverageError:error.message||'已有费用暂未读取'})}
  finally{if(current()&&this._historyCoverageToken===token)this.setData({historyCoverageLoading:false})}
 },
 chooseHistoricalCandidate(event){
  if(this.data.saving||this.data.historyCoverageLoading||!session.isCurrent(this))return
  try{
   const transaction=this.data.historyCoverageCandidates.find(t=>t.transactionId===event.currentTarget.dataset.id)
   if(!transaction)throw new Error('请重新读取原费用')
   const {rows,amountMinor}=this.historicalCoverageTarget(),covers=rows.map(row=>row.chargeKey)
   if(transaction.amountMinor!==amountMinor)throw new Error('原费用金额与本次覆盖不一致，请重新查找')
   const retained=this.data.historyCoverageSelections.filter(s=>!s.covers.some(key=>covers.includes(key)))
   if(retained.some(s=>s.transactionId===transaction.transactionId))throw new Error('这笔费用已选给其他期次；一次性费用请明确选择覆盖多期')
   const selection={transactionId:transaction.transactionId,transactionVersion:transaction.version,covers,periodNumbers:rows.map(row=>row.periodNumber),component:rows[0].component,amountMinor,chargeDate:transaction.occurredLocalAt.slice(0,10),label:transaction.label}
   this.setData({historyCoverageSelections:retained.concat(selection),historyCoverageEditor:null,historyCoverageError:''})
   this.updateHistoricalCoverageLabels()
  }catch(error){this.setData({historyCoverageError:error.message})}
 },
 removeHistoricalCoverage(event){
  if(this.data.saving)return
  const key=event.currentTarget.dataset.key
  this.setData({historyCoverageSelections:this.data.historyCoverageSelections.filter(s=>!s.covers.includes(key))})
  this.updateHistoricalCoverageLabels()
 },
 updateHistoricalCoverageLabels(){
  const rows=this.data.historyCoverageRows.map(row=>({...row,selectedLabel:(this.data.historyCoverageSelections.find(s=>s.covers.includes(row.chargeKey))||{}).label||''})),byPeriod={}
  for(const row of rows){
   const group=byPeriod[row.periodNumber]||(byPeriod[row.periodNumber]={selected:false,label:'选已记'})
   if(row.selectedLabel){group.selected=true;group.label='已选账目'}
  }
  this.setData({historyCoverageRows:rows,historyCoverageByPeriod:byPeriod})
  if(this.data.historyCoverageEditor){
   const selected=rows.find(row=>row.chargeKey===this.data.historyCoverageEditor.chargeKey)
   this.setData({'historyCoverageEditor.selectedLabel':selected&&selected.selectedLabel||''})
  }
  if(this.syncRepaymentAlert)this.syncRepaymentAlert()
 },
 closeHistoricalCoverage(){if(!this.data.saving){this._historyCoverageToken={};this.setData({historyCoverageEditor:null,historyCoverageLoading:false})}},
 historicalCoveragePayload(periodNumbers){
  const selected=new Set(periodNumbers),coverage=[],oneOffCharges=[]
  for(const item of this.data.historyCoverageSelections){
   if(!item.periodNumbers.some(n=>selected.has(n)))continue
   if(!item.periodNumbers.every(n=>selected.has(n)))throw new Error('一次性费用覆盖的期次需一起勾选已还，或重新选择覆盖范围')
   const common={transactionId:item.transactionId,transactionVersion:item.transactionVersion}
   if(item.covers.length===1)coverage.push({...common,chargeKey:item.covers[0]})
   else oneOffCharges.push({...common,key:'existing-'+item.transactionId,component:item.component,amountMinor:item.amountMinor,chargeDate:item.chargeDate,covers:item.covers})
  }
  return {...coverage.length?{coverage}:{},...oneOffCharges.length?{oneOffCharges}:{}}
 }
}
module.exports={initial,methods}
