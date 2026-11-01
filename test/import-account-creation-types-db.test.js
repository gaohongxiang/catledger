const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call, syntheticBill } = require('./helpers/local-services')
const grants = require('../scripts/runtime-role-grants')
const localModel = require('../miniprogram/packages/finance/services/import-local-model')
const identity = require('../cloudfunctions/catledger-import/src/local-review-identity')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const snapshotCodec = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const clone = value => JSON.parse(JSON.stringify(value))
function cardContent() {
  let index = 0
  return Buffer.from(syntheticBill(2, randomUUID()).toString().replace(/微信零钱/g, () =>
    ['合成银行信用卡9900000000001122', '合成银行信用卡9900000000011122'][index++]))
}
async function download(c, objectId) {
  let offset = 0, header
  const descriptors = [], contents = []
  do {
    const page = await c.imp('financeUpdates.snapshotManifest', { objectId, offset })
    header = page.header; descriptors.push(...page.parts); offset = page.nextOffset
  } while (offset != null)
  protocol.validateManifest(header, descriptors)
  for (const part of descriptors) contents.push(protocol.validatePart(header, part,
    await c.imp('financeUpdates.snapshotChunk', { objectId, index: part.index })))
  const value = JSON.parse(contents.join(''))
  return header.kind === 'snapshot' ? snapshotCodec.decode(value) : value
}
async function local(c) {
  const view = await c.summary()
  const prepared = await c.imp('financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: c.updateId, version: view.update.version })
  const facts = await download(c, prepared.snapshot.objectId)
  return { facts, model: localModel.create(facts) }
}
async function post(c, state) {
  const packed = protocol.split(JSON.stringify(state), 'decisions'), uploadId = randomUUID()
  for (const part of packed.parts) await c.imp('financeUpdates.stageDecisions', { requestId: randomUUID(), updateId: c.updateId,
    snapshotId: state.snapshotId, uploadId, baseVersion: state.baseVersion, ruleVersion: state.ruleVersion,
    chunkCount: packed.chunkCount, index: part.index, content: part.content })
  const sealed = await c.imp('financeUpdates.sealDecisions', { requestId: randomUUID(), updateId: c.updateId, snapshotId: state.snapshotId, uploadId })
  const request = { requestId: randomUUID(), protocolVersion: 3, updateId: c.updateId, snapshotId: state.snapshotId,
    uploadId, version: state.baseVersion, payloadDigest: sealed.digest }
  const result = await c.imp('financeUpdates.post', request)
  assert.deepEqual(await c.imp('financeUpdates.post', request), result, '同请求重放不新增或变更账户')
  return result
}

test('账户创建身份与资金类型：真实MySQL最小权限、重名回滚、改名重放与旧决定兼容',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      async function context(content = cardContent(), statementKind) {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-account-contract-' + randomUUID() })
        const c = { services, api: (action, data) => call(services.api, action, data), imp: (action, data) => call(services.import, action, data) }
        c.uid = (await c.api('bootstrap')).uid
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成账户合同.csv', size: content.length }] })).files[0]
        services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        let parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })
        if (parsed.bankPreview) {
          const p = parsed.bankPreview
          parsed = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: { ...p.suggested,
            schemaVersion: 1, sheetIndex: p.sheetIndex, headerRow: p.headerRow, headerToken: p.headerToken, statementKind: statementKind || 'credit' } })
        }
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsed.batch.batchId] })).updateId
        c.summary = () => c.imp('financeUpdates.summary', { updateId: c.updateId })
        c.issues = async () => (await c.imp('reviewIssues.list', { updateId: c.updateId, group: 'accounts', pageSize: 100 })).items
        c.resolve = async (issueId, fields, extra = {}) => {
          const issue = (await c.issues()).find(row => row.issueId === issueId)
          const request = { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await c.summary()).update.version,
            decisions: [{ issueId, issueVersion: issue.version, operation: issue.status === 'resolved' ? 'revise' : 'resolve',
              decision: 'apply_fields', fields, ...extra }] }
          return c.imp('reviewIssues.resolveAccountMappings', request)
        }
        c.drafts = async () => (await lab.owner.execute(`SELECT draft_account_id AS accountId,name,type,superseded_at AS supersededAt
          FROM catledger_finance_update_account_drafts WHERE uid=? AND update_id=? ORDER BY name`, [c.uid, c.updateId]))[0]
        return c
      }

      await t.test('两张同尾号卡的批量新建重名整体回滚，不能在服务端共用一个账户', async () => {
        const c = await context(), issues = await c.issues()
        assert.equal(issues.length, 2)
        assert.equal(issues[0].accountContext.label, issues[1].accountContext.label)
        assert.notEqual(issues[0].accountContext.bindingKey, issues[1].accountContext.bindingKey)
        const request = { requestId: randomUUID(), updateId: c.updateId, updateVersion: (await c.summary()).update.version,
          decisions: issues.map(issue => ({ issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields',
            fields: { mappingAccountDraft: { name: '合成同名信用卡', type: 'credit', currency: 'CNY' } } })) }
        await assert.rejects(c.imp('reviewIssues.resolveAccountMappings', request), { publicCode: 'ACCOUNT_NAME_CONFLICT' })
        assert.equal((await c.drafts()).length, 0)
        assert.equal((await c.api('accounts.list')).accounts.length, 0)
        assert.ok((await c.issues()).every(issue => issue.status === 'open' && !issue.accountContext.accountId))
      })

      await t.test('同一创建改名保留ID；外部归属再改回可恢复同一个草稿；显式复用可共用', async () => {
        const c = await context(), [first, second] = await c.issues()
        const make = name => ({ mappingAccountDraft: { name, type: 'credit', currency: 'CNY' } })
        await assert.rejects(c.resolve(first.issueId, { ...make('合成重复选择'), mappingAccountId: randomUUID() }), { publicCode: 'VALIDATION_ERROR' })
        assert.equal((await c.drafts()).length, 0)
        await c.resolve(first.issueId, make('合成信用卡甲'))
        const id = (await c.drafts())[0].accountId
        await c.resolve(first.issueId, make('合成信用卡乙'))
        assert.deepEqual((await c.drafts()).map(row => [row.accountId, row.name]), [[id, '合成信用卡乙']])
        await c.resolve(first.issueId, {}, { paymentRuleAction: 'external' })
        assert.ok((await c.drafts())[0].supersededAt)
        await c.resolve(first.issueId, make('合成信用卡乙'))
        assert.equal((await c.drafts())[0].accountId, id)
        assert.equal((await c.drafts())[0].supersededAt, null)
        await assert.rejects(c.resolve(second.issueId, make('合成信用卡乙')), { publicCode: 'ACCOUNT_NAME_CONFLICT' })
        await c.resolve(second.issueId, { mappingAccountId: id })
        assert.ok((await c.issues()).every(issue => issue.accountContext.accountId === id))
      })

      await t.test('零钱通与信用账单服务端类型复核拒绝错误默认，并保持事务无草稿残留', async () => {
        const cases = [[Buffer.from(syntheticBill(1, randomUUID()).toString().replace('微信零钱', '微信零钱通')), undefined, 'other_asset', 'wallet'],
          [Buffer.from('交易日期,交易金额,收支,交易类型,卡号,流水号,摘要\n2026-09-01,12.00,支出,消费,9900000000001122,SYNTHETIC-CREDIT,合成消费'), 'credit', 'credit', 'bank']]
        for (const [content, statementKind, expected, wrong] of cases) {
          const c = await context(content, statementKind), [issue] = await c.issues()
          assert.equal(issue.accountContext.defaultAccountType, expected)
          assert.deepEqual(issue.accountContext.allowedAccountTypes, [expected])
          await assert.rejects(c.resolve(issue.issueId, { mappingAccountDraft: { name: '合成错误类型', type: wrong, currency: 'CNY' } }), { publicCode: 'VALIDATION_ERROR' })
          assert.equal((await c.drafts()).length, 0)
          await c.resolve(issue.issueId, { mappingAccountDraft: { name: '合成正确类型', type: expected, currency: 'CNY' } })
          assert.equal((await c.drafts())[0].type, expected)
        }
      })

      await t.test('本机两次独立新建和改名最终入账保留两个稳定ID，重放不重复账户', async () => {
        const c = await context(), { facts, model } = await local(c)
        const issues = [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping')
        for (const [index, issue] of issues.entries()) model.mapAccount({ issueId: issue.issueId, decision: 'apply_fields',
          fields: { mappingAccountDraft: { name: '合成本机信用卡' + index, type: 'credit', currency: 'CNY' } } })
        const firstId = model.events.get(issues[0].subjectEventIds[0]).ledgerAccountId
        model.mapAccount({ issueId: issues[0].issueId, decision: 'apply_fields',
          fields: { mappingAccountDraft: { name: '合成本机改名卡', type: 'credit', currency: 'CNY' } } })
        assert.equal(model.events.get(issues[0].subjectEventIds[0]).ledgerAccountId, firstId)
        const ids = [...model.drafts.keys()].sort(), state = model.finalState()
        assert.equal(ids.length, 2)
        assert.ok(state.decisions.accounts.every(choice => choice.fields.mappingAccountDraft.creationKey ===
          identity.accountCreationKey(facts.members.filter(member => member.issueId === choice.issueId), facts.events)))
        const posted = await post(c, state)
        if (posted.outcome === 'recheck') assert.fail(JSON.stringify((await download(c, posted.recheck.objectId)).problems))
        assert.equal(posted.status, 'posted')
        assert.deepEqual((await c.api('accounts.list')).accounts.map(account => account.accountId).sort(), ids)
      })

      await t.test('旧冻结keyless同名两次创建得到明确重核，保留原请求且没有静默合并', async () => {
        const c = await context(), { model } = await local(c)
        for (const [index, issue] of [...model.issues.values()].filter(issue => issue.issueType === 'account_mapping').entries()) {
          model.mapAccount({ issueId: issue.issueId, decision: 'apply_fields',
            fields: { mappingAccountDraft: { name: '旧合成卡' + index, type: 'credit', currency: 'CNY' } } })
        }
        const state = clone(model.finalState())
        for (const choice of state.decisions.accounts) { delete choice.fields.mappingAccountDraft.creationKey; choice.fields.mappingAccountDraft.name = '旧同名合成卡' }
        const before = JSON.stringify(state), result = await post(c, state)
        assert.equal(result.outcome, 'recheck')
        assert.ok((await download(c, result.recheck.objectId)).problems.some(problem => problem.reason === 'ACCOUNT_NAME_CONFLICT'))
        assert.equal(JSON.stringify(state), before)
        assert.equal((await c.api('accounts.list')).accounts.length, 0)
        assert.equal((await c.drafts()).length, 0)
      })

      await t.test('本机配对后银行归属改外部，再拆分时恢复引用成员，重启和最终入账一致', async () => {
        const c = await require('./helpers/bank-pairing').setup({ apiPool, importPool, count: 1, bankNature: '消费' })
        const { facts, model } = await local(c), records = []
        const [candidate] = model.pairs.values()
        assert.ok(candidate)
        const bankIssue = [...model.issues.values()].find(issue => issue.issueType === 'account_mapping' && issue.accountContext?.sourceType === 'bank')
        assert.ok(bankIssue)
        records.push({ changes: clone(model.pair({ pairKey: candidate.pairKey, decision: 'same' })) })
        assert.ok(model.events.get(candidate.platform.eventId).fieldSources.bankChannelAccountContexts[bankIssue.issueId])
        records.push({ changes: clone(model.mapAccount({ issueId: bankIssue.issueId, decision: 'apply_fields', paymentRuleAction: 'external', fields: {} })) })
        assert.equal(model.events.get(candidate.platform.eventId).status, 'needs_action')
        assert.ok(model.events.get(candidate.platform.eventId).reasonCodes.includes('account_ownership_recheck_required'))
        records.push({ changes: clone(model.reviseDuplicate({ eventId: candidate.platform.eventId, decision: 'distinct' })) })
        assert.equal(model.events.get(candidate.bank.eventId).status, 'excluded')
        assert.equal(model.events.get(candidate.platform.eventId).ledgerAccountId, c.accountId)
        assert.ok(model.members.get(bankIssue.issueId).every(member => member.objectId === candidate.bank.eventId))
        require('../cloudfunctions/catledger-import/src/local-review-submit').validateChoices(model.finalState(), facts)
        const restored = require('../miniprogram/packages/finance/services/import-local-session').create({
          restored: { facts, records }, files: { save() {}, touch() {}, close() {} }, requestId: randomUUID })
        assert.equal(restored.model.invalid.size, 0)
        assert.equal(restored.model.events.get(candidate.bank.eventId).status, 'excluded')
        const posted = await post(c, restored.model.finalState())
        if (posted.outcome === 'recheck') assert.fail(JSON.stringify((await download(c, posted.recheck.objectId)).problems))
        assert.equal(posted.status, 'posted')
        assert.equal(posted.posting.createdTransactionCount, 1)
      })
    } finally { await lab.close() }
  })
