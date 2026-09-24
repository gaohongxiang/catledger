const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, syntheticBill, confirmSyntheticHistoryDistinct } = require('./helpers/local-services')
const hasDatabase = Boolean(process.env.CATLEDGER_TEST_DB_HOST)

test('贷款已有交易关联与整组更正保留来源、版本和一次付款', { skip: !hasDatabase }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-loan-sources' })
    const api = (action,data) => call(services.api,action,data), imp = (action,data) => call(services.import,action,data)
    const user = await api('bootstrap'), categoryId = user.categories.find(c => c.kind === 'expense').id
    const makeAccount = async (type,amount,name) => (await api('accounts.create', { requestId: randomUUID(), type, name, currency: 'CNY',
      openingDisplayBalanceMinor: amount, occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const assetAccountId = await makeAccount('bank','1000000','合成资金账户'), debt = await makeAccount('other_liability','80000','合成负债')
    const metadata = { name: '合成来源贷款', kind: 'borrowing', accountId: debt, baselinePrincipalMinor: '80000', baselineDate: '2026-09-01' }
    const createLoan = () => api('loans.create', { ...metadata, requestId: randomUUID() })
    const base = { kind: 'repayment', totalMinor: '100000', assetAccountId, occurredLocalAt: '2026-09-02T10:00:00', timezoneOffsetMinutes: -480, confirmed: true }
    const split = (loanId,version=1,principalMinor='80000',interestMinor='18000') => ({ loanId,version,principalMinor,interestMinor,feeMinor:'2000',
      interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId,feeCategoryId:categoryId })
    const manual = (type,amountMinor) => api('transactions.create', { requestId:randomUUID(),type,amountMinor,sourceAccountId:assetAccountId,
      ...(type==='transfer' ? {destinationAccountId:debt} : {categoryId}), occurredLocalAt:base.occurredLocalAt,timezoneOffsetMinutes:-480 })
    const source = async ids => (await api('loans.source',{transactionIds:ids})).source
    async function balance() {
      const result = await api('accounts.list')
      return result.accounts.find(a => a.accountId === assetAccountId).bookBalanceMinor
    }
    await t.test('明确选择的三笔既有交易只加关联，双击不新增交易，撤销只取消关联', async () => {
      const loan = await createLoan(), transactions = await Promise.all([manual('transfer','80000'),manual('expense','18000'),manual('expense','2000')])
      const before = await balance(), selection = await source(transactions.map(t=>t.transactionId))
      const data = {...base,requestId:randomUUID(),mode:'associate',source:selection,allocations:[split(loan.loanId)]}
      const payment = await api('loans.record',data)
      assert.deepEqual(await api('loans.record',data),payment)
      assert.equal(await balance(),before)
      assert.equal((await api('loans.payment',{paymentId:payment.paymentId})).transactions.length,3)
      assert.equal((await api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'0')
      await assert.rejects(api('loans.source',{transactionIds:[transactions[0].transactionId]}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
      await api('loans.reverse',{requestId:randomUUID(),paymentId:payment.paymentId,version:1,confirmed:true,loans:[{loanId:loan.loanId,version:2}]})
      assert.equal(await balance(),before)
      for(const row of transactions) assert.equal((await lab.owner.execute('SELECT deleted_at FROM catledger_transactions WHERE uid=? AND transaction_id=?',[user.uid,row.transactionId]))[0][0].deleted_at,null)
    })
    await t.test('全额 transfer 不能假称已拆分；整组更正不再扣款，撤销恢复原交易', async () => {
      const loan = await createLoan(), existing = await manual('transfer','100000'), before = await balance(), selection = await source([existing.transactionId])
      const data = {...base,requestId:randomUUID(),mode:'associate',source:selection,allocations:[split(loan.loanId)]}
      await assert.rejects(api('loans.record',data),{publicCode:'LOAN_SOURCE_MISMATCH'})
      const payment = await api('loans.record',{...data,requestId:randomUUID(),mode:'correctExisting'})
      assert.equal(await balance(),before)
      assert.equal((await api('loans.payment',{paymentId:payment.paymentId})).transactions.length,3)
      const [[old]] = await lab.owner.execute('SELECT deleted_at,version FROM catledger_transactions WHERE uid=? AND transaction_id=?',[user.uid,existing.transactionId])
      assert.ok(old.deleted_at);assert.equal(Number(old.version),2)
      await api('loans.reverse',{requestId:randomUUID(),paymentId:payment.paymentId,version:1,confirmed:true,loans:[{loanId:loan.loanId,version:2}]})
      assert.equal(await balance(),before)
      const [[restored]] = await lab.owner.execute('SELECT deleted_at,version FROM catledger_transactions WHERE uid=? AND transaction_id=?',[user.uid,existing.transactionId])
      assert.equal(restored.deleted_at,null);assert.equal(Number(restored.version),3)
    })
    await t.test('贷款整组更正保留旧付款，结清状态随本金构成修正；更正结果可以整组撤销', async () => {
      const loan=await createLoan(), original=await api('loans.record',{...base,requestId:randomUUID(),mode:'new',allocations:[split(loan.loanId)]}),before=await balance()
      const corrected=await api('loans.correct',{...base,requestId:randomUUID(),paymentId:original.paymentId,version:1,
        loans:[{loanId:loan.loanId,version:2}],allocations:[split(loan.loanId,2,'70000','28000')]})
      assert.notEqual(corrected.paymentId,original.paymentId);assert.equal(await balance(),before)
      assert.equal((await api('loans.payment',{paymentId:original.paymentId})).payment.status,'reversed')
      assert.equal((await api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'10000')
      await api('loans.reverse',{requestId:randomUUID(),paymentId:corrected.paymentId,version:1,confirmed:true,loans:corrected.loans})
      assert.equal(await balance(),String(BigInt(before)+100000n))
    })
    await t.test('来源指纹保护全部版本，金额、账户不符与跨用户引用都不能关联', async () => {
      const loan=await createLoan(), original=await manual('transfer','80000'), selection=await source([original.transactionId])
      const data={...base,totalMinor:'80000',requestId:randomUUID(),mode:'associate',source:selection,allocations:[{...split(loan.loanId),interestMinor:'0',feeMinor:'0'}]}
      await api('transactions.update',{requestId:randomUUID(),transactionId:original.transactionId,version:1,type:'transfer',amountMinor:'80000',sourceAccountId:assetAccountId,destinationAccountId:debt,occurredLocalAt:base.occurredLocalAt,timezoneOffsetMinutes:-480,note:'合成修改'})
      await assert.rejects(api('loans.record',data),{publicCode:'CONFLICT'})
      const other=localServices({apiPool,importPool,subject:'synthetic-source-other'});await call(other.api,'bootstrap')
      await assert.rejects(call(other.api,'loans.source',{transactionIds:[original.transactionId]}),{publicCode:'NOT_FOUND'})
    })
    async function prepareContent(content) {
      const prepared=await imp('imports.prepareMany',{requestId:randomUUID(),files:[{fileName:'合成贷款来源.csv',size:content.length}]})
      const file=prepared.files[0];services.objects.set(file.cloudPath,content)
      const parsed=await imp('imports.parseFile',{requestId:randomUUID(),importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480})
      return imp('financeUpdates.prepare',{requestId:randomUUID(),batchIds:[parsed.batch.batchId]})
    }
    async function postedExpense(prefix, repeat=false) {
      let update=await prepareContent(Buffer.concat([syntheticBill(1,prefix),Buffer.from(repeat?'\n':'')]))
      const issues=await imp('reviewIssues.list',{updateId:update.updateId,group:'accounts'})
      const decisions=issues.items.filter(i=>i.status==='open').map(i=>({issueId:i.issueId,issueVersion:i.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:assetAccountId}}))
      if(decisions.length) update=await imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions})
      // 此套件验证用户保留本次记录后的事后更正；历史候选先明确确认。
      update=await confirmSyntheticHistoryDistinct(services,update)
      const posted=await imp('financeUpdates.post',{requestId:randomUUID(),updateId:update.updateId,version:update.appliedVersion})
      const [links]=await lab.owner.execute('SELECT event_id,transaction_id FROM catledger_economic_event_transactions WHERE uid=? AND update_id=? AND superseded_at IS NULL',[user.uid,update.updateId])
      return {...posted,transactionId:links[0]?.transaction_id,eventId:links[0]?.event_id}
    }
    const small=loanId=>({...split(loanId),principalMinor:'80',interestMinor:'18',feeMinor:'2'})
    const smallBase={...base,totalMinor:'100',occurredLocalAt:'2026-09-01T12:00:00'}
    await t.test('导入支出整组改为本息费；来源原文不变、重复导入不扣第二次，撤销恢复原始账务',async()=>{
      const loan=await createLoan(), imported=await postedExpense('SYNTHETIC-LOAN-SOURCE'),before=await balance()
      const expenseBefore=BigInt((await api('statistics.get',{month:'2026-09'})).summary.expenseMinor)
      const [[original]]=await lab.owner.execute('SELECT economic_nature,field_sources_json FROM catledger_economic_events WHERE uid=? AND event_id=?',[user.uid,imported.eventId])
      const [[evidence]]=await lab.owner.execute('SELECT raw_fields_json FROM catledger_import_rows WHERE uid=? LIMIT 1',[user.uid])
      const selected=await source([imported.transactionId])
      assert.equal(selected.event.eventId,imported.eventId)
      const request={...smallBase,requestId:randomUUID(),mode:'correctExisting',source:selected,allocations:[small(loan.loanId)]}
      const faulty=localServices({importPool,subject:'synthetic-loan-sources',apiPool:{async getConnection(){const connection=await apiPool.getConnection();return new Proxy(connection,{get(target,key){
        if(key==='execute') return async(sql,values)=>{if(/INSERT INTO catledger_loan_payment_sources/.test(sql)) throw new Error('synthetic source audit failure');return target.execute(sql,values)}
        return typeof target[key]==='function'?target[key].bind(target):target[key]
      }})}}})
      await assert.rejects(call(faulty.api,'loans.record',request),{publicCode:'INTERNAL_ERROR'})
      assert.equal(await balance(),before)
      assert.deepEqual(await source([imported.transactionId]),selected)
      assert.equal((await api('loans.get',{loanId:loan.loanId})).loan.version,1)
      const payment=await api('loans.record',request)
      assert.equal(await balance(),before)
      assert.equal((await api('statistics.get',{month:'2026-09'})).summary.expenseMinor,String(expenseBefore-80n))
      await assert.rejects(imp('financeUpdates.undoImpact',{updateId:imported.updateId}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
      await assert.rejects(postedExpense('SYNTHETIC-LOAN-SOURCE',true),{publicCode:'LOAN_TRANSACTION_LOCKED'})
      assert.equal(await balance(),before)
      assert.deepEqual((await lab.owner.execute('SELECT raw_fields_json FROM catledger_import_rows WHERE uid=? LIMIT 1',[user.uid]))[0][0],evidence)
      const corrected=await api('loans.correct',{...smallBase,requestId:randomUUID(),paymentId:payment.paymentId,version:1,loans:payment.loans,
        allocations:[{...small(loan.loanId),version:2,principalMinor:'70',interestMinor:'28'}]})
      assert.equal(await balance(),before)
      await api('loans.reverse',{requestId:randomUUID(),paymentId:corrected.paymentId,version:1,confirmed:true,loans:corrected.loans})
      assert.equal(await balance(),before)
      assert.equal((await api('statistics.get',{month:'2026-09'})).summary.expenseMinor,String(expenseBefore))
      const [[restored]]=await lab.owner.execute('SELECT economic_nature,field_sources_json FROM catledger_economic_events WHERE uid=? AND event_id=?',[user.uid,imported.eventId])
      assert.deepEqual(restored,original)
      const [active]=await lab.owner.execute('SELECT transaction_id,transaction_version FROM catledger_economic_event_transactions WHERE uid=? AND event_id=? AND superseded_at IS NULL',[user.uid,imported.eventId])
      assert.equal(active.length,1);assert.equal(active[0].transaction_id,imported.transactionId);assert.equal(Number(active[0].transaction_version),3)
    })
    await t.test('用户保留导入记录后再更正为已有还款：明确选择才消除重复，保留一次资金变化及审计',async()=>{
      const loan=await createLoan(), before=await balance()
      const manualPayment=await api('loans.record',{...smallBase,requestId:randomUUID(),mode:'new',allocations:[small(loan.loanId)]})
      const imported=await postedExpense('SYNTHETIC-LOAN-DUPLICATE')
      assert.equal(await balance(),String(BigInt(before)-200n))
      const selection=await source([imported.transactionId])
      const data={...smallBase,requestId:randomUUID(),mode:'correctExisting',source:selection,replacePayment:{paymentId:manualPayment.paymentId,version:1,loans:manualPayment.loans},
        allocations:[{...small(loan.loanId),version:2}]}
      const results=await Promise.allSettled([api('loans.record',data),api('loans.record',{...data,requestId:randomUUID()})])
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
      assert.equal(await balance(),String(BigInt(before)-100n))
      assert.equal((await api('loans.payment',{paymentId:manualPayment.paymentId})).payment.status,'reversed')
      const winner=results.find(r=>r.status==='fulfilled').value
      await api('loans.reverse',{requestId:randomUUID(),paymentId:winner.paymentId,version:1,confirmed:true,loans:winner.loans})
      assert.equal(await balance(),String(BigInt(before)-100n))
      assert.equal((await api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'80000')
    })
    await t.test('同一导入还款的两个目标必须整组关联；单成员自动展开并保护两笔交易',async()=>{
      const debt2=await makeAccount('credit','80000','合成第二负债'),first=await createLoan()
      const second=await api('loans.create',{...metadata,accountId:debt2,requestId:randomUUID()})
      const content=Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单','交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
        '2026-09-02 12:00:00,信用借还,花呗|信用购,自动还款-花呗|信用购2026年09月账单,1.00,不计收支,合成银行储蓄卡(1234),还款成功,,SYNTHETIC-LOAN-GROUP,,'].join('\n'))
      let update=await prepareContent(content)
      const issues=await imp('reviewIssues.list',{updateId:update.updateId,group:'accounts'})
      const decisions=issues.items.filter(i=>i.status==='open').map(i=>({issueId:i.issueId,issueVersion:i.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:assetAccountId}}))
      if(decisions.length) update=await imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions})
      const review=(await imp('reviewIssues.list',{updateId:update.updateId,group:'review',status:'open',pageSize:1})).items[0]
      update=await imp('reviewIssues.resolve',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,issueId:review.issueId,issueVersion:review.version,
        decision:'apply_fields',fields:{repaymentAllocations:[{accountId:debt,amountMinor:'60'},{accountId:debt2,amountMinor:'40'}]}})
      await imp('financeUpdates.post',{requestId:randomUUID(),updateId:update.updateId,version:update.appliedVersion})
      const [links]=await lab.owner.execute('SELECT transaction_id FROM catledger_economic_event_transactions WHERE uid=? AND update_id=? AND superseded_at IS NULL',[user.uid,update.updateId])
      assert.equal(links.length,2)
      const selection=await source([links[0].transaction_id]);assert.equal(selection.transactionIds.length,2)
      const before=await balance(),data={...smallBase,occurredLocalAt:'2026-09-02T12:00:00',requestId:randomUUID(),mode:'associate',source:selection,
        allocations:[{...small(first.loanId),principalMinor:'60',interestMinor:'0',feeMinor:'0'},{...small(second.loanId),principalMinor:'40',interestMinor:'0',feeMinor:'0'}]}
      const payment=await api('loans.record',data);assert.equal(await balance(),before)
      for(const row of links) await assert.rejects(api('transactions.delete',{requestId:randomUUID(),transactionId:row.transaction_id,version:1}),{publicCode:'LOAN_TRANSACTION_LOCKED'})
      await api('loans.reverse',{requestId:randomUUID(),paymentId:payment.paymentId,version:1,confirmed:true,loans:payment.loans})
      assert.equal(await balance(),before)
      assert.equal((await source([links[1].transaction_id])).transactionIds.length,2)
    })
  } finally {await lab.close()}
})
