const {randomUUID}=require('node:crypto')
const {isolatedMysql}=require('../../scripts/isolated-mysql')
const grants=require('../../scripts/runtime-role-grants')
const {localServices,call}=require('./local-services')
const plan={name:'合成收费合同',kind:'installment',baselinePrincipalMinor:'600000',baselineDate:'2026-01-01',scheduleMethod:'flat',scheduleTerms:12,
 measurementKind:'repayment',repaymentMinor:'52000',firstPaymentDate:'2026-01-31',generatePlan:true,confirmed:true,
 installmentSetup:{schema:1,originalPrincipalMinor:'600000',historicalPaidTerms:0,recordType:'credit_card',discountKind:null,discountValue:null}}
const authorization={confirmed:true,originKind:'recorded_consumption',mode:'auto',historyChoice:'catch_up',fromDate:'2026-01-01',throughDate:'2026-12-31',
 firstChargeDate:'2026-01-01',fixedConfirmed:true,dateConfirmed:true,coverageConfirmed:true}
async function chargeLab() {
 const lab=await isolatedMysql(),apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer)
 let clock=Date.parse('2026-04-30T12:00:00Z'),queries=0
 const measured=new Proxy(apiPool,{get(target,key){if(key==='getConnection')return async()=>{
  const c=await target.getConnection();return new Proxy(c,{get(conn,method){if(method==='execute')return async(...args)=>{queries++;return conn.execute(...args)};const value=conn[method];return typeof value==='function'?value.bind(conn):value}})
 };const value=target[key];return typeof value==='function'?value.bind(target):value}})
 const services=localServices({apiPool:measured,importPool,subject:'synthetic-charges-'+randomUUID(),now:()=>clock})
 const api=(a,d={})=>call(services.api,a,d),imp=(a,d)=>call(services.import,a,d)
 const identity=await api('bootstrap'),categoryId=identity.categories.find(c=>c.kind==='expense').id
 const {accountId}=await api('accounts.create',{requestId:randomUUID(),type:'credit',name:'合成费用负债',openingDisplayBalanceMinor:'600000',occurredLocalAt:'2020-01-01T00:00:00',timezoneOffsetMinutes:-480})
 const {accountId:assetAccountId}=await api('accounts.create',{requestId:randomUUID(),type:'bank',name:'合成付款银行卡',openingDisplayBalanceMinor:'9000000',occurredLocalAt:'2020-01-01T00:00:00',timezoneOffsetMinutes:-480})
 const create=(extra={})=>api('loans.create',{...plan,accountId,...extra,requestId:randomUUID()})
 const configure=(loan,extra={})=>api('loans.configureCharges',{...authorization,loanId:loan.loanId,version:loan.version,interestCategoryId:categoryId,feeCategoryId:categoryId,...extra,requestId:randomUUID()})
 const state=loan=>api('loans.chargePlan',{loanId:loan.loanId})
 const expense=(date,amountMinor='2000',extra={})=>api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:accountId,categoryId,amountMinor,occurredLocalAt:date+'T12:00:00',timezoneOffsetMinutes:-480,...extra})
 const sync=(loan,extra={})=>api('loans.syncCharges',{requestId:randomUUID(),loanId:loan.loanId,...extra})
 return {...lab,services,apiPool,importPool,api,imp,uid:identity.uid,categoryId,accountId,assetAccountId,create,configure,state,expense,sync,
  setNow:value=>{clock=Date.parse(value)},measure:()=>queries,plan,authorization}
}
module.exports={chargeLab,plan,authorization}
