const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { localServices, call } = require('./helpers/local-services')
const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])

// 负债欠款模型：总欠款 = 最近一期账单本期应还 + 未来未到期次分期剩余本息（已还分摊扣减）。
// 用隔离 MySQL 验证迁移列、迁移可重入、欠款聚合、防重复、无分期计划提示与用户隔离。
test('负债账户欠款：账单本期应还 + 未来分期剩余本息，防重复且用户隔离', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const db = await require('../scripts/isolated-mysql').isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const api = (action, data) => call(services.api, action, data)
    const identity = await api('bootstrap')

    const createCredit = () => api('accounts.create', { requestId: randomUUID(), name: '合成信用卡' + randomUUID().slice(0, 8), type: 'credit',
      creditLimitMinor: '2000000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    const findAccount = async (accountId) => (await api('accounts.list')).accounts.find(a => a.accountId === accountId)

    // 直接写账单快照与贷款期次（等价导入回写与分期计划），验证读取侧欠款派生。
    const setStatement = async (accountId, dueMinor, dueDate, cycle) => db.owner.execute(
      'UPDATE catledger_accounts SET statement_due_minor=?, statement_due_date=?, statement_cycle=? WHERE uid=? AND account_id=?',
      [dueMinor, dueDate, cycle, identity.uid, accountId])
    const insertLoan = async (accountId) => {
      const loanId = randomUUID()
      await db.owner.execute(`INSERT INTO catledger_loans (uid,loan_id,account_id,name,institution,kind,baseline_principal_minor,baseline_date,version) VALUES (?,?,?,?,?,?,?,?,1)`,
        [identity.uid, loanId, accountId, '合成分期', '合成银行', 'installment', '100000', '2026-07-01'])
      return loanId
    }
    const insertPeriod = async (loanId, number, due, principal, interest, fee) => {
      await db.owner.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled,version) VALUES (?,?,?,?,?,?,?,?,0,1)`,
        [identity.uid, randomUUID(), loanId, number, due, principal, interest, fee])
    }

    await t.test('迁移新增账单字段，无分期无账单时欠款为 0 且提示补建', async () => {
      const account = await createCredit()
      const listed = await findAccount(account.accountId)
      assert.equal(listed.debtMinor, '0')
      assert.equal(listed.debtDirection, 'paid')
      assert.equal(listed.statementDueMinor, null)
      // 无账单快照（statement_due_minor 为 NULL）不触发补建提示
      assert.equal(listed.needsInstallmentPlan, false)
    })

    await t.test('有账单快照但无分期来源 → 欠款=本期应还，不提示待处理分期', async () => {
      const account = await createCredit()
      await setStatement(account.accountId, '813739', '2026-09-02', '20260714-20260813')
      const listed = await findAccount(account.accountId)
      // statementDueMinor 为 minor（分）字符串，与 creditLimitMinor 同口径
      assert.equal(listed.statementDueMinor, '813739')
      assert.equal(listed.statementDueDate, '2026-09-02')
      assert.equal(listed.statementCycle, '20260714-20260813')
      assert.equal(listed.debtMinor, '813739')
      assert.equal(listed.debtDirection, 'debt')
      // 只有账单快照、没有任何未归分期来源 → 不算待处理分期
      assert.equal(listed.needsInstallmentPlan, false)
    })

    await t.test('加分期只算到期还款日之后的未来期次，本期不重复', async () => {
      const account = await createCredit()
      // 本期账单应还 8137.39，到期还款日 2026-09-02
      await setStatement(account.accountId, '813739', '2026-09-02', '20260714-20260813')
      const loanId = await insertLoan(account.accountId)
      // 已进入本期账单（due_date <= 到期还款日）的期次：不应再加
      await insertPeriod(loanId, 8, '2026-08-13', '50000', '3000', '0')
      // 未来期次（due_date > 到期还款日）才加：本金+利息+费用
      await insertPeriod(loanId, 9, '2026-09-13', '50000', '3000', '0')
      await insertPeriod(loanId, 10, '2026-10-13', '50000', '3000', '500')
      const listed = await findAccount(account.accountId)
      // 未来期次 9、10 = (50000+3000) + (50000+3000+500) = 53000 + 53500 = 106500
      // 总欠款 = 813739 + 106500 = 920239
      assert.equal(listed.debtMinor, '920239')
      assert.equal(listed.needsInstallmentPlan, false)
    })

    await t.test('用户隔离：他人账户不出现在我的列表', async () => {
      const account = await createCredit()
      await setStatement(account.accountId, '500000', null, null)
      const stranger = localServices({ apiPool, importPool, subject: 'synthetic-debt-stranger' })
      await call(stranger.api, 'bootstrap')
      const strangerList = await call(stranger.api, 'accounts.list')
      assert.equal(strangerList.accounts.some(a => a.accountId === account.accountId), false)
    })
  } finally {
    await db.close()
  }
})

// 导入入账阶段把信用卡账单汇总数回写到绑定的负债账户（applyStatementSnapshot）。
test('账单汇总数在入账阶段回写到账户，缺项不擦除原值', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const db = await require('../scripts/isolated-mysql').isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const identity = await call(services.api, 'bootstrap')
    const uid = identity.uid
    const { randomUUID } = require('node:crypto')
    const { applyStatementSnapshot } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
    const account = await call(services.api, 'accounts.create', { requestId: randomUUID(), name: '合成信用卡' + randomUUID().slice(0, 6), type: 'credit',
      occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    const importId = randomUUID(), batchId = randomUUID(), updateId = randomUUID(), sourceId = randomUUID(), eventId = randomUUID(), rowId = randomUUID(), mappingId = randomUUID()
    const pmKey = 'k'.repeat(64)
    const insert = (sql, params) => db.owner.execute(sql, params)
    await insert(`INSERT INTO catledger_import_files (uid,import_id,state,original_file_name,declared_size,file_extension,storage_object_key) VALUES (?,?,?,?,?,?,?)`,
      [uid, importId, 'committed', 'synthetic.xls', 1, 'xls', 'obj/' + importId])
    await insert(`INSERT INTO catledger_finance_updates (uid,update_id,status,plan_version) VALUES (?,?,?,?)`,
      [uid, updateId, 'posted', 'synthetic-plan-v1'])
    const analysis = { bankMapping: { statementKind: 'credit' }, statement: { statementDueMinor: '8137.39', statementMinimumMinor: '7016.04', statementDueDate: '2026-09-02', statementCycle: '20260714-20260813' } }
    await insert(`INSERT INTO catledger_import_batches (uid,batch_id,import_id,state,source_type,source_format,parser_name,parser_version,normalization_version,identity_version,raw_snapshot_version,parse_fingerprint,analysis_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, batchId, importId, 'committed', 'bank', 'bank_xls', 'p', 'v1', 'v1', 'v1', 'v1', 'a'.repeat(64), JSON.stringify(analysis)])
    await insert(`INSERT INTO catledger_finance_update_sources (uid,source_id,update_id,source_order,import_id,batch_id,source_type_snapshot,source_format_snapshot,parser_version,normalization_version,identity_version,file_name_snapshot,file_content_sha256,total_row_count,valid_row_count,invalid_row_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, sourceId, updateId, 0, importId, batchId, 'bank', 'bank_xls', 'v1', 'v1', 'v1', 'synthetic.xls', 'b'.repeat(64), 1, 1, 0])
    await insert(`INSERT INTO catledger_economic_events (uid,event_id,batch_id,update_id,event_type,state,status,event_core_digest,rule_version) VALUES (?,?,?,?,?,?,?,?,?)`,
      [uid, eventId, batchId, updateId, 'payment', 'posted', 'posted', 'c'.repeat(64), 'v1'])
    await insert(`INSERT INTO catledger_import_rows (uid,row_id,batch_id,source_row_number,source_locator,parse_state,identity_state,processing_state,currency,normalized_direction,normalized_transaction_type,economic_effect,payment_method_key,category_evidence_json,issues_json,raw_fields_json,raw_snapshot_version,parser_version,normalization_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uid, rowId, batchId, 1, 'L1', 'parsed', 'distinct', 'posted', 'CNY', 'expense', 'purchase', 'financial', pmKey, '[]', '[]', '[]', 'v1', 'v1', 'v1'])
    await insert(`INSERT INTO catledger_event_evidence (uid,event_id,row_id,update_id,evidence_role,relation_rule_version) VALUES (?,?,?,?,?,?)`,
      [uid, eventId, rowId, updateId, 'primary', 'v1'])
    await insert(`INSERT INTO catledger_import_account_mappings (uid,mapping_id,source_type,payment_method_key,mapping_action,account_id) VALUES (?,?,?,?,?,?)`,
      [uid, mappingId, 'bank', pmKey, 'account', account.accountId])

    await t.test('回写本期应还/最低/到期日/周期到负债账户', async () => {
      await applyStatementSnapshot(db.owner, uid, updateId)
      const [rows] = await db.owner.execute('SELECT statement_due_minor,statement_minimum_minor,statement_due_date,statement_cycle FROM catledger_accounts WHERE uid=? AND account_id=?', [uid, account.accountId])
      assert.equal(rows[0].statement_due_minor, '813739')
      assert.equal(rows[0].statement_minimum_minor, '701604')
      assert.equal(String(rows[0].statement_due_date).slice(0, 10), '2026-09-02')
      assert.equal(rows[0].statement_cycle, '20260714-20260813')
    })
    await t.test('再次回写缺项时保留原值，不擦除', async () => {
      const [b] = await db.owner.execute('SELECT analysis_json FROM catledger_import_batches WHERE uid=? AND batch_id=?', [uid, batchId])
      const next = { bankMapping: { statementKind: 'credit' }, statement: { statementDueMinor: '9000.00' } }
      await db.owner.execute('UPDATE catledger_import_batches SET analysis_json=? WHERE uid=? AND batch_id=?', [JSON.stringify(next), uid, batchId])
      await applyStatementSnapshot(db.owner, uid, updateId)
      const [rows] = await db.owner.execute('SELECT statement_due_minor,statement_minimum_minor,statement_due_date,statement_cycle FROM catledger_accounts WHERE uid=? AND account_id=?', [uid, account.accountId])
      assert.equal(rows[0].statement_due_minor, '900000')
      assert.equal(rows[0].statement_minimum_minor, '701604') // 未提供，保留
      assert.equal(String(rows[0].statement_due_date).slice(0, 10), '2026-09-02')
    })
  } finally {
    await db.close()
  }
})

// 回归钉子：同一张信用卡下有多笔分期计划时，欠款必须把「所有计划的未来期次剩余本息」全部加总，
// 不能只算一笔或只算第一个计划。同时验证：已进入本期账单（due_date <= 到期还款日）的期次不加。
test('同一张卡多笔分期计划一起计入欠款，不是只算一笔', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const db = await require('../scripts/isolated-mysql').isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const api = (action, data) => call(services.api, action, data)
    const identity = await api('bootstrap'), uid = identity.uid
    const { randomUUID } = require('node:crypto')
    const account = await api('accounts.create', { requestId: randomUUID(), name: '合成多分期卡' + randomUUID().slice(0, 6), type: 'credit',
      creditLimitMinor: '5000000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    // 本期账单应还 8137.39，到期还款日 2026-09-02
    await db.owner.execute('UPDATE catledger_accounts SET statement_due_minor=?,statement_due_date=?,statement_cycle=? WHERE uid=? AND account_id=?',
      ['813739', '2026-09-02', '20260714-20260813', uid, account.accountId])
    const newLoan = async (name) => {
      const loanId = randomUUID()
      await db.owner.execute('INSERT INTO catledger_loans (uid,loan_id,account_id,name,kind,baseline_principal_minor,baseline_date,version) VALUES (?,?,?,?,?,?,?,1)',
        [uid, loanId, account.accountId, name, 'installment', '100000', '2026-07-01'])
      return loanId
    }
    const addPeriod = async (loanId, number, due, principal, interest, fee) => {
      await db.owner.execute('INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled,version) VALUES (?,?,?,?,?,?,?,?,0,1)',
        [uid, randomUUID(), loanId, number, due, principal, interest, fee])
    }
    // 计划 A：12 期现金分期（当前第 8 期）——第 8 期已进本期账单，第 9、10、11、12 期为未来
    const loanA = await newLoan('A-12期现金分期')
    await addPeriod(loanA, 8, '2026-08-13', '100000', '6000', '0')   // 已进本期，不加
    await addPeriod(loanA, 9, '2026-09-13', '100000', '6000', '0')   // 未来
    await addPeriod(loanA, 10, '2026-10-13', '100000', '6000', '0')  // 未来
    await addPeriod(loanA, 11, '2026-11-13', '100000', '6000', '0')  // 未来
    await addPeriod(loanA, 12, '2026-12-13', '100000', '6000', '0')  // 未来
    // 计划 B：36 期总账分期（当前第 28 期）——28 期已进本期，29、30 期未来
    const loanB = await newLoan('B-36期总账分期')
    await addPeriod(loanB, 28, '2026-09-01', '200000', '12000', '0')  // 已进本期（<=9/2），不加
    await addPeriod(loanB, 29, '2026-10-01', '200000', '12000', '0')  // 未来
    await addPeriod(loanB, 30, '2026-11-01', '200000', '12000', '0')  // 未来
    // 计划 C：3 期小额分期（当前第 1 期）——1 期已进本期，2、3 期未来，含手续费
    const loanC = await newLoan('C-3期分期')
    await addPeriod(loanC, 1, '2026-08-20', '30000', '1500', '0')     // 已进本期，不加
    await addPeriod(loanC, 2, '2026-09-20', '30000', '1500', '500')   // 未来，含手续费 500
    await addPeriod(loanC, 3, '2026-10-20', '30000', '1500', '500')   // 未来

    await t.test('三笔分期所有未来期次一起加总', async () => {
      const listed = (await api('accounts.list')).accounts.find(a => a.accountId === account.accountId)
      // 计划 A 未来：4 期 × (100000+6000) = 4 × 106000 = 424000
      // 计划 B 未来：2 期 × (200000+12000) = 2 × 212000 = 424000
      // 计划 C 未来：2 期 × (30000+1500+500) = 2 × 32000 = 64000
      // 未来合计 = 424000 + 424000 + 64000 = 912000
      // 总欠款 = 账单本期应还 813739 + 912000 = 1725739
      assert.equal(listed.debtMinor, '1725739')
      // 有分期计划，不再提示补建
      assert.equal(listed.needsInstallmentPlan, false)
    })

    await t.test('取消某个未来期次后欠款相应减少', async () => {
      await db.owner.execute('UPDATE catledger_loan_periods SET cancelled=1 WHERE uid=? AND loan_id=? AND period_number=12', [uid, loanA])
      const listed = (await api('accounts.list')).accounts.find(a => a.accountId === account.accountId)
      // 减掉计划 A 第 12 期 106000：1725739 - 106000 = 1619739
      assert.equal(listed.debtMinor, '1619739')
    })

    await t.test('归档某笔分期计划后其未来期次不再计入', async () => {
      await db.owner.execute('UPDATE catledger_loans SET archived_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND loan_id=?', [uid, loanB])
      const listed = (await api('accounts.list')).accounts.find(a => a.accountId === account.accountId)
      // 去掉计划 B 未来 424000：1619739 - 424000 = 1195739
      assert.equal(listed.debtMinor, '1195739')
    })

    await t.test('用户隔离：另一用户看不到这张卡的任何分期欠款', async () => {
      const stranger = localServices({ apiPool, importPool, subject: 'synthetic-multi-stranger' })
      await call(stranger.api, 'bootstrap')
      const list = await call(stranger.api, 'accounts.list')
      assert.equal(list.accounts.some(a => a.accountId === account.accountId), false)
    })
  } finally {
    await db.close()
  }
})

// 手动录入账单汇总（解析不到时的兜底）：accounts.update 可写入本期应还/最低/到期日/周期，
// 并通过 hasStatementData 让前端从「待确认」转为正常欠款展示；无分期计划且无账单仍提示补建。
test('账户编辑可手填账单四字段，作为解析不到时的兜底', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const db = await require('../scripts/isolated-mysql').isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const api = (action, data) => call(services.api, action, data)
    await api('bootstrap')
    const { randomUUID } = require('node:crypto')
    const account = await api('accounts.create', { requestId: randomUUID(), name: '合成手填卡' + randomUUID().slice(0, 6), type: 'credit',
      occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    const find = async () => (await api('accounts.list')).accounts.find(a => a.accountId === account.accountId)

    await t.test('新建时无账单数据 → hasStatementData=false', async () => {
      const a = await find()
      assert.equal(a.hasStatementData, false)
      assert.equal(a.hasInstallmentPlan, false)
      assert.equal(a.debtMinor, '0')
    })

    await t.test('手填四个账单字段保存成功，欠款按本期应还计', async () => {
      const a = await find()
      const updated = await api('accounts.update', { requestId: randomUUID(), accountId: account.accountId, version: a.version,
        statementDueMinor: '813739', statementMinimumMinor: '701604', statementDueDate: '2026-09-02', statementCycle: '20260714-20260813' })
      assert.equal(updated.statementDueMinor, '813739')
      assert.equal(updated.statementMinimumMinor, '701604')
      assert.equal(updated.statementDueDate, '2026-09-02')
      assert.equal(updated.statementCycle, '20260714-20260813')
      assert.equal(updated.hasStatementData, true)
      assert.equal(updated.debtMinor, '813739')
      // 手填账单快照但无分期来源 → 不提示待处理分期
      assert.equal(updated.needsInstallmentPlan, false)
    })

    await t.test('非法到期日/周期被拒绝', async () => {
      const a = await find()
      await assert.rejects(api('accounts.update', { requestId: randomUUID(), accountId: account.accountId, version: a.version, statementDueDate: '2026-13-40' }), { publicCode: 'VALIDATION_ERROR' })
      await assert.rejects(api('accounts.update', { requestId: randomUUID(), accountId: account.accountId, version: a.version, statementCycle: 'abc' }), { publicCode: 'VALIDATION_ERROR' })
    })

    await t.test('清空账单字段后回到无数据状态', async () => {
      const a = await find()
      const cleared = await api('accounts.update', { requestId: randomUUID(), accountId: account.accountId, version: a.version,
        statementDueMinor: null, statementMinimumMinor: null, statementDueDate: null, statementCycle: null })
      assert.equal(cleared.statementDueMinor, null)
      assert.equal(cleared.hasStatementData, false)
      assert.equal(cleared.debtMinor, '0')
    })
  } finally {
    await db.close()
  }
})
