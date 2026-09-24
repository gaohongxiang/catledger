const { assertNoLoanTransactions } = require('../loan-transaction-guard')
const { chunks } = require('../sql-batch')
const { commandResult } = require('../command-result')
const { assertIdentityIntegrity } = require('../evidence-integrity')
const { randomUUID } = require('node:crypto')
const { importError } = require('../errors')
const { stageRepaymentAllocationDrafts } = require('../account-draft')
const { insertAction, selectUpdate } = require('../finance-update-repository')
const { EVENT_STATUS, REFUND_RELATION_STATE_VERSION } = require('../organizer-model')
const { ECONOMIC_NATURE, unique } = require('../organizer-values')
const { validateUuid } = require('../validation')
const { isAggregateRepayment } = require('../repayment-allocation')
const { resolvedReasons, applyFields, assertDecisionMatchesIssue } = require('./policy')
const { selectDomainEvents, saveEvents, saveEvent } = require('./event-store')
const { selectIssue, selectMembers, createFollowUpIssues } = require('./issue-store')
const { refreshProjectedEvents, effectiveProjectedEvents, recalculateUpdateCounts } = require('./reconciliation')
const { stageDecisionAccountFields, stageDecisionAccountMappings, stageAccountMappings } = require('./account-mapping')


async function resolve(connection, uid, data, requestDigest, { updateId, issueId, updateVersion, issueVersion, decision }) {
        const update = await selectUpdate(connection, uid, updateId, { forUpdate: true })
        const issue = await selectIssue(connection, uid, issueId, { forUpdate: true })
        if (issue.updateId !== updateId || update.status !== 'review' || Number(update.version) !== updateVersion ||
            issue.status !== 'open' || Number(issue.version) !== issueVersion) throw importError('CONFLICT')
        assertDecisionMatchesIssue(issue, decision)
        if (data.selection != null && !['exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
        const paymentRuleAction = data.paymentRuleAction == null ? null : data.paymentRuleAction
        if (paymentRuleAction != null &&
            (paymentRuleAction !== 'ignore' || decision !== 'exclude_events' || issue.issueType !== 'account_mapping')) {
          throw importError('VALIDATION_ERROR')
        }
        const members = await selectMembers(connection, uid, issueId)
        const eventMembers = members.filter((member) => member.objectType === 'event' && member.memberRole === 'subject')
        const eventIds = eventMembers.map((member) => member.objectId)
        const storedEvents = await selectDomainEvents(connection, uid, updateId, eventIds, { forUpdate: true })
        if (storedEvents.length !== eventIds.length || storedEvents.some((event) => {
          const member = eventMembers.find((item) => item.objectId === event.eventId)
          return !member || member.objectVersion !== event.version || ['posted', 'corrected'].includes(event.status)
        })) throw importError('CONFLICT')
        // 事件可能仍带着整理前的历史映射快照。执行任何人工裁决前先按
        // “历史映射 < 本批映射草稿 < 已手工端点”得到当前有效资金端，
        // 避免用户只选择转入端时把过期的转出端一并保存。
        const events = await effectiveProjectedEvents(connection, uid, updateId, storedEvents)

        const appliedVersion = updateVersion + 1
        const actionId = await insertAction(connection, uid, {
          updateId,
          expectedVersion: updateVersion,
          appliedVersion,
          actionType: 'resolve_review_issue',
          requestDigest,
          decision: data,
          reasons: ['review_issue_resolved', `decision:${decision}`]
        })
        const affected = []
        let duplicateEvidenceDelta = 0

        if (decision === 'confirm_same') {
          const primaryEventId = validateUuid(data.primaryEventId)
          if (!eventIds.includes(primaryEventId) || eventIds.length < 2) throw importError('VALIDATION_ERROR')
          await assertIdentityIntegrity(connection, uid, updateId, eventIds, { merge: true })
          for (const event of events) {
            if (event.eventId === primaryEventId) continue
            const [[linkCount]] = await connection.execute(
              `SELECT COUNT(*) AS count FROM catledger_economic_event_transactions
                WHERE uid = ? AND update_id = ? AND event_id = ?`,
              [uid, updateId, event.eventId]
            )
            if (Number(linkCount.count) !== 0) throw importError('CONFLICT')
            await connection.execute(
              `UPDATE catledger_event_evidence
                  SET event_id = ?, evidence_role = CASE WHEN evidence_role = 'discarded' THEN 'discarded' ELSE 'supporting' END
                WHERE uid = ? AND update_id = ? AND event_id = ?`,
              [primaryEventId, uid, updateId, event.eventId]
            )
            await connection.execute(
              `DELETE FROM catledger_economic_event_relations
                WHERE uid = ? AND update_id = ? AND (source_event_id = ? OR target_event_id = ?)`,
              [uid, updateId, event.eventId, event.eventId]
            )
            const [deleted] = await connection.execute(
              `DELETE FROM catledger_economic_events
                WHERE uid = ? AND update_id = ? AND event_id = ? AND version = ?
                  AND status IN ('ready', 'needs_action', 'excluded')`,
              [uid, updateId, event.eventId, event.version]
            )
            if (deleted.affectedRows !== 1) throw importError('CONFLICT')
            duplicateEvidenceDelta += 1
          }
          const primary = events.find((event) => event.eventId === primaryEventId)
          const next = { ...primary, reasonCodes: resolvedReasons(issue.issueType, primary.reasonCodes), resolvingIssueType: issue.issueType }
          affected.push(await saveEvent(connection, uid, primary, next, actionId))
        } else if (decision === 'confirm_distinct' && issue.primaryReasonCode === 'historical_duplicate_candidate') {
          await require('../historical-duplicates').assertHistoricalChoice(connection, uid, updateId, issue)
        } else if (decision === 'confirm_distinct') {
          await assertIdentityIntegrity(connection, uid, updateId, eventIds)
          for (const part of chunks(eventIds.map(id => [id]))) await connection.execute(
            `UPDATE catledger_economic_event_relations SET status = 'rejected', version = version + 1
              WHERE uid = ? AND update_id = ? AND status = 'proposed'
                AND (source_event_id IN (${part.map(() => '?').join(', ')})
                  OR target_event_id IN (${part.map(() => '?').join(', ')}))`,
            [uid, updateId, ...part.flat(), ...part.flat()]
          )
          affected.push(...await saveEvents(connection, uid, updateId, events.map(event => ({ current: event,
            next: { ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes), resolvingIssueType: issue.issueType } })), actionId))
        } else if (decision === 'apply_fields') {
          let fields = data.fields
          if (fields && fields.repaymentAllocations) {
            if (events.some((event) => !isAggregateRepayment(event))) throw importError('VALIDATION_ERROR')
            fields = { ...fields, repaymentAllocations: await stageRepaymentAllocationDrafts(connection, uid, updateId, fields.repaymentAllocations, actionId) }
          }
          fields = await stageDecisionAccountFields(connection, uid, updateId, fields, actionId)
          affected.push(...await saveEvents(connection, uid, updateId, events.map(event => ({ current: event,
            next: { ...applyFields({ ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes) }, fields), resolvingIssueType: issue.issueType } })), actionId))
          await stageDecisionAccountMappings(connection, uid, updateId, affected, fields, actionId)
        } else if (decision === 'exclude_events') {
          let selected
          {
            const selection = data.selection || (data.eventIds == null ? { mode: 'all' } : { mode: 'include', eventIds: data.eventIds })
            if (!['all', 'include', 'all_except'].includes(selection.mode)) throw importError('VALIDATION_ERROR')
            const ids = selection.eventIds == null ? [] : selection.eventIds
            if (!Array.isArray(ids) || ids.length > 100 || (selection.mode === 'include' && !ids.length) || (selection.mode === 'all' && ids.length)) throw importError('VALIDATION_ERROR')
            const explicit = new Set(ids.map(validateUuid))
            if (explicit.size !== ids.length || [...explicit].some(id => !eventIds.includes(id))) throw importError('VALIDATION_ERROR')
            selected = selection.mode === 'all' ? new Set(eventIds) : selection.mode === 'include' ? explicit : new Set(eventIds.filter(id => !explicit.has(id)))
            if (!selected.size) throw importError('VALIDATION_ERROR')
          }
          if ([...selected].some((eventId) => !eventIds.includes(eventId))) throw importError('VALIDATION_ERROR')
          const pairs = events.filter(item => selected.has(item.eventId)).map(event => {
            const exclusionReasons = issue.issueType === 'account_mapping'
              ? ['manual_exclusion', 'account_mapping_excluded']
              : ['manual_exclusion']
            const next = {
              ...event,
              status: EVENT_STATUS.EXCLUDED,
              reasonCodes: unique([...resolvedReasons(issue.issueType, event.reasonCodes),
                ...exclusionReasons]),
              resolvingIssueType: issue.issueType
            }
            return { current: event, next }
          })
          affected.push(...await saveEvents(connection, uid, updateId, pairs, actionId))
          if (paymentRuleAction === 'ignore') {
            await stageAccountMappings(
              connection,
              uid,
              updateId,
              [...selected],
              null,
              actionId,
              'ignore'
            )
          }
        } else if (decision === 'discard_evidence') {
          const evidenceId = validateUuid(data.evidenceId)
          const [evidenceRows] = await connection.execute('SELECT event_id AS eventId FROM catledger_event_evidence WHERE uid = ? AND update_id = ? AND evidence_id = ? FOR UPDATE', [uid, updateId, evidenceId])
          if (!evidenceRows[0] || !eventIds.includes(evidenceRows[0].eventId)) throw importError('NOT_FOUND')
          const [result] = await connection.execute(
            `UPDATE catledger_event_evidence SET evidence_role = 'discarded'
              WHERE uid = ? AND update_id = ? AND evidence_id = ?`,
            [uid, updateId, evidenceId]
          )
          if (result.affectedRows !== 1) throw importError('NOT_FOUND')
          affected.push(...await saveEvents(connection, uid, updateId, events.map(event => ({ current: event,
            next: { ...event, reasonCodes: resolvedReasons(issue.issueType, event.reasonCodes), resolvingIssueType: issue.issueType } })), actionId))
        } else if (decision === 'mark_refund_pending') {
          if (events.length !== 1 || Number(issue.candidateCount) !== 0) throw importError('VALIDATION_ERROR')
          const source = events[0]
          if (source.economicNature !== ECONOMIC_NATURE.REFUND) throw importError('VALIDATION_ERROR')
          const [proposed] = await connection.execute(
            `SELECT relation_id AS relationId
               FROM catledger_economic_event_relations
              WHERE uid = ? AND update_id = ? AND source_event_id = ?
                AND relation_type = 'refund_of' AND status = 'proposed' FOR UPDATE`,
            [uid, updateId, source.eventId]
          )
          if (proposed.length !== 0) throw importError('VALIDATION_ERROR')
          const next = {
            ...source,
            fieldSources: {
              ...(source.fieldSources || {}),
              refundRelation: {
                version: REFUND_RELATION_STATE_VERSION,
                status: 'pending',
                confirmedBy: 'user'
              }
            },
            reasonCodes: resolvedReasons(issue.issueType, source.reasonCodes),
            resolvingIssueType: issue.issueType
          }
          affected.push(await saveEvent(connection, uid, source, next, actionId))
        } else if (decision === 'link_refund') {
          if (events.length !== 1) throw importError('VALIDATION_ERROR')
          const source = events[0]
          if (source.economicNature !== ECONOMIC_NATURE.REFUND) throw importError('VALIDATION_ERROR')
          const targetEventId = validateUuid(data.targetEventId)
          const [selectedRelations] = await connection.execute(
            `SELECT relation.relation_id AS relationId, relation.status, relation.version
               FROM catledger_economic_event_relations relation
               JOIN catledger_review_issue_members member
                 ON member.uid = relation.uid AND member.update_id = relation.update_id
                AND member.object_type = 'relation' AND member.object_id = relation.relation_id
                AND member.member_role = 'candidate'
              WHERE relation.uid = ? AND relation.update_id = ? AND relation.source_event_id = ?
                AND relation.target_event_id = ? AND relation.relation_type = 'refund_of'
                AND relation.status = 'proposed' AND member.issue_id = ?
              LIMIT 1 FOR UPDATE`,
            [uid, updateId, source.eventId, targetEventId, issueId]
          )
          const selectedRelation = selectedRelations[0]
          if (!selectedRelation) throw importError('VALIDATION_ERROR')
          const [targets] = await connection.execute(
            `SELECT event_id AS eventId, status, economic_nature AS economicNature,
                    event_utc_at AS utcAt, amount_minor AS amountMinor, currency
               FROM catledger_economic_events
              WHERE uid = ? AND update_id = ? AND event_id = ? LIMIT 1`,
            [uid, updateId, targetEventId]
          )
          const target = targets[0]
          if (target && target.fieldSources && target.fieldSources.paymentResolution) throw importError('PAYMENT_REFUND_ALLOCATION_REQUIRED')
          if (!target || source.eventId === targetEventId || target.status === EVENT_STATUS.EXCLUDED ||
              ![ECONOMIC_NATURE.EXPENSE, ECONOMIC_NATURE.FEE].includes(target.economicNature) || target.currency !== source.currency ||
              BigInt(String(target.amountMinor)) < BigInt(source.amountMinor) ||
              !target.utcAt || !source.utcAt || String(target.utcAt) > String(source.utcAt)) {
            throw importError('VALIDATION_ERROR')
          }
          const [[refundTotal]] = await connection.execute(
            `SELECT COALESCE(SUM(amount_minor), 0) AS amountMinor
               FROM catledger_economic_event_relations
              WHERE uid = ? AND update_id = ? AND target_event_id = ?
                AND relation_type = 'refund_of' AND status = 'confirmed' AND source_event_id <> ?`,
            [uid, updateId, targetEventId, source.eventId]
          )
          if (BigInt(String(refundTotal.amountMinor)) + BigInt(source.amountMinor) > BigInt(String(target.amountMinor))) {
            throw importError('VALIDATION_ERROR')
          }
          const selectedRelationId = selectedRelation.relationId
          const [updatedRelation] = await connection.execute(
            `UPDATE catledger_economic_event_relations
                SET status = 'confirmed', manual = 1, amount_minor = ?, currency = ?,
                    reason_codes_json = JSON_ARRAY('manual_refund_relation'), version = version + 1
              WHERE uid = ? AND relation_id = ? AND version = ? AND status = 'proposed'`,
            [source.amountMinor, source.currency, uid, selectedRelationId, Number(selectedRelation.version)]
          )
          if (updatedRelation.affectedRows !== 1) throw importError('CONFLICT')
          await connection.execute(
            `UPDATE catledger_economic_event_relations
                SET status = 'rejected', version = version + 1
              WHERE uid = ? AND update_id = ? AND source_event_id = ?
                AND relation_type = 'refund_of' AND relation_id <> ? AND status = 'proposed'`,
            [uid, updateId, source.eventId, selectedRelationId]
          )
          const next = { ...source, reasonCodes: resolvedReasons(issue.issueType, source.reasonCodes), resolvingIssueType: issue.issueType }
          affected.push(await saveEvent(connection, uid, source, next, actionId))
        } else if (decision === 'link_existing_transaction') {
          const transactionId = validateUuid(data.transactionId)
          await require('../historical-duplicates').assertHistoricalChoice(connection, uid, updateId, issue, transactionId)
          await assertNoLoanTransactions(connection, uid, [transactionId])
          const primaryEventId = data.primaryEventId ? validateUuid(data.primaryEventId) : eventIds[0]
          const event = events.find((item) => item.eventId === primaryEventId)
          const [transactions] = await connection.execute(
            `SELECT version FROM catledger_transactions
              WHERE uid = ? AND transaction_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
            [uid, transactionId]
          )
          if (!event || !transactions[0]) throw importError('NOT_FOUND')
          await connection.execute(
            `INSERT INTO catledger_economic_event_transactions
               (uid, link_id, update_id, event_id, transaction_id, role,
                creation_method, rule_version, transaction_version)
             VALUES (?, ?, ?, ?, ?, 'historical_primary', 'reused',
                     'event-transaction-link-v2', ?)`,
            [uid, randomUUID(), updateId, event.eventId, transactionId, Number(transactions[0].version)]
          )
          const next = {
            ...event,
            status: EVENT_STATUS.EXCLUDED,
            reasonCodes: unique([...resolvedReasons(issue.issueType, event.reasonCodes), 'linked_existing_transaction']),
            resolvingIssueType: issue.issueType
          }
          affected.push(await saveEvent(connection, uid, event, next, actionId))
          await connection.execute(`UPDATE catledger_review_issues i SET status = 'superseded', blocking = 0, version = version + 1,
            resolved_action_id = ? WHERE i.uid = ? AND i.update_id = ? AND i.status = 'open' AND i.issue_id <> ?
            AND EXISTS (SELECT 1 FROM catledger_review_issue_members m WHERE m.uid = i.uid AND m.issue_id = i.issue_id
              AND m.object_type = 'event' AND m.object_id = ? AND m.member_role <> 'candidate')
            AND NOT EXISTS (SELECT 1 FROM catledger_review_issue_members m JOIN catledger_economic_events e
              ON e.uid = m.uid AND e.event_id = m.object_id WHERE m.uid = i.uid AND m.issue_id = i.issue_id
              AND m.object_type = 'event' AND m.member_role <> 'candidate' AND e.status <> 'excluded')`,
          [actionId, uid, updateId, issueId, event.eventId])
        }

        const partialExclusion = ['exclude_events'].includes(decision) && affected.length < events.length
        if (partialExclusion) {
          // 只移出本次已明确排除的成员，余下成员保留原阻塞问题和新版本。
          for (let offset = 0; offset < affected.length; offset += 100) {
            const ids = affected.slice(offset, offset + 100).map(event => event.eventId)
            await connection.execute(`DELETE FROM catledger_review_issue_members WHERE uid = ? AND update_id = ? AND issue_id = ?
              AND object_type = 'event' AND object_id IN (${ids.map(() => '?').join(',')})`, [uid, updateId, issueId, ...ids])
          }
        }
        const [resolved] = await connection.execute(
          partialExclusion ? `UPDATE catledger_review_issues SET version = version + 1,
            member_count = (SELECT COUNT(*) FROM catledger_review_issue_members WHERE uid = ? AND issue_id = ?)
            WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`
            : `UPDATE catledger_review_issues SET status = 'resolved', version = version + 1, blocking = 0,
              resolved_action_id = ? WHERE uid = ? AND issue_id = ? AND version = ? AND status = 'open'`,
          partialExclusion ? [uid, issueId, uid, issueId, issueVersion] : [actionId, uid, issueId, issueVersion]
        )
        if (resolved.affectedRows !== 1) throw importError('CONFLICT')
        await createFollowUpIssues(connection, uid, updateId, affected)
        await refreshProjectedEvents(connection, uid, updateId, actionId)
        await recalculateUpdateCounts(connection, uid, updateId, appliedVersion, actionId, updateVersion, duplicateEvidenceDelta)
        return commandResult(connection, uid, updateId, data, issueId)
      }

module.exports = { resolve }
