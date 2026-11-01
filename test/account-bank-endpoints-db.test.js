const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const bankMappingView = require('../miniprogram/packages/finance/pages/import-workbench/bank-mapping')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/manual-field-mask')
const { loadObject, saveObject } = require('../cloudfunctions/catledger-import/src/local-review-objects')
const snapshotCodec = require('../cloudfunctions/catledger-import/src/local-review-snapshot')
const protocol = require('../cloudfunctions/catledger-import/src/local-review-protocol')

const ownNumber = '9900000000001122', otherNumber = '8800000000001122'
const ledger = accountId => ({ kind: 'ledger', accountId })
const external = { kind: 'external' }

test('银行双端：真实解析、账户确认、编辑、入账、余额与重导保持一致',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 240000 }, async t => {
    const lab = await isolatedMysql(), logs = []
    try {
      const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
      async function setup() {
        const services = localServices({ apiPool, importPool, subject: 'synthetic-bank-endpoints-' + randomUUID(),
          logger: { warn: value => logs.push(value), error: value => logs.push(value) } })
        const c = { services, api: (action, data) => call(services.api, action, data),
          imp: (action, data) => call(services.import, action, data) }
        c.uid = (await c.api('bootstrap')).uid
        for (const side of ['source', 'destination']) c[side] = (await c.api('accounts.create', {
          requestId: randomUUID(), type: 'bank', name: '合成双端-' + side, currency: 'CNY',
          openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-08-01T00:00:00', timezoneOffsetMinutes: -480
        })).accountId
        return c
      }
      const summary = c => c.imp('financeUpdates.summary', { updateId: c.updateId })
      const events = async c => (await c.imp('economicEvents.list', { updateId: c.updateId })).items
      const issues = async c => (await c.imp('reviewIssues.list', { updateId: c.updateId,
        group: 'accounts', status: 'open' })).items.filter(issue => issue.issueType === 'account_mapping')
      const balances = async c => Object.fromEntries((await c.api('accounts.list')).accounts
        .filter(account => [c.source, c.destination].includes(account.accountId)).map(account => [account.accountId, account.bookBalanceMinor]))
      const imported = async c => (await lab.owner.execute(`SELECT transaction_id,type,source_account_id,destination_account_id,amount_minor
        FROM catledger_transactions WHERE uid=? AND origin='import' AND deleted_at IS NULL ORDER BY transaction_id`, [c.uid]))[0]
      const sourceRows = async (c, batchId) => (await lab.owner.execute(`SELECT row_id,observed_identity_key,observed_core_digest,payment_method_key,
        transaction_time_raw,amount_raw,direction_raw,transaction_type_raw,counterparty_raw,payment_method_raw,raw_fields_json
        FROM catledger_import_rows WHERE uid=? AND batch_id=? ORDER BY row_id`, [c.uid, batchId]))[0]

      function contentFor({ direction, own = ownNumber, other = otherNumber, prefix = '' }) {
        return Buffer.from(prefix + '交易日期,交易金额,收支,交易类型,本方账号,对方户名,对方账号,流水号\n' +
          ['2026-09-02 09:30:00', '100.00', direction === 'income' ? '收入' : '支出', '转账', own,
            '合成甲', other, 'SYNTHETIC-BANK-ENDPOINT-TRANSFER'].join(','))
      }
      async function parse(c, content) {
        const file = (await c.imp('imports.prepareMany', { requestId: randomUUID(), files: [
          { fileName: '合成银行双端.csv', size: content.length }
        ] })).files[0]
        c.services.objects.set(file.cloudPath, content)
        const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
        const inspected = await c.imp('imports.parseFile', { requestId: randomUUID(), ...input })
        if (!inspected.mappingRequired) return inspected
        const p = inspected.bankPreview
        const payload = bankMappingView.payload(bankMappingView.view(file.importId, '合成银行双端.csv', p))
        assert.equal(payload.error, undefined)
        assert.equal(payload.value.columns.counterpartyAccount, 6, '实际页面提交不得丢掉已识别的对方账号列')
        return c.imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: payload.value })
      }
      async function prepare(c, content) {
        const parsed = await parse(c, content)
        c.batchId = parsed.batch.batchId
        // 模拟保留下来的旧语义快照，迫使 selectPlanningRows 从原始独立列重建两端。
        await lab.owner.execute(`UPDATE catledger_import_rows SET semantic_json=JSON_SET(semantic_json,
          '$.profileVersion','bank-profile-v4','$.policyVersion','bank-policy-v4') WHERE uid=? AND batch_id=?`, [c.uid, c.batchId])
        c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [c.batchId] })).updateId
        return parsed
      }
      async function confirm(c, kinds = { from: 'ledger', to: 'ledger' }) {
        const pending = await issues(c)
        const decisions = pending.map(issue => {
          const side = issue.accountContext.fundsSide
          assert.ok(['from', 'to'].includes(side))
          return { issueId: issue.issueId, issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields',
            ...(kinds[side] === 'external' ? { paymentRuleAction: 'external', fields: {} }
              : { fields: { mappingAccountId: side === 'from' ? c.source : c.destination } }) }
        })
        if (decisions.length) await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions })
      }
      async function edit(c, decisions) {
        const event = (await events(c))[0]
        return c.imp('financeUpdates.setReview', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, eventId: event.eventId, eventVersion: event.version,
          editorVersion: 1, fields: { note: '合成双端核对' }, ...(decisions ? { decisions } : {}) })
      }
      const postRequest = async c => ({ requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })

      async function legacy(c, mode = 'unknown') {
        await prepare(c, contentFor({ direction: 'income' }))
        const pending = await issues(c), own = pending.find(issue => issue.accountContext.fundsSide === 'to')
        await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: [{ issueId: own.issueId, issueVersion: own.version,
            operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: c.destination } }] })
        await edit(c)
        const [[stored]] = await lab.owner.execute('SELECT event_id AS eventId,field_sources_json AS fields FROM catledger_economic_events WHERE uid=? AND update_id=?', [c.uid, c.updateId])
        const fields = typeof stored.fields === 'string' ? JSON.parse(stored.fields) : stored.fields
        fields.fundsProjection = null
        delete fields.accountOwnership
        if (mode === 'ownership') fields.accountOwnership = { version: 'account-ownership-v1', confirmedBy: 'user',
          businessNature: 'internal_transfer', source: 'ledger', destination: 'ledger' }
        const two = ['two', 'ownership'].includes(mode), nature = two ? 'internal_transfer' : mode
        const mask = FIELD_MASK.ledgerAccountId | FIELD_MASK.note |
          (mode === 'unknown' ? 0 : FIELD_MASK.economicNature | FIELD_MASK.flowDirection) |
          (two ? FIELD_MASK.counterpartyLedgerAccountId : 0)
        // c9b96f4 的旧事件以 ledger 列保存账单观察端；只有本方账号卡，没有银行双端投影。
        await lab.owner.execute(`UPDATE catledger_economic_events SET economic_nature=?,flow_direction=?,ledger_account_id=?,
          counterparty_ledger_account_id=?,manual_field_mask=?,field_sources_json=?,reason_codes_json=?,status=?,state=?
          WHERE uid=? AND event_id=?`, [nature, two ? 'neutral' : 'inflow', c.destination, two ? c.source : null,
          mask, JSON.stringify(fields), JSON.stringify(mode === 'unknown' ? ['economic_nature_required'] : []),
          mode === 'unknown' ? 'needs_action' : 'ready', mode === 'unknown' ? 'needs_action' : 'ready', c.uid, stored.eventId])
        await lab.owner.execute(`UPDATE catledger_review_issues SET status='superseded',blocking=0 WHERE uid=? AND update_id=?
          AND issue_type='account_mapping' AND issue_id<>?`, [c.uid, c.updateId, own.issueId])
        await lab.owner.execute("UPDATE catledger_review_issue_members SET member_role='subject' WHERE uid=? AND issue_id=? AND member_role='mapping_to'", [c.uid, own.issueId])
        const [rows] = await lab.owner.execute('SELECT row_id AS rowId,semantic_json AS semantic FROM catledger_import_rows WHERE uid=? AND batch_id=?', [c.uid, c.batchId])
        for (const row of rows) {
          const semantic = typeof row.semantic === 'string' ? JSON.parse(row.semantic) : row.semantic
          Object.assign(semantic, { profileVersion: 'bank-profile-v4', policyVersion: 'bank-policy-v4', sourceAction: null,
            fromAccountRef: null, toAccountRef: semantic.ledgerAccountRef, fundsProjection: null,
            legacy: { kind: 'unknown', transactionType: 'unknown', economicEffect: 'normal', rule: 'bank.action.review.v1' } })
          await lab.owner.execute('UPDATE catledger_import_rows SET semantic_json=? WHERE uid=? AND row_id=?', [JSON.stringify(semantic), c.uid, row.rowId])
        }
        return { eventId: stored.eventId, mask, fields }
      }
      async function upgrade(c) {
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v44' WHERE uid=? AND update_id=?", [c.uid, c.updateId])
        return c.imp('financeUpdates.organize', { requestId: randomUUID(), updateId: c.updateId, version: (await summary(c)).update.version })
      }

      for (const direction of ['income', 'expense']) {
        for (const nature of ['internal_transfer', 'income', 'expense']) await t.test(direction + ' 来源确认成 ' + nature + '，入账只改变实际本人端', async () => {
          const c = await setup(), content = contentFor({ direction }), parsed = await prepare(c, content)
          const originalBatch = c.batchId, raw = await sourceRows(c, originalBatch), before = await balances(c)
          const initial = (await events(c))[0]
          assert.equal(initial.status, 'needs_action')
          assert.equal(initial.transferOwnershipPending, true)
          assert.equal(initial.fundsProjection.accountOrder, 'actual')
          assert.equal(initial.fundsProjection.from.binding.identityKind, 'full_number')
          assert.equal(initial.fundsProjection.to.binding.identityKind, 'full_number')
          assert.equal((await issues(c)).length, 2)
          await assert.rejects(c.imp('financeUpdates.post', await postRequest(c)), { publicCode: 'UNRESOLVED_IMPORT' })
          const kinds = nature === 'income' ? { from: 'external', to: 'ledger' }
            : nature === 'expense' ? { from: 'ledger', to: 'external' } : { from: 'ledger', to: 'ledger' }
          await confirm(c, kinds)
          assert.equal((await events(c))[0].economicNature, nature)
          // 已确认的实际端点经真实编辑保存，再从收支回改成转账再改回，均不倒置。
          await edit(c)
          await edit(c, { accountOwnership: { source: ledger(c.source), destination: ledger(c.destination) } })
          assert.equal((await events(c))[0].economicNature, 'internal_transfer')
          if (nature !== 'internal_transfer') await edit(c, { accountOwnership: {
            source: nature === 'income' ? external : ledger(c.source),
            destination: nature === 'expense' ? external : ledger(c.destination) } })
          const ready = (await events(c))[0]
          assert.equal(ready.economicNature, nature)
          assert.equal(ready.sourceDirection, direction)
          assert.equal(ready.status, 'ready')
          assert.deepEqual(await balances(c), before, '核对保存不改正式余额')
          assert.equal((await imported(c)).length, 0)
          const request = await postRequest(c), receipt = await c.imp('financeUpdates.post', request)
          assert.deepEqual(await c.imp('financeUpdates.post', request), receipt)
          const rows = await imported(c)
          assert.equal(rows.length, 1)
          assert.equal(rows[0].type, nature === 'internal_transfer' ? 'transfer' : nature)
          assert.equal(rows[0].source_account_id, nature === 'income' ? null : c.source)
          assert.equal(rows[0].destination_account_id, nature === 'expense' ? null : c.destination)
          assert.equal(String(rows[0].amount_minor), '10000')
          const after = await balances(c)
          assert.equal(BigInt(after[c.source]) - BigInt(before[c.source]), nature === 'income' ? 0n : -10000n)
          assert.equal(BigInt(after[c.destination]) - BigInt(before[c.destination]), nature === 'expense' ? 0n : 10000n)
          assert.deepEqual(await sourceRows(c, originalBatch), raw)
          const duplicate = await parse(c, content)
          assert.equal(duplicate.duplicateImportId, parsed.import.importId)
          const freshFile = await parse(c, contentFor({ direction, prefix: '合成银行账户明细\n' }))
          c.updateId = (await c.imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [freshFile.batch.batchId] })).updateId
          assert.ok((await events(c)).every(event => event.status === 'excluded'), '完整本方账号与流水身份不因文件变化而重记')
          assert.deepEqual(await balances(c), after)
          assert.deepEqual(await imported(c), rows)
        })
      }

      await t.test('缺对方账号只保留缺端待办，不把户名认成账户或默认为外部', async () => {
        for (const direction of ['income', 'expense']) {
          const c = await setup()
          await prepare(c, contentFor({ direction, other: '' }))
          assert.equal((await issues(c)).length, 1)
          await confirm(c)
          const event = (await events(c))[0]
          assert.equal(event.economicNature, 'internal_transfer')
          assert.equal(event.status, 'needs_action')
          assert.equal(event.transferOwnershipPending, true)
          const review = await c.imp('reviewIssues.list', { updateId: c.updateId, status: 'open' })
          assert.ok(review.items.some(issue => issue.blocking))
          await assert.rejects(c.imp('financeUpdates.post', await postRequest(c)), { publicCode: 'UNRESOLVED_IMPORT' })
          assert.equal((await imported(c)).length, 0)
        }
      })

      await t.test('同文件两位对方与本方都同尾号时独立确认，外部选择不吞本人账户', async () => {
        const c = await setup()
        const first = contentFor({ direction: 'income', own: '****1122', other: '****1122' })
        const content = Buffer.concat([first, Buffer.from('\n2026-09-02 09:35:00,200.00,收入,转账,****1122,合成乙,****1122,SYNTHETIC-BANK-ENDPOINT-SECOND')])
        await prepare(c, content)
        const before = await balances(c), raw = await sourceRows(c, c.batchId)
        let pending = await issues(c)
        assert.equal(pending.length, 3, '本方可在文件内成组，两位弱对方各自核对')
        const outside = pending.filter(issue => issue.accountContext.fundsSide === 'from')
        assert.equal(outside.length, 2)
        assert.notEqual(outside[0].accountContext.bindingKey, outside[1].accountContext.bindingKey)
        await c.imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: c.updateId,
          updateVersion: (await summary(c)).update.version, decisions: outside.map(issue => ({ issueId: issue.issueId,
            issueVersion: issue.version, operation: 'resolve', decision: 'apply_fields', paymentRuleAction: 'external', fields: {} })) })
        assert.ok((await events(c)).every(event => event.status === 'needs_action'))
        pending = await issues(c)
        assert.equal(pending.length, 1)
        assert.equal(pending[0].accountContext.fundsSide, 'to')
        await confirm(c)
        for (const event of await events(c)) assert.deepEqual([event.economicNature, event.status], ['income', 'ready'],
          JSON.stringify({ nature: event.economicNature, status: event.status, reasons: event.reasonCodes }))
        await c.imp('financeUpdates.post', await postRequest(c))
        const rows = await imported(c)
        assert.equal(rows.length, 2)
        assert.ok(rows.every(row => row.type === 'income' && row.source_account_id === null && row.destination_account_id === c.destination))
        const after = await balances(c)
        assert.equal(BigInt(after[c.destination]) - BigInt(before[c.destination]), 30000n)
        assert.equal(after[c.source], before[c.source])
        assert.deepEqual(await sourceRows(c, c.batchId), raw)
      })

      await t.test('新银行投影撤销后两账户余额复原，原始记录仍完整', async () => {
        const c = await setup()
        await prepare(c, contentFor({ direction: 'income' }))
        const before = await balances(c), raw = await sourceRows(c, c.batchId)
        await confirm(c)
        await c.imp('financeUpdates.post', await postRequest(c))
        const impact = await c.imp('financeUpdates.undoImpact', { updateId: c.updateId })
        assert.equal(impact.canUndo, true)
        const request = { requestId: randomUUID(), updateId: c.updateId,
          version: (await summary(c)).update.version, previewToken: impact.previewToken }
        const undone = await c.imp('financeUpdates.undo', request)
        assert.deepEqual(await c.imp('financeUpdates.undo', request), undone)
        assert.deepEqual(await balances(c), before)
        assert.equal((await imported(c)).length, 0)
        assert.deepEqual(await sourceRows(c, c.batchId), raw)
      })

      await t.test('旧 unknown 转入仅确认本方后升级，账户与人工位转到收款端且可正确入账', async () => {
        const c = await setup(), previous = await legacy(c), raw = await sourceRows(c, c.batchId), before = await balances(c)
        await upgrade(c)
        const event = (await events(c))[0]
        assert.equal(event.eventId, previous.eventId)
        assert.equal(event.economicNature, 'internal_transfer')
        assert.equal(event.ledgerAccountId, null)
        assert.equal(event.counterpartyLedgerAccountId, c.destination)
        assert.equal(event.fundsProjection.accountOrder, 'actual')
        const [[stored]] = await lab.owner.execute('SELECT manual_field_mask AS mask FROM catledger_economic_events WHERE uid=? AND event_id=?', [c.uid, event.eventId])
        assert.equal(Number(stored.mask), FIELD_MASK.counterpartyLedgerAccountId | FIELD_MASK.note)
        const pending = await issues(c)
        assert.equal(pending.length, 1)
        assert.equal(pending[0].accountContext.fundsSide, 'from')
        await confirm(c, { from: 'external', to: 'ledger' })
        await c.imp('financeUpdates.post', await postRequest(c))
        const [entry] = await imported(c)
        assert.equal(entry.type, 'income')
        assert.equal(entry.destination_account_id, c.destination)
        const after = await balances(c)
        assert.equal(BigInt(after[c.destination]) - BigInt(before[c.destination]), 10000n)
        assert.equal(after[c.source], before[c.source])
        assert.deepEqual(await sourceRows(c, c.batchId), raw)
      })

      await t.test('旧人工收入、两端及归属决定升级保持人工值，不套新方向', async () => {
        for (const mode of ['income', 'two', 'ownership']) {
          const c = await setup(), previous = await legacy(c, mode), raw = await sourceRows(c, c.batchId)
          await upgrade(c)
          const event = (await events(c))[0]
          assert.equal(event.eventId, previous.eventId)
          assert.equal(event.economicNature, mode === 'income' ? 'income' : 'internal_transfer')
          assert.equal(event.ledgerAccountId, c.destination)
          assert.equal(event.counterpartyLedgerAccountId, mode === 'income' ? null : c.source)
          assert.equal(event.fundsProjection, null)
          const [[stored]] = await lab.owner.execute('SELECT manual_field_mask AS mask,field_sources_json AS fields FROM catledger_economic_events WHERE uid=? AND event_id=?', [c.uid, event.eventId])
          assert.equal(Number(stored.mask), previous.mask)
          const fields = typeof stored.fields === 'string' ? JSON.parse(stored.fields) : stored.fields
          assert.equal(fields.editorOverrides.note, '合成双端核对')
          if (mode === 'ownership') assert.deepEqual(fields.accountOwnership, previous.fields.accountOwnership)
          await c.imp('financeUpdates.post', await postRequest(c))
          const [entry] = await imported(c)
          assert.equal(entry.type, mode === 'income' ? 'income' : 'transfer')
          assert.equal(entry.source_account_id, mode === 'income' ? null : c.source)
          assert.equal(entry.destination_account_id, c.destination)
          assert.deepEqual(await sourceRows(c, c.batchId), raw)
        }
      })

      await t.test('旧封存快照和入账请求不被升级改写或悄悄重放', async () => {
        const c = await setup()
        await legacy(c)
        const prepared = await c.imp('financeUpdates.prepareSnapshot', { requestId: randomUUID(), updateId: c.updateId,
          version: (await summary(c)).update.version })
        const facts = (await loadObject(lab.owner, c.uid, prepared.snapshot.objectId, 'snapshot')).value
        const snapshotId = randomUUID(), uploadId = randomUUID()
        facts.snapshotId = snapshotId
        facts.ruleVersion = facts.update.planVersion = 'organizer-plan-v44'
        await saveObject(lab.owner, c.uid, { objectId: snapshotId, updateId: c.updateId, kind: 'snapshot',
          baseVersion: prepared.update.version, ruleVersion: facts.ruleVersion, metadata: { counts: snapshotCodec.counts(facts) } },
        protocol.split(snapshotCodec.encodeText(facts)))
        const payload = { protocolVersion: 3, snapshotId, updateId: c.updateId, baseVersion: prepared.update.version,
          ruleVersion: facts.ruleVersion, decisions: { accounts: [], events: [], pairings: [], reviews: [], duplicates: [] } }
        const packed = protocol.split(JSON.stringify(payload), 'decisions')
        await saveObject(lab.owner, c.uid, { objectId: uploadId, updateId: c.updateId, snapshotId, kind: 'decisions',
          baseVersion: prepared.update.version, ruleVersion: facts.ruleVersion }, packed)
        const frozen = { requestId: randomUUID(), protocolVersion: 3, updateId: c.updateId, version: prepared.update.version,
          snapshotId, uploadId, payloadDigest: packed.digest }
        const original = JSON.stringify(frozen)
        await assert.rejects(c.imp('financeUpdates.post', frozen), { publicCode: 'VALIDATION_ERROR' })
        await upgrade(c)
        assert.equal((await events(c))[0].counterpartyLedgerAccountId, c.destination)
        assert.deepEqual((await loadObject(lab.owner, c.uid, snapshotId, 'snapshot')).value, facts)
        assert.deepEqual((await loadObject(lab.owner, c.uid, uploadId, 'decisions')).value, payload)
        assert.equal(JSON.stringify(frozen), original)
        assert.equal((await imported(c)).length, 0)
      })
      assert.doesNotMatch(JSON.stringify(logs), /9900000000001122|8800000000001122|SYNTHETIC-BANK-ENDPOINT-TRANSFER|bindings|password/)
    } finally { await lab.close() }
  })
