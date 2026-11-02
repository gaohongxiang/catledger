const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate } = require('./helpers/local-services')
const { digestParts } = require('../cloudfunctions/catledger-import/src/digest')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')
const codec = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')
const { rebase } = require('../miniprogram/packages/finance/services/import-local-decisions')
const creationFacts = require('../cloudfunctions/catledger-import/src/account-creation-facts')
const identity = require('../cloudfunctions/catledger-import/src/local-review-identity')
const clone = value => JSON.parse(JSON.stringify(value))
const create = name => ({ decision: 'apply_fields', fields: { mappingAccountDraft: { name, type: 'bank', currency: 'CNY' } } })
const external = { decision: 'apply_fields', paymentRuleAction: 'external', fields: {} }

async function download(c, objectId) {
  let offset = 0, header
  const descriptors = [], content = []
  do {
    const page = await c.imp('financeUpdates.snapshotManifest', { objectId, offset })
    header = page.header; descriptors.push(...page.parts); offset = page.nextOffset
  } while (offset != null)
  protocol.validateManifest(header, descriptors)
  for (const part of descriptors) content.push(protocol.validatePart(header, part,
    await c.imp('financeUpdates.snapshotChunk', { objectId, index: part.index })))
  const value = JSON.parse(content.join(''))
  return header.kind === 'snapshot' ? codec.decode(value) : value
}
async function stage(c, state) {
  const packed = protocol.split(JSON.stringify(state), 'decisions'), uploadId = randomUUID()
  for (const part of packed.parts) await c.imp('financeUpdates.stageDecisions', { requestId: randomUUID(), updateId: c.updateId,
    snapshotId: state.snapshotId, uploadId, baseVersion: state.baseVersion, ruleVersion: state.ruleVersion,
    chunkCount: packed.chunkCount, index: part.index, content: part.content })
  const sealed = await c.imp('financeUpdates.sealDecisions', { requestId: randomUUID(), updateId: c.updateId, snapshotId: state.snapshotId, uploadId })
  return { requestId: randomUUID(), protocolVersion: 3, updateId: c.updateId, snapshotId: state.snapshotId,
    uploadId, version: state.baseVersion, payloadDigest: sealed.digest }
}

test('共享新建草稿真实MySQL：创建者外部、可信成员、整批回滚和原请求重放',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      async function context(count = 2, suppliedServices) {
        const services = suppliedServices || localServices({ apiPool, importPool, subject: 'synthetic-shared-draft-' + randomUUID() })
        const c = { services, api: (action, data) => call(services.api, action, data), imp: (action, data) => call(services.import, action, data) }
        c.uid = (await c.api('bootstrap')).uid
        c.updateId = (await prepareSyntheticUpdate(services, count, randomUUID(), '合成银行储蓄卡(9900000000001122)')).updateId
        const [[issue]] = await lab.owner.execute("SELECT * FROM catledger_review_issues WHERE uid=? AND update_id=? AND issue_type='account_mapping'", [c.uid, c.updateId])
        const [members] = await lab.owner.execute('SELECT * FROM catledger_review_issue_members WHERE uid=? AND issue_id=? ORDER BY sort_order', [c.uid, issue.issue_id])
        assert.equal(members.length, count)
        // 合成历史事项分组：两份真实原成员保留各自入口，来源与账户引用原样。
        const second = { ...issue, issue_id: randomUUID(), issue_key: digestParts('synthetic-shared-original-issue', c.updateId), member_count: 1 }
        for (const [key, value] of Object.entries(second)) if (key.endsWith('_json') && value && typeof value !== 'string') second[key] = JSON.stringify(value)
        await lab.owner.query('INSERT INTO catledger_review_issues SET ?', second)
        await lab.owner.execute('UPDATE catledger_review_issues SET member_count=? WHERE uid=? AND issue_id=?', [count - 1, c.uid, issue.issue_id])
        await lab.owner.execute('UPDATE catledger_review_issue_members SET issue_id=?,sort_order=0 WHERE uid=? AND member_id=?', [second.issue_id, c.uid, members[count - 1].member_id])
        const summary = await c.imp('financeUpdates.summary', { updateId: c.updateId })
        const prepared = await c.imp('financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: c.updateId, version: summary.update.version })
        c.facts = await download(c, prepared.snapshot.objectId)
        c.issueIds = c.facts.issues.filter(row => row.issueType === 'account_mapping').map(row => row.issueId)
        assert.equal(c.issueIds.length, 2)
        c.records = []
        c.files = { save(changes) { c.records.push({ changes: clone(changes) }) }, touch() {}, close() {} }
        c.restart = () => sessions.create({ restored: { facts: c.facts, records: c.records }, files: c.files, requestId: randomUUID })
        c.session = c.restart()
        c.counts = async () => {
          const result = {}
          for (const table of ['accounts', 'transactions', 'finance_update_account_drafts', 'finance_update_account_mapping_drafts']) {
            const [[row]] = await lab.owner.execute('SELECT COUNT(*) AS count FROM catledger_' + table + ' WHERE uid=?', [c.uid])
            result[table] = Number(row.count)
          }
          return result
        }
        return c
      }
      async function renew(c) {
        const prior = c.facts, summary = await c.imp('financeUpdates.summary', { updateId: c.updateId })
        const prepared = await c.imp('financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: c.updateId, version: summary.update.version, force: true })
        c.facts = await download(c, prepared.snapshot.objectId)
        c.records = [{ changes: rebase(c.records, prior, c.facts) }]
        c.session = c.restart()
        assert.equal(c.session.model.invalid.size, 0)
        return prior
      }
      function retainOne(c, name = '合成共享账户') {
        const group = c.session.confirmAccountGroup({ issueIds: c.issueIds, decision: create(name) }).accountGroups[0]
        c.session.confirmAccountGroup({ issueIds: [group.creatorIssueId], decision: external })
        c.session = c.restart()
        assert.equal(c.session.model.invalid.size, 0)
        assert.equal(c.session.model.finalState().accountCreations.length, 1)
        return group
      }
      const empty = { accounts: 0, transactions: 0, finance_update_account_drafts: 0, finance_update_account_mapping_drafts: 0 }

      await t.test('创建者外部后冷启动仍可整批入账，仅创建一个账户并只记剩余本人资金', async () => {
        const c = await context(); retainOne(c)
        const prior = await renew(c), state = c.session.model.finalState(), request = await stage(c, state)
        assert.equal(state.accountCreations[0].origin.snapshotId, prior.snapshotId, '新快照仍用原封存快照证明完整创建范围')
        const accountId = creationFacts.accountId(state.accountCreations[0], state.snapshotId)
        const posted = await c.imp('financeUpdates.post', request)
        if (posted.outcome === 'recheck') assert.fail(JSON.stringify((await download(c, posted.recheck.objectId)).problems))
        assert.equal(posted.status, 'posted')
        assert.equal(posted.posting.createdTransactionCount, 1)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        const accounts = (await c.api('accounts.list')).accounts
        assert.equal(accounts.length, 1); assert.equal(accounts[0].accountId, accountId)
        const [transactions] = await lab.owner.execute('SELECT type,amount_minor AS amount,source_account_id AS source FROM catledger_transactions WHERE uid=?', [c.uid])
        assert.deepEqual(transactions.map(row => [row.type, String(row.amount), row.source]), [['expense', '100', accountId]])
      })

      await t.test('先选已有再联合新建的reuse-before-create最终决定可完整入账', async () => {
        const c = await context(), issueIds = [...c.issueIds].sort()
        const accountId = (await c.api('accounts.create', { requestId: randomUUID(), name: '合成先选账户', type: 'bank' })).accountId
        c.session.model.accounts.set(accountId, { accountId, name: '合成先选账户', type: 'bank', nature: 'asset', currency: 'CNY' })
        c.session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: issueIds[1], decision: 'apply_fields', fields: { mappingAccountId: accountId } }] })
        const group = c.session.confirmAccountGroup({ issueIds, decision: create('合成后建共享账户') }).accountGroups[0]
        const state = c.session.model.finalState(), frozen = JSON.stringify(state)
        assert.deepEqual(state.decisions.accounts.map(item => creationFacts.draftOf(item) ? 'create' : 'reuse'), ['reuse', 'create'])
        const posted = await c.imp('financeUpdates.post', await stage(c, state))
        assert.equal(posted.status, 'posted'); assert.equal(posted.posting.createdTransactionCount, 2)
        assert.equal(JSON.stringify(state), frozen)
        const [rows] = await lab.owner.execute('SELECT DISTINCT source_account_id AS id FROM catledger_transactions WHERE uid=?', [c.uid])
        assert.deepEqual(rows.map(row => row.id), [group.accountId])
      })

      await t.test('伪造成员、创建key或类型不能建立账户，原合法请求可继续', async () => {
        const c = await context(); retainOne(c)
        const valid = c.session.model.finalState(), before = JSON.stringify(valid)
        for (const mutate of [
          state => { state.accountCreations[0].members[0].issueId = c.issueIds.find(id => id !== state.accountCreations[0].members[0].issueId) },
          state => { state.accountCreations[0].key = state.accountCreations[0].draft.creationKey = 'a'.repeat(64) },
          state => { state.accountCreations[0].draft.type = 'credit' }
        ]) {
          const forged = clone(valid); mutate(forged)
          const result = await c.imp('financeUpdates.post', await stage(c, forged))
          assert.equal(result.outcome, 'recheck')
          assert.deepEqual(await c.counts(), empty)
        }
        const sources = clone(valid); sources.accountCreations[0].sourceIds = [randomUUID()]
        await assert.rejects(c.imp('financeUpdates.post', await stage(c, sources)), { publicCode: 'VALIDATION_ERROR' })
        assert.deepEqual(await c.counts(), empty)
        assert.equal(JSON.stringify(valid), before)
        assert.equal((await c.imp('financeUpdates.post', await stage(c, valid))).status, 'posted')
      })

      await t.test('删减真实原成员并重算key和来源仍拒绝，跨批/跨用户/缺失origin均不得认领', async () => {
        const c = await context(3), creator = c.facts.issues.find(issue => issue.issueType === 'account_mapping' && Number(issue.memberCount) === 2)
        const survivor = c.issueIds.find(id => id !== creator.issueId)
        c.session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: creator.issueId, ...create('合成完整原组账户') }] })
        const accountId = [...c.session.model.drafts.keys()][0]
        c.session.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: [{ issueId: survivor, decision: 'apply_fields', fields: { mappingAccountId: accountId } }] })
        c.session.confirmAccountGroup({ issueIds: [creator.issueId], decision: external })
        const valid = c.session.model.finalState(), forged = clone(valid), fact = forged.accountCreations[0]
        fact.members = fact.members.slice(0, 1)
        fact.sourceIds = c.facts.evidence.filter(row => row.eventId === fact.members[0].objectId).map(row => row.rowId)
        fact.key = fact.draft.creationKey = identity.accountCreationKey(fact.members, c.facts.events)
        forged.decisions.accounts.find(item => item.issueId === survivor).fields.mappingAccountId = creationFacts.accountId(fact, forged.snapshotId)
        assert.equal((await c.imp('financeUpdates.post', await stage(c, forged))).outcome, 'recheck')
        assert.deepEqual(await c.counts(), empty)
        const sameUser = await context(2, c.services), otherUser = await context()
        for (const origin of [{ snapshotId: sameUser.facts.snapshotId, issueId: sameUser.issueIds[0] },
          { snapshotId: otherUser.facts.snapshotId, issueId: otherUser.issueIds[0] },
          { snapshotId: randomUUID(), issueId: creator.issueId }]) {
          const wrong = clone(valid); wrong.accountCreations[0].origin = origin
          assert.equal((await c.imp('financeUpdates.post', await stage(c, wrong))).outcome, 'recheck')
          assert.deepEqual(await c.counts(), empty)
        }
        assert.equal((await c.imp('financeUpdates.post', await stage(c, valid))).status, 'posted')
      })

      await t.test('所有引用改外部后不创建正式账户，旧创建事实不成为额外副作用', async () => {
        const c = await context()
        c.session.confirmAccountGroup({ issueIds: c.issueIds, decision: create('合成最终不用账户') })
        c.session.confirmAccountGroup({ issueIds: c.issueIds, decision: external })
        c.session = c.restart()
        const state = c.session.model.finalState()
        assert.equal(state.accountCreations, undefined)
        const posted = await c.imp('financeUpdates.post', await stage(c, state))
        assert.equal(posted.status, 'posted'); assert.equal(posted.posting.createdTransactionCount, 0)
        const counts = await c.counts()
        assert.equal(counts.accounts, 0); assert.equal(counts.transactions, 0); assert.equal(counts.finance_update_account_drafts, 0)
      })

      await t.test('正式写入故障回滚独立创建和全部账户决定，同一冻结请求重试成功', async () => {
        const c = await context(); retainOne(c, '合成回滚共享账户')
        const state = c.session.model.finalState(), request = await stage(c, state), frozen = JSON.stringify(request)
        await lab.owner.query(`CREATE TRIGGER synthetic_shared_draft_rollback BEFORE INSERT ON catledger_transactions
          FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic shared posting failure'`)
        try { await assert.rejects(c.imp('financeUpdates.post', request), { publicCode: 'INTERNAL_ERROR' }) }
        finally { await lab.owner.query('DROP TRIGGER synthetic_shared_draft_rollback') }
        assert.deepEqual(await c.counts(), empty)
        assert.equal(JSON.stringify(request), frozen)
        const posted = await c.imp('financeUpdates.post', request)
        assert.equal(posted.status, 'posted'); assert.equal(posted.posting.createdTransactionCount, 1)
        assert.deepEqual(await c.imp('financeUpdates.post', request), posted)
        assert.equal((await c.counts()).accounts, 1)
      })
    } finally { await lab.close() }
  })
