const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const { legacyAlipayAccounts } = require('../cloudfunctions/catledger-import/test/helpers/legacy-alipay-accounts')
const { PLAN_VERSION } = require('../cloudfunctions/catledger-import/src/domain-versions')
const { loadObject, saveObject } = require('../cloudfunctions/catledger-import/src/local-review-objects')
const codec = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const oldVersion = 'organizer-plan-v34'
async function setup(lab, mode, apiPool, importPool) {
  const services = localServices({ apiPool, importPool, subject: 'rule-upgrade-' + randomUUID() })
  const { uid } = await call(services.api, 'bootstrap')
  const accounts = []
  for (const name of ['合成信用账户甲', '合成信用账户乙']) accounts.push(await call(services.api, 'accounts.create', { requestId: randomUUID(), name, type: 'credit' }))
  const content = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
    '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
    ...['花呗', '江苏银行信用购'].map((method, index) => `2026-09-01 12:00:00,日用百货,合成商户,合成消费,1.00,支出,${method},交易成功,,RULE-${index},,`)].join('\n'))
  const upload = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成规则升级.csv', size: content.length }] })
  const file = upload.files[0]; services.objects.set(file.cloudPath, content)
  const parsed = await call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
  await legacyAlipayAccounts(lab.owner, uid, parsed.batch.batchId)
  let update = await call(services.import, 'financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
  const issues = (await call(services.import, 'reviewIssues.list', { updateId: update.updateId })).items.filter(issue => issue.issueType === 'account_mapping')
  assert.equal(issues.length, 2)
  if (mode !== 'pending') for (const [index, issue] of issues.entries()) {
    update = await call(services.import, 'reviewIssues.resolve', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
      issueId: issue.issueId, issueVersion: issue.version, decision: 'apply_fields', fields: { ledgerAccountId: accounts[mode === 'conflict' ? index : 0].accountId } })
  }
  const prepared = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
  const snapshot = await loadObject(lab.owner, uid, prepared.snapshot.objectId, 'snapshot')
  // 把合成旧图与封存快照恢复到真实旧代次，升级须完全依赖已存证据。
  const legacyFacts = snapshot.value
  legacyFacts.ruleVersion = oldVersion; legacyFacts.update.planVersion = oldVersion
  const snapshotId = randomUUID(); legacyFacts.snapshotId = snapshotId
  await saveObject(lab.owner, uid, { objectId: snapshotId, updateId: update.updateId, kind: 'snapshot', baseVersion: prepared.update.version, ruleVersion: oldVersion, metadata: { counts: codec.counts(legacyFacts) } }, protocol.split(codec.encodeText(legacyFacts)))
  await lab.owner.execute('UPDATE catledger_finance_updates SET plan_version=? WHERE uid=? AND update_id=?', [oldVersion, uid, update.updateId])
  await lab.owner.execute("UPDATE catledger_import_rows SET semantic_json=JSON_SET(semantic_json,'$.policyVersion','alipay-semantic-policy-v4') WHERE uid=? AND batch_id=?", [uid, parsed.batch.batchId])
  services.objects.clear()
  return { services, uid, updateId: update.updateId, version: prepared.update.version, snapshotId, issues, accounts }
}
async function invariant(pool, uid, updateId) {
  const [events] = await pool.execute('SELECT event_id,amount_minor,event_local_at,ledger_account_id,manual_field_mask FROM catledger_economic_events WHERE uid=? AND update_id=? ORDER BY event_id', [uid, updateId])
  const [rows] = await pool.execute('SELECT row_id,payment_method_key,observed_identity_key,observed_core_digest FROM catledger_import_rows WHERE uid=? ORDER BY row_id', [uid])
  const [[formal]] = await pool.execute('SELECT (SELECT COUNT(*) FROM catledger_accounts WHERE uid=?) AS accounts,(SELECT COUNT(*) FROM catledger_transactions WHERE uid=?) AS transactions', [uid, uid])
  return { events, rows, formal }
}
test('v34账户族升级保留证据和人工决定，冲突转核对，旧快照拒绝且事务可重试', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    for (const mode of ['pending', 'consistent', 'conflict']) await t.test(mode, async () => {
      const c = await setup(lab, mode, apiPool, importPool), { uid, updateId, services } = c
      const before = await invariant(lab.owner, uid, updateId)
      await assert.rejects(call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId, version: c.version }), { publicCode: 'CONFLICT' })
      await assert.rejects(call(services.import, 'financeUpdates.stageDecisions', { requestId: randomUUID(), updateId, snapshotId: c.snapshotId,
        uploadId: randomUUID(), baseVersion: c.version, ruleVersion: PLAN_VERSION, chunkCount: 1, index: 0, content: '{}' }), { publicCode: 'CONFLICT' })
      const oldPayload = { protocolVersion: 3, snapshotId: c.snapshotId, updateId, baseVersion: c.version, ruleVersion: oldVersion,
        decisions: { accounts: [], events: [], pairings: [], reviews: [], duplicates: [] } }
      const oldUploadId = randomUUID(), oldPacked = protocol.split(JSON.stringify(oldPayload), 'decisions')
      await saveObject(lab.owner, uid, { objectId: oldUploadId, updateId, snapshotId: c.snapshotId, kind: 'decisions', baseVersion: c.version, ruleVersion: oldVersion }, oldPacked)
      await assert.rejects(call(services.import, 'financeUpdates.post', { requestId: randomUUID(), protocolVersion: 3, updateId,
        version: c.version, snapshotId: c.snapshotId, uploadId: oldUploadId, payloadDigest: oldPacked.digest }), { publicCode: 'VALIDATION_ERROR' })
      const data = { requestId: randomUUID(), updateId, version: c.version }
      if (mode === 'pending') {
        const trigger = 'fail_upgrade_' + randomUUID().replaceAll('-', '')
        await lab.owner.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON catledger_finance_updates FOR EACH ROW BEGIN IF NEW.uid='${uid}' AND NEW.plan_version='${PLAN_VERSION}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic rollback'; END IF; END`)
        try {
          await assert.rejects(call(services.import, 'financeUpdates.organize', data))
          assert.deepEqual(await invariant(lab.owner, uid, updateId), before)
          const [[actions]] = await lab.owner.execute("SELECT COUNT(*) AS count FROM catledger_finance_actions WHERE uid=? AND action_type='semantic_upgrade'", [uid])
          assert.equal(Number(actions.count), 0)
        } finally { await lab.owner.query('DROP TRIGGER ' + trigger) }
      }
      const [upgraded, replay] = await Promise.all([call(services.import, 'financeUpdates.organize', data), call(services.import, 'financeUpdates.organize', data)])
      assert.deepEqual(upgraded, replay)
      assert.deepEqual(await invariant(lab.owner, uid, updateId), before)
      const summary = await call(services.import, 'financeUpdates.summary', { updateId })
      assert.equal(summary.update.planVersion, PLAN_VERSION)
      const [issues] = await lab.owner.execute("SELECT issue_id AS issueId,status,blocking,primary_reason_code AS reason FROM catledger_review_issues WHERE uid=? AND update_id=? AND issue_type='account_mapping' AND status IN ('open','resolved')", [uid, updateId])
      assert.equal(issues.length, 1); assert.equal(issues[0].status, mode === 'consistent' ? 'resolved' : 'open')
      if (mode === 'conflict') assert.equal(issues[0].reason, 'account_mapping_conflict')
      const [[action]] = await lab.owner.execute("SELECT decision_json AS decision FROM catledger_finance_actions WHERE uid=? AND update_id=? AND action_type='semantic_upgrade'", [uid, updateId])
      const decision = typeof action.decision === 'string' ? JSON.parse(action.decision) : action.decision
      assert.equal(decision.accountIssueMappings.length, 2)
      assert.ok(decision.accountIssueMappings.every(item => item.toIssueId === issues[0].issueId))
      const snapshot = await call(services.import, 'financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId, version: upgraded.appliedVersion })
      assert.notEqual(snapshot.snapshot.objectId, c.snapshotId)
      assert.equal(snapshot.snapshot.ruleVersion, PLAN_VERSION)
      const facts = (await loadObject(lab.owner, uid, snapshot.snapshot.objectId, 'snapshot')).value
      assert.ok(facts.actions.some(item => item.actionType === 'semantic_upgrade' && item.decision.accountIssueMappings.length === 2))
      if (mode === 'consistent') {
        const state = { ...oldPayload, snapshotId: snapshot.snapshot.objectId, baseVersion: snapshot.update.version, ruleVersion: PLAN_VERSION }
        const packed = protocol.split(JSON.stringify(state), 'decisions'), uploadId = randomUUID()
        await saveObject(lab.owner, uid, { objectId: uploadId, updateId, snapshotId: state.snapshotId, kind: 'decisions', baseVersion: state.baseVersion, ruleVersion: PLAN_VERSION }, packed)
        const request = { requestId: randomUUID(), protocolVersion: 3, updateId, version: state.baseVersion, snapshotId: state.snapshotId, uploadId, payloadDigest: packed.digest }
        const posted = await call(services.import, 'financeUpdates.post', request)
        assert.equal(posted.status, 'posted')
        await lab.owner.execute('UPDATE catledger_finance_updates SET plan_version=? WHERE uid=? AND update_id=?', [oldVersion, uid, updateId])
        assert.deepEqual(await call(services.import, 'financeUpdates.post', request), posted, '结果未知后重试沿用原回执，先于规则与对象门禁')
        const [[total]] = await lab.owner.execute('SELECT COUNT(*) AS count,SUM(amount_minor) AS amount FROM catledger_transactions WHERE uid=?', [uid])
        assert.equal(Number(total.count), 2); assert.equal(String(total.amount), '200')
      }
    })
    await t.test('同一事件多个付款角色合并到一个账户事项后可保存和修改', async () => {
      const services = localServices({ apiPool, importPool, subject: 'multi-member-' + randomUUID() })
      const { uid } = await call(services.api, 'bootstrap')
      const account = await call(services.api, 'accounts.create', { requestId: randomUUID(), name: '合成统一信用账户', type: 'credit' })
      const content = Buffer.from(['支付宝(中国)网络技术有限公司 电子客户回单,,,,,,,,,,,',
        '交易时间,交易分类,交易对方,商品说明,金额,收/支,收/付款方式,交易状态,备注,交易订单号,订单号,商家订单号',
        '2026-09-01 12:00:00,日用百货,合成商户,合成组合消费,1.00,支出,花呗&信用购,交易成功,,MULTI-ROLE-001,,'].join('\n'))
      const upload = await call(services.import, 'imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成组合账户.csv', size: content.length }] })
      const file = upload.files[0]; services.objects.set(file.cloudPath, content)
      const parsed = await call(services.import, 'imports.parseFile', { requestId: randomUUID(), importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 })
      let update = await call(services.import, 'financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })
      update = await call(services.import, 'reviewIssues.refreshAccountGroups', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
      const issue = (await call(services.import, 'reviewIssues.list', { updateId: update.updateId })).items.find(row => row.issueType === 'account_mapping' && row.status === 'open')
      const [roles] = await lab.owner.execute('SELECT member_role AS role FROM catledger_review_issue_members WHERE uid=? AND issue_id=? ORDER BY member_role', [uid, issue.issueId])
      assert.deepEqual(roles.map(row => row.role), ['payment_component_0','payment_component_1'])
      update = await call(services.import, 'reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
        decisions: [{ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', fields: { ledgerAccountId: account.accountId } }] })
      const [[event]] = await lab.owner.execute('SELECT field_sources_json AS fields FROM catledger_economic_events WHERE uid=? AND update_id=?', [uid, update.updateId])
      const fields = typeof event.fields === 'string' ? JSON.parse(event.fields) : event.fields
      assert.deepEqual(fields.paymentAccounts, [{ componentIndex: 0, accountId: account.accountId }, { componentIndex: 1, accountId: account.accountId }])
      const revised = await call(services.import, 'reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId, updateVersion: update.appliedVersion,
        decisions: [{ issueId: issue.issueId, issueVersion: issue.version + 1, operation: 'revise', decision: 'apply_fields', fields: { ledgerAccountId: account.accountId } }] })
      assert.equal(revised.status, 'review')
      const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_transactions WHERE uid=?', [uid])
      assert.equal(Number(count.count), 0)
    })
  } finally { await lab.close() }
})
