const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { chargeLab } = require('./helpers/loan-charges')
const { realPage } = require('./helpers/real-page')
const input = (field,value) => ({currentTarget:{dataset:{field}},detail:{value}})
test('退款真实Page跨越60条找原消费，两个入口保留服务端退款保护', {skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000}, async t => {
  const h=await chargeLab()
  try{
    const oldest=await h.expense('2025-01-02','10000',{note:'合成早期消费'})
    for(let i=0;i<70;i++){
      const expense=await h.expense('2026-02-02','10000',{note:'合成较新消费'+i})
      if(i%9===0)await h.api('transactions.create',{requestId:randomUUID(),type:'refund',destinationAccountId:h.assetAccountId,originalTransactionId:expense.transactionId,amountMinor:'10000',occurredLocalAt:'2026-03-01T12:00:00',timezoneOffsetMinutes:-480})
    }
    const ui=realPage(h),page=ui.page('transaction-editor');page.onLoad({});await page.prepareForm()
    await page.changeType({currentTarget:{dataset:{index:3}}})
    assert.ok(page.data.refundNextCursor,'超过60条的消费必须有继续查找入口')
    const seen=new Set()
    while(true){for(const row of page.data.refundableTransactions)seen.add(row.transactionId);if(!page.data.refundNextCursor)break;await page.nextRefundPage()}
    assert.equal(seen.size,63)
    assert.ok(seen.has(oldest.transactionId))
    page.changeOriginal({detail:{value:page.data.refundableTransactions.findIndex(r=>r.transactionId===oldest.transactionId)}})
    page.bindAmount({detail:{value:'10'}});page.changeDestination({detail:{value:page.data.accounts.findIndex(a=>a.accountId===h.assetAccountId)}})
    await page.save();assert.equal(page.data.errorMessage,'')
    const request=ui.calls.find(c=>c.action==='transactions.create').data,result=await h.api('transactions.create',request)
    assert.equal(result.originalTransaction.transactionId,oldest.transactionId)
    assert.equal((await h.api('transactions.refundable',{originalTransactionId:oldest.transactionId})).transactions[0].refundableMinor,'9000')
    await t.test('待关联退款按关键词、月份和账户定位同一早期消费',async()=>{
      const id=randomUUID()
      await h.owner.execute("INSERT INTO catledger_transactions(uid,transaction_id,type,destination_account_id,amount_minor,occurred_local_date,occurred_local_at,occurred_at_utc,timezone_offset_minutes,origin) VALUES(?,?,'refund',?,'2000','2026-03-01','2026-03-01 12:00:00','2026-03-01 04:00:00',-480,'import')",[h.uid,id,h.assetAccountId])
      const pending=(await h.api('transactions.list',{month:'2026-03',pageSize:100})).transactions.find(r=>r.transactionId===id)
      const ui=realPage(h);ui.app.globalData.editingTransaction=pending
      const p=ui.page('transaction-editor');p.onLoad({mode:'link-refund'});await p.prepareForm()
      p.refundFilter(input('refundSearch','合成早期'));p.refundFilter(input('refundMonth','2025-01'))
      p.refundFilter({currentTarget:{dataset:{field:'refundAccountIndex'}},detail:{value:p.data.refundAccounts.findIndex(a=>a.accountId===h.accountId)}})
      await p.searchRefunds();assert.equal(p.data.refundableTransactions.length,1)
      p.changeOriginal({detail:{value:0}});await p.save();assert.equal(p.data.errorMessage,'')
      assert.equal((await h.api('transactions.refundable',{originalTransactionId:oldest.transactionId})).transactions[0].refundableMinor,'7000')
    })
    await t.test('保护费用、原消费直接入口、陈旧版本和并发退款',async()=>{
      const loan=await h.create();await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:loan.loanId,version:1,repayments:[{periodNumber:1,paid:true}]})
      const protectedId=(await h.state(loan)).items[0].transactionId
      assert.equal((await h.api('transactions.refundable',{originalTransactionId:protectedId})).transactions.length,0)
      const direct=realPage(h),p=direct.page('transaction-editor');p.onLoad({originalTransactionId:oldest.transactionId});await p.prepareForm()
      assert.equal(p.data.originalTransactionId,oldest.transactionId);assert.equal(p.data.originalIndex,0)
      p.bindAmount({detail:{value:'60'}})
      const draft={...p.buildRequest(),requestId:randomUUID(),amountMinor:'6000',destinationAccountId:h.assetAccountId}
      const changed=await h.api('transactions.update',{requestId:randomUUID(),transactionId:oldest.transactionId,version:1,type:'expense',sourceAccountId:h.accountId,categoryId:h.categoryId,amountMinor:'10000',occurredLocalAt:'2025-01-02T12:00:00',timezoneOffsetMinutes:-480,note:'合成早期消费已更新'})
      await assert.rejects(h.api('transactions.create',draft),{publicCode:'CONFLICT'})
      const outcomes=await Promise.allSettled([1,2].map(()=>h.api('transactions.create',{...draft,originalVersion:changed.version,requestId:randomUUID()})))
      assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
      assert.equal(outcomes.find(r=>r.status==='rejected').reason.publicCode,'REFUND_EXCEEDS_ORIGINAL')
      await assert.rejects(h.api('transactions.create',{...draft,requestId:randomUUID(),originalTransactionId:protectedId,originalVersion:1}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
    })
    await t.test('游标绑定快照和筛选，迟到响应、删除、日期与回滚不放松保存资格',async()=>{
      const first=await h.api('transactions.refundable',{pageSize:2})
      await assert.rejects(h.api('transactions.refundable',{pageSize:2,month:'2025-01',cursor:first.nextCursor}),{publicCode:'VALIDATION_ERROR'})
      const expense=await h.expense('2026-01-10','5000',{note:'合成定位回滚'})
      await assert.rejects(h.api('transactions.refundable',{pageSize:2,cursor:first.nextCursor}),{publicCode:'READ_SNAPSHOT_CHANGED'})
      assert.equal((await h.api('transactions.refundable',{originalTransactionId:expense.transactionId,occurredLocalAt:'2026-01-09T12:00:00',timezoneOffsetMinutes:-480})).transactions.length,0)
      const refund={requestId:randomUUID(),type:'refund',originalTransactionId:expense.transactionId,originalVersion:1,amountMinor:'1000',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-01-11T12:00:00',timezoneOffsetMinutes:-480}
      await assert.rejects(h.api('transactions.create',{...refund,occurredLocalAt:'2026-01-09T12:00:00'}),{publicCode:'VALIDATION_ERROR'})
      await h.owner.query("CREATE TRIGGER fail_refund_lookup BEFORE INSERT ON catledger_transactions FOR EACH ROW BEGIN IF NEW.type='refund' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic refund rollback'; END IF; END")
      try{await assert.rejects(h.api('transactions.create',refund),{publicCode:'INTERNAL_ERROR'})}finally{await h.owner.query('DROP TRIGGER fail_refund_lookup')}
      assert.equal((await h.api('transactions.refundable',{originalTransactionId:expense.transactionId})).transactions[0].refundableMinor,'5000')
      const ui=realPage(h),p=ui.page('transaction-editor');p.onLoad({});await p.prepareForm();await p.changeType({currentTarget:{dataset:{index:3}}})
      let release,started
      const waiting=new Promise(resolve=>{started=resolve})
      ui.respond=async(action,data)=>{const result=await h.services.api({action,data});if(action==='transactions.refundable'&&data.search==='较新'){started();await new Promise(resolve=>{release=resolve})}return result}
      p.refundFilter(input('refundSearch','较新'));const slow=p.searchRefunds();await waiting
      p.refundFilter(input('refundSearch','定位回滚'));await p.searchRefunds();release();await slow
      assert.equal(p.data.refundableTransactions.length,1);assert.equal(p.data.refundableTransactions[0].transactionId,expense.transactionId)
      p.changeOriginal({detail:{value:0}});p.bindAmount({detail:{value:'10'}})
      await h.api('transactions.delete',{requestId:randomUUID(),transactionId:expense.transactionId,version:1})
      await p.save();assert.ok(p.data.errorMessage);assert.equal(p.data.amountYuan,'10')
      await p.searchRefunds();assert.equal(p.data.refundableTransactions.length,0);assert.equal(p.data.originalIndex,-1)
      const {localServices,call}=require('./helpers/local-services'),other=localServices({apiPool:h.apiPool,importPool:h.importPool,subject:'synthetic-other-refund'})
      await call(other.api,'bootstrap')
      assert.equal((await call(other.api,'transactions.refundable',{originalTransactionId:oldest.transactionId})).transactions.length,0)
    })
  }finally{await h.close()}
})
