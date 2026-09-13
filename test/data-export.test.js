const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {isolatedMysql}=require('../scripts/isolated-mysql'),grants=require('../scripts/runtime-role-grants')
const {localServices,call,prepareSyntheticUpdate}=require('./helpers/local-services')
const {manifest,createDataExportService}=require('../cloudfunctions/catledger-api/src/data-export-service')
const {hashWechatSubject}=require('../cloudfunctions/catledger-api/src/handler')

test('完整私有导出：隔离、宽 Unicode 分段、分页并发失效和两库恢复核对',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:120000},async t=>{
 const source=await isolatedMysql(),target=await isolatedMysql()
 try{
  const apiPool=await source.role('api',grants.api),importPool=await source.role('import',grants.importer)
  const services=localServices({apiPool,importPool,subject:'synthetic-export'}),api=(a,d)=>call(services.api,a,d),imp=(a,d)=>call(services.import,a,d)
  const user=await api('bootstrap'),uid=user.uid,categoryId=user.categories.find(c=>c.kind==='expense').id
  const account=async(type,amount,name)=>(await api('accounts.create',{requestId:randomUUID(),type,name,openingDisplayBalanceMinor:amount,occurredLocalAt:'2026-09-01T00:00:00',timezoneOffsetMinutes:-480})).accountId
  const asset=await account('bank','100000','合成资产'),debt=await account('credit','10000','合成负债')
  const {loanId}=await api('loans.create',{requestId:randomUUID(),accountId:debt,name:'合成贷款',kind:'borrowing',baselinePrincipalMinor:'10000',baselineDate:'2026-09-01'})
  const period=await api('loans.savePeriod',{requestId:randomUUID(),loanId,loanVersion:1,periodNumber:1,dueDate:'2026-09-20',principalMinor:'1000',interestMinor:'100',feeMinor:'0'})
  const payment=await api('loans.record',{requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId:asset,totalMinor:'1100',occurredLocalAt:'2026-09-02T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId,version:2,principalMinor:'1000',interestMinor:'100',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId}]})
  await api('loans.allocatePeriods',{requestId:randomUUID(),loanId,loanVersion:3,paymentId:payment.paymentId,version:1,confirmed:true,items:[{periodId:period.periodId,version:1,principalMinor:'500',interestMinor:'50',feeMinor:'0'}]})
  const manual=await api('transactions.create',{requestId:randomUUID(),type:'expense',amountMinor:'800',sourceAccountId:asset,categoryId,note:'=SUM(1,2)\n合成 🐱',occurredLocalAt:'2026-09-03T12:00:00',timezoneOffsetMinutes:-480})
  await api('transactions.create',{requestId:randomUUID(),type:'refund',amountMinor:'300',destinationAccountId:asset,originalTransactionId:manual.transactionId,occurredLocalAt:'2026-09-04T12:00:00',timezoneOffsetMinutes:-480})
  const update=await prepareSyntheticUpdate(services,4,'SYNTHETIC-EXPORT'),updateId=update.updateId
  const issue=(await imp('reviewIssues.list',{updateId,group:'accounts'})).items[0]
  const mapped=await imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId,updateVersion:update.appliedVersion,decisions:[{issueId:issue.issueId,issueVersion:issue.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:asset}}]})
  await imp('financeUpdates.post',{requestId:randomUUID(),updateId,version:mapped.appliedVersion})
  const [[sourceTransaction]]=await source.owner.execute('SELECT transaction_id AS id FROM catledger_economic_event_transactions WHERE uid=? AND update_id=? LIMIT 1',[uid,updateId])
  const selection=(await api('loans.source',{transactionIds:[sourceTransaction.id]})).source
  const loanVersion=(await api('loans.get',{loanId})).loan.version
  const sourceData={mode:'correctExisting',kind:'repayment',totalMinor:'100',assetAccountId:asset,occurredLocalAt:'2026-09-01T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
    allocations:[{loanId,version:loanVersion,principalMinor:'80',interestMinor:'20',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId}]}
  const linked=await api('loans.record',{...sourceData,requestId:randomUUID(),source:selection})
  await api('loans.correct',{...sourceData,requestId:randomUUID(),paymentId:linked.paymentId,version:1,loans:linked.loans,
    allocations:[{...sourceData.allocations[0],version:loanVersion+1,principalMinor:'70',interestMinor:'30'}]})
  const other=localServices({apiPool,importPool,subject:'synthetic-export-other'}),otherUser=await call(other.api,'bootstrap')
  // 只在一次性库播种超宽审计行，证明大字段不会截坏 UTF-8。
  const wide='合成🐱\n"'.repeat(40000)
  await source.owner.execute('UPDATE catledger_finance_actions SET decision_json=? WHERE uid=? LIMIT 1',[JSON.stringify({syntheticWide:wide}),uid])
  const revision=async()=>String((await source.owner.execute('SELECT data_revision AS v FROM catledger_users WHERE uid=?',[uid]))[0][0].v)
  const startData={requestId:randomUUID()},job=await api('dataExports.start',startData),rev=await revision()
  assert.deepEqual(await api('dataExports.start',startData),job);await api('bootstrap');assert.equal(await revision(),rev)
  await assert.rejects(call(other.api,'dataExports.page',{exportId:job.exportId}),{publicCode:'NOT_FOUND'})
  const records=[],parts=[];let cursor=null,terminal=null,pageCount=0
  do{
   const page=await api('dataExports.page',{exportId:job.exportId,...(cursor?{cursor}:{})})
   assert.ok(page.bytes<=65536&&page.rows<=50);assert.equal(Buffer.byteLength(page.text),page.bytes);assert.equal(page.text.includes('\ufffd'),false)
   if(page.nextCursor&&pageCount===0)await assert.rejects(call(other.api,'dataExports.page',{exportId:job.exportId,cursor:page.nextCursor}))
   parts.push(page.text);cursor=page.nextCursor;terminal=page.completeToken;pageCount++
  }while(cursor)
  assert.ok(pageCount>4);for(const line of parts.join('').trimEnd().split('\n'))records.push(JSON.parse(line))
  const done=await api('dataExports.finish',{exportId:job.exportId,completeToken:terminal});assert.equal(done.rows,records.length)
  const exportedWide=records.find(r=>r.table==='catledger_finance_actions'&&r.row.decision_json.syntheticWide);assert.equal(exportedWide.row.decision_json.syntheticWide,wide)
  assert.ok(!parts.join('').includes(otherUser.uid));assert.ok(records.every(r=>!Object.hasOwn(r.row,'uid')))
  await t.test('清单覆盖当前全部业务表和非生成列，导出逐行等于原库',async()=>{
   const [tables]=await source.owner.query('SELECT DISTINCT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME=\'uid\'')
   assert.deepEqual(tables.map(t=>t.name).filter(n=>!['catledger_users','catledger_user_identities','catledger_data_exports'].includes(n)).sort(),manifest.map(t=>t.name).sort())
   for(const table of manifest){
    const [columns]=await source.owner.query('SELECT COLUMN_NAME AS name,EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[table.name])
    assert.deepEqual(table.columns,columns.filter(c=>c.name!=='uid'&&!/VIRTUAL GENERATED|STORED GENERATED/.test(c.extra)).map(c=>c.name))
    const [original]=await source.owner.execute(`SELECT ${table.columns.join(',')} FROM ${table.name} WHERE uid=? ORDER BY ${table.keys.join(',')}`,[uid])
    assert.deepEqual(records.filter(r=>r.table===table.name).map(r=>r.row),original.map(r=>({...r})))
   }
  })
  await t.test('恢复保持外键开启，逐表和余额/收支/贷款/期次完全相同',async()=>{
   const newUid='1234567891',subject='synthetic-restored-export'
   await target.owner.execute("INSERT INTO catledger_users(uid,status) VALUES(?,'active')",[newUid])
   await target.owner.execute("INSERT INTO catledger_user_identities(uid,provider,subject_hash) VALUES(?,'wechat-mini',?)",[newUid,hashWechatSubject(subject)])
   const refunds=[]
   for(const entry of records){const table=manifest.find(t=>t.name===entry.table),row={...entry.row}
    if(table.name==='catledger_transactions'&&row.original_transaction_id){refunds.push([row.original_transaction_id,newUid,row.transaction_id]);row.original_transaction_id=null}
    await target.owner.execute(`INSERT INTO ${table.name}(uid,${table.columns.join(',')}) VALUES(${['uid',...table.columns].map(()=>'?').join(',')})`,[newUid,...table.columns.map(k=>table.json.includes(k)&&row[k]!=null?JSON.stringify(row[k]):row[k])])
   }
   for(const values of refunds)await target.owner.execute('UPDATE catledger_transactions SET original_transaction_id=?,updated_at=updated_at WHERE uid=? AND transaction_id=?',values)
   for(const table of manifest){const [rows]=await target.owner.execute(`SELECT ${table.columns.join(',')} FROM ${table.name} WHERE uid=? ORDER BY ${table.keys.join(',')}`,[newUid]);assert.deepEqual(rows.map(r=>({...r})),records.filter(r=>r.table===table.name).map(r=>r.row))}
   const restored=localServices({apiPool:target.owner,importPool:target.owner,subject}),read=(a,d)=>call(restored.api,a,d)
   for(const [action,data]of [['accounts.list',{}],['statistics.get',{month:'2026-09'}],['loans.get',{loanId}],['loans.periods',{loanId}],['loans.planAllocation',{loanId,paymentId:payment.paymentId}]])assert.deepEqual(await read(action,data),await api(action,data))
  })
  await t.test('导出中发生任一函数写入即失效，重放不升修订；过期拒绝',async()=>{
   const draft=await api('dataExports.start',{requestId:randomUUID()}),first=await api('dataExports.page',{exportId:draft.exportId})
   const request={requestId:randomUUID(),files:[{fileName:'合成等待.csv',size:10}]}
   await imp('imports.prepareMany',request);const v=await revision();await imp('imports.prepareMany',request);assert.equal(await revision(),v)
   await assert.rejects(api('dataExports.page',{exportId:draft.exportId,cursor:first.nextCursor}),{publicCode:'EXPORT_CHANGED'})
   const expired=createDataExportService({getPool:()=>apiPool,now:()=>Date.now()+7200000})
   await assert.rejects(expired.page({provider:'wechat-mini',subjectHash:hashWechatSubject('synthetic-export'),data:{exportId:draft.exportId}}),{publicCode:'EXPORT_EXPIRED'})
   await assert.rejects(api('dataExports.finish',{exportId:draft.exportId,completeToken:first.nextCursor}),{publicCode:'VALIDATION_ERROR'})
  })
 }finally{await source.close();await target.close()}
})
