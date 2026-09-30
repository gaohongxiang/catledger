const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {chargeLab,prepareBank,postBank,plan,authorization}=require('./helpers/loan-charges')
const {localServices,call}=require('./helpers/local-services')
const version=async(h,l)=>(await h.api('loans.get',{loanId:l.loanId})).loan.version
const confirm=async(h,l,periodNumber=1)=>h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:l.loanId,version:await version(h,l),repayments:[{periodNumber,paid:true}]})
async function remove(h,l){const data={loanId:l.loanId,version:await version(h,l)},impact=await h.api('loans.deleteImpact',data);return h.api('loans.delete',{...data,previewToken:impact.previewToken,confirmed:true,requestId:randomUUID()})}
async function pay(h,l,periodNumber=1){const {period,loanVersion}=await h.api('loans.installment',{loanId:l.loanId,periodNumber});return h.api('loans.record',{requestId:randomUUID(),confirmed:true,kind:'repayment',mode:'new',simplePeriod:true,assetAccountId:h.assetAccountId,totalMinor:'52000',occurredLocalAt:period.dueDate+'T12:00:00',timezoneOffsetMinutes:-480,allocations:[{loanId:l.loanId,version:loanVersion,period:{periodNumber,version:period.version},principalMinor:'50000',interestMinor:'2000',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:h.categoryId}]})}

test('F01 合同认领依据身份与明确选择，不以同账户旧计划拦截新计划',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 async function scenario(name,fn){await t.test(name,async()=>{const h=await chargeLab();try{await fn(h)}finally{await h.close()}})}
 for(const archived of [false,true])await scenario((archived?'归档':'删除')+'A后，同卡同金额同日期的无关B可确认历史并还本期，旧费用不被占用',async h=>{
  const a=await h.create();await confirm(h,a);const old=await h.state(a)
  if(archived)await h.api('loans.archiveInstallment',{loanId:a.loanId,version:await version(h,a),archived:true,requestId:randomUUID()});else await remove(h,a)
  const b=await h.create();await confirm(h,b);await pay(h,b,2)
  const current=await h.state(b),prior=await h.state(a)
  assert.notEqual(current.contract.contractId,old.contract.contractId)
  assert.equal(prior.contract.loanId,a.loanId)
  assert(current.items.every(f=>!old.items.some(p=>p.chargeId===f.chargeId||p.transactionId===f.transactionId)))
 })
 await scenario('旧授权入口也允许独立无编号新合同；原请求和并发只创建一次',async h=>{
  const a=await h.create();await confirm(h,a);await remove(h,a)
  const b=await h.create(),payload={...h.authorization,loanId:b.loanId,version:1,interestCategoryId:h.categoryId,feeCategoryId:h.categoryId,requestId:randomUUID()}
  const results=await Promise.all([h.api('loans.configureCharges',payload),h.api('loans.configureCharges',payload)])
  assert.deepEqual(results[0],results[1]);assert.deepEqual(await h.api('loans.configureCharges',payload),results[0])
  assert.notEqual((await h.state(a)).contract.contractId,results[0].contractId)
  await assert.rejects(h.api('loans.configureCharges',{...payload,requestId:randomUUID()}),{publicCode:'CONFLICT'})
 })
 await scenario('明确重建复用有效旧费用，用户抑制不复活，跨用户和账户不符拒绝',async h=>{
  const a=await h.create();await h.configure(a);await h.sync(a)
  const state=await h.state(a),f=state.items.find(f=>f.chargeKey==='period:2:interest'),change={loanId:a.loanId,chargeId:f.chargeId,operation:'suppress'}
  const impact=await h.api('loans.chargeImpact',change);await h.api('loans.changeCharge',{...change,previewToken:impact.previewToken,confirmed:true,requestId:randomUUID()})
  await h.api('loans.archiveInstallment',{loanId:a.loanId,version:await version(h,a),archived:true,requestId:randomUUID()})
  const other=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-f01-other'});await call(other.api,'bootstrap')
  await assert.rejects(call(other.api,'loans.configureCharges',{...h.authorization,loanId:a.loanId,version:1,contractId:state.contract.contractId,requestId:randomUUID()}),{publicCode:'NOT_FOUND'})
  const account=await h.api('accounts.create',{type:'credit',name:'合成其他信用卡',requestId:randomUUID()})
  await assert.rejects(h.create({accountId:account.accountId,chargeContractId:state.contract.contractId}),{publicCode:'NOT_FOUND'})
  const payload={...h.plan,accountId:h.accountId,chargeContractId:state.contract.contractId,requestId:randomUUID()}
  const created=await Promise.all([h.api('loans.create',payload),h.api('loans.create',payload)])
  assert.deepEqual(created[0],created[1]);await confirm(h,created[0])
  const after=await h.state(created[0]);assert.equal(after.contract.contractId,state.contract.contractId)
  assert.equal(after.items.find(i=>i.chargeKey==='period:1:interest').transactionId,state.items.find(i=>i.chargeKey==='period:1:interest').transactionId)
  assert.equal(after.items.find(i=>i.chargeId===f.chargeId).state,'suppressed')
  await assert.rejects(h.api('loans.create',{...payload,requestId:randomUUID()}),{publicCode:'CONFLICT'})
 })
 await scenario('稳定编号碰撞仍阻止；已核验来源才可自动重建合同',async h=>{
  await postBank(h,await prepareBank(h,{period:1,date:'2026-01-31',reference:'SYNTHETIC-F01-VERIFIED'}))
  const source=(await h.api('loans.installmentSources')).items[0],a=await h.create({sourceItemId:source.itemId});await confirm(h,a)
  const old=await h.state(a),b=await h.create()
  await assert.rejects(h.configure(b,{referenceLabel:'SYNTHETIC-F01-VERIFIED'}),{publicCode:'LOAN_COVERAGE_REQUIRED'})
  await remove(h,a)
  await assert.rejects(h.configure(b,{referenceLabel:'SYNTHETIC-F01-VERIFIED'}),{publicCode:'LOAN_COVERAGE_REQUIRED'})
  const next=await h.create({sourceItemId:source.itemId});await confirm(h,next)
  assert.equal((await h.state(next)).contract.contractId,old.contract.contractId)
  assert.equal((await h.state(next)).items[0].transactionId,source.transactionId)
 })
})

test('F01 导入明确还款使用只读旧合同权限；同账户无来源身份时建立独立合同',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async()=>{
 const lab=await require('../scripts/isolated-mysql').isolatedMysql(),grants=require('../scripts/runtime-role-grants')
 try{
  const apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',{
   ...grants.importer,catledger_loan_charge_contracts:'SELECT, INSERT'
  })
  const services=localServices({apiPool,importPool,subject:'synthetic-f01-importer'}),api=(a,d={})=>call(services.api,a,d),imp=(a,d={})=>call(services.import,a,d)
  const {uid,categories}=await api('bootstrap'),categoryId=categories.find(c=>c.kind==='expense').id
  const account=async type=>(await api('accounts.create',{requestId:randomUUID(),name:'合成权限验证'+type,type,openingDisplayBalanceMinor:'600000',occurredLocalAt:'2026-01-01T00:00:00',timezoneOffsetMinutes:-480})).accountId
  const asset=await account('bank'),debt=await account('other_liability')
  const create=()=>api('loans.create',{...plan,accountId:debt,requestId:randomUUID()})
  const a=await create()
  const configured=await api('loans.configureCharges',{...authorization,loanId:a.loanId,version:a.version,interestCategoryId:categoryId,feeCategoryId:categoryId,referenceLabel:'SYNTHETIC-F01-UNVERIFIED',requestId:randomUUID()})
  await api('loans.archiveInstallment',{loanId:a.loanId,version:configured.version,archived:true,requestId:randomUUID()})
  const old=await api('loans.chargePlan',{loanId:a.loanId}),b=await create()
  const fee=await api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:debt,categoryId,amountMinor:'2000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480})
  // 原始合成支付宝还款经过上传、解析、账户/归属确认，不能通过改表预设语义。
  const content=Buffer.from([
   '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
   '支付宝账户: synth@example.invalid,,,,,,,,,,,',
   '起始日期: [2026-01-01 00:00:00] 终止日期: [2026-01-31 23:59:59],,,,,,,,,,,',
   '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
   '2026-01-31 13:00:00,信用借还,合成贷款,本期还款,520.00,不计收支,账户余额,还款成功,,SYNTHETIC-F01-REPAYMENT,,'
  ].join('\n'))
  const {files}=await imp('imports.prepareMany',{requestId:randomUUID(),files:[{fileName:'合成还款权限.csv',size:content.length}]}),file=files[0]
  services.objects.set(file.cloudPath,content)
  const parsed=await imp('imports.parseFile',{requestId:randomUUID(),importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480})
  let update=await imp('financeUpdates.prepare',{requestId:randomUUID(),batchIds:[parsed.batch.batchId]})
  const accounts=await imp('reviewIssues.list',{updateId:update.updateId,group:'accounts'})
  const decisions=accounts.items.filter(i=>i.status==='open').map(i=>({issueId:i.issueId,issueVersion:i.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:asset}}))
  if(decisions.length)update=await imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions})
  const issues=await imp('reviewIssues.list',{updateId:update.updateId,status:'open'}),target=issues.items.find(i=>i.issueType==='transfer_accounts')
  assert(target)
  update=await imp('reviewIssues.resolve',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,issueId:target.issueId,issueVersion:target.version,decision:'apply_fields',fields:{counterpartyLedgerAccountId:debt}})
  const {items:[event]}=await imp('economicEvents.list',{updateId:update.updateId})
  const repayment={confirmed:true,mode:'associate',loanId:b.loanId,loanVersion:b.version,assetAccountId:asset,liabilityAccountId:debt,principalMinor:'50000',interestMinor:'2000',feeMinor:'0',interestTreatment:'accrued',feeTreatment:'expense',chargeAllocations:[{transactionId:fee.transactionId,component:'interest',amountMinor:'2000'}]}
  update=await imp('financeUpdates.setRepayment',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,eventId:event.eventId,eventVersion:event.version,repayment})
  const [[before]]=await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[uid])
  const post={requestId:randomUUID(),updateId:update.updateId,version:update.appliedVersion},result=await imp('financeUpdates.post',post)
  assert.equal(result.posting.createdTransactionCount,1);assert.deepEqual(await imp('financeUpdates.post',post),result)
  const current=await api('loans.chargePlan',{loanId:b.loanId})
  assert.notEqual(current.contract.contractId,old.contract.contractId)
  assert.equal(current.items[0].transactionId,fee.transactionId);assert.equal(current.items[0].settledMinor,'2000')
  assert.deepEqual((await api('loans.chargePlan',{loanId:a.loanId})).contract,old.contract)
  const [[after]]=await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[uid])
  assert.equal(after.count,before.count)
  await assert.rejects(importPool.execute('UPDATE catledger_loan_charge_contracts SET loan_id=loan_id,version=version WHERE uid=? AND contract_id=?',[uid,old.contract.contractId]),{code:'ER_TABLEACCESS_DENIED_ERROR'})
  // 有 reference 的分期来源只能记在信用卡；普通负债不能获得供旧合同认领的绑定。
  const source=await prepareBank({services,imp,accountId:debt},{period:2,date:'2026-02-28',reference:'SYNTHETIC-F01-DEBT-SOURCE'})
  await assert.rejects(postBank({imp},source),{publicCode:'LOAN_SOURCE_MISMATCH'})
  const [[bindings]]=await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_installment_bindings WHERE uid=? AND account_id=?',[uid,debt])
  assert.equal(Number(bindings.count),0)
 }finally{await lab.close()}
})
