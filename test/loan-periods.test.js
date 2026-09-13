const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {isolatedMysql}=require('../scripts/isolated-mysql')
const grants=require('../scripts/runtime-role-grants')
const {localServices,call}=require('./helpers/local-services')
test('确认期次与实际付款分开：部分/跨期、修订、撤销、并发和隔离',{skip:!process.env.CATLEDGER_TEST_DB_HOST},async t=>{
 const lab=await isolatedMysql()
 try{
  const apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer),services=localServices({apiPool,importPool,subject:'synthetic-loan-periods'})
  const api=(a,d)=>call(services.api,a,d),user=await api('bootstrap'),categoryId=user.categories.find(c=>c.kind==='expense').id
  const account=async(type,amount,name)=>(await api('accounts.create',{requestId:randomUUID(),type,name,currency:'CNY',openingDisplayBalanceMinor:amount,occurredLocalAt:'2026-09-01T00:00:00',timezoneOffsetMinutes:-480})).accountId
  const asset=await account('bank','1000000','合成资金'),debt=await account('credit','80000','合成负债')
  const {loanId}=await api('loans.create',{requestId:randomUUID(),name:'合成期次贷款',kind:'installment',accountId:debt,baselinePrincipalMinor:'80000',baselineDate:'2026-09-01'})
  const current=async()=>(await api('loans.get',{loanId})).loan
  const plans=()=>api('loans.periods',{loanId,pageSize:1})
  const totals=async()=>({accounts:(await api('accounts.list')).accounts.map(a=>[a.accountId,a.bookBalanceMinor]),expense:(await api('statistics.get',{month:'2026-09'})).summary.expenseMinor})
  let p1,p2,payment
  const save=async(fields)=>api('loans.savePeriod',{requestId:randomUUID(),loanId,loanVersion:(await current()).version,...fields})
  const fields=n=>({periodNumber:n,dueDate:'2026-09-'+(n===1?'02':'20'),principalMinor:'40000',interestMinor:'9000',feeMinor:'1000'})
  await t.test('创建期次、改未来计划不记钱，金额未知不能冒充零，下一期来自未付计划',async()=>{
   const before=await totals();p1=await save(fields(1));p2=await save(fields(2))
   await assert.rejects(save({...fields(3),principalMinor:''}),{publicCode:'VALIDATION_ERROR'})
   assert.deepEqual(await totals(),before)
   const view=await plans();assert.equal(view.items.length,1);assert.ok(view.nextCursor);assert.equal(view.summary.unpaidPrincipalMinor,'80000');assert.equal(view.summary.nextDueDate,'2026-09-02')
   const next=await api('loans.periods',{loanId,pageSize:1,cursor:view.nextCursor});assert.equal(next.items[0].periodNumber,2)
  })
  const paymentData=async()=>({requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId:asset,totalMinor:'100000',occurredLocalAt:'2026-09-03T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
   allocations:[{loanId,version:(await current()).version,principalMinor:'80000',interestMinor:'18000',feeMinor:'2000',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId,feeCategoryId:categoryId}]})
  const allocate=async(items)=>api('loans.allocatePeriods',{requestId:randomUUID(),loanId,loanVersion:(await current()).version,paymentId:payment.paymentId,version:(await api('loans.payment',{paymentId:payment.paymentId})).payment.version,confirmed:true,items})
  await t.test('实际付款后可以部分清偿一期，剩余分项显式未分配；超配和不同费用构成拒绝',async()=>{
   payment=await api('loans.record',await paymentData());const before=await totals()
   await allocate([{periodId:p1.periodId,version:1,principalMinor:'20000',interestMinor:'4500',feeMinor:'500'}])
   assert.deepEqual(await totals(),before)
   const view=await plans();assert.equal(view.items[0].status,'partial');assert.equal(view.summary.unpaidPrincipalMinor,'60000')
   assert.equal(view.summary.remainingPrincipalMinor,'0');assert.equal(view.summary.principalGapMinor,'60000')
   const a=await api('loans.planAllocation',{loanId,paymentId:payment.paymentId});assert.equal(a.unallocated.principalMinor,'60000');assert.equal(a.items.length,1)
   await assert.rejects(allocate([{periodId:p1.periodId,version:view.items[0].version,principalMinor:'40001',interestMinor:'9000',feeMinor:'1000'}]),{publicCode:'LOAN_PLAN_OVERALLOCATED'})
   await assert.rejects(save({...fields(1),periodId:p1.periodId,version:view.items[0].version,principalMinor:'19999'}),{publicCode:'LOAN_PLAN_OVERALLOCATED'})
  })
  await t.test('一次分配跨两期，旧分配和修订保留；并发相同版本只允许一次完成',async()=>{
   const view=await api('loans.periods',{loanId,pageSize:40})
   const items=view.items.map(p=>({periodId:p.periodId,version:p.version,principalMinor:'40000',interestMinor:'9000',feeMinor:'1000'}))
   const input={loanId,loanVersion:(await current()).version,paymentId:payment.paymentId,version:(await api('loans.payment',{paymentId:payment.paymentId})).payment.version,confirmed:true,items}
   const out=await Promise.allSettled([api('loans.allocatePeriods',{...input,requestId:randomUUID()}),api('loans.allocatePeriods',{...input,requestId:randomUUID()})])
   assert.equal(out.filter(r=>r.status==='fulfilled').length,1)
   assert.equal((await plans()).summary.unpaidPrincipalMinor,'0');assert.equal((await plans()).summary.nextDueDate,null)
   const a=await api('loans.planAllocation',{loanId,paymentId:payment.paymentId});assert.equal(a.unallocated.feeMinor,'0')
   const history=await api('loans.periodHistory',{periodId:p1.periodId,kind:'payment'});assert.equal(history.items.length,2);assert.equal(history.items.filter(i=>i.active).length,1)
   const before=await totals(),period=(await plans()).items[0]
   await save({...fields(1),periodId:p1.periodId,version:period.version,dueDate:'2026-09-04',principalMinor:'41000'})
   assert.deepEqual(await totals(),before)
   const revisions=await api('loans.periodHistory',{periodId:p1.periodId,kind:'plan'});assert.equal(revisions.items.length,2);assert.equal(revisions.items.at(-1).snapshot.principalMinor,'40000')
  })
  await t.test('贷款整组撤销恢复所有期次，保留历史且计划本身不撤销',async()=>{
   const p=(await api('loans.payment',{paymentId:payment.paymentId})).payment
   await api('loans.reverse',{requestId:randomUUID(),paymentId:p.paymentId,version:p.version,confirmed:true,loans:[{loanId,version:(await current()).version}]})
   const view=await plans();assert.equal(view.items[0].status,'unpaid');assert.equal(view.summary.unpaidPrincipalMinor,'81000')
   assert.equal((await api('loans.periodHistory',{periodId:p1.periodId,kind:'payment'})).items.every(i=>!i.active),true)
   const other=localServices({apiPool,importPool,subject:'synthetic-period-other'});await call(other.api,'bootstrap')
   await assert.rejects(call(other.api,'loans.periodHistory',{periodId:p1.periodId,kind:'payment'}),{publicCode:'NOT_FOUND'})
  })
  await t.test('更正后的付款重新待对账，旧期次分配停用且未付金额恢复',async()=>{
   payment=await api('loans.record',await paymentData())
   const p=(await plans()).items[0]
   await allocate([{periodId:p.periodId,version:p.version,principalMinor:'40000',interestMinor:'9000',feeMinor:'1000'}])
   const actual=(await api('loans.payment',{paymentId:payment.paymentId})).payment,input=await paymentData()
   const corrected=await api('loans.correct',{...input,paymentId:actual.paymentId,version:actual.version,loans:[{loanId,version:(await current()).version}],allocations:[{...input.allocations[0],principalMinor:'70000',interestMinor:'28000'}]})
   assert.equal((await plans()).summary.unpaidPrincipalMinor,'81000')
   const view=await api('loans.planAllocation',{loanId,paymentId:corrected.paymentId});assert.equal(view.items.length,0);assert.equal(view.unallocated.principalMinor,'70000')
   await api('loans.reverse',{requestId:randomUUID(),paymentId:corrected.paymentId,version:1,confirmed:true,loans:corrected.loans})
  })
  await t.test('多贷款分配不能挪用；第二期写入故障完整回滚旧分配和所有版本',async()=>{
   const second=(await api('loans.create',{requestId:randomUUID(),name:'合成同账户另一贷款',kind:'borrowing',accountId:debt,baselinePrincipalMinor:'1000',baselineDate:'2026-09-01'})).loanId
   const q=await api('loans.savePeriod',{requestId:randomUUID(),loanId:second,loanVersion:1,periodNumber:1,dueDate:'2026-09-20',principalMinor:'100',interestMinor:'0',feeMinor:'0'})
   const base=await paymentData();payment=await api('loans.record',{...base,totalMinor:'500',allocations:[{...base.allocations[0],principalMinor:'300',interestMinor:'0',feeMinor:'0'},{...base.allocations[0],loanId:second,version:2,principalMinor:'200',interestMinor:'0',feeMinor:'0'}]})
   const p=(await plans()).items[0]
   await assert.rejects(allocate([{periodId:q.periodId,version:1,principalMinor:'100',interestMinor:'0',feeMinor:'0'}]),{publicCode:'NOT_FOUND'})
   await allocate([{periodId:p.periodId,version:p.version,principalMinor:'300',interestMinor:'0',feeMinor:'0'}])
   const other=await api('loans.planAllocation',{loanId:second,paymentId:payment.paymentId});assert.equal(other.unallocated.principalMinor,'200')
   const view=await api('loans.periods',{loanId,pageSize:40}),actual=(await api('loans.payment',{paymentId:payment.paymentId})).payment,loan=await current(),before=await totals()
   const input={requestId:randomUUID(),loanId,loanVersion:loan.version,paymentId:payment.paymentId,version:actual.version,confirmed:true,items:view.items.map(p=>({periodId:p.periodId,version:p.version,principalMinor:'100',interestMinor:'0',feeMinor:'0'}))}
   let inserts=0
   const faulty=localServices({importPool,subject:'synthetic-loan-periods',apiPool:{async getConnection(){const c=await apiPool.getConnection();return new Proxy(c,{get(target,key){if(key==='execute')return async(sql,values)=>{if(/INSERT INTO catledger_loan_period_allocations/.test(sql)&&++inserts===2)throw new Error('synthetic period second insertion');return target.execute(sql,values)};return typeof target[key]==='function'?target[key].bind(target):target[key]}})}}})
   await assert.rejects(call(faulty.api,'loans.allocatePeriods',input),{publicCode:'INTERNAL_ERROR'});assert.equal(inserts,2)
   assert.deepEqual(await totals(),before);assert.equal((await current()).version,loan.version)
   const existing=await api('loans.planAllocation',{loanId,paymentId:payment.paymentId});assert.equal(existing.items.length,1);assert.equal(existing.items[0].principalMinor,'300');assert.equal(existing.payment.version,actual.version)
   const outcome=await api('loans.allocatePeriods',input);assert.deepEqual(await api('loans.allocatePeriods',input),outcome)
   assert.equal((await api('loans.planAllocation',{loanId,paymentId:payment.paymentId})).unallocated.principalMinor,'100')
  })
 }finally{await lab.close()}
})

test('整组撤销最多停用 800 个期次引用，版本更新按 100 个分块，超限不部分写入',async()=>{
 const {deactivatePaymentPeriods}=require('../cloudfunctions/catledger-api/src/loan-period-repository')
 const writes=[]
 const c={async execute(sql,values){if(sql.startsWith('SELECT'))return [Array.from({length:800},(_,n)=>({periodId:'synthetic-'+n}))];writes.push({sql,values});return [{affectedRows:1}]}}
 await deactivatePaymentPeriods(c,'synthetic-user','synthetic-payment')
 assert.equal(writes.filter(w=>w.sql.includes('SET version')).length,8);assert.equal(writes.every(w=>w.values.length<=101),true)
 const over={async execute(sql){assert.ok(sql.startsWith('SELECT'));return [Array.from({length:801},(_,n)=>({periodId:'over-'+n}))]}}
 await assert.rejects(deactivatePaymentPeriods(over,'synthetic-user','synthetic-payment'),{publicCode:'CONFLICT'})
})
