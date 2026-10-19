const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')

async function download(services, objectId) {
  const descriptors = []; let offset = 0, header
  do {
    const page = await call(services.import, 'financeUpdates.snapshotManifest', { objectId, offset })
    header = page.header; descriptors.push(...page.parts); offset = page.nextOffset
  } while (offset != null)
  protocol.validateManifest(header, descriptors)
  const contents = []
  for (const descriptor of descriptors) contents.push(protocol.validatePart(header, descriptor,
    await call(services.import, 'financeUpdates.snapshotChunk', { objectId, index: descriptor.index })))
  const value=JSON.parse(contents.join(''))
  return { header, facts: header.kind==='snapshot'?require('../cloudfunctions/catledger-import/src/local-review-snapshot').decode(value):value }
}
function finalState(snapshot) {
  return { protocolVersion: 3, snapshotId: snapshot.header.objectId, updateId: snapshot.header.updateId,
    baseVersion: snapshot.header.baseVersion, ruleVersion: snapshot.header.ruleVersion,
    decisions: { accounts: [], events: [], pairings: [], reviews: [], duplicates: [] } }
}
async function stage(services, state, { uploadId = randomUUID(), parts = null } = {}) {
  const packed = protocol.split(JSON.stringify(state), 'decisions')
  for (const part of parts || packed.parts) await call(services.import, 'financeUpdates.stageDecisions', {
    requestId: randomUUID(), updateId: state.updateId, snapshotId: state.snapshotId, uploadId,
    baseVersion: state.baseVersion, ruleVersion: state.ruleVersion, chunkCount: packed.chunkCount, index: part.index, content: part.content
  })
  const receipt = await call(services.import, 'financeUpdates.sealDecisions', { requestId: randomUUID(), uploadId, updateId: state.updateId, snapshotId: state.snapshotId })
  return { protocolVersion: 3, requestId: randomUUID(), updateId: state.updateId, version: state.baseVersion,
    snapshotId: state.snapshotId, uploadId, payloadDigest: receipt.digest }
}

test('完整快照/决定暂存：可信用户、不可替换、完整性及旧入口门禁', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async () => {
  const lab = await isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const identity = await call(services.api, 'bootstrap')
    const update = await prepareSyntheticUpdate(services, 3, randomUUID())
    const [[before]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [identity.uid])
    const prepared = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
    const snapshot = await download(services, prepared.snapshot.objectId)
    assert.equal(snapshot.facts.rows.length, 3)
    assert.equal(snapshot.facts.raw.length, 3)
    assert.equal(snapshot.facts.events.length, 3)
    assert.equal(snapshot.facts.update.reviewMode, 'local_v3')
    assert.equal(snapshot.facts.update.version, snapshot.header.baseVersion)
    await assert.rejects(call(services.import, 'financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: snapshot.header.baseVersion }), { publicCode: 'LOCAL_REVIEW_REQUIRED' })
    const [[after]] = await lab.owner.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?', [identity.uid])
    assert.equal(BigInt(after.revision), BigInt(before.revision)+1n)
    const exportJob = await call(services.api, 'dataExports.start', { requestId: randomUUID() })
    const state = finalState(snapshot), request = await stage(services, state)
    // Staging changes the full private export, never the formal ledger.
    await assert.rejects(call(services.api,'dataExports.page',{exportId:exportJob.exportId}),{publicCode:'EXPORT_CHANGED'})
    const outsider = localServices({ apiPool, importPool, subject: 'other-local-review-user' })
    await call(outsider.api, 'bootstrap')
    await assert.rejects(download(outsider, prepared.snapshot.objectId), { publicCode: 'SNAPSHOT_INCOMPLETE' })
    await assert.rejects(call(services.import, 'financeUpdates.stageDecisions', {
      requestId: randomUUID(), updateId: state.updateId, snapshotId: state.snapshotId, uploadId: request.uploadId,
      baseVersion: state.baseVersion, ruleVersion: state.ruleVersion, chunkCount: 1, index: 0, content: '{}'
    }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
    const [[counts]] = await lab.owner.execute(`SELECT (SELECT COUNT(*) FROM catledger_transactions WHERE uid=?) AS transactions,
      (SELECT COUNT(*) FROM catledger_accounts WHERE uid=?) AS accounts,
      (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid=?) AS mappings`, [identity.uid, identity.uid, identity.uid])
    assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key,value]) => [key,Number(value)])), { transactions: 0, accounts: 0, mappings: 0 })
  } finally { await lab.close() }
})
test('prepareSnapshot 重放刷新服务端租约，force 生成新快照并保留旧代次', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({ apiPool: lab.owner, importPool: lab.owner })
    await call(services.api, 'bootstrap')
    const update = await prepareSyntheticUpdate(services, 1, randomUUID())
    const first = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
    await lab.owner.execute('UPDATE catledger_finance_updates SET updated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 25 HOUR) WHERE update_id = ?', [update.updateId])
    const replay = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: update.updateId, version: first.update.version })
    assert.equal(replay.snapshot.objectId, first.snapshot.objectId)
    assert.equal(replay.update.version, first.update.version)
    assert.ok(Number(replay.update.ageMs) < 5000, '重放既有快照应刷新 updated_at 租约')
    const forced = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: update.updateId, version: replay.update.version, force: true })
    assert.notEqual(forced.snapshot.objectId, first.snapshot.objectId)
    assert.equal(forced.update.version, replay.update.version + 1)
    const [[objects]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_import_review_objects WHERE update_id=? AND object_kind='snapshot'", [update.updateId])
    assert.equal(Number(objects.count), 2)
  } finally { await lab.close() }
})

module.exports = { download, finalState, stage }

async function prepareLocal(services, updateId, version) {
  if (!version) version = (await call(services.import, 'financeUpdates.summary', { updateId })).update.version
  const prepared = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId, version })
  const snapshot = await download(services, prepared.snapshot.objectId)
  return { snapshot, model: require('../miniprogram/packages/finance/services/import-local-model').create(snapshot.facts) }
}
async function postLocal(services, model) {
  const request = await stage(services, model.finalState())
  const result = await call(services.import, 'financeUpdates.post', request)
  if (result.outcome === 'recheck') return { ...result, supplement: (await download(services, result.recheck.objectId)).facts }
  return result
}

test('银行候选容量边界：100×100候选完整下发与本地分页，保持既有上限', {skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:180000},async t=>{
  const lab=await isolatedMysql()
  try{
    const grants=require('../scripts/runtime-role-grants')
    const c=await require('./helpers/bank-pairing').setup({apiPool:await lab.role('api',grants.api),
      importPool:await lab.role('import',grants.importer),count:100,ambiguous:true,bankNature:'消费'})
    const {model,snapshot}=await prepareLocal(c.services,c.updateId)
    assert.equal(model.pairs.size,10000)
    const reader=require('../miniprogram/packages/finance/services/import-local-read').create(model)
    const page=reader.read('reviewIssues.pairings',{mode:'ambiguous',pageSize:40})
    assert.equal(page.total,10000);assert.ok(page.items.length>0&&page.items.length<=40)
    const next=reader.read('reviewIssues.pairings',{mode:'ambiguous',pageSize:40,cursor:page.nextCursor})
    assert.ok(next.items.every(item=>!page.items.some(previous=>previous.pairKey===item.pairKey)))
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=262144)
    const first=page.items[0]
    model.pair({pairKey:first.pairKey,decision:'same'})
    assert.equal(model.pairs.size,9801)
    assert.equal(model.finalState().decisions.pairings.length,1)
    const [[ledger]]=await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?',[c.uid])
    assert.equal(Number(ledger.count),0)
    t.diagnostic(JSON.stringify({rows:200,candidates:10000,snapshotBytes:snapshot.header.bytes,
      pageBytes:Buffer.byteLength(JSON.stringify(page)),decisionBytes:Buffer.byteLength(JSON.stringify(model.finalState()))}))
  }finally{await lab.close()}
})

test('当前状态裁决：无关账务允许提交，停用账户精确退回，其他批次来源不会重复入账', {skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:180000},async t=>{
  const lab=await isolatedMysql()
  try{
    const grants=require('../scripts/runtime-role-grants'),apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer)
    for(const scenario of ['unrelated','archived','same-source'])await t.test(scenario,async()=>{
      const services=localServices({apiPool,importPool,subject:'current-state-'+randomUUID()}),api=(action,data)=>call(services.api,action,data)
      const {uid,categories}=await api('bootstrap'),categoryId=categories.find(row=>row.kind==='expense').id
      const account=await api('accounts.create',{requestId:randomUUID(),name:'微信零钱',type:'wallet'}),prefix=randomUUID()
      const prepared=await prepareSyntheticUpdate(services,2,prefix),{model}=await prepareLocal(services,prepared.updateId)
      for(const event of model.events.values())model.edit({eventId:event.eventId,editorVersion:1,fields:{categoryId,note:'保留核对'}})
      if(scenario==='unrelated')await api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:account.accountId,amountMinor:'9900',categoryId,occurredLocalAt:'2026-08-01T12:00:00',timezoneOffsetMinutes:-480})
      if(scenario==='archived')await api('accounts.archive',{requestId:randomUUID(),accountId:account.accountId,version:account.version})
      if(scenario==='same-source'){
        const content=Buffer.concat([require('./helpers/local-services').syntheticBill(2,prefix),Buffer.from('\n\n')])
        const uploaded=await call(services.import,'imports.prepareMany',{requestId:randomUUID(),files:[{fileName:'合成另一批.csv',size:content.length}]})
        const file=uploaded.files[0];services.objects.set(file.cloudPath,content)
        const parsed=await call(services.import,'imports.parseFile',{requestId:randomUUID(),importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480})
        const other=await call(services.import,'financeUpdates.prepare',{requestId:randomUUID(),batchIds:[parsed.batch.batchId]}),second=await prepareLocal(services,other.updateId)
        assert.notEqual(other.updateId,prepared.updateId)
        for(const event of second.model.events.values())second.model.edit({eventId:event.eventId,editorVersion:1,fields:{categoryId}})
        assert.equal((await postLocal(services,second.model)).status,'posted')
      }
      const result=await postLocal(services,model)
      if(scenario==='archived'){
        assert.equal(result.outcome,'recheck');assert.ok(result.supplement.problems.some(row=>row.reason==='account_unavailable'&&row.eventIds.length))
        model.applySupplement(result.supplement)
        assert.equal(model.choices.events.size,2);assert.equal(model.invalid.size,2)
      }else if(scenario==='unrelated')assert.equal(result.status,'posted',JSON.stringify(result.supplement?.problems))
      const [[total]]=await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?',[uid])
      assert.equal(Number(total.count),scenario==='unrelated'?3:scenario==='same-source'?2:0)
      if(scenario==='same-source')assert.ok(result.status==='posted'||result.outcome==='recheck')
    })
  }finally{await lab.close()}
})

test('历史退款额度被占用后整批退回，补充当前可退额并保留无关决定',{skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:180000},async()=>{
  const lab=await isolatedMysql()
  try{
    const grants=require('../scripts/runtime-role-grants'),services=localServices({apiPool:await lab.role('api',grants.api),importPool:await lab.role('import',grants.importer),subject:'refund-current-'+randomUUID()}),api=(action,data)=>call(services.api,action,data)
    const {uid,categories}=await api('bootstrap'),categoryId=categories.find(row=>row.kind==='expense').id,account=await api('accounts.create',{requestId:randomUUID(),name:'微信零钱',type:'wallet'})
    const original=await api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:account.accountId,amountMinor:'10000',categoryId,occurredLocalAt:'2026-08-01T12:00:00',timezoneOffsetMinutes:-480})
    let update=await prepareSyntheticUpdate(services,2,randomUUID())
    const [event]= (await call(services.import,'economicEvents.list',{updateId:update.updateId})).items
    update=await call(services.import,'financeUpdates.setReview',{requestId:randomUUID(),updateId:update.updateId,updateVersion:update.appliedVersion,eventId:event.eventId,eventVersion:event.version,editorVersion:1,fields:{economicNature:'refund',amountMinor:'6000'}})
    const {model}=await prepareLocal(services,update.updateId)
    const refund=model.events.get(event.eventId),candidate=model.refundCandidates(refund,'transaction').find(row=>row.id===original.transactionId)
    assert.ok(candidate)
    model.edit({eventId:event.eventId,editorVersion:1,decisions:{refund:{mode:'link',kind:'transaction',id:candidate.id,version:candidate.version}}})
    const other=[...model.events.values()].find(row=>row.eventId!==event.eventId)
    model.edit({eventId:other.eventId,editorVersion:1,fields:{categoryId,note:'保留无关备注'}})
    await api('transactions.create',{requestId:randomUUID(),type:'refund',destinationAccountId:account.accountId,originalTransactionId:original.transactionId,amountMinor:'5000',occurredLocalAt:'2026-08-02T12:00:00',timezoneOffsetMinutes:-480})
    const result=await postLocal(services,model)
    assert.equal(result.outcome,'recheck');assert.ok(result.supplement.problems.some(row=>row.eventIds.includes(event.eventId)))
    model.applySupplement(result.supplement)
    assert.equal(model.choices.events.get(other.eventId).editor.fields.note,'保留无关备注')
    const [[total]]=await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?',[uid]);assert.equal(Number(total.count),2)
  }finally{await lab.close()}
})

test('真实 Page/API 配对与拆分保持零网络；最终仍使用同一整批入账内核', {skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:180000},async t=>{
  const lab=await isolatedMysql()
  try{
    const grants=require('../scripts/runtime-role-grants'),apiPool=await lab.role('api',grants.api),importPool=await lab.role('import',grants.importer)
    for(const ambiguous of [false,true])await t.test(ambiguous?'多候选逐对不同笔':'唯一建议、拆分、重新合并',async sub=>{
      const c=await require('./helpers/bank-pairing').setup({apiPool,importPool,count:2,ambiguous,bankNature:'消费'})
      const {snapshot}=await prepareLocal(c.services,c.updateId)
      const h=await require('./helpers/local-workbench').localWorkbench(sub,snapshot.facts),page=h.page,tap=data=>({currentTarget:{dataset:data}})
      await page.setStep({currentStep:3})
      if(ambiguous){
        while(h.local.model.pairs.size){
          await page.openAmbiguousPairingReview(tap({issueId:[...h.local.model.issues.values()].find(row=>row.primaryReasonCode==='bank_channel_same_event_candidate'&&row.subjectEventIds.length===4)?.issueId}))
          assert.equal(page.data.pairingCanDecide,true,page.data.pairingError)
          await page.decidePairing(tap({decision:'distinct'}))
          assert.equal(page.data.pairingSheet,null,page.data.pairingError)
        }
      }else{
        const first=[...h.local.model.pairs.values()][0]
        await page.openPairingReview()
        assert.equal(page.data.pairingSelectedCount,2)
        await page.confirmPairings()
        assert.equal(h.local.model.events.size,2,page.data.pairingError)
        page.closePairingReview()
        await page.openDuplicateEdit(tap({id:first.platform.eventId}));await page.saveDuplicateEdit()
        assert.equal(h.local.model.events.size,3,page.data.duplicateEditSheet?.error)
        assert.ok(h.local.model.events.has(first.bank.eventId))
        await page.openDuplicateEdit(tap({id:first.platform.eventId}));await page.saveDuplicateEdit()
        assert.equal(h.local.model.events.size,2,page.data.duplicateEditSheet?.error)
      }
      for(const event of h.local.model.events.values())h.local.call('financeUpdates.setCategory',{eventId:event.eventId,eventVersion:event.version,categoryId:snapshot.facts.categories.find(row=>row.kind==='expense').categoryId})
      assert.equal(h.network.length,0,JSON.stringify(h.network))
      const result=await postLocal(c.services,h.local.model)
      assert.equal(result.status,'posted',JSON.stringify(result.supplement?.problems))
      assert.equal(result.posting.createdTransactionCount,ambiguous?4:2)
      sub.diagnostic('配对真实页面网络调用 0')
    })
  }finally{await lab.close()}
})

test('v3 单事务故障注入：新账户、交易、退款、贷款、映射、成功回执全部回滚；原请求可恢复', {skip:!process.env.CATLEDGER_TEST_DB_HOST,timeout:240000},async t=>{
  const lab=await isolatedMysql()
  try{
    const grants=require('../scripts/runtime-role-grants'),apiPool=await lab.role('api',grants.api),pool=await lab.role('import',grants.importer)
    let failure=null,hits=0
    const importPool={async getConnection(){const c=await pool.getConnection();return new Proxy(c,{get(target,key){
      if(key==='execute')return async(sql,values)=>{if(failure?.test(sql)){hits++;throw Error('synthetic post boundary')}return target.execute(sql,values)}
      return typeof target[key]==='function'?target[key].bind(target):target[key]
    }})}}
    const services=localServices({apiPool,importPool,subject:'local-atomic-'+randomUUID()}),api=(action,data)=>call(services.api,action,data)
    const {uid,categories}=await api('bootstrap'),categoryId=categories.find(row=>row.kind==='expense').id
    const debt=(await api('accounts.create',{requestId:randomUUID(),name:'合成负债',type:'other_liability'})).accountId
    const {plan,authorization}=require('./helpers/loan-charges')
    const loan=await api('loans.create',{...plan,requestId:randomUUID(),accountId:debt,baselinePrincipalMinor:'1080000',repaymentMinor:'98000',feeUpfrontMinor:'2000',installmentSetup:{...plan.installmentSetup,originalPrincipalMinor:'1080000',recordType:'bank_loan'}})
    await api('loans.configureCharges',{...authorization,requestId:randomUUID(),loanId:loan.loanId,version:loan.version,interestCategoryId:categoryId,feeCategoryId:categoryId,upfrontChargeDate:'2026-01-01'})
    await api('loans.syncCharges',{requestId:randomUUID(),loanId:loan.loanId})
    const update=await prepareSyntheticUpdate(services,3,randomUUID()),{model,snapshot}=await prepareLocal(services,update.updateId)
    for(const issue of snapshot.facts.issues.filter(row=>row.issueType==='account_mapping'&&row.status==='open'))model.mapAccount({issueId:issue.issueId,decision:'apply_fields',fields:{mappingAccountDraft:{name:'整批新建钱包',type:'wallet',currency:'CNY'}}})
    const ids=[...model.events.keys()],wallet=model.events.get(ids[0]).ledgerAccountId
    model.edit({eventId:ids[0],editorVersion:1,fields:{categoryId,amountMinor:'10000'}})
    model.edit({eventId:ids[1],editorVersion:1,fields:{economicNature:'refund',amountMinor:'4000',occurredLocalAt:'2026-09-02 12:00:00',timezoneOffsetMinutes:-480},decisions:{refund:{mode:'link',kind:'event',id:ids[0],version:model.events.get(ids[0]).version}}})
    const interest=snapshot.facts.charges.find(row=>row.chargeKey==='period:1:interest'),fee=snapshot.facts.charges.find(row=>row.chargeKey==='upfront:fee'),current=snapshot.facts.loans.find(row=>row.loanId===loan.loanId)
    model.edit({eventId:ids[2],editorVersion:1,fields:{economicNature:'repayment',amountMinor:'100000',counterpartyLedgerAccountId:debt},decisions:{repayment:{confirmed:true,mode:'associate',loanId:loan.loanId,loanVersion:current.version,assetAccountId:wallet,liabilityAccountId:debt,principalMinor:'90000',interestMinor:'8000',feeMinor:'2000',interestTreatment:'accrued',feeTreatment:'accrued',chargeAllocations:[{chargeId:interest.chargeId,component:'interest',amountMinor:'8000'},{chargeId:fee.chargeId,component:'fee',amountMinor:'2000'}]}}})
    const request=await stage(services,model.finalState())
    const tables=['accounts','transactions','loans','loan_payments','loan_repayment_details','loan_payment_allocations','loan_payment_transactions','loan_charge_allocations','loan_charges','import_account_mappings','finance_update_account_drafts','finance_update_account_mapping_drafts','finance_updates','economic_events','economic_event_relations','economic_event_transactions','review_issues','review_issue_members','finance_actions','mutation_receipts','users','import_review_objects','import_review_chunks']
    async function dump(){const result={};for(const table of tables){const [rows]=await lab.owner.execute('SELECT * FROM catledger_'+table+' WHERE uid=?',[uid]);result[table]=rows.map(row=>JSON.stringify(row)).sort()}return result}
    const before=await dump()
    for(const [label,pattern]of [['账户创建',/INSERT INTO catledger_accounts\s/],['交易写入',/INSERT INTO catledger_transactions\s/],['退款关系',/INSERT INTO catledger_economic_event_relations\s/],['贷款收费清偿',/INSERT INTO catledger_loan_charge_allocations/],['映射记忆',/INSERT INTO catledger_import_account_mappings/],['临时对象清理',/DELETE FROM catledger_import_review_objects/],['成功回执',/UPDATE catledger_mutation_receipts/]])await t.test(label,async()=>{
      failure=pattern;hits=0
      await assert.rejects(call(services.import,'financeUpdates.post',request),{publicCode:'INTERNAL_ERROR'})
      failure=null;assert.ok(hits>0,'必须真正命中指定写入阶段')
      assert.deepEqual(await dump(),before,label+'不得留下任何正式或草稿部分写入')
    })
    failure=null
    await t.test('贷款版本与收费项变化保留其他决定',async()=>{
      await lab.owner.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      const changed=await call(services.import,'financeUpdates.post',{...request,requestId:randomUUID()})
      assert.equal(changed.outcome,'recheck')
      const fresh=(await download(services,changed.recheck.objectId)).facts
      assert.ok(fresh.problems.some(row=>row.eventIds.includes(ids[2])))
      assert.equal(fresh.loans.find(row=>row.loanId===loan.loanId).version,current.version+1)
      await lab.owner.execute('UPDATE catledger_loans SET version=? WHERE uid=? AND loan_id=?',[current.version,uid,loan.loanId])
      await lab.owner.execute('UPDATE catledger_loan_charges SET historical_settled_minor=amount_minor,version=version+1 WHERE uid=? AND charge_id=?',[uid,interest.chargeId])
      const chargeChanged=await call(services.import,'financeUpdates.post',{...request,requestId:randomUUID()})
      assert.equal(chargeChanged.outcome,'recheck')
      const updated=(await download(services,chargeChanged.recheck.objectId)).facts
      assert.ok(updated.problems.some(row=>row.eventIds.includes(ids[2])))
      assert.equal(updated.charges.find(row=>row.chargeId===interest.chargeId).outstandingMinor,'0')
      await lab.owner.execute('UPDATE catledger_loan_charges SET historical_settled_minor=0,version=? WHERE uid=? AND charge_id=?',[interest.version,uid,interest.chargeId])
    })
    const results=await Promise.all([call(services.import,'financeUpdates.post',request),call(services.import,'financeUpdates.post',request)])
    assert.equal(results[0].status,'posted',JSON.stringify(results[0]));assert.deepEqual(results[1],results[0])
    assert.equal(results[0].posting.createdTransactionCount,3)
    assert.equal((await api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'990000')
    const [[accounts]]=await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid=?',[uid]);assert.equal(Number(accounts.count),2)
  }finally{await lab.close()}
})

test('本地配对：编辑/合并/拆分保留身份，多候选不同笔共用成员，整批一次入账', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants'), apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    for (const ambiguous of [false, true]) await t.test(ambiguous ? '重叠的不同笔决定' : '唯一配对与稳定拆分', async () => {
      const c = await require('./helpers/bank-pairing').setup({ apiPool, importPool, count: 2, ambiguous, bankNature: '消费' })
      const { model } = await prepareLocal(c.services, c.updateId)
      const pairs = [...model.pairs.values()]
      assert.equal(pairs.length, ambiguous ? 4 : 2)
      if (ambiguous) {
        for (const pair of pairs) model.pair({ pairKey: pair.pairKey, decision: 'distinct' })
        assert.equal(model.pairs.size, 0)
      } else {
        const first = pairs[0], bankId = first.bank.eventId, platformId = first.platform.eventId
        model.edit({ eventId: bankId, editorVersion: 1, fields: { note: '合并前银行备注' } })
        model.pair({ pairKey: first.pairKey, decision: 'same' })
        assert.equal(model.events.has(bankId), false)
        model.reviseDuplicate({ eventId: platformId, decision: 'distinct' })
        assert.ok(model.events.has(bankId)); assert.ok(model.events.has(platformId))
        assert.equal(model.events.get(bankId).fieldSources.editorOverrides.note, '合并前银行备注')
        model.reviseDuplicate({ eventId: platformId, otherEventId: bankId, pairKey: first.pairKey, decision: 'same' })
        for (const pair of [...model.pairs.values()]) model.pair({ pairKey: pair.pairKey, decision: 'same' })
      }
      for (const event of model.events.values()) model.edit({ eventId: event.eventId, editorVersion: 1,
        fields: { categoryId: model.facts.categories.find(row => row.kind === 'expense').categoryId } })
      const result = await postLocal(c.services, model)
      assert.equal(result.status, 'posted', JSON.stringify(result.supplement?.problems))
      assert.equal(result.posting.createdTransactionCount, ambiguous ? 4 : 2)
      const [[evidence]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_event_evidence WHERE uid=? AND update_id=?', [c.uid,c.updateId])
      assert.equal(Number(evidence.count), 4)
    })
  } finally { await lab.close() }
})

test('快照外历史退回：冷恢复后使用新请求提交，成功事务清理全部临时对象，原回执仍可重放', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants'), services = localServices({ apiPool: await lab.role('api', grants.api), importPool: await lab.role('import', grants.importer) })
    const user = await call(services.api, 'bootstrap'), account = await call(services.api, 'accounts.create', { requestId: randomUUID(), name: '微信零钱', type: 'wallet' })
    const prepared = await prepareSyntheticUpdate(services, 2, randomUUID())
    const { snapshot } = await prepareLocal(services, prepared.updateId)
    const disk = require('./helpers/local-review').filesystem(); t.after(disk.cleanup)
    const files = require('../miniprogram/packages/finance/services/import-local-files')
    const session = require('../miniprogram/packages/finance/services/import-local-session')
    const options = { ...disk, scope: 'synthetic:' + user.uid, updateId: prepared.updateId }, posts = []
    const callNetwork = async (action, data) => {
      if (action === 'financeUpdates.post') posts.push(structuredClone(data))
      try { return await call(services.import, action, data) }
      catch (error) { error.code = error.publicCode; throw error }
    }
    let store = files.create(options)
    await store.download(snapshot.header, callNetwork)
    const create = () => session.create({ files: store, restored: store.restore(), requestId: randomUUID,
      callNetwork, saveReceipt() {}, cleanup() {}, queueAbandon() {} })
    let current = create()
    const categoryId = snapshot.facts.categories.find(row => row.kind === 'expense').categoryId
    assert.equal(snapshot.facts.history.length, 0)
    const ids = [...current.model.events.keys()]
    current.call('financeUpdates.setReview', { eventId: ids[0], editorVersion: 1, fields: { amountMinor: '200', categoryId, note: '应保留修改' } })
    current.call('financeUpdates.setReview', { eventId: ids[1], editorVersion: 1, fields: { categoryId, note: '不受影响的选择' } })
    assert.equal(current.model.needsCheck.has(ids[0]), true)
    const history = await call(services.api, 'transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: account.accountId,
      amountMinor: '200', categoryId, occurredLocalAt: '2026-09-01T12:00:00', timezoneOffsetMinutes: -480, note: '合成新增历史' })
    const rejected = await current.post()
    assert.equal(rejected.outcome, 'recheck')
    const supplemental = (await download(services, rejected.recheck.objectId)).facts
    assert.ok(supplemental.history.some(row => row.transactionId === history.transactionId))
    const rejectedReceipt = await call(services.import, 'financeUpdates.post', posts[0])
    assert.equal(rejectedReceipt.outcome, 'recheck')
    const [[before]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [user.uid])
    assert.equal(Number(before.count), 1)
    store = files.create(options); current = create()
    assert.equal(current.status.frozen, false)
    await assert.rejects(current.post(), { code: 'LOCAL_RECHECK_REQUIRED' })
    assert.equal(posts.length, 1, '未重核前不能创建或发送下一次提交')
    assert.equal(current.model.choices.events.get(ids[1]).editor.fields.note, '不受影响的选择')
    const issue = supplemental.issues.find(row => row.primaryReasonCode === 'historical_duplicate_candidate')
    assert.deepEqual(issue.subjectEventIds, [ids[0]])
    current.call('reviewIssues.resolve', { issueId: issue.issueId, decision: 'confirm_distinct' })
    assert.equal(current.model.invalid.size, 0)
    // An unused upload and another batch must not change cleanup scope.
    const unused = await stage(services, current.model.finalState())
    const other = await prepareSyntheticUpdate(services, 1, randomUUID())
    const otherSnapshot = await prepareLocal(services, other.updateId)
    const posted = await current.post()
    assert.equal(posted.status, 'posted')
    assert.equal(posts.length, 2)
    assert.notEqual(posts[1].requestId, posts[0].requestId)
    assert.notEqual(posts[1].uploadId, posts[0].uploadId)
    assert.notEqual(posts[1].payloadDigest, posts[0].payloadDigest)
    const objectIds = [snapshot.header.objectId, rejected.recheck.objectId, unused.uploadId, ...posts.map(row => row.uploadId)]
    const [[remaining]] = await lab.owner.execute(`SELECT
      (SELECT COUNT(*) FROM catledger_import_review_objects WHERE uid=? AND update_id=?) AS objects,
      (SELECT COUNT(*) FROM catledger_import_review_chunks WHERE uid=? AND object_id IN (${objectIds.map(() => '?').join(',')})) AS chunks`,
    [user.uid, prepared.updateId, user.uid, ...objectIds])
    assert.equal(Number(remaining.objects), 0)
    assert.equal(Number(remaining.chunks), 0)
    assert.deepEqual(await call(services.import, 'financeUpdates.post', posts[0]), rejectedReceipt)
    assert.deepEqual(await call(services.import, 'financeUpdates.post', posts[1]), posted)
    assert.deepEqual(await call(services.import, 'imports.commandResult', { requestId: posts[1].requestId, commandAction: 'financeUpdates.post' }), posted)
    await assert.rejects(download(services, snapshot.header.objectId), { publicCode: 'SNAPSHOT_INCOMPLETE' })
    assert.equal((await download(services, otherSnapshot.snapshot.header.objectId)).facts.events.length, 1)
    const [[after]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [user.uid])
    assert.equal(Number(after.count), 3)
  } finally { await lab.close() }
})

test('本地最终决定一次原子入账，成功回执原样重放且不同内容拒绝', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async () => {
  const lab = await isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const services = localServices({ apiPool: await lab.role('api', grants.api), importPool: await lab.role('import', grants.importer) })
    const identity = await call(services.api, 'bootstrap')
    const update = await prepareSyntheticUpdate(services, 3, randomUUID())
    const prepare = { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion }
    const prepared = await call(services.import, 'financeUpdates.prepareSnapshot', prepare)
    assert.deepEqual(await call(services.import, 'financeUpdates.prepareSnapshot', prepare), prepared)
    const snapshot = await download(services, prepared.snapshot.objectId), state = finalState(snapshot)
    const sourceIds = ids => snapshot.facts.evidence.filter(row => ids.includes(row.eventId)).map(row => row.rowId)
    for (const issue of snapshot.facts.issues.filter(row => row.issueType === 'account_mapping' && row.status === 'open')) {
      state.decisions.accounts.push({ key: issue.issueId, issueId: issue.issueId, reasonCode: issue.primaryReasonCode,
        eventIds: issue.subjectEventIds, sourceIds: sourceIds(issue.subjectEventIds), decision: 'apply_fields',
        fields: { mappingAccountDraft: { name: '本地核对钱包', type: 'wallet', currency: 'CNY' } } })
    }
    const local = require('../miniprogram/packages/finance/services/import-local-model').create(snapshot.facts)
    for (const choice of state.decisions.accounts) local.mapAccount(choice)
    const category = snapshot.facts.categories.find(row => row.kind === 'expense')
    for (const event of snapshot.facts.events) state.decisions.events.push({ key: event.eventId, eventId: event.eventId,
      sourceIds: sourceIds([event.eventId]), editor: { editorVersion: 1, fields: { categoryId: category.categoryId, note: '本地决定' } } })
    for (const choice of state.decisions.events) local.edit({ eventId: choice.eventId, ...choice.editor })
    assert.equal(require('../miniprogram/packages/finance/services/import-local-read').create(local).summary().coverage.selectedEventsReadyToPost, true)
    const request = await stage(services, local.finalState())
    const posted = await call(services.import, 'financeUpdates.post', request)
    if (posted.outcome === 'recheck') assert.fail(JSON.stringify((await download(services, posted.recheck.objectId)).facts.problems))
    assert.equal(posted.status, 'posted')
    assert.equal(posted.posting.createdTransactionCount, 3)
    assert.deepEqual(await call(services.import, 'financeUpdates.post', request), posted)
    await assert.rejects(call(services.import, 'financeUpdates.post', { ...request, payloadDigest: '0'.repeat(64) }), { publicCode: 'IDEMPOTENCY_CONFLICT' })
    const [[counts]] = await lab.owner.execute(`SELECT (SELECT COUNT(*) FROM catledger_transactions WHERE uid=?) AS transactions,
      (SELECT COUNT(*) FROM catledger_accounts WHERE uid=?) AS accounts`, [identity.uid, identity.uid])
    assert.equal(Number(counts.transactions), 3); assert.equal(Number(counts.accounts), 1)
  } finally { await lab.close() }
})
