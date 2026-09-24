const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {isolatedMysql}=require('../scripts/isolated-mysql')
const grants=require('../scripts/runtime-role-grants')
const {localServices,call}=require('./helpers/local-services')
const plan={scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'203909',
  firstPaymentDate:'2025-10-31',kind:'installment',name:'合成分期',baselinePrincipalMinor:'2400000',baselineDate:'2025-10-01',generatePlan:true,confirmed:true,
  installmentSetup:{schema:1,originalPrincipalMinor:'2400000',historicalPaidTerms:0,recordType:'credit_card',customRecordType:'',discountKind:null,discountValue:null}}
test('统一分期：真实 MySQL、最小权限、费用去重、连续进度、迟关联与用户隔离',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
  const lab=await isolatedMysql()
  try {
    const apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer),logs=[]
    const services=localServices({apiPool,importPool,subject:'synthetic-installment-flow',logger:{error:v=>logs.push(v),warn:v=>logs.push(v)}})
    const api=(action,data)=>call(services.api,action,data),imp=(action,data)=>call(services.import,action,data)
    const {uid}=await api('bootstrap')
    const {accountId}=await api('accounts.create',{requestId:randomUUID(),type:'credit',name:'合成信用卡',openingDisplayBalanceMinor:'2400000',occurredLocalAt:'2025-10-01T00:00:00',timezoneOffsetMinutes:-480})
    const first=await api('loans.create',{...plan,accountId,requestId:randomUUID()});let version=first.version
    const expense=async()=>{const [[r]]=await lab.owner.execute("SELECT COALESCE(SUM(amount_minor),0) AS amount,COUNT(*) AS n FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[uid]);return {amount:String(r.amount),n:Number(r.n)}}
    const progress=async(term,extra={})=>{const r=await api('loans.setInstallmentProgress',{requestId:randomUUID(),loanId:first.loanId,version,periodNumber:term,status:'completed',...extra});version=r.version;return r}
    const view=()=>api('loans.installments',{loanId:first.loanId})
    async function bank(term,component,reference='SYNTHETIC-PLAN-A',amount=component==='principal'?'2000':'39.09',flowSuffix='',historyChoice=null){
      const content=Buffer.from('交易日期,交易金额,收支,交易类型,卡号,流水号,摘要,分期编号,当前期数,总期数,分期项目\n2026-09-02,'+amount+',支出,分期'+(component==='principal'?'本金':'利息')+',SYNTHETIC-CARD,'+reference+'-'+term+'-'+component+flowSuffix+',合成账单,'+reference+','+term+',12,'+component+'\n')
      const {files}=await imp('imports.prepareMany',{requestId:randomUUID(),files:[{fileName:'合成信用卡.csv',size:content.length}]});const file=files[0];services.objects.set(file.cloudPath,content)
      const input={importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480}
      const {bankPreview:p}=await imp('imports.parseFile',{requestId:randomUUID(),...input})
      const parsed=await imp('imports.parseFile',{requestId:randomUUID(),...input,bankMapping:{...p.suggested,statementKind:'credit',schemaVersion:1,sheetIndex:p.sheetIndex,headerRow:p.headerRow,headerToken:p.headerToken}})
      if(!parsed.batch){assert.equal(parsed.duplicateDisposition,'already_posted');return parsed}
      let update=await imp('financeUpdates.prepare',{requestId:randomUUID(),batchIds:[parsed.batch.batchId]})
      const issues=await imp('reviewIssues.list',{updateId:update.updateId,group:'accounts'})
      const decisions=issues.items.filter(r=>r.status==='open').map(r=>({issueId:r.issueId,issueVersion:r.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:accountId}}))
      if(decisions.length)update=await imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions})
      {
        const reviews=(await imp('reviewIssues.list',{updateId:update.updateId,status:'open'})).items.filter(row=>row.primaryReasonCode==='historical_duplicate_candidate')
        for (const issue of reviews) update=await imp('reviewIssues.resolve',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,
          issueId:issue.issueId,issueVersion:issue.version,decision:historyChoice?'link_existing_transaction':'confirm_distinct',...(historyChoice?{transactionId:historyChoice}:{})})
      }
      const request={requestId:randomUUID(),updateId:update.updateId,version:update.appliedVersion}
      let result
      try {result=await imp('financeUpdates.post',request)} catch(error) {const events=await imp('economicEvents.list',{updateId:update.updateId});throw Object.assign(new Error(error.message+' '+JSON.stringify(events.items.map(e=>({nature:e.economicNature,status:e.status,reasons:e.reasonCodes,installment:e.fieldSources&&e.fieldSources.installment})))),{publicCode:error.publicCode})}
      const repeat=await imp('financeUpdates.post',request);assert.equal(repeat.status,result.status)
      return {...result,testUpdateId:update.updateId}
    }
    await t.test('建立方案和补十期进度均不生成本金或费用流水',async()=>{
      assert.deepEqual(await expense(),{amount:'0',n:0});await progress(10)
      const result=await view();assert.equal(result.summary.paidPeriods,10);assert.equal(result.items.length,12);assert.equal(result.items[10].stateText,'缺少账单，待补充')
      assert.deepEqual(await expense(),{amount:'0',n:0})
    })
    await t.test('手动补记本期费用仅一次，重复/并发请求复用结果',async()=>{
      const req={requestId:randomUUID(),loanId:first.loanId,version,periodNumber:10,status:'completed',bookCosts:true}
      const results=await Promise.all([api('loans.setInstallmentProgress',req),api('loans.setInstallmentProgress',req)])
      version=results[0].version;assert.equal(results[1].version,version)
      await progress(10,{bookCosts:true});assert.deepEqual(await expense(),{amount:'3909',n:1})
    })
    await t.test('先导入本金与利息，后关联分期；晚到银行利息复用手动费用',async()=>{
      await bank(10,'principal');assert.deepEqual(await expense(),{amount:'3909',n:1})
      await bank(10,'interest');assert.deepEqual(await expense(),{amount:'7818',n:2})
      const sources=await api('loans.installmentSources',{});assert.equal(sources.items.length,2)
      const linked=await api('loans.linkInstallmentSource',{requestId:randomUUID(),loanId:first.loanId,version,itemId:sources.items[0].itemId});version=linked.version
      assert.equal(linked.linked,2);assert.deepEqual(await expense(),{amount:'3909',n:1})
      const detail=await api('loans.installment',{loanId:first.loanId,periodNumber:10})
      assert.equal(detail.sources.length,3);assert.ok(detail.sources.every(s=>s.active));assert.equal((await view()).summary.paidPeriods,10)
    })
    let finalBill
    await t.test('建立明确归属后后续期自动匹配，异常期不被后续期抹掉',async()=>{
      await progress(9,{status:'unpaid'});finalBill=await bank(12,'interest')
      const result=await view();version=result.loanVersion
      assert.equal(result.summary.paidPeriods,11);assert.equal(result.items[8].stateText,'已逾期');assert.deepEqual(await expense(),{amount:'7818',n:2})
      assert.equal((await api('loans.installmentSources',{})).items.length,0)
    })
    await t.test('不同银行流水即使同分期同一期同额，也拒绝吞并并原子回滚',async()=>{
      const before=await view()
      await assert.rejects(bank(12,'interest','SYNTHETIC-PLAN-A','39.09','-ANOTHER-FLOW'),{publicCode:'LOAN_SOURCE_MISMATCH'})
      assert.deepEqual(await expense(),{amount:'7818',n:2})
      assert.equal((await view()).loanVersion,before.loanVersion)
      assert.equal((await api('loans.installment',{loanId:first.loanId,periodNumber:12})).sources.length,1)
    })
    await t.test('撤销已导入的第十二期后进度重读，保留先前手动利息和明确异常',async()=>{
      const impact=await imp('financeUpdates.undoImpact',{updateId:finalBill.testUpdateId})
      await imp('financeUpdates.undo',{requestId:randomUUID(),updateId:finalBill.testUpdateId,version:finalBill.appliedVersion,previewToken:impact.previewToken})
      const result=await view();version=result.loanVersion
      assert.equal(result.summary.completedThrough,10);assert.equal(result.summary.paidPeriods,9)
      assert.equal(result.items[8].stateText,'已逾期');assert.equal(result.items[10].stateText,'缺少账单，待补充')
      assert.deepEqual(await expense(),{amount:'3909',n:1})
      assert.equal((await api('loans.installment',{loanId:first.loanId,periodNumber:12})).sources[0].active,false)
    })
    await t.test('从待关联账单新建同事务完成；期数冲突不留下半笔分期；补记可撤销',async()=>{
      await bank(4,'principal','SYNTHETIC-PLAN-B')
      const source=(await api('loans.installmentSources',{})).items[0]
      await assert.rejects(api('loans.create',{...plan,scheduleTerms:6,repaymentMinor:'403909',accountId,sourceItemId:source.itemId,requestId:randomUUID()}),{publicCode:'LOAN_SOURCE_MISMATCH'})
      assert.equal((await api('loans.list',{})).items.length,1)
      assert.equal((await api('loans.installmentSources',{})).items[0].loanId,null)
      const second=await api('loans.create',{...plan,accountId,sourceItemId:source.itemId,requestId:randomUUID()})
      assert.equal((await api('loans.installments',{loanId:second.loanId})).summary.paidPeriods,4)
      const changed=await api('loans.setInstallmentProgress',{requestId:randomUUID(),loanId:second.loanId,version:second.version,periodNumber:5,status:'completed',bookCosts:true})
      const detail=await api('loans.installment',{loanId:second.loanId,periodNumber:5}),item=detail.sources[0]
      const removed=await api('loans.removeInstallmentItem',{requestId:randomUUID(),loanId:second.loanId,version:changed.version,itemId:item.itemId,itemVersion:item.version})
      assert.deepEqual(await expense(),{amount:'3909',n:1})
      await api('loans.archiveInstallment',{requestId:randomUUID(),loanId:second.loanId,version:removed.version,archived:true})
    })
    await t.test('历史查重选择同一笔费用后，保留分期来源且不重复支出；撤销来源不删手动费用',async()=>{
      const third=await api('loans.create',{...plan,firstPaymentDate:'2025-10-02',accountId,requestId:randomUUID()})
      let changed=await api('loans.setInstallmentProgress',{requestId:randomUUID(),loanId:third.loanId,version:third.version,periodNumber:12,status:'completed',bookCosts:true})
      const manual=(await api('loans.installment',{loanId:third.loanId,periodNumber:12})).sources[0]
      await bank(12,'principal','SYNTHETIC-PLAN-C')
      const pending=(await api('loans.installmentSources',{})).items.find(row=>row.referenceLabel==='SYNTHETIC-PLAN-C')
      changed=await api('loans.linkInstallmentSource',{requestId:randomUUID(),loanId:third.loanId,version:changed.version,itemId:pending.itemId})
      const posted=await bank(12,'interest','SYNTHETIC-PLAN-C','39.09','',manual.transactionId)
      const detail=await api('loans.installment',{loanId:third.loanId,periodNumber:12})
      assert.equal(detail.sources.length,3);assert.ok(detail.sources.every(row=>row.active))
      assert.deepEqual(await expense(),{amount:'7818',n:2})
      const impact=await imp('financeUpdates.undoImpact',{updateId:posted.testUpdateId})
      await imp('financeUpdates.undo',{requestId:randomUUID(),updateId:posted.testUpdateId,version:posted.appliedVersion,previewToken:impact.previewToken})
      const after=await api('loans.installment',{loanId:third.loanId,periodNumber:12})
      assert.equal(after.sources.find(row=>row.origin==='import'&&row.component==='interest').active,false)
      assert.ok(after.sources.find(row=>row.origin==='manual').active);assert.deepEqual(await expense(),{amount:'7818',n:2})
      await api('loans.archiveInstallment',{requestId:randomUUID(),loanId:third.loanId,version:after.loanVersion,archived:true})
    })
    let archivedRequest,rebuilt
    await t.test('进度和来源受用户隔离；删除管理记录不删真实账目',async()=>{
      const other=localServices({apiPool,importPool,subject:'synthetic-installment-other'});await call(other.api,'bootstrap')
      await assert.rejects(call(other.api,'loans.installments',{loanId:first.loanId}),{publicCode:'NOT_FOUND'})
      archivedRequest={requestId:randomUUID(),loanId:first.loanId,version,archived:true}
      await assert.rejects(call(other.api,'loans.archiveInstallment',archivedRequest),{publicCode:'NOT_FOUND'})
      const before=(await api('accounts.list')).accounts
      const results=await Promise.all([api('loans.archiveInstallment',archivedRequest),api('loans.archiveInstallment',archivedRequest)])
      assert.deepEqual(results[0],results[1]);assert.deepEqual((await api('accounts.list')).accounts,before)
      assert.equal((await api('loans.list',{})).items.length,0);assert.deepEqual(await expense(),{amount:'7818',n:2})
      assert.equal((await api('loans.get',{loanId:first.loanId})).loan.archived,true)
      const [[bindings]]=await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_installment_bindings WHERE uid=? AND loan_id=?',[uid,first.loanId])
      assert.equal(Number(bindings.n),0)
      assert.equal((await api('loans.installment',{loanId:first.loanId,periodNumber:10})).sources.length,0)
    })
    await t.test('删除后从旧账单重建，同笔费用的手动和导入来源一起归属，旧请求重放不拆新关联',async()=>{
      const pending=(await api('loans.installmentSources',{})).items
      const source=pending.find(row=>row.referenceLabel==='SYNTHETIC-PLAN-A'&&row.component==='principal')
      assert.ok(source);assert.equal(source.loanId,null)
      const before=await expense()
      rebuilt=await api('loans.create',{...plan,accountId,sourceItemId:source.itemId,requestId:randomUUID()})
      const detail=await api('loans.installment',{loanId:rebuilt.loanId,periodNumber:10})
      assert.equal(detail.sources.length,3);assert.equal(new Set(detail.sources.filter(s=>s.component==='interest').map(s=>s.transactionId)).size,1)
      assert.equal((await api('loans.installments',{loanId:rebuilt.loanId})).summary.paidPeriods,10)
      assert.deepEqual(await expense(),before)
      const ids=new Set(detail.sources.map(row=>row.itemId))
      assert.ok((await api('loans.installmentSources',{})).items.every(row=>!ids.has(row.itemId)))
      await api('loans.archiveInstallment',archivedRequest)
      assert.equal((await api('loans.installment',{loanId:rebuilt.loanId,periodNumber:10})).sources.length,3)
      // 重复导入同一来源和后续新期次分别验证；已有费用不重记。
      await bank(10,'interest');assert.deepEqual(await expense(),before)
      await bank(11,'principal');await bank(11,'interest')
      const result=await api('loans.installments',{loanId:rebuilt.loanId});rebuilt.version=result.loanVersion
      assert.equal(result.summary.paidPeriods,11);assert.deepEqual(await expense(),{amount:'11727',n:3})
    })
    await t.test('解除关联中途失败整体回滚，同请求重试成功；删后新期账单可关联另一笔分期',async()=>{
      let fail=true
      const faultPool={async getConnection(){const c=await apiPool.getConnection();return new Proxy(c,{get(target,key){
        if(key==='execute')return async(sql,values)=>{if(fail&&sql.startsWith('DELETE FROM catledger_installment_bindings'))throw new Error('synthetic archive fault');return target.execute(sql,values)}
        return typeof target[key]==='function'?target[key].bind(target):target[key]
      }})}}
      const faulty=localServices({apiPool:faultPool,importPool,subject:'synthetic-installment-flow'})
      const req={requestId:randomUUID(),loanId:rebuilt.loanId,version:rebuilt.version,archived:true}
      const before=await expense()
      await assert.rejects(call(faulty.api,'loans.archiveInstallment',req),{publicCode:'INTERNAL_ERROR'})
      assert.equal((await api('loans.get',{loanId:rebuilt.loanId})).loan.archived,false)
      assert.equal((await api('loans.installment',{loanId:rebuilt.loanId,periodNumber:10})).sources.length,3)
      const [[binding]]=await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_installment_bindings WHERE uid=? AND loan_id=?',[uid,rebuilt.loanId]);assert.equal(Number(binding.n),1)
      fail=false;await call(faulty.api,'loans.archiveInstallment',req);assert.deepEqual(await expense(),before)
      await bank(12,'principal')
      const sources=(await api('loans.installmentSources',{})).items,source=sources.find(row=>row.referenceLabel==='SYNTHETIC-PLAN-A'&&row.periodNumber===12)
      assert.ok(source)
      const fresh=await api('loans.create',{...plan,accountId,requestId:randomUUID()})
      const linked=await api('loans.linkInstallmentSource',{requestId:randomUUID(),loanId:fresh.loanId,version:fresh.version,itemId:source.itemId})
      assert.equal((await api('loans.installments',{loanId:fresh.loanId})).summary.paidPeriods,12)
      assert.deepEqual(await expense(),before)
      // 旧记录即使通过兼容接口恢复，也不能抢回已经重新关联的账单。
      const old=(await api('loans.get',{loanId:rebuilt.loanId})).loan
      await api('loans.archiveInstallment',{requestId:randomUUID(),loanId:rebuilt.loanId,version:old.version,archived:false})
      await assert.rejects(api('loans.linkInstallmentSource',{requestId:randomUUID(),loanId:rebuilt.loanId,version:old.version+1,itemId:source.itemId}),{publicCode:'LOAN_SOURCE_MISMATCH'})
      rebuilt={...fresh,version:linked.version}
    })
    await t.test('0025 修复旧版归档残留且可重入，只释放已归档记录并保留交易/来源身份',async()=>{
      const fs=require('node:fs'),path=require('node:path'),{splitSqlStatements}=require('../migrations/runner')
      const statements=splitSqlStatements(fs.readFileSync(path.resolve(__dirname,'../migrations/0025_release_archived_installments.sql'),'utf8'))
      const activeSource=(await api('loans.installmentSources',{})).items.find(row=>row.referenceLabel==='SYNTHETIC-PLAN-B')
      const activeLoan=await api('loans.create',{...plan,accountId,sourceItemId:activeSource.itemId,requestId:randomUUID()})
      const [before]=await lab.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? ORDER BY transaction_id',[uid])
      const [identities]=await lab.owner.execute('SELECT item_id,source_identity_id,source_event_id,transaction_id,active FROM catledger_installment_items WHERE uid=? ORDER BY item_id',[uid])
      await lab.owner.execute('UPDATE catledger_loans SET archived_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND loan_id=?',[uid,rebuilt.loanId])
      const connection=await lab.owner.getConnection()
      try {for(const sql of statements)await connection.query(sql)} finally {connection.release()}
      assert.deepEqual((await lab.owner.execute('SELECT * FROM catledger_transactions WHERE uid=? ORDER BY transaction_id',[uid]))[0],before)
      assert.deepEqual((await lab.owner.execute('SELECT item_id,source_identity_id,source_event_id,transaction_id,active FROM catledger_installment_items WHERE uid=? ORDER BY item_id',[uid]))[0],identities)
      const [after]=await lab.owner.execute('SELECT item_id,loan_id,version FROM catledger_installment_items WHERE uid=? ORDER BY item_id',[uid])
      assert.ok(after.every(row=>row.loan_id!==rebuilt.loanId))
      assert.equal(after.find(row=>row.item_id===activeSource.itemId).loan_id,activeLoan.loanId)
      const [[revision]]=await lab.owner.execute('SELECT data_revision FROM catledger_users WHERE uid=?',[uid])
      const retry=await lab.owner.getConnection();try {for(const sql of statements)await retry.query(sql)} finally {retry.release()}
      assert.deepEqual((await lab.owner.execute('SELECT item_id,loan_id,version FROM catledger_installment_items WHERE uid=? ORDER BY item_id',[uid]))[0],after)
      assert.deepEqual((await lab.owner.execute('SELECT data_revision FROM catledger_users WHERE uid=?',[uid]))[0][0],revision)
    })
    await t.test('从已解除的手动费用来源重建，也能找回同一交易的银行编号及其他期次',async()=>{
      const sources=(await api('loans.installmentSources',{})).items
      const manual=sources.find(row=>row.origin==='manual'&&row.periodNumber===10)
      assert.ok(manual);assert.equal(manual.referenceKey,null)
      const before=await expense(),fresh=await api('loans.create',{...plan,accountId,sourceItemId:manual.itemId,requestId:randomUUID()})
      assert.equal((await api('loans.installments',{loanId:fresh.loanId})).summary.paidPeriods,12)
      assert.equal((await api('loans.installment',{loanId:fresh.loanId,periodNumber:10})).sources.length,3)
      assert.deepEqual(await expense(),before)
    })
    assert.ok(!JSON.stringify(logs).includes('SYNTHETIC-CARD'))
  } finally {await lab.close()}
})
