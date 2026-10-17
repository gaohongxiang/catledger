const { chunks, insertMany, loadEventContexts } = require('../sql-batch')
const { randomUUID } = require('node:crypto')
const { digestParts } = require('../digest')
const { REVIEW_ISSUE_VERSION } = require('../domain-versions')
const { importError } = require('../errors')
const { EVENT_STATUS, REVIEW_ISSUE_TYPE, classifyReviewIssue, needsCategory } = require('../organizer-model')
const { needsAttribution, REASON_CODE: INSTALLMENT_ATTRIBUTION_REASON } = require('../installment-plan')
const { parseJson } = require('../finance-update-repository')
const { selectDomainEvents } = require('./event-store')

async function selectIssue(connection, uid, issueId, { forUpdate = false } = {}) {
  const [rows] = await connection.execute(
    `SELECT issue_id AS issueId, update_id AS updateId, issue_key AS issueKey,
            issue_type AS issueType, status, version, blocking,
            primary_reason_code AS primaryReasonCode, member_count AS memberCount,
            candidate_count AS candidateCount, reason_codes_json AS reasonCodes
       FROM catledger_review_issues
      WHERE uid = ? AND issue_id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [uid, issueId]
  )
  if (!rows[0]) throw importError('NOT_FOUND')
  return rows[0]
}

async function selectMembers(connection, uid, issueId) {
  const [rows] = await connection.execute(
    `SELECT member_id AS memberId, update_id AS updateId, issue_id AS issueId,
            object_type AS objectType, object_id AS objectId,
            object_version AS objectVersion, member_role AS memberRole,
            sort_order AS sortOrder
       FROM catledger_review_issue_members
      WHERE uid = ? AND issue_id = ? ORDER BY sort_order, member_id`,
    [uid, issueId]
  )
  return rows.map((row) => ({ ...row, objectVersion: Number(row.objectVersion), sortOrder: Number(row.sortOrder) }))
}

async function updateMappingMemberVersions(connection, uid, updateId, events, otherOpenOnly = false) {
  if (!events.length) return
  const byId = new Map(events.map(event => [event.eventId, event]))
  const [members] = await connection.execute(`SELECT member.member_id AS memberId, member.object_id AS eventId, issue.issue_type AS issueType
    FROM catledger_review_issue_members member JOIN catledger_review_issues issue ON issue.uid = member.uid AND issue.issue_id = member.issue_id
    WHERE member.uid = ? AND member.update_id = ? AND member.object_type = 'event'
      AND ${otherOpenOnly ? "issue.status = 'open' AND issue.issue_type <> 'account_mapping'" : "(issue.status = 'open' OR (issue.issue_type = 'account_mapping' AND issue.status = 'resolved'))"}`, [uid, updateId])
  const rows = members.filter(member => {
    const event = byId.get(member.eventId)
    return event && (otherOpenOnly || member.issueType === 'account_mapping' || event.fieldSources.paymentAccountReferences != null)
  }).map(member => [member.memberId, byId.get(member.eventId).version]).sort((a, b) => a[0].localeCompare(b[0]))
  for (const part of chunks(rows, { parametersPerRow: 3, fixedParameters: 2 })) {
    const [result] = await connection.execute(`UPDATE catledger_review_issue_members SET object_version = CASE member_id
      ${part.map(() => 'WHEN ? THEN ?').join(' ')} END
      WHERE uid = ? AND update_id = ? AND member_id IN (${part.map(() => '?').join(',')})`, [...part.flat(), uid, updateId, ...part.map(row => row[0])])
    if (result.affectedRows !== part.length) throw importError('CONFLICT')
  }
}

async function createFollowUpIssue(connection, uid, updateId, event) {
  return createFollowUpIssues(connection, uid, updateId, [event])
}

// 一个分期计划本期次的说明只有本金行有：费用行要指定给谁，必须看着本金选。
// 整理期由 buildReviewIssues 一次性把整组建进一条事项；但来源账户还没确认时整批事件会先被
// account_mapping 拦下，等用户确认账户后才回到这里补建。补建必须复用同一口径，否则费用会
// 各自成一条，用户面对的又变成“一笔利息一张卡”，拿不到“这笔利息属于哪个计划”的对照。
// 回库捞本批次全部活跃分期行，按分组键归堆；本金置前——事项的 sort_order=0 就是这张卡的门面。
async function activeInstallmentMembers(connection, uid, updateId) {
  const [rows] = await connection.execute(
    `SELECT event_id AS eventId, version, field_sources_json AS fieldSources, reason_codes_json AS reasonCodes
       FROM catledger_economic_events
      WHERE uid = ? AND update_id = ? AND status IN ('ready', 'needs_action')`,
    [uid, updateId]
  )
  const groups = new Map()
  for (const row of rows) {
    // mysql2 默认直接返回 JSON 对象／数组；沿用仓库读取层，兼容字符串返回。
    const sources = parseJson(row.fieldSources, {}) || {}
    const reasons = parseJson(row.reasonCodes, []) || []
    const installment = sources.installment
    if (!installment || !installment.groupKey) continue
    if (!groups.has(installment.groupKey)) groups.set(installment.groupKey, [])
    groups.get(installment.groupKey).push({ eventId: row.eventId, version: Number(row.version),
      principal: installment.component === 'principal',
      // 只有判不出归属的费用行带这个原因码：本金不带，它靠“同组事项成员”身份进待核对。
      pending: reasons.includes(INSTALLMENT_ATTRIBUTION_REASON) })
  }
  groups.forEach(members => members.sort((left, right) =>
    Number(right.principal) - Number(left.principal) || left.eventId.localeCompare(right.eventId)))
  return groups
}

async function installmentAttributionGroups(connection, uid, updateId, pendingEventIds) {
  // 只有“本期次还有待指定费用”的组要建事项。
  return [...(await activeInstallmentMembers(connection, uid, updateId)).entries()]
    .filter(([, members]) => members.some(member => pendingEventIds.has(member.eventId)))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([groupKey, members]) => ({ groupKey, members }))
}

function availableInstallmentIssueKey(updateId, groupKey, takenKeys) {
  const parts = ['review-follow-up-v2', updateId, INSTALLMENT_ATTRIBUTION_REASON, groupKey]
  let key = digestParts(...parts), generation = 0
  // 历史已解决事项保留原键和决定；再次取消指定时创建新事项，不覆盖历史。
  // 调用者持有用户写锁，同一组的补建与保存不会并发抢占下一代键。
  while (takenKeys.has(key)) key = digestParts(...parts, ++generation)
  return key
}

// 分期整组必须落在同一条事项里（同一期次一条、本金置前），用户才能在一张卡里对照本息。
// 整理期由 buildReviewIssues 一次性建好；但来源账户没确认时整批会先被 account_mapping 拦下，
// 等确认后才增量补建——早期版本的增量按单笔 eventKey 建事项，同一期次会被拆成多条，本金甚至
// 整组都没进过事项（于是留在已核对里，用户看到“本金核对完了、利息还没归属”这种对不上的状态）。
// 这里按分组键做两件事：缺的补建，散的收拢回一条（保留一条、其余收尾、成员补齐为整组）。
// 补建是必须的：分期行只要还缺账户，classifyReviewIssue 就先把它判成 account_mapping，
// 整理期那条归属分支压根不进，事项根本不会被创建——本金因此失去唯一的待核对凭据。
async function collapseInstallmentIssues(connection, uid, updateId, actionId = null, { beforeChange } = {}) {
  const groups = [...(await activeInstallmentMembers(connection, uid, updateId)).entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
  if (!groups.length) return 0
  const [rows] = await connection.execute(
    `SELECT issue.issue_id AS issueId, member.object_id AS eventId
       FROM catledger_review_issues issue
       JOIN catledger_review_issue_members member
         ON member.uid = issue.uid AND member.update_id = issue.update_id AND member.issue_id = issue.issue_id
      WHERE issue.uid = ? AND issue.update_id = ? AND issue.status = 'open'
        AND issue.primary_reason_code = ? AND member.object_type = 'event' AND member.member_role <> 'candidate'`,
    [uid, updateId, INSTALLMENT_ATTRIBUTION_REASON]
  )
  const issuesByEvent = new Map()
  for (const row of rows) {
    if (!issuesByEvent.has(row.eventId)) issuesByEvent.set(row.eventId, new Set())
    issuesByEvent.get(row.eventId).add(row.issueId)
  }
  // issue_key 的唯一键不含状态：任何历史事项占过的键都不能再插一条。
  const [claims] = await connection.execute(
    `SELECT issue_key AS issueKey FROM catledger_review_issues
      WHERE uid = ? AND update_id = ? AND primary_reason_code = ?`,
    [uid, updateId, INSTALLMENT_ATTRIBUTION_REASON]
  )
  const takenKeys = new Set(claims.map(row => row.issueKey))
  let touched = 0
  for (const [groupKey, members] of groups) {
    // 归属都指定完的组不该留着事项：只有本期次确实还有待指定费用时才需要它。
    if (!members.some(member => member.pending)) continue
    const issueIds = new Set()
    members.forEach(member => (issuesByEvent.get(member.eventId) || new Set()).forEach(id => issueIds.add(id)))
    if (!issueIds.size) {
      // 补建与增量补建同键同口径：一笔费用都没进过事项时，整组（本金置前）现建一条。
      const issueKey = availableInstallmentIssueKey(updateId, groupKey, takenKeys)
      if (!touched && beforeChange) actionId = await beforeChange()
      const issueId = randomUUID()
      await connection.execute(`INSERT INTO catledger_review_issues (uid, issue_id, update_id, issue_key, issue_key_version,
          issue_type, status, version, blocking, primary_reason_code, member_count, candidate_count, rule_version, reason_codes_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, issueId, updateId, issueKey, REVIEW_ISSUE_VERSION, REVIEW_ISSUE_TYPE.INSTALLMENT_ORIGIN,
        'open', 1, 1, INSTALLMENT_ATTRIBUTION_REASON, members.length, 0, REVIEW_ISSUE_VERSION,
        JSON.stringify([INSTALLMENT_ATTRIBUTION_REASON])])
      await insertMany(connection, `INSERT INTO catledger_review_issue_members
        (uid, member_id, update_id, issue_id, object_type, object_id, object_version, member_role, sort_order) VALUES`,
      members.map((member, index) => [uid, randomUUID(), updateId, issueId, 'event', member.eventId, member.version, 'subject', index]))
      takenKeys.add(issueKey)
      touched++
      continue
    }
    const ordered = [...issueIds].sort()
    const keep = ordered[0]
    const expected = members.map(member => member.eventId)
    const kept = rows.filter(row => row.issueId === keep).map(row => row.eventId)
    // 已经是“一条事项 + 成员就是整组”就不写库：整理每次打开工作台都会跑到这里。
    if (ordered.length === 1 && kept.length === expected.length && expected.every(id => kept.includes(id))) continue
    if (!touched && beforeChange) actionId = await beforeChange()
    for (const drop of ordered.slice(1)) {
      await connection.execute(`DELETE FROM catledger_review_issue_members
        WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event' AND member_role <> 'candidate'`,
      [uid, updateId, drop])
      await connection.execute(`UPDATE catledger_review_issues SET status = 'superseded', blocking = 0, version = version + 1,
        resolved_action_id = ?, member_count = (SELECT COUNT(*) FROM catledger_review_issue_members m WHERE m.uid = ? AND m.issue_id = ?)
        WHERE uid = ? AND update_id = ? AND issue_id = ? AND status = 'open'`,
      [actionId, uid, drop, uid, updateId, drop])
    }
    await connection.execute(`DELETE FROM catledger_review_issue_members
      WHERE uid = ? AND update_id = ? AND issue_id = ? AND object_type = 'event' AND member_role <> 'candidate'`,
    [uid, updateId, keep])
    await insertMany(connection, `INSERT INTO catledger_review_issue_members
      (uid, member_id, update_id, issue_id, object_type, object_id, object_version, member_role, sort_order) VALUES`,
    members.map((member, index) => [uid, randomUUID(), updateId, keep, 'event', member.eventId, member.version, 'subject', index]))
    await connection.execute(`UPDATE catledger_review_issues SET version = version + 1, blocking = 1,
      member_count = (SELECT COUNT(*) FROM catledger_review_issue_members m WHERE m.uid = ? AND m.issue_id = ?)
      WHERE uid = ? AND update_id = ? AND issue_id = ? AND status = 'open'`,
    [uid, keep, uid, updateId, keep])
    touched++
  }
  return touched
}

async function createFollowUpIssues(connection, uid, updateId, events) {
  const candidates = events.filter(event => event.status === EVENT_STATUS.NEEDS_ACTION || (event.status === EVENT_STATUS.READY && needsCategory(event)))
  if (!candidates.length) return
  const [existing] = await connection.execute(`SELECT member.object_id AS eventId, issue.issue_type AS issueType, issue.blocking
    FROM catledger_review_issues issue JOIN catledger_review_issue_members member ON member.uid = issue.uid AND member.issue_id = issue.issue_id
    WHERE issue.uid = ? AND issue.update_id = ? AND issue.status = 'open' AND member.object_type = 'event'`, [uid, updateId])
  const occupied = new Map()
  for (const row of existing) {
    if (!occupied.has(row.eventId)) occupied.set(row.eventId, new Set())
    occupied.get(row.eventId).add(row.blocking ? '*' : row.issueType)
  }
  const contexts = candidates.some(event => classifyReviewIssue(event).issueType === REVIEW_ISSUE_TYPE.REFUND_RELATION)
    ? await loadEventContexts(connection, uid, updateId) : null
  const issues = [], members = []
  // 待指定的费用先整组收进一条事项，本金作为成员一起进去（它自己不带原因码，靠成员身份进待核对）。
  // 判定用事件自己的原因码，不用分类结论：分期行只要还缺账户，classifyReviewIssue 就会先把它
  // 判成 account_mapping（primaryReason=ledger_account_required），按分类比会把整组漏掉，
  // 费用只能各自成条——正是“一笔利息一张卡”的来源。
  const pendingAttribution = new Set(candidates
    .filter(event => (event.reasonCodes || []).includes(INSTALLMENT_ATTRIBUTION_REASON))
    .map(event => event.eventId))
  const grouped = new Set()
  if (pendingAttribution.size) {
    // 唯一键包含所有历史状态；取消指定重新打开待办时必须避开已收尾事项的键。
    const [claims] = await connection.execute(`SELECT issue_key AS issueKey FROM catledger_review_issues
      WHERE uid=? AND update_id=? AND primary_reason_code=?`,
      [uid, updateId, INSTALLMENT_ATTRIBUTION_REASON])
    const claimed = new Set(claims.map(row => row.issueKey))
    for (const group of await installmentAttributionGroups(connection, uid, updateId, pendingAttribution)) {
      // 与整理期 buildReviewIssues 同口径：整组收进同一条事项，本金置前（sort_order=0 就是卡片入口）。
      // 只吸收待指定的费用和它的本金锚点：组内其他费用若另有自己的问题（如待分类），它走的是
      // 「分类待指定」那条线，塞进「利息待归属」卡里只会被误读成还没归好属，也会同一笔出现两次。
      const available = group.members.filter(member => pendingAttribution.has(member.eventId) ||
        (member.principal && !occupied.has(member.eventId)))
      if (!available.length) continue
      // 待指定的费用一律由本条事项承接：即使它当前已在别的开放事项里，也不能再各自成一条，
      // 否则用户面对的又回到“一笔利息一张卡”。本金锚点只在没被占用时才新挂进来。
      available.forEach(member => { if (pendingAttribution.has(member.eventId)) grouped.add(member.eventId) })
      const fresh = available.filter(member => !occupied.has(member.eventId))
      // 已在开放事项内的成员不重复创建；历史事项不能阻止新一轮待办恢复。
      if (!fresh.length) continue
      const issueKey = availableInstallmentIssueKey(updateId, group.groupKey, claimed)
      claimed.add(issueKey)
      const reasonCodes = [...new Set(candidates
        .filter(event => fresh.some(member => member.eventId === event.eventId))
        .flatMap(event => event.reasonCodes || []))]
      const issueId = randomUUID()
      issues.push([uid, issueId, updateId, issueKey,
        REVIEW_ISSUE_VERSION, REVIEW_ISSUE_TYPE.INSTALLMENT_ORIGIN, 'open', 1, 1,
        INSTALLMENT_ATTRIBUTION_REASON, fresh.length, 0, REVIEW_ISSUE_VERSION, JSON.stringify(reasonCodes)])
      fresh.forEach((member, index) => {
        members.push([uid, randomUUID(), updateId, issueId, 'event', member.eventId, member.version, 'subject', index])
      })
    }
  }
  for (const event of candidates) {
    if (grouped.has(event.eventId)) continue
    const classification = classifyReviewIssue(event), prior = occupied.get(event.eventId)
    if (prior && (prior.has('*') || prior.has(classification.issueType))) continue
    const relations = classification.issueType === REVIEW_ISSUE_TYPE.REFUND_RELATION ? contexts.get(event.eventId).relations
      .filter(row => row.sourceEventId === event.eventId && row.relationType === 'refund_of' && row.status === 'proposed')
      .sort((a, b) => a.relationId.localeCompare(b.relationId)) : []
    const issueId = randomUUID()
    issues.push([uid, issueId, updateId, digestParts('review-follow-up-v2', updateId, event.eventId, event.version, classification.issueType),
      REVIEW_ISSUE_VERSION, classification.issueType, 'open', 1, classification.issueType !== REVIEW_ISSUE_TYPE.CATEGORY_ASSIGNMENT,
      classification.primaryReason, 1 + relations.length, relations.length, REVIEW_ISSUE_VERSION, JSON.stringify(event.reasonCodes)])
    members.push([uid, randomUUID(), updateId, issueId, 'event', event.eventId, event.version, 'subject', 0])
    relations.forEach((relation, index) => members.push([uid, randomUUID(), updateId, issueId, 'relation', relation.relationId, Number(relation.version), 'candidate', index + 1]))
    occupied.set(event.eventId, new Set([classification.issueType]))
  }
  await insertMany(connection, `INSERT INTO catledger_review_issues (uid, issue_id, update_id, issue_key, issue_key_version, issue_type,
    status, version, blocking, primary_reason_code, member_count, candidate_count, rule_version, reason_codes_json) VALUES`, issues)
  await insertMany(connection, `INSERT INTO catledger_review_issue_members (uid, member_id, update_id, issue_id, object_type, object_id,
    object_version, member_role, sort_order) VALUES`, members)
}

// 分期归属是整组的事实：事项里除了当前这笔，还挂着同组的本金和其余费用。它们身上没有
// 原因码，只会被这里删掉成员从而退出待核对。所以每次归属变更后都要回头看一眼整组——
// 本期次已经没有待指定的费用了，剩下的成员一起收尾，让整组回到已核对里按计划合并。
async function releaseInstallmentGroup(connection, uid, updateId, issueIds, actionId) {
  for (const issueId of issueIds) {
    const [members] = await connection.execute(`SELECT DISTINCT object_id AS eventId FROM catledger_review_issue_members
      WHERE uid=? AND update_id=? AND issue_id=? AND object_type='event' AND member_role<>'candidate'`,
      [uid, updateId, issueId])
    if (!members.length) continue
    const members_ = await selectDomainEvents(connection, uid, updateId, members.map(row => row.eventId))
    if (members_.some(event => needsAttribution(event))) continue
    await connection.execute(`DELETE FROM catledger_review_issue_members WHERE uid=? AND update_id=? AND issue_id=?
      AND object_type='event' AND member_role<>'candidate'`, [uid, updateId, issueId])
    await connection.execute(`UPDATE catledger_review_issues SET version=version+1, status='resolved', blocking=0,
      resolved_action_id=?, member_count=(SELECT COUNT(*) FROM catledger_review_issue_members m WHERE m.uid=? AND m.issue_id=?)
      WHERE uid=? AND update_id=? AND issue_id=?`, [actionId, uid, issueId, uid, updateId, issueId])
  }
}

// 更新当前笔的普通核对成员，不结束同组其他成员或判重/来源冲突组。
const ORDINARY_EDIT_ISSUES = new Set(['shared_fields','account_mapping','transfer_accounts','category_assignment','refund_relation'])
const PROTECTED_EDIT_REASONS = new Set(['refund_source_conflict','row_status_unknown','transaction_status_unknown',
  'account_mapping_conflict','core_fields_conflict','row_semantic_conflict','source_group_conflict','identity_conflict',
  'identity_review_required','source_profile_unknown'])
async function refreshEditedEventsIssues(connection, uid, updateId, events, actionId) {
  const byId = new Map(events.map(event => [event.eventId,event])), rows = []
  for (const part of chunks(events.map(event=>[event.eventId]))) {
    const [found] = await connection.execute(`SELECT m.member_id AS memberId,m.object_id AS eventId,
      i.issue_id AS issueId,i.issue_type AS issueType,i.primary_reason_code AS reason
      FROM catledger_review_issues i JOIN catledger_review_issue_members m
        ON m.uid=i.uid AND m.update_id=i.update_id AND m.issue_id=i.issue_id
      WHERE i.uid=? AND i.update_id=? AND i.status='open' AND m.object_type='event'
        AND m.member_role<>'candidate' AND m.object_id IN (${part.map(()=>'?').join(',')})`,[uid,updateId,...part.flat()])
    rows.push(...found)
  }
  const removable = rows.filter(issue=>!PROTECTED_EDIT_REASONS.has(issue.reason)&&
    (ORDINARY_EDIT_ISSUES.has(issue.issueType)||issue.reason==='installment_attribution_required'))
  for (const part of chunks(removable.map(row=>[row.memberId]))) await connection.execute(
    `DELETE FROM catledger_review_issue_members WHERE uid=? AND update_id=? AND member_id IN (${part.map(()=>'?').join(',')})`,[uid,updateId,...part.flat()])
  const touched=[...new Set(removable.map(row=>row.issueId))]
  for (const part of chunks(touched.map(id=>[id]))) await connection.execute(`UPDATE catledger_review_issues i SET
    member_count=(SELECT COUNT(*) FROM catledger_review_issue_members m WHERE m.uid=i.uid AND m.issue_id=i.issue_id),
    version=version+1,status=IF(NOT EXISTS (SELECT 1 FROM catledger_review_issue_members m WHERE m.uid=i.uid AND m.issue_id=i.issue_id
      AND m.object_type='event' AND m.member_role<>'candidate'),'resolved',status),
    blocking=IF(status='resolved',0,blocking),resolved_action_id=IF(status='resolved',?,resolved_action_id)
    WHERE i.uid=? AND i.update_id=? AND i.issue_id IN (${part.map(()=>'?').join(',')})`,[actionId,uid,updateId,...part.flat()])
  const installmentIds=[...new Set(rows.filter(row=>row.reason==='installment_attribution_required').map(row=>row.issueId))]
  if(installmentIds.length)await releaseInstallmentGroup(connection,uid,updateId,installmentIds,actionId)
  const hard=require('../organizer-model').HARD_BLOCKING_REASONS,counts=new Map(events.map(event=>[event.eventId,0]))
  for(const part of chunks(events.map(event=>[event.eventId]))){
    const [remaining]=await connection.execute(`SELECT DISTINCT m.object_id AS eventId,i.issue_id AS issueId,i.primary_reason_code AS reason
      FROM catledger_review_issues i JOIN catledger_review_issue_members m ON m.uid=i.uid AND m.update_id=i.update_id AND m.issue_id=i.issue_id
      WHERE i.uid=? AND i.update_id=? AND i.status='open' AND i.blocking=1 AND m.object_type='event' AND m.member_role<>'candidate'
        AND m.object_id IN (${part.map(()=>'?').join(',')})`,[uid,updateId,...part.flat()])
    for(const issue of remaining)if(!hard.has(issue.reason)||!byId.get(issue.eventId).reasonCodes.includes(issue.reason))counts.set(issue.eventId,counts.get(issue.eventId)+1)
  }
  return counts
}
async function refreshEditedEventIssues(connection, uid, updateId, event, actionId) {
  return (await refreshEditedEventsIssues(connection, uid, updateId, [event], actionId)).get(event.eventId)
}

module.exports = { refreshEditedEventIssues, refreshEditedEventsIssues, selectIssue, selectMembers, updateMappingMemberVersions, createFollowUpIssue,
  createFollowUpIssues, collapseInstallmentIssues }
