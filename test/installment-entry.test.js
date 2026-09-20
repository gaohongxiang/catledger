const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {remainingSchedule}=require('../cloudfunctions/catledger-api/src/loan-installment')
const {buildSchedule}=require('../cloudfunctions/catledger-api/src/loan-schedule/schedule-engine')
const form=require('../miniprogram/pages/loan-form/model')
const scheduleForm=require('../miniprogram/pages/loan-detail/schedule-form')
const {isolatedMysql}=require('../scripts/isolated-mysql')
const grants=require('../scripts/runtime-role-grants')
const {localServices,call}=require('./helpers/local-services')
const setup=(patch={})=>({schema:1,originalPrincipalMinor:'1200000',historicalPaidTerms:3,recordType:'bank_loan',customRecordType:'',discountKind:null,discountValue:null,...patch})
const schedule=(patch={})=>({principalMinor:'1200000',scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'110000',quoteType:null,ratePpm:null,feePerTermMinor:null,feeUpfrontMinor:null,firstPaymentDate:'2026-01-31',...patch})

test('历史进度按已确认连续期数截取，原本金与剩余本金分开且期号/月末日期保持',()=>{
  const plan=remainingSchedule({...schedule(),installmentSetup:setup()})
  assert.equal(plan.periods.length,9);assert.equal(plan.periods[0].periodNumber,4);assert.equal(plan.periods[0].dueDate,'2026-04-30')
  assert.equal(plan.periods.at(-1).periodNumber,12);assert.equal(plan.periods.at(-1).dueDate,'2026-12-31')
  assert.equal(plan.summary.remainingPrincipalMinor,'900000');assert.equal(plan.summary.totalPaymentMinor,'990000')
  const paid=remainingSchedule({...schedule(),installmentSetup:setup({historicalPaidTerms:12})})
  assert.equal(paid.periods.length,0);assert.equal(paid.summary.remainingPrincipalMinor,'0')
  for(const historicalPaidTerms of [-1,13,1.5,'3'])assert.throws(()=>remainingSchedule({...schedule(),installmentSetup:setup({historicalPaidTerms})}))
})

test('四种还款方式与三种优惠保持本金守恒，现金优惠不超过成本并精确到分',()=>{
  for(const scheduleMethod of ['flat','equal_payment','equal_principal','interest_only']){
    const input=schedule({scheduleMethod,repaymentMinor:scheduleMethod==='interest_only'?'10000':'110000'})
    const original=buildSchedule(input)
    for(const [discountKind,discountValue] of [['interest_rate','500000'],['per_period','1000'],['total','2401']]){
      const discounted=buildSchedule({...input,discountKind,discountValue})
      assert.equal(discounted.periods.reduce((s,r)=>s+r.principalMinor,0),1200000)
      assert.ok(discounted.periods.every(r=>r.principalMinor>=0&&r.interestMinor>=0&&r.feeMinor>=0))
      assert.ok(discounted.summary.totalPaymentMinor<original.summary.totalPaymentMinor)
      if(discountKind==='total')assert.equal(original.summary.totalPaymentMinor-discounted.summary.totalPaymentMinor,2401)
    }
  }
  const fees=buildSchedule(schedule({feePerTermMinor:'800',discountKind:'per_period',discountValue:'900'}))
  assert.equal(fees.periods[0].feeMinor,0);assert.equal(fees.periods[0].interestMinor,9900)
  const free=remainingSchedule({...schedule({scheduleMethod:'interest_only',repaymentMinor:'0'}),installmentSetup:setup()})
  assert.equal(free.periods.length,1);assert.equal(free.periods[0].periodNumber,12);assert.equal(free.summary.remainingPrincipalMinor,'1200000')
  const noCost=buildSchedule(schedule({discountKind:'total',discountValue:'9999999'}))
  assert.equal(noCost.summary.totalPaymentMinor,1200000)
  assert.throws(()=>buildSchedule(schedule({scheduleMethod:'equal_payment',measurementKind:'rate',repaymentMinor:null,quoteType:'annual',ratePpm:'9007199254740991',discountKind:'total',discountValue:'100'})),{publicCode:'VALIDATION_ERROR'})
})

test('新表单要求明确历史期数与计划确认；空值不会自动变成已还或保存',()=>{
  const data={name:'合成分期',accounts:[{accountId:'debt'}],accountIndex:0,principalYuan:'12000',paidTerms:'3',typeIndex:2,discountIndex:0,discountValue:'7',baselineDate:'2026-04-01',
    schedule:Object.assign(scheduleForm.blank(),{terms:'12',measurementIndex:1,repaymentYuan:'1100',firstPaymentDate:'2026-01-31'})}
  const input=form.previewInput(data);assert.equal(input.installmentSetup.discountValue,'700000')
  assert.throws(()=>form.previewInput({...data,paidTerms:''}),/历史已还/)
  assert.throws(()=>form.previewInput({...data,paidTerms:'13'}),/历史已还/)
  assert.throws(()=>form.previewInput({...data,schedule:{...data.schedule,firstPaymentDate:''}}),/首次还款/)
  const preview=remainingSchedule(input)
  assert.throws(()=>form.createPayload(data,preview),/勾选确认/)
  const payload=form.createPayload({...data,confirmed:true},preview)
  assert.equal(payload.kind,'installment');assert.equal(payload.generatePlan,true);assert.equal(payload.baselinePrincipalMinor,'900000')
  assert.equal(payload.installmentSetup.originalPrincipalMinor,'1200000');assert.equal(payload.installmentSetup.historicalPaidTerms,3)
})

test('分期录入真实 MySQL：原子计划、历史本金、幂等、回滚、隔离和旧资料兼容',{skip:!process.env.CATLEDGER_TEST_DB_HOST},async t=>{
  const lab=await isolatedMysql()
  try{
    const apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer)
    const first=localServices({apiPool,importPool,subject:'synthetic-installment-a'}),other=localServices({apiPool,importPool,subject:'synthetic-installment-b'})
    const api=(name,data)=>call(first.api,name,data),identity=await api('bootstrap');await call(other.api,'bootstrap')
    const debt=(await api('accounts.create',{requestId:randomUUID(),type:'other_liability',name:'合成负债',currency:'CNY',openingDisplayBalanceMinor:'1500000',occurredLocalAt:'2026-01-01T00:00:00',timezoneOffsetMinutes:-480})).accountId
    const original=schedule();delete original.principalMinor
    const base={...original,name:'合成分期',kind:'installment',accountId:debt,baselinePrincipalMinor:'900000',baselineDate:'2026-04-01',installmentSetup:setup(),generatePlan:true,confirmed:true}
    const counts=async()=>{const [[r]]=await lab.owner.execute('SELECT (SELECT COUNT(*) FROM catledger_loans WHERE uid=?) loans,(SELECT COUNT(*) FROM catledger_loan_periods WHERE uid=?) periods,(SELECT COUNT(*) FROM catledger_transactions WHERE uid=?) transactions',[identity.uid,identity.uid,identity.uid]);return r}
    let created,view
    await t.test('资料、剩余计划与回执同一次保存，重复及并发提交不增加账目',async()=>{
      const before=await counts(),balances=await api('accounts.list'),input={...base,requestId:randomUUID()}
      const results=await Promise.all([api('loans.create',input),api('loans.create',input)])
      created=results[0];assert.deepEqual(results[1],created);assert.equal(created.generatedPeriods,9)
      view=(await api('loans.get',{loanId:created.loanId})).loan
      assert.deepEqual(view.installmentSetup,setup());assert.equal(view.remainingPrincipalMinor,'900000')
      const after=await counts();assert.equal(Number(after.loans)-Number(before.loans),1);assert.equal(Number(after.periods)-Number(before.periods),9);assert.equal(after.transactions,before.transactions)
      assert.deepEqual((await api('accounts.list')).accounts,balances.accounts)
      const periods=await api('loans.periods',{loanId:created.loanId,pageSize:40})
      assert.equal(periods.items[0].periodNumber,4);assert.equal(periods.summary.historicalPaidTerms,3);assert.equal(periods.summary.principalGapMinor,'0')
      assert.equal(periods.items.every(p=>p.status==='unpaid'),true)
      assert.deepEqual((await api('transactions.commandResult',{requestId:input.requestId,commandAction:'loans.create'})).result,created)
    })
    await t.test('未知/伪造本金、历史期数越界、未确认、外人账户均拒绝且无残留',async()=>{
      const before=await counts()
      for(const patch of [{baselinePrincipalMinor:'900001'},{confirmed:false},{generatePlan:undefined},{kind:'borrowing'},{installmentSetup:setup({historicalPaidTerms:13})},{installmentSetup:setup({discountKind:'interest_rate',discountValue:'1000001'})}])
        await assert.rejects(api('loans.create',{...base,...patch,requestId:randomUUID()}),{publicCode:'VALIDATION_ERROR'})
      await assert.rejects(call(other.api,'loans.create',{...base,requestId:randomUUID()}),{publicCode:'NOT_FOUND'})
      await assert.rejects(call(other.api,'loans.get',{loanId:created.loanId}),{publicCode:'NOT_FOUND'})
      assert.deepEqual(await counts(),before)
    })
    await t.test('期次写入失败回滚贷款和回执；解除故障可用原请求安全重试',async()=>{
      const before=await counts(),input={...base,requestId:randomUUID()}
      await lab.owner.query("CREATE TRIGGER synthetic_reject_period BEFORE INSERT ON catledger_loan_periods FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic failure'")
      try{await assert.rejects(api('loans.create',input));assert.deepEqual(await counts(),before)}finally{await lab.owner.query('DROP TRIGGER synthetic_reject_period')}
      const saved=await api('loans.create',input);assert.equal(saved.generatedPeriods,9)
    })
    await t.test('历史已还期次不能重建；已有计划后原本金/历史进度受保护，名称分类可更新',async()=>{
      await assert.rejects(api('loans.savePeriod',{requestId:randomUUID(),loanId:created.loanId,loanVersion:1,periodNumber:1,dueDate:'2026-01-31',principalMinor:'100000',interestMinor:'10000',feeMinor:'0'}),{publicCode:'VALIDATION_ERROR'})
      const update={...base,loanId:created.loanId,version:1};delete update.generatePlan;delete update.confirmed
      await assert.rejects(api('loans.update',{...update,installmentSetup:setup({historicalPaidTerms:2}),requestId:randomUUID()}),{publicCode:'LOAN_BASELINE_LOCKED'})
      const renamed=await api('loans.update',{...update,name:'合成修改名称',installmentSetup:setup({recordType:'other',customRecordType:'装修'}),requestId:randomUUID()})
      assert.equal(renamed.version,2)
      const oldClient={...update,version:2,name:'旧端修改名称'};delete oldClient.installmentSetup
      await api('loans.update',{...oldClient,requestId:randomUUID()})
      assert.equal((await api('loans.get',{loanId:created.loanId})).loan.installmentSetup.customRecordType,'装修')
    })
    await t.test('全部历史已还仍保留原始借款与费用，剩余本金零，不生成伪历史付款',async()=>{
      const before=await counts(),closed=await api('loans.create',{...base,requestId:randomUUID(),baselinePrincipalMinor:'0',feeUpfrontMinor:'10000',installmentSetup:setup({historicalPaidTerms:12})})
      assert.equal(closed.generatedPeriods,0)
      const loan=(await api('loans.get',{loanId:closed.loanId})).loan
      assert.equal(loan.status,'settled');assert.equal(loan.installmentSetup.originalPrincipalMinor,'1200000')
      assert.equal((await counts()).transactions,before.transactions)
    })
    await t.test('接入后本金由实际还款更新、期次由明确分配更新，撤销同时恢复且历史不动',async()=>{
      const assetAccountId=(await api('accounts.create',{requestId:randomUUID(),type:'bank',name:'合成付款账户',currency:'CNY',openingDisplayBalanceMinor:'200000',occurredLocalAt:'2026-01-01T00:00:00',timezoneOffsetMinutes:-480})).accountId
      const categoryId=identity.categories.find(c=>c.kind==='expense').id
      const payment=await api('loans.record',{requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId,occurredLocalAt:'2026-04-30T10:00:00',timezoneOffsetMinutes:-480,totalMinor:'110000',confirmed:true,
        allocations:[{loanId:created.loanId,version:3,principalMinor:'100000',interestMinor:'10000',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId,feeCategoryId:categoryId}]})
      const periods=await api('loans.periods',{loanId:created.loanId,pageSize:40}),p=periods.items[0]
      assert.equal(periods.summary.remainingPrincipalMinor,'800000');assert.equal(periods.summary.paidPeriods,0)
      const before=await counts()
      const result=await api('loans.allocatePeriods',{requestId:randomUUID(),loanId:created.loanId,loanVersion:payment.loans[0].version,paymentId:payment.paymentId,version:1,confirmed:true,items:[{periodId:p.periodId,version:p.version,principalMinor:'100000',interestMinor:'10000',feeMinor:'0'}]})
      const paid=await api('loans.periods',{loanId:created.loanId,pageSize:40})
      assert.equal(paid.items[0].status,'paid');assert.equal(paid.summary.paidPeriods,1);assert.equal(paid.summary.historicalPaidTerms,3);assert.equal(paid.summary.principalGapMinor,'0')
      assert.deepEqual(await counts(),before)
      await api('loans.reverse',{requestId:randomUUID(),paymentId:payment.paymentId,version:result.version,confirmed:true,loans:[{loanId:created.loanId,version:result.loanVersion}]})
      const reversed=await api('loans.periods',{loanId:created.loanId,pageSize:40})
      assert.equal(reversed.items[0].status,'unpaid');assert.equal(reversed.summary.paidPeriods,0);assert.equal(reversed.summary.historicalPaidTerms,3);assert.equal(reversed.summary.remainingPrincipalMinor,'900000')
    })
  }finally{await lab.close()}
})
