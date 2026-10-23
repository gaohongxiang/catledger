const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, randomBytes } = require('node:crypto')
const { queries, queryBodies, main } = require('../scripts/audit-historical-rule-impact')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const { chargeLab } = require('./helpers/loan-charges')
const skip = !process.env.CATLEDGER_TEST_DB_HOST
const digest = () => randomBytes(32).toString('hex')
const count = (rows, classification, postingState) => rows.filter(row => row.classification === classification && (!postingState || row.posting_state === postingState))
  .reduce((sum,row) => sum + Number(row.record_count),0)
function privateOutput(rows, forbidden) {
  const text = JSON.stringify(rows)
  for(const value of forbidden) assert.ok(!text.includes(value),'聚合结果不能返回合成身份/账户/事件/交易标识')
  for(const row of rows) for(const [key,value] of Object.entries(row)) {
    if(['classification','posting_state'].includes(key)) assert.match(value,/^[a-z_]+$/)
    else assert.match(String(value),/^\d+$/)
  }
}
async function readOnly(pool,sql) {
  const c = await pool.getConnection()
  try {
    await c.query('START TRANSACTION READ ONLY')
    return (await c.query(sql))[0]
  } finally { await c.rollback(); c.release() }
}
async function action(pool,uid,updateId,eventId,accountId,actionId=randomUUID()) {
  await pool.execute(`INSERT INTO catledger_finance_actions
    (uid,action_id,update_id,expected_update_version,applied_update_version,action_type,idempotency_key_digest,request_digest,status,decision_json,reason_codes_json)
    VALUES(?,?,?,1,2,'set_event_review',?,?,'applied',?,'[]')`,
  [uid,actionId,updateId,digest(),digest(),JSON.stringify({eventId,fields:{counterpartyLedgerAccountId:accountId}})])
  return actionId
}

test('历史清点只生成固定只读查询，拒绝 SQL/身份/执行参数', () => {
  for(const [name,sql] of Object.entries(queries)) {
    assert.equal(main(['--sql',name]),sql+'\n')
    assert.match(sql,/^SELECT \/\*\+ MAX_EXECUTION_TIME\(30000\) \*\/ \* FROM \(\nWITH /)
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|CALL|PREPARE|EXECUTE|OUTFILE|DUMPFILE)\b/i)
    assert.equal((sql.match(/;/g)||[]).length,1)
  }
  for(const args of [[],['--sql','SELECT 1'],['--sql','candidate-account','--uid','synthetic'],['--execute'],['--sql','upfront-fee; DELETE']]) assert.throws(()=>main(args))
  assert.match(main(['--describe']),/零候选不能证明历史从未受影响/)
})

test('历史归户清点区分不完整自动候选、完整候选、人工决定、版本及跨用户未知证据', {skip,timeout:120000}, async () => {
  const lab = await isolatedMysql()
  try {
    const services = localServices({apiPool:lab.owner,importPool:lab.owner,subject:'synthetic-inventory-'+randomUUID()})
    const {uid} = await call(services.api,'bootstrap')
    let accountNumber=0
    const makeAccount = type => call(services.api,'accounts.create',{requestId:randomUUID(),type,name:'合成清点账户'+(++accountNumber)})
    const {accountId:a} = await makeAccount('credit'),{accountId:b} = await makeAccount('credit'),{accountId:asset} = await makeAccount('bank')
    const update = await prepareSyntheticUpdate(services,12,'SYNTHETIC-INVENTORY-'+randomUUID())
    const [events] = await lab.owner.execute('SELECT event_id AS id FROM catledger_economic_events WHERE uid=? AND update_id=? ORDER BY event_id',[uid,update.updateId])
    assert.equal(events.length,12)
    const other = localServices({apiPool:lab.owner,importPool:lab.owner,subject:'synthetic-inventory-other-'+randomUUID()})
    const {uid:otherUid} = await call(other.api,'bootstrap')
    const {accountId:foreign} = await call(other.api,'accounts.create',{requestId:randomUUID(),type:'credit',name:'合成另一用户账户'})
    const otherUpdate = await prepareSyntheticUpdate(other,1,'SYNTHETIC-INVENTORY-OTHER')
    const manualId = await action(lab.owner,uid,update.updateId,events[7].id,a)
    const foreignActionId = await action(lab.owner,otherUid,otherUpdate.updateId,events[8].id,a)
    const cases = [
      {ids:[a,null]}, {ids:[a,a]}, {ids:[a,b]}, {ids:[]}, {ids:[a,null],version:'source-funds-v9'},
      {ids:[a,null],version:'unknown'}, {ids:[a,null],target:b},
      {ids:[a,null],mask:2,extra:{lastUserActionId:manualId}},
      {ids:[a,null],mask:2,extra:{lastUserActionId:foreignActionId}},
      {ids:[foreign,null]}, {ids:[null,null],resolved:null,target:null}, {ids:{bad:true}}
    ]
    for(const [index,item] of cases.entries()) {
      const candidates = Array.isArray(item.ids) ? item.ids.map(accountId=>({accountId})) : item.ids
      const fields = {...item.extra,fundsProjection:{ruleVersion:item.version||'source-funds-v8',to:{referenceKind:'aggregate',
        resolvedAccountId:Object.hasOwn(item,'resolved')?item.resolved:a,candidates}}}
      await lab.owner.execute("UPDATE catledger_economic_events SET economic_nature='repayment',counterparty_ledger_account_id=?,manual_field_mask=?,field_sources_json=? WHERE uid=? AND event_id=?",
        [Object.hasOwn(item,'target')?item.target:a,item.mask||0,JSON.stringify(fields),uid,events[index].id])
    }
    const transfer = () => call(services.api,'transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:asset,destinationAccountId:a,
      amountMinor:'100',occurredLocalAt:'2026-01-01T12:00:00',timezoneOffsetMinutes:-480})
    const live = await transfer(),deleted = await transfer()
    for(const [eventId,transactionId] of [[events[0].id,live.transactionId],[events[2].id,deleted.transactionId]]) await lab.owner.execute(`INSERT INTO catledger_economic_event_transactions
      (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version)
      VALUES(?,?,?,?,?,'primary','created','synthetic-old',1)`,[uid,randomUUID(),update.updateId,eventId,transactionId])
    await lab.owner.execute('UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND transaction_id=?',[uid,deleted.transactionId])
    await lab.owner.execute("UPDATE catledger_finance_updates SET status='posted' WHERE uid=? AND update_id=?",[uid,update.updateId])
    const [[pre]] = await lab.owner.query(queries.preflight)
    assert.equal(Number(pre.schema_ready),1)
    const numericFields=row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)]))
    assert.deepEqual(numericFields((await readOnly(lab.owner,queryBodies.preflight))[0]),numericFields(pre))
    const rows = await readOnly(lab.owner,queries['candidate-account'])
    assert.deepEqual(rows,await readOnly(lab.owner,queryBodies['candidate-account']),'SELECT 包装必须与原 CTE 聚合结果一致')
    assert.equal(count(rows,'candidate_old_partial_resolution','linked_live_transactions'),1)
    assert.equal(count(rows,'candidate_old_stale_resolution','only_deleted_or_superseded_links'),1)
    for(const category of ['complete_same_account_candidates','explicit_manual_target','manual_trace_requires_review','current_rule_projection',
      'unknown_rule_version','target_differs_from_projection','unverifiable_account_reference','no_single_account_conclusion']) assert.equal(count(rows,category),1,category)
    assert.equal(count(rows,'missing_candidate_evidence'),2)
    assert.equal(count(rows,'coverage_all_events'),13)
    privateOutput(rows,[uid,otherUid,a,b,foreign,manualId,...events.map(row=>row.id),live.transactionId])
    // 数据字典不匹配必须明确失败，不能把未知 schema 当作零影响。
    await lab.owner.query('ALTER TABLE catledger_economic_events RENAME COLUMN field_sources_json TO synthetic_missing_fields')
    try {
      const [[drift]] = await lab.owner.query(queries.preflight)
      assert.equal(Number(drift.schema_ready),0);assert.equal(Number(drift.missing_column_count),1)
      await assert.rejects(lab.owner.query(queries['candidate-account']),{code:'ER_BAD_FIELD_ERROR'})
    } finally { await lab.owner.query('ALTER TABLE catledger_economic_events RENAME COLUMN synthetic_missing_fields TO field_sources_json') }
  } finally { await lab.close() }
})

async function legacyUpfront(h,{audit=true,periodNumber=null}={}) {
  const loan = await h.create({feeUpfrontMinor:'10000',baselinePrincipalMinor:'550000',repayments:[{periodNumber:1,paid:true}]})
  const {contract} = await h.state(loan),chargeId=randomUUID(),adjustmentId=randomUUID()
  const expense = await h.expense('2026-01-31','10000')
  await h.owner.execute("UPDATE catledger_transactions SET origin='loan_plan' WHERE uid=? AND transaction_id=?",[h.uid,expense.transactionId])
  await h.owner.execute(`INSERT INTO catledger_transactions(uid,transaction_id,type,destination_account_id,amount_minor,
    occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin)
    VALUES(?,?,'balance_adjustment',?,10000,'2026-01-31','2026-01-31 12:00:00',-480,'2026-01-31 04:00:00','合成历史余额保全','system')`,[h.uid,adjustmentId,h.accountId])
  await h.owner.execute(`INSERT INTO catledger_loan_charges(uid,charge_id,contract_id,charge_key,component,charge_date,amount_minor,
    category_id,state,basis,transaction_id,balance_adjustment_id,historical_settled_minor)
    VALUES(?,?,?,'upfront:fee','fee','2026-01-31',10000,?,'recorded','manual',?,?,10000)`,[h.uid,chargeId,contract.contractId,h.categoryId,expense.transactionId,adjustmentId])
  if(audit) {
    await chargeAudit(h,contract.contractId,chargeId,'confirm_historical_paid',{periodNumber,transactionId:expense.transactionId,balanceAdjustmentId:adjustmentId})
    await chargeAudit(h,contract.contractId,chargeId,'confirm_settlement',{periodNumber:1,amountMinor:'10000',chargeVersion:2})
  }
  return {loan,contractId:contract.contractId,chargeId,transactionId:expense.transactionId,adjustmentId}
}
async function chargeAudit(h,contractId,chargeId,action,snapshot) {
  await h.owner.execute('INSERT INTO catledger_loan_charge_audit(uid,audit_id,contract_id,charge_id,action,snapshot_json) VALUES(?,?,?,?,?,?)',
    [h.uid,randomUUID(),contractId,chargeId,action,JSON.stringify(snapshot)])
}

test('一次费清点保留旧递归/null审计，区分实际认领、授权计划、撤回、覆盖和未知', {skip,timeout:120000}, async () => {
  const h = await chargeLab()
  try {
    const legacy = await legacyUpfront(h),unknown = await legacyUpfront(h,{audit:false}),wrongShape = await legacyUpfront(h,{periodNumber:1})
    const removed = await legacyUpfront(h)
    await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:removed.loan.loanId,version:1,repayments:[{periodNumber:1,paid:false}]})
    const authorizedLoan = await h.create({feeUpfrontMinor:'10000'})
    await h.configure(authorizedLoan,{upfrontChargeDate:'2026-01-15'})
    await h.sync(authorizedLoan)
    const actualLoan = await h.create({feeUpfrontMinor:'10000'}),actual = await h.expense('2026-01-15','10000')
    await h.configure(actualLoan,{upfrontChargeDate:'2026-01-15',coverage:[{chargeKey:'upfront:fee',transactionId:actual.transactionId}]})
    const coveredLoan = await h.create({feeUpfrontMinor:'10000'}),coverTx = await h.expense('2026-01-15','10000')
    await h.api('loans.confirmInstallments',{requestId:randomUUID(),loanId:coveredLoan.loanId,version:1,repayments:[{periodNumber:1,paid:true}],
      oneOffCharges:[{key:'synthetic-cover',component:'fee',chargeDate:'2026-01-15',amountMinor:'10000',transactionId:coverTx.transactionId,transactionVersion:1,covers:['upfront:fee']}]})
    let rows = await readOnly(h.owner,queries['upfront-fee'])
    assert.deepEqual(rows,await readOnly(h.owner,queryBodies['upfront-fee']),'费用查询包装前后证据分类一致')
    assert.equal(count(rows,'candidate_legacy_first_period_generated','recorded_expense'),1)
    assert.equal(count(rows,'candidate_legacy_first_period_generated','no_current_recorded_expense'),1)
    assert.equal(count(rows,'missing_audit_evidence'),1)
    assert.equal(count(rows,'other_or_incomplete_evidence'),1,'periodNumber=1 不能冒充旧递归 null 审计')
    assert.equal(count(rows,'authorized_plan_accrual'),1)
    assert.equal(count(rows,'explicit_actual_claim','recorded_expense'),1)
    assert.equal(count(rows,'explicit_actual_claim','covered_by_expense'),1)
    assert.equal(count(rows,'coverage_all_upfront_fees'),7)
    const removedRow=rows.find(row=>row.classification==='candidate_legacy_first_period_generated'&&row.posting_state==='no_current_recorded_expense')
    assert.equal(Number(removedRow.withdrawal_trace_count),1)
    // 后续明确认领、付款和退款独立于历史自动生成证据；不可据候选删掉后续关系。
    await h.owner.execute("UPDATE catledger_loan_charges SET basis='actual' WHERE uid=? AND charge_id=?",[h.uid,legacy.chargeId])
    await chargeAudit(h,legacy.contractId,legacy.chargeId,'adopt_historical_fee',{transactionId:legacy.transactionId,transactionVersion:1,chargeKey:'upfront:fee'})
    await h.owner.execute(`INSERT INTO catledger_transactions(uid,transaction_id,type,destination_account_id,amount_minor,original_transaction_id,
      occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin)
      VALUES(?,?,'refund',?,100,?,'2026-02-01','2026-02-01 12:00:00',-480,'2026-02-01 04:00:00','合成退款','manual')`,[h.uid,randomUUID(),h.assetAccountId,legacy.transactionId])
    const paymentId=randomUUID()
    await h.owner.execute(`INSERT INTO catledger_loan_payments(uid,payment_id,kind,origin_mode,asset_account_id,total_minor,occurred_local_at,occurred_at_utc,timezone_offset_minutes)
      VALUES(?,?,'repayment','new',?,100,'2026-02-01 12:00:00','2026-02-01 04:00:00',-480)`,[h.uid,paymentId,h.assetAccountId])
    await h.owner.execute('INSERT INTO catledger_loan_charge_allocations(uid,payment_id,charge_id,amount_minor) VALUES(?,?,?,100)',[h.uid,paymentId,legacy.chargeId])
    rows = await readOnly(h.owner,queries['upfront-fee'])
    const actualRow=rows.find(row=>row.classification==='explicit_actual_claim'&&row.posting_state==='recorded_expense')
    assert.equal(Number(actualRow.record_count),2)
    assert.equal(Number(actualRow.legacy_generated_count),1)
    assert.equal(Number(actualRow.with_active_payment_count),1)
    assert.equal(Number(actualRow.with_live_refund_count),1)
    privateOutput(rows,[h.uid,h.accountId,legacy.chargeId,unknown.transactionId,wrongShape.adjustmentId,paymentId,coverTx.transactionId])
    // 决定中保存交易 ID 仍不足以确认实际关系：费用与当前交易金额/账户也必须一致。
    await h.owner.execute('UPDATE catledger_transactions SET amount_minor=9999 WHERE uid=? AND transaction_id=?',[h.uid,actual.transactionId])
    const mismatched=await readOnly(h.owner,queries['upfront-fee'])
    assert.equal(count(mismatched,'actual_basis_without_complete_evidence'),1)
    assert.equal(count(mismatched,'explicit_actual_claim','recorded_expense'),1)
  } finally { await h.close() }
})
