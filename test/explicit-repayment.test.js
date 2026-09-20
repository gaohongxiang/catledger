const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices,call,prepareSyntheticUpdate } = require('./helpers/local-services')
const booking = require('../cloudfunctions/catledger-api/src/repayment-booking').createRepaymentBooking(code=>Object.assign(new Error(code),{ publicCode:code }))
const { decision } = require('../miniprogram/pages/repayment-entry/model')
test('本金、利息和费用必须明确且守恒；未知不能变成零',()=>{
  const value = { confirmed:true,mode:'defer',assetAccountId:randomUUID(),liabilityAccountId:randomUUID(),principalMinor:'800',interestMinor:'180',feeMinor:'20',
    interestTreatment:'expense',feeTreatment:'accrued',interestCategoryId:randomUUID() }
  const parsed = booking.normalize(value,'1000'), drafts = booking.drafts(parsed)
  assert.deepEqual(drafts.map(d=>[d.type,d.amountMinor]),[['transfer','820'],['expense','180']])
  for (const replacement of [undefined,null,'',-1,'-1','0.5','9223372036854775808']) assert.throws(()=>booking.normalize({ ...value,interestMinor:replacement },'1000'))
  assert.throws(()=>booking.normalize({ ...value,principalMinor:'1000' },'1000'))
  assert.throws(()=>decision({ confirmed:true,assets:[{ accountId:value.assetAccountId }],debts:[{ accountId:value.liabilityAccountId }],assetIndex:0,debtIndex:0,principalYuan:'10',interestYuan:'',feeYuan:'0' }),/都需要确认/)
})
test('明确还款：真实 MySQL 原子入账、延期关联、幂等及导入', { skip:!process.env.CATLEDGER_TEST_DB_HOST }, async t=>{
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api',grants.api), importPool = await lab.role('import',grants.importer)
    const services = localServices({ apiPool,importPool,subject:'synthetic-explicit-repayment' })
    const api=(action,data)=>call(services.api,action,data), imp=(action,data)=>call(services.import,action,data)
    const user=await api('bootstrap'), categoryId=user.categories.find(c=>c.kind==='expense').id
    async function account(type) { return (await api('accounts.create',{ requestId:randomUUID(),type,name:'合成'+type,currency:'CNY',openingDisplayBalanceMinor:'100000',occurredLocalAt:'2026-08-01T00:00:00',timezoneOffsetMinutes:-480 })).accountId }
    const asset=await account('wallet'), debt=await account('other_liability'), credit=await account('credit')
    const repayment={ confirmed:true,mode:'defer',assetAccountId:asset,liabilityAccountId:debt,principalMinor:'80',interestMinor:'20',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId }
    const packet=()=>({ requestId:randomUUID(),repayment,totalMinor:'100',occurredLocalAt:'2026-09-01T12:00:00',timezoneOffsetMinutes:-480 })
    const balances=async()=> (await api('accounts.list')).accounts.map(a=>[a.accountId,a.bookBalanceMinor])
    const expenses=async()=> (await api('statistics.get',{ month:'2026-09' })).summary.expenseMinor
    const loan=await api('loans.create',{ requestId:randomUUID(),name:'合成借款',kind:'borrowing',accountId:debt,baselinePrincipalMinor:'10000',baselineDate:'2026-08-01' })
    let first
    await t.test('普通转账不会成为待办，信用卡也不接受明确借款确认',async()=>{
      for(const target of [debt,credit]) {
        const tx=await api('transactions.create',{ requestId:randomUUID(),type:'transfer',sourceAccountId:asset,destinationAccountId:target,amountMinor:'100',occurredLocalAt:'2026-09-01T12:00:00',timezoneOffsetMinutes:-480 })
        assert.equal((await api('loans.transaction',{ transactionId:tx.transactionId })).state,'none')
      }
      assert.equal((await api('loans.unassigned')).total,0)
      await assert.rejects(api('loans.bookRepayment',{ ...packet(),repayment:{ ...repayment,liabilityAccountId:credit } }),{ publicCode:'VALIDATION_ERROR' })
    })
    await t.test('本息分项同事务入账；重放一次、分组只计一笔待办',async()=>{
      const input=packet(), before=await expenses()
      first=await api('loans.bookRepayment',input)
      assert.equal(first.pending,true);assert.equal(first.transactionCount,2)
      assert.deepEqual(await api('loans.bookRepayment',input),first)
      assert.equal(BigInt(await expenses())-BigInt(before),20n)
      const list=await api('loans.unassigned');assert.equal(list.total,1);assert.equal(list.items[0].repaymentTotalMinor,'100')
      assert.equal((await api('loans.list')).pendingRepaymentCount,1)
      const context=await api('loans.transaction',{ transactionId:list.items[0].transactionId })
      assert.equal(context.state,'candidate');assert.equal(context.repayment.principalMinor,'80')
      await assert.rejects(api('transactions.delete',{ requestId:randomUUID(),transactionId:list.items[0].transactionId,version:1 }),{ publicCode:'LOAN_TRANSACTION_LOCKED' })
    })
    await t.test('后续关联不新增流水；并发只成功一次，过期版本不更新本金',async()=>{
      const before=await balances(), args={ requestId:randomUUID(),paymentId:first.paymentId,version:1,loanId:loan.loanId,loanVersion:1,confirmed:true }
      const results=await Promise.allSettled([api('loans.assignRepayment',args),api('loans.assignRepayment',{ ...args,requestId:randomUUID() })])
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
      assert.equal((await api('loans.unassigned')).total,0)
      assert.deepEqual(await balances(),before)
      assert.equal((await api('loans.get',{ loanId:loan.loanId })).loan.remainingPrincipalMinor,'9920')
    })
    await t.test('取消待办保留原流水、跨用户拒绝、全本金缺少零确认仍拒绝',async()=>{
      const value=await api('loans.bookRepayment',packet()), before=await balances()
      const other=localServices({ apiPool,importPool,subject:'synthetic-repayment-stranger' });await call(other.api,'bootstrap')
      await assert.rejects(call(other.api,'loans.assignRepayment',{ requestId:randomUUID(),paymentId:value.paymentId,version:1,loanId:loan.loanId,loanVersion:2,confirmed:true }),{ publicCode:'NOT_FOUND' })
      await api('loans.releaseRepayment',{ requestId:randomUUID(),paymentId:value.paymentId,version:1,confirmed:true })
      assert.deepEqual(await balances(),before);assert.equal((await api('loans.unassigned')).total,0)
      await assert.rejects(api('loans.bookRepayment',{ ...packet(),repayment:{ ...repayment,principalMinor:'100',interestMinor:undefined } }),{ publicCode:'VALIDATION_ERROR' })
    })
    await t.test('立即关联本金不足时金融流水与实际付款整组回滚',async()=>{
      const before=await balances()
      await assert.rejects(api('loans.bookRepayment',{ ...packet(),totalMinor:'20000',repayment:{ ...repayment,mode:'associate',loanId:loan.loanId,loanVersion:2,principalMinor:'19980' } }),{ publicCode:'LOAN_PRINCIPAL_EXCEEDED' })
      assert.deepEqual(await balances(),before);assert.equal((await api('loans.unassigned')).total,0)
    })
    await t.test('延期列表按实际付款分组分页、月份/账户绑定游标，0 本金也保留付款账户',async()=>{
      const packets=[packet(),packet(),{ ...packet(),occurredLocalAt:'2026-08-20T12:00:00' }]
      packets[0].repayment={ ...repayment,principalMinor:'0',interestMinor:'100' }
      const values=[]
      for (const input of packets) values.push(await api('loans.bookRepayment',input))
      const firstPage=await api('loans.unassigned',{ month:'2026-09',accountId:debt,pageSize:1 })
      assert.equal(firstPage.total,2);assert.ok(firstPage.nextCursor)
      const secondPage=await api('loans.unassigned',{ month:'2026-09',accountId:debt,pageSize:1,cursor:firstPage.nextCursor })
      assert.equal(secondPage.total,2);assert.equal(secondPage.nextCursor,null)
      assert.notEqual(firstPage.items[0].paymentId,secondPage.items[0].paymentId)
      await assert.rejects(api('loans.unassigned',{ month:'2026-08',accountId:debt,pageSize:1,cursor:firstPage.nextCursor }),{ publicCode:'VALIDATION_ERROR' })
      for (const value of values) await api('loans.releaseRepayment',{ requestId:randomUUID(),paymentId:value.paymentId,version:1,confirmed:true })
    })
    // 合成导入数据经过真实上传/解析/整理；测试夹具把单笔消费裁决为双方账户已确认的转账。
    async function importDraft(prefix) {
      let update=await prepareSyntheticUpdate(services,1,prefix)
      const issues=await imp('reviewIssues.list',{ updateId:update.updateId,group:'accounts' })
      const decisions=issues.items.filter(i=>i.status==='open').map(i=>({ issueId:i.issueId,issueVersion:i.version,operation:'resolve',decision:'apply_fields',fields:{ mappingAccountId:asset } }))
      if(decisions.length) update=await imp('reviewIssues.resolveAccountMappings',{ requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions })
      const [[event]]=await lab.owner.execute('SELECT event_id AS eventId,version FROM catledger_economic_events WHERE uid=? AND update_id=?',[user.uid,update.updateId])
      await lab.owner.execute("UPDATE catledger_economic_events SET economic_nature='internal_transfer',flow_direction='neutral',counterparty_ledger_account_id=?,category_id=NULL,manual_field_mask=manual_field_mask|15,reason_codes_json=JSON_ARRAY(),state='ready',status='ready' WHERE uid=? AND event_id=?",[debt,user.uid,event.eventId])
      await lab.owner.execute("UPDATE catledger_review_issues SET status='superseded',blocking=0 WHERE uid=? AND update_id=? AND issue_type='category_assignment'",[user.uid,update.updateId])
      return { update,event }
    }
    await t.test('导入未知本息费留待核对；已确认后整批原子入账并建立真实待办',async()=>{
      const {update,event}=await importDraft('SYNTHETIC-DEFER')
      let result=await imp('financeUpdates.setRepayment',{ requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,eventId:event.eventId,eventVersion:Number(event.version),repayment:{ mode:'review' } })
      await assert.rejects(imp('financeUpdates.post',{ requestId:randomUUID(),updateId:update.updateId,version:result.appliedVersion }),{ publicCode:'UNRESOLVED_IMPORT' })
      result=await imp('financeUpdates.setRepayment',{ requestId:randomUUID(),updateId:update.updateId,updateVersion:result.appliedVersion,eventId:event.eventId,eventVersion:Number(event.version)+1,repayment })
      const summary=await imp('financeUpdates.summary',{ updateId:update.updateId })
      assert.equal(summary.workbench.finalSummary.expenseText,'¥0.20')
      const expensePage=await imp('economicEvents.list',{ protocolVersion:2,updateId:update.updateId,view:'expense',pageSize:10 })
      assert.equal(expensePage.items[0].summaryExpenseMinor,'20')
      const before=await expenses(), post={ requestId:randomUUID(),updateId:update.updateId,version:result.appliedVersion }
      const receipt=await imp('financeUpdates.post',post)
      assert.equal(receipt.posting.createdTransactionCount,2);assert.deepEqual(await imp('financeUpdates.post',post),receipt)
      assert.equal(BigInt(await expenses())-BigInt(before),20n);assert.equal((await api('loans.unassigned')).total,1)
      const item=(await api('loans.unassigned')).items[0], payment=(await api('loans.payment',{ paymentId:item.paymentId })).payment
      const funds=await balances()
      await api('loans.assignRepayment',{ requestId:randomUUID(),paymentId:item.paymentId,version:payment.version,loanId:loan.loanId,loanVersion:2,confirmed:true })
      assert.deepEqual(await balances(),funds)
    })
    await t.test('导入立即关联失败整批回滚；更换有效贷款版本后可重试且撤销保留已入账流水',async()=>{
      const {update,event}=await importDraft('SYNTHETIC-ASSOCIATE')
      const current=(await api('loans.get',{ loanId:loan.loanId })).loan
      let result=await imp('financeUpdates.setRepayment',{ requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,eventId:event.eventId,eventVersion:Number(event.version),repayment:{ ...repayment,mode:'associate',loanId:loan.loanId,loanVersion:1 } })
      const before=await balances()
      await assert.rejects(imp('financeUpdates.post',{ requestId:randomUUID(),updateId:update.updateId,version:result.appliedVersion }),{ publicCode:'CONFLICT' })
      assert.deepEqual(await balances(),before)
      result=await imp('financeUpdates.setRepayment',{ requestId:randomUUID(),updateId:update.updateId,updateVersion:result.appliedVersion,eventId:event.eventId,eventVersion:Number(event.version)+1,repayment:{ ...repayment,mode:'associate',loanId:loan.loanId,loanVersion:current.version } })
      await imp('financeUpdates.post',{ requestId:randomUUID(),updateId:update.updateId,version:result.appliedVersion })
      assert.equal((await api('loans.unassigned')).total,0)
      const [[source]]=await lab.owner.execute('SELECT payment_id AS paymentId FROM catledger_loan_payment_sources WHERE uid=? AND event_id=? AND active=1',[user.uid,event.eventId])
      const funds=await balances()
      await api('loans.reverse',{ requestId:randomUUID(),paymentId:source.paymentId,version:1,loans:[{ loanId:loan.loanId,version:current.version+1 }],confirmed:true })
      assert.deepEqual(await balances(),funds)
    })
  } finally { await lab.close() }
})
