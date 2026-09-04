const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const test = require('node:test')

const mysql = require('mysql2/promise')

const { digestParts } = require('../src/digest')
const { hashWechatSubject } = require('../src/handler')
const { buildPaymentMethodKey } = require('../src/identity')
const { createImportService } = require('../src/import-service')
const { createAccountService } = require('../../catledger-api/src/account-service')
const { createTransactionService } = require('../../catledger-api/src/transaction-service')

const DATABASE_ENV_KEYS = [
  'CATLEDGER_TEST_DB_HOST',
  'CATLEDGER_TEST_DB_USER',
  'CATLEDGER_TEST_DB_PASSWORD',
  'CATLEDGER_TEST_DB_NAME'
]
const hasDatabase = DATABASE_ENV_KEYS.every((key) => process.env[key])

function databaseConfig() {
  return {
    host: process.env.CATLEDGER_TEST_DB_HOST,
    port: Number(process.env.CATLEDGER_TEST_DB_PORT || 3306),
    user: process.env.CATLEDGER_TEST_DB_USER,
    password: process.env.CATLEDGER_TEST_DB_PASSWORD,
    database: process.env.CATLEDGER_TEST_DB_NAME,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    connectionLimit: 8
  }
}

function fixture() {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'wechat-pay.csv'))
}

function fixtureWithSequence(sequence) {
  const value = String(sequence).padStart(3, '0')
  const next = String(Number(sequence) + 1).padStart(3, '0')
  return Buffer.from(fixture().toString('utf8')
    .replaceAll('001', value)
    .replaceAll('002', next))
}

function wechatWithdrawalFixture() {
  return Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '微信昵称: 合成用户,,,,,,,,,,,',
    '起始时间: 2026-07-01 00:00:00 终止时间: 2026-07-31 23:59:59,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    '2026-07-08 16:26:00,零钱提现,浙江农商联合银行(5564),/,/,10.01,浙江农商联合银行储蓄卡(5564),提现已到账,WX-WITHDRAWAL-001,,,服务费¥0.01'
  ].join('\n'))
}

function alipayBalanceTransferFixture() {
  return Buffer.from([
    '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
    '支付宝账户: synth@example.invalid,,,,,,,,,,,',
    '起始日期: [2026-07-01 00:00:00] 终止日期: [2026-07-31 23:59:59],,,,,,,,,,,',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    '2026-07-06 13:49:00,余额宝-转出到余额,支付宝,余额宝-转出到余额,494.00,不计收支,账户余额,交易成功,,ALI-BALANCE-TRANSFER-001,, '
  ].join('\n'))
}

function alipayAggregateRepaymentFixture() {
  return Buffer.from([
    '支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
    '支付宝账户: synth@example.invalid,,,,,,,,,,,',
    '起始日期: [2026-07-01 00:00:00] 终止日期: [2026-07-31 23:59:59],,,,,,,,,,,',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    '2026-07-01 10:00:00,日用百货,合成商户甲,合成消费甲,1.00,支出,花呗,交易成功,,ALI-HUABEI-001,,',
    '2026-07-02 10:00:00,日用百货,合成商户乙,合成消费乙,2.00,支出,江苏银行信用购,交易成功,,ALI-CREDIT-001,,',
    '2026-07-20 09:00:00,信用借还,花呗|信用购,自动还款-花呗|信用购2026年07月账单,100.00,不计收支,浙江农商联合银行储蓄卡(5564),还款成功,,ALI-REPAYMENT-001,,'
  ].join('\n'))
}

function wechatRefundCandidatesFixture() {
  return Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '微信昵称: 合成用户,,,,,,,,,,,',
    '起始时间: 2026-07-01 00:00:00 终止时间: 2026-07-31 23:59:59,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    '2026-07-01 10:00:00,商户消费,合成商户甲,合成消费甲,支出,10.00,微信零钱,支付成功,WX-REFUND-ORIGINAL-001,,,',
    '2026-07-02 10:00:00,商户消费,合成商户甲,合成消费乙,支出,9.00,微信零钱,支付成功,WX-REFUND-ORIGINAL-002,,,',
    '2026-07-02 11:00:00,商户消费,无关商户,无关消费,支出,8.00,微信零钱,支付成功,WX-REFUND-UNRELATED-001,,,',
    '2026-07-03 10:00:00,商户退款,合成商户甲,退款入账,收入,3.00,微信零钱,退款成功,WX-REFUND-INCOME-001,,,'
  ].join('\n'))
}

function wechatUnlinkedRefundFixture() {
  return Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '微信昵称: 合成用户,,,,,,,,,,,',
    '起始时间: 2026-07-01 00:00:00 终止时间: 2026-07-31 23:59:59,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    '2026-07-04 15:02:00,商户退款,义乌市千单日用品有限公司,退款-手持小型缝纫机,收入,4.66,微信零钱,退款成功,WX-UNLINKED-REFUND-001,,,'
  ].join('\n'))
}

async function createUserLedger(pool, label) {
  const uid = randomUUID()
  const accountId = randomUUID()
  const categoryId = randomUUID()
  const subjectHash = hashWechatSubject(`synthetic-${label}-${randomUUID()}`)
  await pool.execute('INSERT INTO catledger_users (uid, status) VALUES (?, \'active\')', [uid])
  await pool.execute(
    `INSERT INTO catledger_user_identities (uid, provider, subject_hash)
     VALUES (?, 'wechat-mini', ?)`,
    [uid, subjectHash]
  )
  await pool.execute(
    `INSERT INTO catledger_accounts
       (uid, account_id, type, nature, name, normalized_name, currency)
     VALUES (?, ?, 'wallet', 'asset', ?, ?, 'CNY')`,
    [uid, accountId, `合成账户-${label}`, `合成账户-${label}`]
  )
  await pool.execute(
    `INSERT INTO catledger_categories
       (category_id, uid, kind, system_key, name, normalized_name, sort_order, is_system_default)
     VALUES (?, ?, 'expense', NULL, ?, ?, 1, 0)`,
    [categoryId, uid, `合成分类-${label}`, `合成分类-${label}`]
  )
  return { uid, accountId, categoryId, subjectHash }
}

function context(user, data) {
  return { provider: 'wechat-mini', subjectHash: user.subjectHash, data }
}

function decisions(view, user) {
  return view.rows.filter((row) => row.eventId && row.processingState === 'pending').map((row) => ({
    eventId: row.eventId,
    disposition: 'post',
    accountId: user.accountId,
    categoryId: user.categoryId
  }))
}

function ignoredDecisions(view, paymentRuleAction) {
  return view.rows.filter((row) => row.eventId && row.processingState === 'pending').map((row) => ({
    eventId: row.eventId,
    disposition: 'skip',
    accountId: null,
    categoryId: null,
    paymentRuleAction
  }))
}

async function resolveOpenCategoryIssues(service, user, initialView) {
  let view = initialView
  while (true) {
    const issue = view.issues.find((item) => item.status === 'open' && item.issueType === 'category_assignment')
    if (!issue) return view
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
      updateVersion: view.update.version, issueVersion: issue.version,
      decision: 'apply_fields', fields: { categoryId: user.categoryId }
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
  }
}

test('MySQL 单文件导入覆盖隔离、重复、并发和回滚', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      assert.ok(objects.has(objectKey))
      return objects.get(objectKey)
    },
    async remove() {
      return true
    }
  }
  const service = createImportService({ getPool: () => pool, storage })

  try {
    const userA = await createUserLedger(pool, 'A')
    const prepared = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '微信账单.csv', size: fixture().length
    }))
    objects.set(prepared.cloudPath, fixture())
    const parsed = await service.parse(context(userA, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    assert.equal(parsed.import.state, 'review_ready')
    assert.deepEqual(parsed.batch.summary, { total: 2, valid: 2, invalid: 0, pending: 2, posted: 0 })
    const view = await service.get(context(userA, { importId: prepared.importId }))
    const commitRequestId = randomUUID()
    const committed = await service.commit(context(userA, {
      requestId: commitRequestId, importId: prepared.importId, version: view.import.version,
      decisions: decisions(view, userA)
    }))
    assert.equal(committed.createdTransactionCount, 2)
    assert.equal(committed.contentState, 'deleted')
    const [[countA]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions
        WHERE uid = ? AND origin = 'import'`,
      [userA.uid]
    )
    assert.equal(Number(countA.count), 2)
    const replayedCommit = await service.commit(context(userA, {
      requestId: commitRequestId, importId: prepared.importId, version: view.import.version,
      decisions: decisions(view, userA)
    }))
    assert.equal(replayedCommit.contentState, 'deleted')
    assert.equal(replayedCommit.createdTransactionCount, 2)

    const learnedContent = Buffer.from(fixture().toString('utf8')
      .replace('WX-SYNTH-001', 'WX-SYNTH-101')
      .replace('WX-SYNTH-002', 'WX-SYNTH-102'))
    const learned = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '分类复用.csv', size: learnedContent.length
    }))
    objects.set(learned.cloudPath, learnedContent)
    await service.parse(context(userA, {
      requestId: randomUUID(), importId: learned.importId,
      fileID: `cloud://synthetic.bucket/${learned.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const learnedView = await service.get(context(userA, { importId: learned.importId }))
    learnedView.rows.filter((row) => row.processingState === 'pending').forEach((row) => {
      assert.equal(row.decision.accountId, userA.accountId)
      assert.equal(row.decision.categoryId, userA.categoryId)
    })
    await service.discard(context(userA, {
      requestId: randomUUID(), importId: learned.importId, version: learnedView.import.version
    }))

    const ignoredContent = fixtureWithSequence(201)
    const ignored = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '永久忽略.csv', size: ignoredContent.length
    }))
    objects.set(ignored.cloudPath, ignoredContent)
    await service.parse(context(userA, {
      requestId: randomUUID(), importId: ignored.importId,
      fileID: `cloud://synthetic.bucket/${ignored.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const ignoredView = await service.get(context(userA, { importId: ignored.importId }))
    await service.commit(context(userA, {
      requestId: randomUUID(), importId: ignored.importId, version: ignoredView.import.version,
      decisions: ignoredDecisions(ignoredView, 'ignore')
    }))
    const [[ignoredRule]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, account_id AS accountId,
              disabled_at AS disabledAt, version
         FROM catledger_import_account_mappings
        WHERE uid = ? AND source_type = 'wechat'`,
      [userA.uid]
    )
    assert.equal(ignoredRule.mappingAction, 'ignore')
    assert.equal(ignoredRule.accountId, null)
    assert.equal(ignoredRule.disabledAt, null)

    const repeatedIgnoreContent = fixtureWithSequence(251)
    const repeatedIgnore = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '复用忽略规则.csv', size: repeatedIgnoreContent.length
    }))
    objects.set(repeatedIgnore.cloudPath, repeatedIgnoreContent)
    await service.parse(context(userA, {
      requestId: randomUUID(), importId: repeatedIgnore.importId,
      fileID: `cloud://synthetic.bucket/${repeatedIgnore.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const repeatedIgnoreView = await service.get(context(userA, { importId: repeatedIgnore.importId }))
    await service.commit(context(userA, {
      requestId: randomUUID(), importId: repeatedIgnore.importId,
      version: repeatedIgnoreView.import.version,
      decisions: ignoredDecisions(repeatedIgnoreView, 'ignore')
    }))
    const [[repeatedRule]] = await pool.execute(
      `SELECT version FROM catledger_import_account_mappings
        WHERE uid = ? AND source_type = 'wechat'`,
      [userA.uid]
    )
    assert.equal(String(repeatedRule.version), String(ignoredRule.version))

    const futureContent = fixtureWithSequence(301)
    const future = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '复用永久忽略.csv', size: futureContent.length
    }))
    objects.set(future.cloudPath, futureContent)
    await service.parse(context(userA, {
      requestId: randomUUID(), importId: future.importId,
      fileID: `cloud://synthetic.bucket/${future.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const futureView = await service.get(context(userA, { importId: future.importId }))
    futureView.rows.filter((row) => row.processingState === 'pending').forEach((row) => {
      assert.equal(row.decision.paymentRuleAction, 'ignore')
      assert.equal(row.decision.accountId, null)
    })

    const isolatedUser = await createUserLedger(pool, '规则隔离')
    const isolated = await service.prepare(context(isolatedUser, {
      requestId: randomUUID(), fileName: '规则隔离.csv', size: futureContent.length
    }))
    objects.set(isolated.cloudPath, futureContent)
    await service.parse(context(isolatedUser, {
      requestId: randomUUID(), importId: isolated.importId,
      fileID: `cloud://synthetic.bucket/${isolated.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const isolatedView = await service.get(context(isolatedUser, { importId: isolated.importId }))
    isolatedView.rows.filter((row) => row.processingState === 'pending').forEach((row) => {
      assert.notEqual(row.decision.paymentRuleAction, 'ignore')
    })
    await service.discard(context(isolatedUser, {
      requestId: randomUUID(), importId: isolated.importId, version: isolatedView.import.version
    }))

    await service.commit(context(userA, {
      requestId: randomUUID(), importId: future.importId, version: futureView.import.version,
      decisions: ignoredDecisions(futureView, 'forget')
    }))
    const [[forgottenRule]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, disabled_at AS disabledAt
         FROM catledger_import_account_mappings
        WHERE uid = ? AND source_type = 'wechat'`,
      [userA.uid]
    )
    assert.equal(forgottenRule.mappingAction, 'ignore')
    assert.ok(forgottenRule.disabledAt)

    const remappedContent = fixtureWithSequence(401)
    const remapped = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '恢复账户映射.csv', size: remappedContent.length
    }))
    objects.set(remapped.cloudPath, remappedContent)
    await service.parse(context(userA, {
      requestId: randomUUID(), importId: remapped.importId,
      fileID: `cloud://synthetic.bucket/${remapped.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const remappedView = await service.get(context(userA, { importId: remapped.importId }))
    await service.commit(context(userA, {
      requestId: randomUUID(), importId: remapped.importId, version: remappedView.import.version,
      decisions: decisions(remappedView, userA)
    }))
    const [[activeAccountRule]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, account_id AS accountId, disabled_at AS disabledAt
         FROM catledger_import_account_mappings
        WHERE uid = ? AND source_type = 'wechat'`,
      [userA.uid]
    )
    assert.deepEqual(activeAccountRule, {
      mappingAction: 'account', accountId: userA.accountId, disabledAt: null
    })

    const duplicate = await service.prepare(context(userA, {
      requestId: randomUUID(), fileName: '再次上传.csv', size: fixture().length
    }))
    objects.set(duplicate.cloudPath, fixture())
    const duplicateResult = await service.parse(context(userA, {
      requestId: randomUUID(), importId: duplicate.importId,
      fileID: `cloud://synthetic.bucket/${duplicate.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    assert.equal(duplicateResult.import.state, 'duplicate')
    assert.equal(duplicateResult.duplicateImportId, prepared.importId)

    const userB = await createUserLedger(pool, 'B')
    await assert.rejects(
      service.get(context(userB, { importId: prepared.importId })),
      { publicCode: 'NOT_FOUND' }
    )

    const concurrentImports = []
    for (const ending of ['\n', '\r\n']) {
      const content = Buffer.concat([fixture(), Buffer.from(ending)])
      const item = await service.prepare(context(userB, {
        requestId: randomUUID(), fileName: '并发账单.csv', size: content.length
      }))
      objects.set(item.cloudPath, content)
      await service.parse(context(userB, {
        requestId: randomUUID(), importId: item.importId,
        fileID: `cloud://synthetic.bucket/${item.cloudPath}`, timezoneOffsetMinutes: -480
      }))
      const itemView = await service.get(context(userB, { importId: item.importId }))
      concurrentImports.push({ item, view: itemView })
    }
    const concurrentResults = await Promise.all(concurrentImports.map(({ item, view }) => (
      service.commit(context(userB, {
        requestId: randomUUID(), importId: item.importId, version: view.import.version,
        decisions: decisions(view, userB)
      }))
    )))
    assert.equal(concurrentResults.reduce((sum, result) => sum + result.createdTransactionCount, 0), 2)
    assert.equal(concurrentResults.reduce((sum, result) => sum + result.reusedTransactionCount, 0), 2)
    const [[countB]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions
        WHERE uid = ? AND origin = 'import'`,
      [userB.uid]
    )
    assert.equal(Number(countB.count), 2)

    const userC = await createUserLedger(pool, 'C')
    const rollbackContent = Buffer.from(fixture().toString('utf8').replace(
      '12.34,零钱,支付成功,WX-SYNTH-002',
      '12.35,零钱,支付成功,WX-SYNTH-002'
    ))
    const rollbackImport = await service.prepare(context(userC, {
      requestId: randomUUID(), fileName: '回滚账单.csv', size: rollbackContent.length
    }))
    objects.set(rollbackImport.cloudPath, rollbackContent)
    await service.parse(context(userC, {
      requestId: randomUUID(), importId: rollbackImport.importId,
      fileID: `cloud://synthetic.bucket/${rollbackImport.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const rollbackView = await service.get(context(userC, { importId: rollbackImport.importId }))
    await pool.query(`CREATE TRIGGER catledger_test_reject_import_amount
      BEFORE INSERT ON catledger_transactions FOR EACH ROW
      BEGIN
        IF NEW.origin = 'import' AND NEW.amount_minor = 1235 THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic rollback gate';
        END IF;
      END`)
    try {
      await assert.rejects(service.commit(context(userC, {
        requestId: randomUUID(), importId: rollbackImport.importId,
        version: rollbackView.import.version, decisions: decisions(rollbackView, userC)
      })))
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS catledger_test_reject_import_amount')
    }
    const [[rollbackCount]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions
        WHERE uid = ? AND origin = 'import'`,
      [userC.uid]
    )
    assert.equal(Number(rollbackCount.count), 0)
    const rollbackAfter = await service.get(context(userC, { importId: rollbackImport.importId }))
    assert.equal(rollbackAfter.import.state, 'review_ready')
  } finally {
    await pool.end()
  }
})

test('MySQL 多文件形成一个 FinanceUpdate 并整批原子入账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'multi')
    const contents = [fixtureWithSequence(101), fixtureWithSequence(201)]
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(),
      files: contents.map((content, index) => ({ fileName: `多账单-${index + 1}.csv`, size: content.length }))
    }))
    const parsed = []
    for (let index = 0; index < prepared.files.length; index += 1) {
      const file = prepared.files[index]
      objects.set(file.cloudPath, contents[index])
      parsed.push(await service.parseFile(context(user, {
        requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480
      })))
    }
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: parsed.map((item) => item.batch.batchId)
    }))
    assert.equal(view.sources.length, 2)
    assert.equal(view.events.length, 4)
    assert.equal(view.update.counts.validEvidence, 4)

    const accountIssues = view.issues.filter((item) => item.status === 'open')
    for (const issue of accountIssues) {
      assert.equal(issue.issueType, 'account_mapping')
    }
    const versionBeforeAccountBatch = view.update.version
    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(),
      updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: { ledgerAccountDraft: { name: '多账单新账户', type: 'wallet', currency: 'CNY' } }
      }))
    }))
    assert.equal(view.update.version, versionBeforeAccountBatch + 1)
    view = await resolveOpenCategoryIssues(service, user, view)
    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 4)
    const [[accountBatchActions]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM catledger_finance_actions
        WHERE uid = ? AND update_id = ? AND action_type = 'resolve_account_mappings'`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(accountBatchActions.count), 1)

    const [[formalMappingsBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ?`,
      [user.uid]
    )
    const [[draftMappingsBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM catledger_finance_update_account_mapping_drafts
        WHERE uid = ? AND update_id = ?`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(formalMappingsBeforePost.count), 0)
    assert.ok(Number(draftMappingsBeforePost.count) > 0)
    const [[formalAccountsBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid = ?`,
      [user.uid]
    )
    assert.equal(Number(formalAccountsBeforePost.count), 1)

    const requestId = randomUUID()
    const posted = await service.financeUpdatePost(context(user, {
      requestId, updateId: view.update.updateId, version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(posted.update.status, 'posted')
    assert.deepEqual(posted.posting, { createdTransactionCount: 4, reusedTransactionCount: 0 })
    const replayed = await service.financeUpdatePost(context(user, {
      requestId, updateId: view.update.updateId, version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(replayed.update.status, 'posted')
    const [[transactions]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL`,
      [user.uid]
    )
    assert.equal(Number(transactions.count), 4)
    const [[formalMappingsAfterPost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ?`,
      [user.uid]
    )
    assert.ok(Number(formalMappingsAfterPost.count) > 0)
    const [[formalAccountsAfterPost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_accounts WHERE uid = ?`,
      [user.uid]
    )
    assert.equal(Number(formalAccountsAfterPost.count), 2)
    const impact = await service.financeUpdateUndoImpact(context(user, { updateId: posted.update.updateId }))
    assert.equal(impact.canUndo, true)
    assert.equal(impact.createdTransactionCount, 4)
    const undone = await service.financeUpdateUndo(context(user, {
      requestId: randomUUID(), updateId: posted.update.updateId, version: posted.update.version
    }))
    assert.equal(undone.update.status, 'undone')
    const [[activeAfterUndo]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL`,
      [user.uid]
    )
    assert.equal(Number(activeAfterUndo.count), 0)
  } finally {
    await pool.end()
  }
})

test('退款详情只返回冻结候选且服务端拒绝集合外原消费', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'refund-policy')
    const content = wechatRefundCandidatesFixture()
    const prepared = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '退款候选账单.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.ok(accountIssue)
    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: [{
        issueId: accountIssue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: { ledgerAccountId: user.accountId }
      }]
    }))

    const refundIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'refund_relation')
    assert.ok(refundIssue)
    assert.equal(refundIssue.candidateCount, 2)
    const details = await service.reviewIssueGet(context(user, { issueId: refundIssue.issueId }))
    assert.equal(Object.prototype.hasOwnProperty.call(details, 'refundChoices'), false)
    const candidateMembers = details.members.filter((member) => member.memberRole === 'candidate')
    assert.equal(candidateMembers.length, 2)

    const unrelated = view.events.find((event) => event.amountMinor === '800')
    assert.ok(unrelated)
    await assert.rejects(() => service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: refundIssue.issueId,
      updateVersion: view.update.version, issueVersion: refundIssue.version,
      decision: 'link_refund', targetEventId: unrelated.eventId
    })), { publicCode: 'VALIDATION_ERROR' })

    const selectedTargetId = candidateMembers[0].relation.targetEventId
    const refundEventId = candidateMembers[0].relation.sourceEventId
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: refundIssue.issueId,
      updateVersion: view.update.version, issueVersion: refundIssue.version,
      decision: 'link_refund', targetEventId: selectedTargetId
    }))
    const afterResolve = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(afterResolve.issues.find((issue) => issue.issueId === refundIssue.issueId).status, 'resolved')
    const [relationStates] = await pool.execute(
      `SELECT status, COUNT(*) AS count
         FROM catledger_economic_event_relations
        WHERE uid = ? AND update_id = ? AND source_event_id = ? AND relation_type = 'refund_of'
        GROUP BY status ORDER BY status`,
      [user.uid, view.update.updateId, refundEventId]
    )
    assert.deepEqual(relationStates.map((row) => [row.status, Number(row.count)]), [
      ['confirmed', 1], ['rejected', 1]
    ])
  } finally {
    await pool.end()
  }
})

test('零候选退款可明确暂记并入账余额但不进入收支统计', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  const accountService = createAccountService({ getPool: () => pool })
  const transactionService = createTransactionService({ getPool: () => pool })
  try {
    const user = await createUserLedger(pool, 'unlinked-refund')
    const content = wechatUnlinkedRefundFixture()
    const prepared = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '待关联退款.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.ok(accountIssue)
    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: [{
        issueId: accountIssue.issueId, operation: 'resolve', decision: 'apply_fields',
        fields: { ledgerAccountId: user.accountId }
      }]
    }))
    const refundIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'refund_relation')
    assert.ok(refundIssue)
    assert.equal(refundIssue.candidateCount, 0)
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: refundIssue.issueId,
      updateVersion: view.update.version, issueVersion: refundIssue.version,
      decision: 'mark_refund_pending'
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 1)
    const pending = view.events.find((event) => event.economicNature === 'refund')
    const [[storedPending]] = await pool.execute(
      `SELECT field_sources_json AS fieldSources
         FROM catledger_economic_events
        WHERE uid = ? AND update_id = ? AND event_id = ?`,
      [user.uid, view.update.updateId, pending.eventId]
    )
    const storedFieldSources = typeof storedPending.fieldSources === 'string'
      ? JSON.parse(storedPending.fieldSources)
      : storedPending.fieldSources
    assert.equal(storedFieldSources.refundRelation.status, 'pending')

    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(posted.update.status, 'posted')
    const [rows] = await pool.execute(
      `SELECT type, destination_account_id AS destinationAccountId,
              original_transaction_id AS originalTransactionId
         FROM catledger_transactions
        WHERE uid = ? AND origin = 'import' AND deleted_at IS NULL`,
      [user.uid]
    )
    assert.deepEqual(rows, [{
      type: 'refund', destinationAccountId: user.accountId, originalTransactionId: null
    }])
    const page = await transactionService.list(context(user, { month: '2026-07' }))
    assert.deepEqual(page.summary, { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' })
    assert.equal(page.transactions[0].refundLinkStatus, 'pending')
    const statistics = await transactionService.statistics(context(user, { month: '2026-07' }))
    assert.deepEqual(statistics.expenseCategories, [])
    assert.equal(statistics.daily.find((day) => day.date === '2026-07-04').expenseMinor, '0')
    const accounts = await accountService.list(context(user, {}))
    assert.equal(accounts.accounts.find((account) => account.accountId === user.accountId).bookBalanceMinor, '466')

    const original = await transactionService.create(context(user, {
      requestId: randomUUID(), type: 'expense', sourceAccountId: user.accountId,
      categoryId: user.categoryId, amountMinor: '466',
      occurredLocalAt: '2026-07-04T11:37:00', timezoneOffsetMinutes: -480,
      note: '手持小型缝纫机'
    }))
    const linked = await transactionService.linkRefund(context(user, {
      requestId: randomUUID(), transactionId: page.transactions[0].transactionId,
      version: page.transactions[0].version, originalTransactionId: original.transactionId
    }))
    assert.equal(linked.refundLinkStatus, 'linked')
    assert.equal(linked.originalTransaction.transactionId, original.transactionId)
    const [refundOriginalLinks] = await pool.execute(
      `SELECT transaction_id AS transactionId, role, creation_method AS creationMethod,
              rule_version AS ruleVersion
         FROM catledger_economic_event_transactions
        WHERE uid = ? AND transaction_id = ? AND role = 'refund_original'`,
      [user.uid, original.transactionId]
    )
    assert.deepEqual(refundOriginalLinks, [{
      transactionId: original.transactionId,
      role: 'refund_original',
      creationMethod: 'manual_link',
      ruleVersion: 'refund-link-v1'
    }])
    const afterLink = await transactionService.list(context(user, { month: '2026-07' }))
    assert.deepEqual(afterLink.summary, { incomeMinor: '0', expenseMinor: '0', netIncomeMinor: '0' })
    assert.equal(afterLink.transactions.find((transaction) => transaction.type === 'refund').refundLinkStatus, 'linked')
    const afterLinkAccounts = await accountService.list(context(user, {}))
    assert.equal(afterLinkAccounts.accounts.find((account) => account.accountId === user.accountId).bookBalanceMinor, '0')
  } finally {
    await pool.end()
  }
})

test('MySQL 同一批账单放弃后可再次原子 prepare', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'repeat-prepare')
    const content = fixtureWithSequence(251)
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '重复整理账单.csv', size: content.length }]
    }))
    const file = prepared.files[0]
    objects.set(file.cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: file.importId,
      fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const batchIds = [parsed.batch.batchId]

    const first = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds
    }))
    const abandoned = await service.financeUpdateAbandon(context(user, {
      requestId: randomUUID(), updateId: first.update.updateId, version: first.update.version
    }))
    assert.equal(abandoned.status, 'abandoned')

    const second = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds
    }))
    assert.notEqual(second.update.updateId, first.update.updateId)
    assert.equal(second.update.status, 'review')
  } finally {
    await pool.end()
  }
})

test('微信零钱提现按资金端分别确认，账户归属后不再生成同账户转账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'wechat-withdrawal')
    const content = wechatWithdrawalFixture()
    const prepared = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '微信零钱提现.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssues = view.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.equal(accountIssues.length, 2)
    assert.deepEqual(accountIssues.map((issue) => [issue.accountContext.fundsSide, issue.accountContext.label])
      .sort((left, right) => left[0].localeCompare(right[0])), [
      ['from', '微信零钱'],
      ['to', '浙江农商联合银行储蓄卡(5564)']
    ])

    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: {
          mappingAccountDraft: {
            name: issue.accountContext.label,
            type: issue.accountContext.fundsSide === 'from' ? 'wallet' : 'bank',
            currency: 'CNY'
          }
        }
      }))
    }))

    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 1)
    assert.equal(view.issues.some((issue) => issue.status === 'open'), false)
    assert.equal(view.events.length, 1)
    assert.notEqual(view.events[0].ledgerAccountId, view.events[0].counterpartyLedgerAccountId)
    const drafts = new Map(view.accountDrafts.map((draft) => [draft.accountId, draft.name]))
    assert.equal(drafts.get(view.events[0].ledgerAccountId), '微信零钱')
    assert.equal(drafts.get(view.events[0].counterpartyLedgerAccountId), '浙江农商联合银行储蓄卡(5564)')
  } finally {
    await pool.end()
  }
})

test('余额宝转出到账户余额确认两端归属后直接完成整理', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'alipay-balance-transfer')
    const content = alipayBalanceTransferFixture()
    const prepared = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '支付宝余额宝转出.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssues = view.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.deepEqual(accountIssues.map((issue) => [issue.accountContext.fundsSide, issue.accountContext.label])
      .sort((left, right) => left[0].localeCompare(right[0])), [
      ['from', '支付宝余额宝'],
      ['to', '支付宝账户余额']
    ])

    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: {
          mappingAccountDraft: {
            name: issue.accountContext.label,
            type: issue.accountContext.fundsSide === 'from' ? 'other_asset' : 'wallet',
            currency: 'CNY'
          }
        }
      }))
    }))

    assert.equal(view.update.counts.needsActionEvents, 0)
    assert.equal(view.update.counts.readyEvents, 1)
    assert.equal(view.issues.some((issue) => issue.status === 'open'), false)
    assert.notEqual(view.events[0].ledgerAccountId, view.events[0].counterpartyLedgerAccountId)
    const drafts = new Map(view.accountDrafts.map((draft) => [draft.accountId, draft.name]))
    assert.equal(drafts.get(view.events[0].ledgerAccountId), '支付宝余额宝')
    assert.equal(drafts.get(view.events[0].counterpartyLedgerAccountId), '支付宝账户余额')
  } finally {
    await pool.end()
  }
})

test('支付宝合并还款不创建第三账户并原子入账为多笔守恒转账', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'alipay-aggregate-repayment')
    const content = alipayAggregateRepaymentFixture()
    const prepared = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '支付宝合并还款.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    let view = await service.financeUpdatePrepare(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    const accountIssues = view.issues.filter((issue) => issue.status === 'open' && issue.issueType === 'account_mapping')
    assert.deepEqual(accountIssues.map((issue) => issue.accountContext.label).sort(), [
      '支付宝花呗', '江苏银行信用购', '浙江农商联合银行储蓄卡(5564)'
    ].sort())
    assert.equal(accountIssues.some((issue) => issue.accountContext.label.includes('花呗｜信用购')), false)

    view = await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      decisions: accountIssues.map((issue) => ({
        issueId: issue.issueId,
        operation: 'resolve',
        decision: 'apply_fields',
        fields: {
          mappingAccountDraft: {
            name: issue.accountContext.label,
            type: issue.accountContext.label.includes('储蓄卡') ? 'bank' : 'credit',
            currency: 'CNY'
          }
        }
      }))
    }))

    const draftsByName = new Map(view.accountDrafts.map((draft) => [draft.name, draft.accountId]))
    const repaymentIssue = view.issues.find((issue) => issue.status === 'open' && issue.issueType === 'transfer_accounts' &&
      issue.subject && issue.subject.fundsProjection && issue.subject.fundsProjection.to.referenceKind === 'aggregate')
    assert.ok(repaymentIssue)
    assert.equal(repaymentIssue.subject.ledgerAccountId, draftsByName.get('浙江农商联合银行储蓄卡(5564)'))
    assert.deepEqual(repaymentIssue.subject.fundsProjection.to.candidates.map((candidate) => candidate.accountId).sort(), [
      draftsByName.get('支付宝花呗'), draftsByName.get('江苏银行信用购')
    ].sort())

    const unrelatedCreditAccountId = randomUUID()
    await pool.execute(
      `INSERT INTO catledger_accounts
         (uid, account_id, type, nature, name, normalized_name, currency)
       VALUES (?, ?, 'credit', 'liability', '光大银行信用卡(2690)', '光大银行信用卡(2690)', 'CNY')`,
      [user.uid, unrelatedCreditAccountId]
    )
    await assert.rejects(() => service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: repaymentIssue.issueId,
      updateVersion: view.update.version, issueVersion: repaymentIssue.version,
      decision: 'apply_fields',
      fields: {
        repaymentAllocations: [{ accountId: unrelatedCreditAccountId, amountMinor: '1036610' }]
      }
    })), { publicCode: 'VALIDATION_ERROR' })

    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: repaymentIssue.issueId,
      updateVersion: view.update.version, issueVersion: repaymentIssue.version,
      decision: 'apply_fields',
      fields: {
        repaymentAllocations: [
          { accountId: draftsByName.get('支付宝花呗'), amountMinor: '6000' },
          { accountId: draftsByName.get('江苏银行信用购'), amountMinor: '4000' }
        ]
      }
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    view = await resolveOpenCategoryIssues(service, user, view)

    while (view.issues.some((issue) => issue.status === 'open')) {
      const issue = view.issues.find((item) => item.status === 'open')
      await service.reviewIssueResolve(context(user, {
        requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version,
        decision: 'exclude_events'
      }))
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    }
    const repaymentEvent = view.events.find((event) => event.economicNature === 'repayment')
    assert.ok(repaymentEvent)
    assert.equal(repaymentEvent.status, 'ready')

    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      version: view.update.version, mode: 'all_ready'
    }))
    assert.deepEqual(posted.posting, { createdTransactionCount: 4, reusedTransactionCount: 0 })
    const [transactions] = await pool.execute(
      `SELECT transaction_row.source_account_id AS sourceAccountId,
              transaction_row.destination_account_id AS destinationAccountId,
              CAST(transaction_row.amount_minor AS CHAR) AS amountMinor,
              event_link.role
         FROM catledger_economic_event_transactions event_link
         JOIN catledger_transactions transaction_row
           ON transaction_row.uid = event_link.uid AND transaction_row.transaction_id = event_link.transaction_id
        WHERE event_link.uid = ? AND event_link.event_id = ?
        ORDER BY amountMinor`,
      [user.uid, repaymentEvent.eventId]
    )
    assert.deepEqual(transactions.map((transaction) => ({
      sourceAccountId: transaction.sourceAccountId,
      destinationAccountId: transaction.destinationAccountId,
      amountMinor: transaction.amountMinor,
      role: transaction.role
    })), [
      {
        sourceAccountId: draftsByName.get('浙江农商联合银行储蓄卡(5564)'),
        destinationAccountId: draftsByName.get('江苏银行信用购'),
        amountMinor: '4000', role: 'repayment_allocation'
      },
      {
        sourceAccountId: draftsByName.get('浙江农商联合银行储蓄卡(5564)'),
        destinationAccountId: draftsByName.get('支付宝花呗'),
        amountMinor: '6000', role: 'repayment_allocation'
      }
    ])
  } finally {
    await pool.end()
  }
})

test('FinanceUpdate 永久忽略只在整批入账后提升并让后续匹配自动排除且可修改', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) {
      assert.equal(fileID, `cloud://synthetic.bucket/${objectKey}`)
      return objects.get(objectKey)
    },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'finance-update-ignore')
    const content = fixtureWithSequence(501)
    const prepared = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '整批永久忽略.csv', size: content.length
    }))
    objects.set(prepared.cloudPath, content)
    const parsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: prepared.importId,
      fileID: `cloud://synthetic.bucket/${prepared.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const created = await service.financeUpdateCreate(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    let view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: created.updateId, version: created.version
    }))
    const issue = view.issues.find((item) => item.status === 'open' && item.issueType === 'account_mapping')
    assert.ok(issue)
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
      updateVersion: view.update.version, issueVersion: issue.version,
      decision: 'exclude_events', paymentRuleAction: 'ignore'
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(view.update.counts.readyEvents, 0)
    assert.equal(view.update.counts.excludedEvents, 2)
    view.events.filter((event) => event.status === 'excluded').forEach((event) => {
      assert.ok(event.reasonCodes.includes('account_mapping_excluded'))
    })

    const [[formalBeforePost]] = await pool.execute(
      `SELECT COUNT(*) AS count FROM catledger_import_account_mappings WHERE uid = ?`,
      [user.uid]
    )
    const [[draftBeforePost]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, account_id AS accountId
         FROM catledger_finance_update_account_mapping_drafts
        WHERE uid = ? AND update_id = ? LIMIT 1`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(formalBeforePost.count), 0)
    assert.deepEqual(draftBeforePost, { mappingAction: 'ignore', accountId: null })

    const posted = await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId,
      version: view.update.version, mode: 'all_ready'
    }))
    assert.equal(posted.update.status, 'posted')
    assert.deepEqual(posted.posting, { createdTransactionCount: 0, reusedTransactionCount: 0 })
    const [[formalAfterPost]] = await pool.execute(
      `SELECT mapping_action AS mappingAction, account_id AS accountId, disabled_at AS disabledAt
         FROM catledger_import_account_mappings WHERE uid = ? LIMIT 1`,
      [user.uid]
    )
    assert.deepEqual(formalAfterPost, { mappingAction: 'ignore', accountId: null, disabledAt: null })

    // 模拟旧版本曾按带平台前缀的原文生成键。原事实必须保留，后续读取
    // 应从稳定提示派生当前规范键别名，而不是要求用户再次确认。
    const legacyKey = digestParts('payment-method-v1', 'wechat', '微信零钱')
    await pool.execute(
      `UPDATE catledger_import_account_mappings
          SET payment_method_key = ?, payment_method_hint = '微信零钱'
        WHERE uid = ?`,
      [legacyKey, user.uid]
    )

    const laterContent = fixtureWithSequence(601)
    const later = await service.prepare(context(user, {
      requestId: randomUUID(), fileName: '后续复用永久忽略.csv', size: laterContent.length
    }))
    objects.set(later.cloudPath, laterContent)
    const laterParsed = await service.parse(context(user, {
      requestId: randomUUID(), importId: later.importId,
      fileID: `cloud://synthetic.bucket/${later.cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const laterCreated = await service.financeUpdateCreate(context(user, {
      requestId: randomUUID(), batchIds: [laterParsed.batch.batchId]
    }))
    const laterView = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: laterCreated.updateId, version: laterCreated.version
    }))
    assert.equal(laterView.events.every((event) => event.status === 'excluded'), true)
    assert.equal(laterView.events.every((event) => event.reasonCodes.includes('source_account_ignored_default')), true)
    const laterIssue = laterView.issues.find((item) => item.status === 'resolved' && item.issueType === 'account_mapping')
    assert.ok(laterIssue)
    assert.equal(laterIssue.blocking, false)
    assert.equal(laterIssue.accountContext.defaultIgnored, true)
    await service.reviewIssueResolveAccountMappings(context(user, {
      requestId: randomUUID(), updateId: laterView.update.updateId,
      decisions: [{
        issueId: laterIssue.issueId,
        operation: 'revise',
        decision: 'apply_fields',
        fields: { ledgerAccountId: user.accountId }
      }]
    }))
    const laterResolved = await service.financeUpdateGet(context(user, { updateId: laterView.update.updateId }))
    const categorizedLater = await resolveOpenCategoryIssues(service, user, laterResolved)
    assert.equal(categorizedLater.issues.some((item) => item.status === 'open'), false)
    await service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: categorizedLater.update.updateId,
      version: categorizedLater.update.version, mode: 'all_ready'
    }))
    const [rulesAfterOverride] = await pool.execute(
      `SELECT payment_method_key AS paymentMethodKey, mapping_action AS mappingAction,
              account_id AS accountId
         FROM catledger_import_account_mappings WHERE uid = ? ORDER BY payment_method_key`,
      [user.uid]
    )
    assert.equal(rulesAfterOverride.length, 2)
    assert.deepEqual(rulesAfterOverride.find((rule) => rule.paymentMethodKey === legacyKey), {
      paymentMethodKey: legacyKey, mappingAction: 'ignore', accountId: null
    })
    assert.deepEqual(rulesAfterOverride.find((rule) => rule.mappingAction === 'account'), {
      paymentMethodKey: buildPaymentMethodKey('wechat', '零钱'),
      mappingAction: 'account', accountId: user.accountId
    })
  } finally {
    await pool.end()
  }
})

test('FinanceUpdate 入账不得产生现金负余额且失败时整批回滚', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'cash-guard')
    await pool.execute(
      `UPDATE catledger_accounts SET type = 'cash' WHERE uid = ? AND account_id = ?`,
      [user.uid, user.accountId]
    )
    const content = fixtureWithSequence(601)
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '现金支出.csv', size: content.length }]
    }))
    objects.set(prepared.files[0].cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.files[0].importId,
      fileID: `cloud://synthetic.bucket/${prepared.files[0].cloudPath}`, timezoneOffsetMinutes: -480
    }))
    const created = await service.financeUpdateCreate(context(user, {
      requestId: randomUUID(), batchIds: [parsed.batch.batchId]
    }))
    let view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: created.updateId, version: created.version
    }))
    while (view.issues.some((item) => item.status === 'open')) {
      const issue = view.issues.find((item) => item.status === 'open')
      await service.reviewIssueResolve(context(user, {
        requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
        updateVersion: view.update.version, issueVersion: issue.version,
        decision: 'apply_fields',
        fields: issue.issueType === 'category_assignment'
          ? { categoryId: user.categoryId }
          : { ledgerAccountId: user.accountId }
      }))
      view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    }

    await assert.rejects(service.financeUpdatePost(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, version: view.update.version, mode: 'all_ready'
    })), { publicCode: 'INSUFFICIENT_CASH_BALANCE' })

    const after = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(after.update.status, 'review')
    const [[counts]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM catledger_transactions WHERE uid = ? AND origin = 'import') AS transactions,
         (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid = ?) AS mappings,
         (SELECT COUNT(*) FROM catledger_economic_event_transactions WHERE uid = ? AND update_id = ?) AS links`,
      [user.uid, user.uid, user.uid, view.update.updateId]
    )
    assert.deepEqual({
      transactions: Number(counts.transactions),
      mappings: Number(counts.mappings),
      links: Number(counts.links)
    }, { transactions: 0, mappings: 0, links: 0 })
  } finally {
    await pool.end()
  }
})

test('MySQL 重新解析自动放弃旧 FinanceUpdate，不改变正式账本并可幂等重放', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'abandon')
    const content = fixtureWithSequence(701)
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '待放弃账单.csv', size: content.length }]
    }))
    objects.set(prepared.files[0].cloudPath, content)
    const parsed = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: prepared.files[0].importId,
      fileID: `cloud://synthetic.bucket/${prepared.files[0].cloudPath}`, timezoneOffsetMinutes: -480
    }))

    const selectedAgain = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '再次选择未入账账单.csv', size: content.length }]
    }))
    objects.set(selectedAgain.files[0].cloudPath, content)
    const reused = await service.parseFile(context(user, {
      requestId: randomUUID(), importId: selectedAgain.files[0].importId,
      fileID: `cloud://synthetic.bucket/${selectedAgain.files[0].cloudPath}`, timezoneOffsetMinutes: -480
    }))
    assert.equal(reused.duplicateDisposition, 'reused_unposted')
    assert.equal(reused.reusedImportId, parsed.import.importId)
    assert.equal(reused.import.state, 'review_ready')
    assert.equal(reused.batch.batchId, parsed.batch.batchId)
    assert.equal(reused.duplicateImportId, undefined)

    const created = await service.financeUpdateCreate(context(user, {
      requestId: randomUUID(), batchIds: [reused.batch.batchId]
    }))
    let view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: created.updateId, version: created.version
    }))

    const issue = view.issues.find((item) => item.status === 'open')
    await service.reviewIssueResolve(context(user, {
      requestId: randomUUID(), updateId: view.update.updateId, issueId: issue.issueId,
      updateVersion: view.update.version, issueVersion: issue.version,
      decision: 'apply_fields',
      fields: { ledgerAccountDraft: { name: '替换时不创建', type: 'wallet', currency: 'CNY' } }
    }))
    view = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    const [[before]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM catledger_accounts WHERE uid = ?) AS accounts,
         (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid = ?) AS mappings,
         (SELECT COUNT(*) FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL) AS transactions`,
      [user.uid, user.uid, user.uid]
    )

    const selectedDuringActiveUpdate = await service.prepareMany(context(user, {
      requestId: randomUUID(), files: [{ fileName: '整理中再次选择.csv', size: content.length }]
    }))
    objects.set(selectedDuringActiveUpdate.files[0].cloudPath, content)
    const replacementRequest = {
      requestId: randomUUID(), importId: selectedDuringActiveUpdate.files[0].importId,
      fileID: `cloud://synthetic.bucket/${selectedDuringActiveUpdate.files[0].cloudPath}`,
      timezoneOffsetMinutes: -480
    }
    const resumable = await service.parseFile(context(user, replacementRequest))
    assert.equal(resumable.duplicateDisposition, 'replaced_unposted_update')
    assert.equal(resumable.replacedUpdateId, view.update.updateId)
    assert.equal(resumable.reusedImportId, parsed.import.importId)
    assert.equal(resumable.import.state, 'review_ready')
    assert.equal(resumable.batch.batchId, parsed.batch.batchId)
    assert.equal(resumable.duplicateImportId, undefined)
    assert.deepEqual(await service.parseFile(context(user, replacementRequest)), resumable)

    const replaced = await service.financeUpdateGet(context(user, { updateId: view.update.updateId }))
    assert.equal(replaced.update.status, 'abandoned')
    const [[replacementAction]] = await pool.execute(
      `SELECT action_type AS actionType, reason_codes_json AS reasonCodes
         FROM catledger_finance_actions
        WHERE uid = ? AND update_id = ? AND action_type = 'replace_unposted_update'
        LIMIT 1`,
      [user.uid, view.update.updateId]
    )
    assert.equal(replacementAction.actionType, 'replace_unposted_update')
    assert.deepEqual(
      typeof replacementAction.reasonCodes === 'string'
        ? JSON.parse(replacementAction.reasonCodes)
        : replacementAction.reasonCodes,
      ['unposted_update_replaced_by_reparse']
    )
    const [[replacementActionCount]] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM catledger_finance_actions
        WHERE uid = ? AND update_id = ? AND action_type = 'replace_unposted_update'`,
      [user.uid, view.update.updateId]
    )
    assert.equal(Number(replacementActionCount.count), 1)
    const [[after]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM catledger_accounts WHERE uid = ?) AS accounts,
         (SELECT COUNT(*) FROM catledger_import_account_mappings WHERE uid = ?) AS mappings,
         (SELECT COUNT(*) FROM catledger_transactions WHERE uid = ? AND deleted_at IS NULL) AS transactions`,
      [user.uid, user.uid, user.uid]
    )
    assert.deepEqual(after, before)

    const restarted = await service.financeUpdateCreate(context(user, {
      requestId: randomUUID(), batchIds: [resumable.batch.batchId]
    }))
    assert.notEqual(restarted.updateId, view.update.updateId)
    assert.equal(restarted.status, 'draft')
  } finally {
    await pool.end()
  }
})

test('MySQL 多文件解析失败彼此隔离，成功来源仍可建立更新', { skip: !hasDatabase, timeout: 30000 }, async () => {
  const pool = mysql.createPool(databaseConfig())
  const objects = new Map()
  const storage = {
    async downloadExact(fileID, objectKey) { return objects.get(objectKey) },
    async remove() { return true }
  }
  const service = createImportService({ getPool: () => pool, storage })
  try {
    const user = await createUserLedger(pool, 'isolated-files')
    const contents = [fixtureWithSequence(301), Buffer.from('not,a,supported,bill\n')]
    const prepared = await service.prepareMany(context(user, {
      requestId: randomUUID(),
      files: contents.map((content, index) => ({ fileName: `隔离-${index + 1}.csv`, size: content.length }))
    }))
    const results = []
    for (let index = 0; index < prepared.files.length; index += 1) {
      const file = prepared.files[index]
      objects.set(file.cloudPath, contents[index])
      results.push(await service.parseFile(context(user, {
        requestId: randomUUID(), importId: file.importId,
        fileID: `cloud://synthetic.bucket/${file.cloudPath}`, timezoneOffsetMinutes: -480
      })))
    }
    assert.equal(results[0].import.state, 'review_ready')
    assert.equal(results[1].import.state, 'failed')
    const update = await service.financeUpdateCreate(context(user, {
      requestId: randomUUID(), batchIds: [results[0].batch.batchId]
    }))
    const view = await service.financeUpdateOrganize(context(user, {
      requestId: randomUUID(), updateId: update.updateId, version: update.version
    }))
    assert.equal(view.sources.length, 1)
    assert.equal(view.sources[0].importId, prepared.files[0].importId)
  } finally {
    await pool.end()
  }
})
