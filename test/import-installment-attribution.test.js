const test = require('node:test')
const assert = require('node:assert/strict')

const plan = require('../cloudfunctions/catledger-import/src/installment-plan')
const { applyInstallmentAttribution, buildReviewIssues } = require('../cloudfunctions/catledger-import/src/organizer-planner')
const { evaluatePostability, classifyReviewIssue } = require('../cloudfunctions/catledger-import/src/organizer-model')
const { publicEvent } = require('../cloudfunctions/catledger-import/src/finance-update-repository')
const { prepare } = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const { createFollowUpIssues, collapseInstallmentIssues } = require('../cloudfunctions/catledger-import/src/review/issue-store')

// 真实账单文案：本金行摘要带计划名，利息行只到“第 x 期共 y 期”，不带计划名。
const CASH_PRINCIPAL = '电销现分按月收12期第12期共12期'
const BILL_PRINCIPAL = '电销总账分月12期第12期共12期'
const PERIOD_INTEREST = '分期付款利息第12期共12期'

let seq = 0
function eventOf(item, component, options) {
  options = options || {}
  seq += 1
  return {
    eventId: options.eventId || 'event-' + seq,
    updateId: 'update',
    version: 1,
    status: options.status || 'ready',
    economicNature: component === 'principal' ? 'repayment' : 'fee',
    flowDirection: component === 'principal' ? 'neutral' : 'outflow',
    amountMinor: String(options.amountMinor == null ? 10000 + seq : options.amountMinor),
    currency: 'CNY',
    localAt: '2026-09-02 10:00:00',
    utcAt: '2026-09-02 02:00:00',
    ledgerAccountId: 'credit-account',
    counterpartyLedgerAccountId: null,
    categoryId: component === 'principal' ? null : 'fee-category',
    manualFieldMask: 0,
    display: { item: item, counterparty: '', sourceNote: '' },
    accountGroupingKey: options.accountGroupingKey || 'bank|6106',
    primaryEvidence: { item: item, sourceType: 'bank', rowId: 'row-' + seq, fileName: 'bill.xls', rowNumber: seq, status: '' },
    fieldSources: { installment: { schema: 2, creditStatement: true, factKind: 'billing', component: component,
      periodNumber: options.periodNumber || 12, totalTerms: options.totalTerms == null ? 12 : options.totalTerms,
      originKind: 'unconfirmed', referenceKey: null, referenceLabel: null } },
    reasonCodes: options.reasonCodes || []
  }
}

function twoPlans() {
  return [eventOf(BILL_PRINCIPAL, 'principal', { amountMinor: 300000 }),
    eventOf(CASH_PRINCIPAL, 'principal', { amountMinor: 500000 })]
}

test('同期次有两个计划时，没写明归属的利息降为待核对并给出候选计划', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  for (const charge of events.slice(2)) {
    assert.equal(charge.status, 'needs_action')
    assert.ok(charge.reasonCodes.includes(plan.REASON_CODE))
    const attribution = charge.fieldSources.installmentAttribution
    assert.equal(attribution.planLabel, '')
    assert.equal(attribution.groupKey, 'bank|6106|12|12')
    assert.deepEqual(attribution.plans.map(item => item.planName), ['电销总账分月12期', '电销现分按月收12期'])
    assert.equal(classifyReviewIssue(charge).issueType, 'installment_origin')
    assert.equal(classifyReviewIssue(charge).primaryReason, 'installment_attribution_required')
  }
  // 本金行自己就是归属目标，不因同组有多个计划被拦：它不带归属原因码，靠同组事项的成员身份进待核对。
  // 但它同时是那张卡片的入口，所以服务端给它带的是本组上下文（role=principal），编辑器据此列出待指定的利息。
  for (const principal of events.slice(0, 2)) {
    assert.equal(principal.status, 'ready')
    assert.deepEqual(principal.reasonCodes, [])
    assert.equal(principal.fieldSources.installment.groupKey, 'bank|6106|12|12')
    const context = principal.fieldSources.installmentAttribution
    assert.equal(context.role, 'principal')
    assert.equal(context.groupKey, 'bank|6106|12|12')
    assert.deepEqual(context.plans.map(item => item.planName), ['电销总账分月12期', '电销现分按月收12期'])
  }
})

test('整组利息都指定完，本金行的组上下文随之撤掉', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  assert.equal(events[0].fieldSources.installmentAttribution.role, 'principal')
  // 用户把这笔利息指定给其中一个计划后重新整理：没有待指定费用了，本金行不再带上下文。
  events[2].fieldSources.editorOverrides = { version: 1, sourceCorrection: { planLabel: '电销现分按月收12期' } }
  applyInstallmentAttribution(events)
  assert.equal(events[0].fieldSources.installmentAttribution, undefined)
  assert.equal(events[2].fieldSources.installmentAttribution.planLabel, '电销现分按月收12期')
})

test('本期次只有一笔本金时利息自动归属，不产生待办', () => {
  const events = [eventOf(BILL_PRINCIPAL, 'principal'), eventOf(PERIOD_INTEREST, 'interest')]
  applyInstallmentAttribution(events)
  const charge = events[1]
  assert.equal(charge.status, 'ready')
  assert.deepEqual(charge.reasonCodes, [])
  assert.equal(charge.fieldSources.installmentAttribution.planLabel, '电销总账分月12期')
  assert.deepEqual(charge.fieldSources.installmentAttribution.plans, [])
})

test('费用摘要写明了计划名时直接归属，即便本期次有多个计划', () => {
  const events = twoPlans().concat([eventOf('电销现分按月收12期分期付款利息第12期共12期', 'interest')])
  applyInstallmentAttribution(events)
  const charge = events[2]
  assert.equal(charge.status, 'ready')
  assert.deepEqual(charge.reasonCodes, [])
  assert.equal(charge.fieldSources.installmentAttribution.planLabel, '电销现分按月收12期')
})

test('不同卡片、不同期次各自成组，不互相借用本金', () => {
  const events = twoPlans().concat([
    eventOf(PERIOD_INTEREST, 'interest', { accountGroupingKey: 'bank|8888' }),
    eventOf(PERIOD_INTEREST, 'interest', { periodNumber: 11 })
  ])
  applyInstallmentAttribution(events)
  // 另一张卡、另一期次都没有可用的本金计划：不猜，也不制造用户无法解决的待办。
  for (const charge of events.slice(2)) {
    assert.equal(charge.status, 'ready')
    assert.deepEqual(charge.fieldSources.installmentAttribution.plans, [])
    assert.notEqual(charge.fieldSources.installment.groupKey, 'bank|6106|12|12')
  }
})

test('用户指定计划后归属原因消失，事件回到可入账', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  const charge = events[2]
  assert.ok(evaluatePostability(charge).reasonCodes.includes(plan.REASON_CODE))
  charge.fieldSources.editorOverrides = { version: 1, sourceCorrection: { planLabel: '电销现分按月收12期' } }
  assert.equal(evaluatePostability(charge).reasonCodes.includes(plan.REASON_CODE), false)
  assert.equal(plan.confirmedPlan(charge), '电销现分按月收12期')
})

test('读取层下发计划名、已确认归属、分组键与候选计划', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  const charge = events[2]
  charge.fieldSources.editorOverrides = { version: 1, sourceCorrection: { planLabel: '电销总账分月12期' } }
  const exposed = publicEvent({ ...charge, item: PERIOD_INTEREST, fieldSources: JSON.stringify(charge.fieldSources),
    reasonCodes: JSON.stringify(charge.reasonCodes), evidenceCount: 1 })
  // 利息摘要派生出来的是泛称，正是“不能拿它当计划名”的证明。
  assert.equal(exposed.installment.planName, '分期付款利息')
  assert.equal(exposed.installment.planLabel, '电销总账分月12期')
  assert.equal(exposed.installment.groupKey, 'bank|6106|12|12')
  assert.deepEqual(exposed.installmentAttribution.plans.map(item => item.planName),
    ['电销总账分月12期', '电销现分按月收12期'])
})

test('计划归属只接受本期次已识别的候选计划', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  const charge = events[2]
  const base = { requestId: 'request', updateId: 'update', updateVersion: 1, eventId: charge.eventId, eventVersion: 1, editorVersion: 1 }
  const accepted = prepare(charge, { ...base, fields: {}, sourceCorrection: { planLabel: '电销总账分月12期' } })
  assert.equal(accepted.fieldSources.editorOverrides.sourceCorrection.planLabel, '电销总账分月12期')
  assert.equal(accepted.reasonCodes.includes(plan.REASON_CODE), false)
  assert.throws(() => prepare(charge, { ...base, fields: {}, sourceCorrection: { planLabel: '自造计划' } }), /VALIDATION_ERROR/)
  assert.throws(() => prepare(charge, { ...base, fields: {}, sourceCorrection: { planLabel: 12 } }), /VALIDATION_ERROR/)
})

test('显式 null 清除计划归属，整组退回待核对', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  const charge = events[2], base = { requestId: 'request', updateId: 'update', updateVersion: 1, eventId: charge.eventId, eventVersion: 1, editorVersion: 1 }
  const assigned = prepare(charge, { ...base, fields: {}, sourceCorrection: { planLabel: '电销现分按月收12期' } })
  assert.equal(plan.confirmedPlan(assigned), '电销现分按月收12期')
  // 清除是删键不是置空：sourceCorrection 整体消失，confirmedPlan 退回空，原因码重挂、状态回待核对。
  const cleared = prepare(assigned, { ...base, fields: {}, sourceCorrection: { planLabel: null } })
  assert.equal(cleared.fieldSources.editorOverrides.sourceCorrection, undefined)
  assert.equal(plan.confirmedPlan(cleared), '')
  assert.ok(evaluatePostability(cleared).reasonCodes.includes(plan.REASON_CODE))
  assert.equal(evaluatePostability(cleared).status, 'needs_action')
  // 同一条修正里还有期次信息时只删 planLabel，其余键保留。
  const mixed = prepare(assigned, { ...base, fields: {}, sourceCorrection: { periodNumber: 12, planLabel: null } })
  assert.deepEqual(mixed.fieldSources.editorOverrides.sourceCorrection, { periodNumber: 12 })
})

test('本期次待归属的利息合成一个问题，已确定的本金不进事项', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  let seq = 0
  const { issues, members } = buildReviewIssues('update', events, [], [], () => 'id-' + (++seq))
  const attributionIssues = issues.filter(issue => issue.primaryReasonCode === 'installment_attribution_required')
  // 两笔同文案利息落进同一个问题：用户在一张卡里看到本期还剩几笔要定。
  // 本金已经确定（本期次唯一本金或摘要写明计划名），它不该被绑在这里陪等——那是“还要核对啥”。
  assert.equal(attributionIssues.length, 1)
  assert.equal(attributionIssues[0].issueType, 'installment_origin')
  assert.equal(attributionIssues[0].blocking, true)
  assert.equal(attributionIssues[0].memberCount, 2)
  const ordered = members.filter(member => member.issueId === attributionIssues[0].issueId)
    .sort((left, right) => left.sortOrder - right.sortOrder).map(member => member.objectId)
  assert.deepEqual(ordered, [events[2].eventId, events[3].eventId])
})

test('账户还没确认时归属事项照样建出来，只装待归属的利息', () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  // 真实导入：来源账户还没确认，分期行会先被账户缺口拦下。此时 classifyReviewIssue 给的是
  // account_mapping/ledger_account_required，归属事项不能因此消失——它是待归属利息唯一的落点，
  // 一旦缺失，账户确认后利息就再没有入口可以指定给哪个计划。
  for (const event of events) {
    event.ledgerAccountId = null
    event.reasonCodes = ['ledger_account_required']
  }
  applyInstallmentAttribution(events)
  assert.ok(events[2].reasonCodes.includes(plan.REASON_CODE))
  assert.equal(classifyReviewIssue(events[2]).issueType, 'account_mapping')
  assert.equal(classifyReviewIssue(events[2]).primaryReason, 'ledger_account_required')
  let seq = 0
  const { issues, members } = buildReviewIssues('update', events, [], [], () => 'id-' + (++seq))
  const attributionIssues = issues.filter(issue => issue.primaryReasonCode === 'installment_attribution_required')
  assert.equal(attributionIssues.length, 1)
  assert.equal(attributionIssues[0].issueType, 'installment_origin')
  assert.equal(attributionIssues[0].blocking, true)
  assert.equal(attributionIssues[0].memberCount, 2)
  const ordered = members.filter(member => member.issueId === attributionIssues[0].issueId)
    .sort((left, right) => left.sortOrder - right.sortOrder).map(member => member.objectId)
  assert.deepEqual(ordered, [events[2].eventId, events[3].eventId])
})

// 补建路径只带着"刚被放出来的费用"调用，本金不在入参里：要么回库把整组捞回来，要么就会
// 退化成"一笔利息一条事项"——正是用户在待核对里看到、并明确否掉的那个形态。
function ledgerConnection(events, jsonStrings = false) {
  const executed = []
  return { executed, execute: async (sql, params) => {
    const text = String(sql)
    executed.push({ sql: text.replace(/\s+/g, ' ').trim(), params })
    if (text.includes('catledger_economic_events')) {
      return [events.map(event => ({ eventId: event.eventId, version: event.version,
        fieldSources: jsonStrings ? JSON.stringify(event.fieldSources) : event.fieldSources,
        reasonCodes: jsonStrings ? JSON.stringify(event.reasonCodes || []) : (event.reasonCodes || []) }))]
    }
    if (/^\s*SELECT/.test(text)) return [[]]
    return [{ affectedRows: 1 }]
  } }
}

// 写入是批量拼一条 INSERT，一条语句里可能有多行；断言事项/成员数量必须按行拆开看。
function insertedRows(connection, table, columnsPerRow) {
  const rows = []
  for (const entry of connection.executed) {
    if (!entry.sql.startsWith('INSERT INTO ' + table + ' ')) continue
    for (let index = 0; index < entry.params.length; index += columnsPerRow) {
      rows.push(entry.params.slice(index, index + columnsPerRow))
    }
  }
  return rows
}

test('账户确认后补建事项，只把待归属的利息收进同一条', async () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  const connection = ledgerConnection(events)
  await createFollowUpIssues(connection, 'uid', 'update', events.slice(2))
  const issues = insertedRows(connection, 'catledger_review_issues', 14)
  const members = insertedRows(connection, 'catledger_review_issue_members', 9)
  // 两笔利息只对应一条事项；本金不在入参里也不该被补挂进来——它已经确定。
  assert.equal(issues.length, 1)
  assert.equal(issues[0][5], 'installment_origin')
  assert.equal(issues[0][8], 1)
  assert.equal(issues[0][9], 'installment_attribution_required')
  assert.equal(issues[0][10], 2)
  assert.equal(issues[0][11], 0)
  assert.equal(members.length, 2)
  assert.deepEqual(members.map(row => row[5]), [events[2].eventId, events[3].eventId])
  assert.deepEqual(members.map(row => row[8]), [0, 1])
  assert.ok(members.every(row => row[7] === 'subject'))
  // 事项带上的原因码只来自待归属的费用，本金不复制一份自己的"问题"。
  assert.deepEqual(JSON.parse(issues[0][13]), ['installment_attribution_required'])
})

test('组内另有自己问题的费用不进归属事项，仍各自成条', async () => {
  const assigned = eventOf(PERIOD_INTEREST, 'interest', { reasonCodes: ['category_required'] })
  // 已经指定过计划的费用不再是归属问题，只剩分类待办；它不该被归属事项顺带吸收掉。
  assigned.categoryId = null
  assigned.fieldSources.editorOverrides = { version: 1, sourceCorrection: { planLabel: '电销总账分月12期' } }
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), assigned])
  applyInstallmentAttribution(events)
  const connection = ledgerConnection(events)
  await createFollowUpIssues(connection, 'uid', 'update', events.slice(2))
  const issues = insertedRows(connection, 'catledger_review_issues', 14)
  // 归属事项只吸收还没归属的费用：本期次只剩一笔，事项就一个成员。
  const attribution = issues.filter(row => row[9] === 'installment_attribution_required')
  assert.equal(attribution.length, 1)
  assert.equal(attribution[0][10], 1)
  // 另一笔已指定计划的费用只剩分类待办，自己单独成条，不被归属事项顺带吸收。
  const category = issues.filter(row => row[9] === 'category_required')
  assert.equal(category.length, 1)
  assert.equal(category[0][5], 'category_assignment')
  assert.equal(category[0][10], 1)
  assert.equal(issues.length, 2)
})

test('计划名只从摘要去掉期次后缀，不把利息泛称当计划', () => {
  assert.equal(plan.planNameFromItem(BILL_PRINCIPAL), '电销总账分月12期')
  assert.equal(plan.planNameFromItem(CASH_PRINCIPAL), '电销现分按月收12期')
  assert.equal(plan.planNameFromItem(PERIOD_INTEREST), '分期付款利息')
  assert.equal(plan.planNameFromItem('分期付款利息第12期／共12期'), '分期付款利息')
  assert.equal(plan.planNameFromItem('分期付款利息第3期'), '分期付款利息')
})

// 早期版本的增量补建按单笔 eventKey 建事项：同一期次的利息各自成条，本金压根没进过事项，
// 于是本金留在已核对、利息留在待核对，用户看到的是“本金核对完了、利息还没归属”这种对不上的状态。
// 整理时按分组键把分歧收拢回一条：保留其中一条，其余收尾，成员补齐为整组（本金在前）。
function collapsedConnection(events, memberships, jsonStrings = false) {
  const executed = []
  return { executed, execute: async (sql, params) => {
    const text = String(sql)
    executed.push({ sql: text.replace(/\s+/g, ' ').trim(), params })
    if (text.includes('catledger_economic_events')) {
      return [events.map(event => ({ eventId: event.eventId, version: event.version,
        fieldSources: jsonStrings ? JSON.stringify(event.fieldSources) : event.fieldSources,
        reasonCodes: jsonStrings ? JSON.stringify(event.reasonCodes || []) : (event.reasonCodes || []) }))]
    }
    if (text.includes('catledger_review_issue_members') && /^\s*SELECT/.test(text)) {
      const rows = []
      memberships.forEach(membership => membership.issueIds.forEach(issueId =>
        rows.push({ issueId: issueId, eventId: membership.eventId })))
      return [rows]
    }
    if (/^\s*SELECT/.test(text)) return [[]]
    return [{ affectedRows: 1 }]
  } }
}

test('整理时把被拆开的分期事项收拢成一条，成员只留待归属费用', async () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  // 复现线上形态：两笔利息各是一条事项。
  const connection = collapsedConnection(events, [
    { eventId: events[2].eventId, issueIds: ['issue-a'] },
    { eventId: events[3].eventId, issueIds: ['issue-b'] }
  ])
  assert.equal(await collapseInstallmentIssues(connection, 'uid', 'update', 'action-1'), 1)
  // 只留一条：字典序靠前的 issue-a 保留，issue-b 清空成员并收尾。
  const superseded = connection.executed.filter(entry => entry.sql.includes("status = 'superseded'"))
  assert.equal(superseded.length, 1)
  assert.deepEqual(superseded[0].params.slice(0, 6), ['action-1', 'uid', 'issue-b', 'uid', 'update', 'issue-b'])
  // 留下的那条重写成全部待归属费用，sort_order 就是卡片顺序。
  const members = insertedRows(connection, 'catledger_review_issue_members', 9)
  assert.equal(members.length, 2)
  assert.deepEqual(members.map(row => row[3]), ['issue-a', 'issue-a'])
  assert.deepEqual(members.map(row => row[5]), [events[2].eventId, events[3].eventId])
  assert.deepEqual(members.map(row => row[8]), [0, 1])
  assert.ok(members.every(row => row[7] === 'subject'))
})

test('历史事项里混着的本金与已归好的费用，整理时摘掉只留待归属费用', async () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  // 旧口径把整组都塞进了同一件事项：本金和两笔利息都是成员。
  const connection = collapsedConnection(events,
    events.map(event => ({ eventId: event.eventId, issueIds: ['issue-a'] })))
  assert.equal(await collapseInstallmentIssues(connection, 'uid', 'update', 'action-1'), 1)
  // 摘掉本金：它们已经确定，留在待核对里用户只会问“还要核对啥”。
  const members = insertedRows(connection, 'catledger_review_issue_members', 9)
  assert.deepEqual(members.map(row => row[5]), [events[2].eventId, events[3].eventId])
  assert.deepEqual(members.map(row => row[8]), [0, 1])
})

test('事项成员就是全部待归属费用时不再重写', async () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  const connection = collapsedConnection(events, [
    { eventId: events[2].eventId, issueIds: ['issue-a'] },
    { eventId: events[3].eventId, issueIds: ['issue-a'] }
  ])
  assert.equal(await collapseInstallmentIssues(connection, 'uid', 'update', 'action-1'), 0)
  // 整理每次打开工作台都会跑到这里，已经对了就不能反复写库。
  assert.equal(connection.executed.filter(entry => /DELETE FROM|UPDATE catledger_review_issues/.test(entry.sql)).length, 0)
})

test('整理期没建出归属事项时，收敛入口按待归属费用补建一条', async () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  // 线上形态：分期行还缺账户，分类先判成 account_mapping，归属事项一条都没建（memberships 为空）。
  const connection = collapsedConnection(events, [])
  assert.equal(await collapseInstallmentIssues(connection, 'uid', 'update', null), 1)
  const issues = insertedRows(connection, 'catledger_review_issues', 14)
  assert.equal(issues.length, 1)
  assert.equal(issues[0][5], 'installment_origin')
  assert.equal(issues[0][8], 1)
  assert.equal(issues[0][9], 'installment_attribution_required')
  assert.equal(issues[0][10], 2)
  assert.equal(issues[0][11], 0)
  // 补建只装待归属的费用；本金已经确定，不该被拉进待核对。
  const members = insertedRows(connection, 'catledger_review_issue_members', 9)
  assert.equal(members.length, 2)
  assert.deepEqual(members.map(row => row[5]), [events[2].eventId, events[3].eventId])
})

test('归属问题解决后原因码由通用结算通道清除', () => {
  const { resolvedReasons } = require('../cloudfunctions/catledger-import/src/review/policy')
  // 编辑器通道（editor-policy 的 derived）已经会清掉它；通用决定通道靠这张表，
  // 两处口径必须一致，否则换个入口解决同一件事，事件会永远停在待核对。
  assert.deepEqual(resolvedReasons('installment_origin', ['installment_attribution_required', 'category_required']),
    ['category_required'])
})

test('JSON 字符串返回与 mysql2 默认对象返回保持相同的待归属成员', async () => {
  const events = twoPlans().concat([eventOf(PERIOD_INTEREST, 'interest'), eventOf(PERIOD_INTEREST, 'interest')])
  applyInstallmentAttribution(events)
  for (const jsonStrings of [false, true]) {
    const followUp = ledgerConnection(events, jsonStrings)
    await createFollowUpIssues(followUp, 'uid', 'update', events.slice(2))
    assert.equal(insertedRows(followUp, 'catledger_review_issues', 14).length, 1)
    const collapsed = collapsedConnection(events, [
      { eventId: events[2].eventId, issueIds: ['issue-a'] },
      { eventId: events[3].eventId, issueIds: ['issue-b'] }
    ], jsonStrings)
    assert.equal(await collapseInstallmentIssues(collapsed, 'uid', 'update'), 1)
    const expected = [events[2].eventId, events[3].eventId].sort()
    for (const connection of [followUp, collapsed]) {
      assert.deepEqual(insertedRows(connection, 'catledger_review_issue_members', 9).map(row => row[5]).sort(), expected)
    }
  }
})
