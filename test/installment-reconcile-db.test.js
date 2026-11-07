const test=require('node:test')
const assert=require('node:assert/strict')
const {randomUUID}=require('node:crypto')
const {isolatedMysql}=require('../scripts/isolated-mysql')
const grants=require('../scripts/runtime-role-grants')
const {localServices,call}=require('./helpers/local-services')

// 自动补偿：早期做计划只按编号/交易归组（两列为空）时，同期次的本金已归而利息被落下。
// 这里复现：先只导入本金建计划，再单独导入同一计划名+同期次的利息作为待归来源，
// 然后 loans.reconcileInstallmentSources 应把利息补进计划（不改账户余额、不造重复交易），
// 且重复调用幂等（第二次 linked=0、不推进版本）。
test('分期来源自动补偿：同计划名+同期次的利息漏归后由 reconcile 补进计划',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
  const lab=await isolatedMysql()
  try {
    const apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer),logs=[]
    const services=localServices({apiPool,importPool,subject:'synthetic-installment-reconcile',logger:{error:v=>logs.push(v),warn:v=>logs.push(v)}})
    const api=(action,data)=>call(services.api,action,data),imp=(action,data)=>call(services.import,action,data)
    const {uid}=await api('bootstrap')
    const {accountId}=await api('accounts.create',{requestId:randomUUID(),type:'credit',name:'合成信用卡',openingDisplayBalanceMinor:'2400000',occurredLocalAt:'2025-10-01T00:00:00',timezoneOffsetMinutes:-480})
    const plan={scheduleMethod:'flat',scheduleTerms:12,measurementKind:'repayment',repaymentMinor:'203909',
      firstPaymentDate:'2025-10-31',kind:'installment',name:'合成分期',baselinePrincipalMinor:'2400000',baselineDate:'2025-10-01',generatePlan:true,confirmed:true,
      installmentSetup:{schema:1,originalPrincipalMinor:'2400000',historicalPaidTerms:0,recordType:'credit_card',customRecordType:'',discountKind:null,discountValue:null}}
    const expense=async()=>{const [[r]]=await lab.owner.execute("SELECT COALESCE(SUM(amount_minor),0) AS amount,COUNT(*) AS n FROM catledger_transactions WHERE uid=? AND type='expense' AND deleted_at IS NULL",[uid]);return {amount:String(r.amount),n:Number(r.n)}}
    async function bank(term,component,reference='SYNTHETIC-PLAN-R',amount=component==='principal'?'2000':'39.09'){
      const content=Buffer.from('交易日期,交易金额,收支,交易类型,卡号,流水号,摘要,分期编号,当前期数,总期数,分期项目\n2026-09-02,'+amount+',支出,分期'+(component==='principal'?'本金':'利息')+',SYNTHETIC-CARD,'+reference+'-'+term+'-'+component+',合成账单,'+reference+','+term+',12,'+component+'\n')
      const {files}=await imp('imports.prepareMany',{requestId:randomUUID(),files:[{fileName:'合成信用卡.csv',size:content.length}]});const file=files[0];services.objects.set(file.cloudPath,content)
      const input={importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480}
      const {bankPreview:p}=await imp('imports.parseFile',{requestId:randomUUID(),...input})
      const parsed=await imp('imports.parseFile',{requestId:randomUUID(),...input,bankMapping:{...p.suggested,statementKind:'credit',schemaVersion:1,sheetIndex:p.sheetIndex,headerRow:p.headerRow,headerToken:p.headerToken}})
      let update=await imp('financeUpdates.prepare',{requestId:randomUUID(),batchIds:[parsed.batch.batchId]})
      const issues=await imp('reviewIssues.list',{updateId:update.updateId,group:'accounts'})
      const decisions=issues.items.filter(r=>r.status==='open').map(r=>({issueId:r.issueId,issueVersion:r.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:accountId}}))
      if(decisions.length)update=await imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,decisions})
      const reviews=(await imp('reviewIssues.list',{updateId:update.updateId,status:'open'})).items.filter(row=>row.primaryReasonCode==='historical_duplicate_candidate')
      for(const issue of reviews)update=await imp('reviewIssues.resolve',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,issueId:issue.issueId,issueVersion:issue.version,decision:'confirm_distinct'})
      return imp('financeUpdates.post',{requestId:randomUUID(),updateId:update.updateId,version:update.appliedVersion})
    }

    // 1) 本金和利息同批导入（真实形态：分期本金与利息随账单一起进来，此时尚无计划）。
    await bank(3,'principal')
    await bank(3,'interest')
    const principalSource=(await api('loans.installmentSources',{})).items.find(row=>row.component==='principal'&&row.periodNumber===3)
    assert.ok(principalSource)
    // 2) 用本金来源建计划（当前代码会把同期次利息一起归入）。
    const loan=await api('loans.create',{...plan,accountId,sourceItemId:principalSource.itemId,requestId:randomUUID()})
    const afterPrincipal=await expense()
    // 3) 复现历史遗留状态：把同期次利息的来源 loan_id 清空，模拟「旧代码只归了本金、利息被落下」。
    //    真实账单里利息行通常带与本金相同的计划名（plan_label），synthetic 导入不带，这里补上以贴合真实。
    const [[principalRow]]=await lab.owner.execute("SELECT item_id,plan_label FROM catledger_installment_items WHERE uid=? AND account_id=? AND period_number=3 AND component='principal' AND active=1",[uid,accountId])
    assert.ok(principalRow&&principalRow.plan_label,'本金来源应有计划名')
    const [[interestRow]]=await lab.owner.execute("SELECT item_id FROM catledger_installment_items WHERE uid=? AND account_id=? AND period_number=3 AND component='interest' AND active=1",[uid,accountId])
    assert.ok(interestRow,'利息来源应存在')
    await lab.owner.execute('UPDATE catledger_installment_items SET loan_id=NULL, plan_label=? WHERE uid=? AND item_id=?',[principalRow.plan_label,uid,interestRow.item_id])
    const orphan=(await api('loans.installmentSources',{accountId})).items.find(row=>row.component==='interest'&&row.periodNumber===3)
    assert.ok(orphan,'利息应作为待归来源出现')
    assert.equal(orphan.loanId,null)
    const loanVersion=(await api('loans.get',{loanId:loan.loanId})).loan.version
    loan.version=loanVersion

    // 3) 自动补偿：把落后的同期次利息补进计划。
    await t.test('reconcile 把同计划名+同期次漏归的利息补进计划',async()=>{
      const result=await api('loans.reconcileInstallmentSources',{requestId:randomUUID(),loanId:loan.loanId,version:loan.version})
      assert.ok(result.linked>=1)
      assert.equal((await api('loans.installmentSources',{accountId})).items.filter(row=>row.periodNumber===3).length,0)
      const detail=await api('loans.installment',{loanId:loan.loanId,periodNumber:3})
      assert.ok(detail.sources.some(s=>s.component==='interest'),'利息应已归入第 3 期')
      // 只改归属，不重复记支出（利息那笔交易仍在，未被再记一次：仅一笔利息支出）。
      assert.deepEqual(await expense(),{amount:'3909',n:1})
      loan.version=result.version
    })

    await t.test('重复 reconcile 幂等：无补项、不推进版本',async()=>{
      const before=loan.version
      const again=await api('loans.reconcileInstallmentSources',{requestId:randomUUID(),loanId:loan.loanId,version:before})
      assert.equal(again.linked,0)
      assert.equal(again.version,before)
    })

    await t.test('不同计划名的未归利息不会被误并',async()=>{
      // 同卡同期次、但计划名不同的未归利息（直接造原始行），reconcile 不应吞并它。
      const otherId=randomUUID()
      await lab.owner.execute(`INSERT INTO catledger_installment_items
        (uid,item_id,account_id,loan_id,reference_key,reference_label,plan_label,period_number,total_terms,component,amount_minor,occurred_date,origin,source_event_id,source_identity_id,transaction_id,canonical)
        VALUES (?,?,?,NULL,NULL,'OTHER','另一分期',3,12,'interest','100','2026-09-02','manual',NULL,NULL,NULL,1)`,[uid,otherId,accountId])
      const again=await api('loans.reconcileInstallmentSources',{requestId:randomUUID(),loanId:loan.loanId,version:loan.version})
      assert.equal(again.linked,0,'另一计划名的未归来源不应被本计划吞并')
      const [[row]]=await lab.owner.execute('SELECT loan_id FROM catledger_installment_items WHERE uid=? AND item_id=?',[uid,otherId])
      assert.equal(row.loan_id,null,'另一计划名的来源仍未被归入')
    })

    await t.test('缺 requestId 的调用被拒绝（客户端必须补 requestId）',async()=>{
      // 复现真实 bug：前端若漏传 requestId，幂等写会直接 VALIDATION_ERROR。
      await assert.rejects(api('loans.reconcileInstallmentSources',{loanId:loan.loanId,version:loan.version}),{publicCode:'VALIDATION_ERROR'})
    })

    assert.ok(!JSON.stringify(logs).includes('SYNTHETIC-CARD'))
    assert.ok(afterPrincipal.n>=1)
  } finally {await lab.close()}
})
