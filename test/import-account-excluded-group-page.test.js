const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { parseEvidenceFile } = require('../cloudfunctions/catledger-import/src/parsers')
const { buildOrganizePlan, PLAN_VERSION } = require('../cloudfunctions/catledger-import/src/organizer-planner')
const { publicIssue } = require('../cloudfunctions/catledger-import/src/review-presentation')
const { statementAnalysis } = require('../cloudfunctions/catledger-import/src/statement-analysis')
const { localWorkbench } = require('./helpers/local-workbench')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')

const plain = value => JSON.parse(JSON.stringify(value))
const tap = data => ({ currentTarget: { dataset: data } })
const label = '合成测试银行信用卡(6106)'
const alias = '主卡6106'
const account = (name, type) => ({ accountId: randomUUID(), name, type,
  nature: type === 'credit' ? 'liability' : 'asset', currency: 'CNY', version: 1 })

async function sourceFacts(accounts, counts = { bank: 40, alipay: 29, savings: 29, huabei: 50 }) {
  const updateId = randomUUID(), documents = []
  const contents = [Buffer.from([
    '导出信息:合成账户排除验收',
    '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    ...[[counts.alipay, label], [counts.savings, '余额宝'], [counts.huabei, '花呗']].flatMap(([count, method], group) =>
      Array.from({ length: count }, (_, index) =>
        `2026-09-02 12:00:00,餐饮美食,合成商户,合成商品,支出,1.00,${method},交易成功,SYNTHETIC-EXCLUDED-ALI-${group}-${index},,`))
  ].join('\n')), Buffer.from([
    '交易日期,交易金额,收支,交易类型,摘要,账户,交易流水号',
    ...Array.from({ length: counts.bank }, (_, index) =>
      `2026-09-01 09:${String(index).padStart(2, '0')},2.00,支出,消费,合成商品,${alias},SYNTHETIC-EXCLUDED-BANK-${index}`)
  ].join('\n'))]
  for (const content of contents) {
    const input = { content, extension: 'csv', timezoneOffsetMinutes: -480 }
    let document = await parseEvidenceFile(input)
    if (document.bankPreview) {
      const preview = document.bankPreview
      document = await parseEvidenceFile({ ...input, bankMapping: { ...preview.suggested,
        schemaVersion: 1, headerRow: preview.headerRow, sheetIndex: preview.sheetIndex,
        headerToken: preview.headerToken, statementKind: 'credit' } })
    }
    documents.push({ document, batchId: randomUUID() })
  }
  const rows = [], raw = []
  documents.forEach(({ document, batchId }, sourceOrder) => document.rows.forEach((row, index) => {
    const rowId = randomUUID()
    rows.push({ ...row.normalized, rowId, batchId, sourceOrder, rowNumber: index + 1,
      parseState: row.parseState, identityId: randomUUID(), identityState: 'new',
      sourceType: document.descriptor.sourceType, sourceFormat: document.descriptor.sourceFormat,
      rawTransactionTime: row.raw.transactionTime, rawTransactionType: row.raw.transactionType,
      rawStatus: row.raw.status, bankStatementKind: row.raw.bankStatementKind,
      paymentMethod: row.raw.paymentMethod, semantic: row.semantic,
      sourceTransactionId: row.identifiers.transactionId, sourceOrderId: row.identifiers.orderId,
      sourceMerchantOrderId: row.identifiers.merchantOrderId })
    raw.push({ rowId, fields: row.raw })
  }))
  const plan = buildOrganizePlan({ updateId, rows, accounts, paymentMappings: [] })
  const events = plan.events.map(({ relationEvidence, sameEventCandidateKey, ...event }) => event)
  const eventById = new Map(events.map(event => [event.eventId, event])), rowById = new Map(rows.map(row => [row.rowId, row]))
  const primary = new Map(plan.evidence.filter(link => link.evidenceRole === 'primary')
    .map(link => [link.eventId, rowById.get(link.rowId)]))
  const issues = plan.issues.map(issue => {
    const members = plan.members.filter(member => member.issueId === issue.issueId &&
      member.objectType === 'event' && member.memberRole !== 'candidate')
    const member = members.find(value => value.sortOrder === 0), event = eventById.get(member?.objectId), row = primary.get(event?.eventId)
    const { accountContext } = publicIssue({ ...issue, subjectEventId: event?.eventId,
      subjectMemberRole: member?.memberRole, subjectEconomicNature: event?.economicNature,
      subjectSourceDirection: event?.sourceDirection, subjectCurrency: event?.currency,
      subjectFieldSources: event?.fieldSources, subjectLedgerAccountId: event?.ledgerAccountId,
      subjectCounterpartyLedgerAccountId: event?.counterpartyLedgerAccountId,
      subjectSourceType: row?.sourceType, subjectPaymentMethod: row?.paymentMethod })
    return { ...issue, accountContext, subjectEventIds: [...new Set(members.map(value => value.objectId))] }
  })
  const sources = documents.map(({ document, batchId }, index) => ({ sourceId: 'synthetic-excluded-source-' + index,
    batchId, fileName: '合成账户排除账单' + index + '.csv', sourceType: document.descriptor.sourceType,
    sourceFormat: document.descriptor.sourceFormat, parserVersion: document.descriptor.parserVersion,
    normalizationVersion: document.descriptor.normalizationVersion, identityVersion: document.identityVersion,
    contentState: 'review_ready', contentDeletedAt: null, summary: { total: document.rows.length }, analysis: statementAnalysis(document) }))
  return plain({ protocolVersion: 3, ruleVersion: PLAN_VERSION, snapshotId: randomUUID(),
    update: { updateId, version: 2, status: 'review', reviewMode: 'local_v3', planVersion: PLAN_VERSION, counts: plan.counts },
    sources, events, issues, members: plan.members, rows, raw,
    evidence: plan.evidence.map(link => ({ ...link, identityKind: 'source_transaction_id' })),
    relations: plan.relations, links: [], accounts, accountDrafts: [], categories: [], loans: [], contracts: [], charges: [],
    actions: [], paymentMappings: [], history: [], historyGroups: [], refundCandidates: [],
    historyCoverage: { duplicates: events.map(event => Object.fromEntries(
      ['eventId', 'amountMinor', 'utcAt', 'ledgerAccountId', 'counterpartyLedgerAccountId', 'flowDirection'].map(key => [key, event[key]]))), refunds: [] },
    summary: { sources } })
}

async function setup(t, counts) {
  const credit = account(label, 'credit'), savings = account('支付宝余额宝', 'other_asset'), huabei = account('支付宝花呗', 'credit')
  const other = account('合成另一信用卡', 'credit'), h = await localWorkbench(t, await sourceFacts([credit, savings, huabei, other], counts))
  const issues = [...h.local.model.issues.values()].filter(issue => issue.issueType === 'account_mapping')
  const bankIssue = issues.find(issue => issue.accountContext.sourceType === 'bank')
  h.local.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: issues.map(issue => ({
    issueId: issue.issueId, decision: 'apply_fields', fields: { mappingAccountId:
      /余额宝/.test(issue.accountContext.label) ? savings.accountId : /花呗/.test(issue.accountContext.label) ? huabei.accountId : credit.accountId }
  })) })
  await h.page.applyUpdateView(h.local.view)
  await h.page.setStep({ currentStep: 2 })
  return { ...h, credit, savings, huabei, other, bankIssue }
}

function assertJoined(page, credit) {
  const cards = page.data.accountMappings
  assert.deepEqual(plain(cards.map(card => card.memberCount)), [69, 50, 29])
  assert.ok(cards.every(card => !card.needsConfirmation && card.validationText === ''))
  assert.equal(cards[0].choiceValue, 'account:' + credit.accountId)
  assert.ok(cards[0].groupId)
  assert.equal(cards[0].groupSourceCount, 2)
  assert.deepEqual(plain(cards[0].groupSourceChips.map(chip => chip.label).sort()), ['支付宝', '银行'])
  return cards[0]
}

async function excludeOne(h) {
  const eventId = h.bankIssue.subjectEventIds.slice().sort((left, right) =>
    h.local.model.events.get(left).localAt.localeCompare(h.local.model.events.get(right).localAt))[0]
  const issue = h.local.model.eventIssues(eventId).find(item => item.issueType === 'category_assignment')
  assert.ok(issue, '第三步逐笔排除使用真实的待分类事项')
  await h.page.setStep({ currentStep: 3 })
  h.local.call('reviewIssues.resolve', { requestId: randomUUID(), issueId: issue.issueId, decision: 'exclude_events',
    selection: { mode: 'include', eventIds: [eventId] } })
  await h.page.applyUpdateView(h.local.view)
  await h.page.setStep({ currentStep: 2 })
  return eventId
}

async function reconfirm(h, excludedId) {
  const joint = assertJoined(h.page, h.credit)
  h.page.closeAccountRecords()
  await h.page.openAccountChoice(tap({ id: joint.issueId }))
  await h.page.selectAccountChoice(tap({ value: 'account:' + h.credit.accountId }))
  const pending = h.page.data.accountMappings.find(card => card.choiceValue === 'account:' + h.credit.accountId)
  assert.equal(pending.memberCount, 69)
  assert.equal(pending.needsConfirmation, true)
  await h.page.completeAccountMapping(tap({ id: pending.issueId }))
  assert.equal(h.page.data.accountStepError, '')
  assert.equal(h.local.model.events.get(excludedId).status, 'excluded')
  assert.ok(h.local.model.events.get(excludedId).reasonCodes.includes('manual_exclusion'))
  assertJoined(h.page, h.credit)
}

test('真实银行40笔与支付宝29笔：第三步单笔排除不拆散已确认同账户，69笔合卡按总数排序', async t => {
  const h = await setup(t)
  assertJoined(h.page, h.credit)
  const excludedId = await excludeOne(h), financial = plain(h.local.model.finalState())
  const joint = assertJoined(h.page, h.credit)
  assert.equal(h.local.model.events.get(excludedId).status, 'excluded')
  assert.equal(h.local.model.events.get(excludedId).ledgerAccountId, h.credit.accountId)
  assert.equal(h.local.model.issues.get(h.bankIssue.issueId).status, 'resolved')
  await h.page.openAccountRecords(tap({ id: joint.issueId }))
  assert.equal(h.page.data.accountRecordsSheet.count, 69)
  const excluded = h.page.data.accountRecordsSheet.records.find(record => record.eventId === excludedId)
  assert.match(excluded?.exclusionReasonText || '', /排除|不计/u)
  const ids = [], options = h.page.businessData().accountConfirmationOptions
  let cursor = null
  do {
    const response = h.local.call('reviewIssues.members', { accountConfirmationGroupId: joint.issueId,
      ...options, memberKind: 'event', pageSize: 20, cursor })
    ids.push(...response.items.map(member => member.objectId)); cursor = response.nextCursor
  } while (cursor)
  assert.equal(ids.length, 69)
  assert.equal(new Set(ids).size, 69)
  assert.equal(ids.filter(id => id === excludedId).length, 1)
  assert.deepEqual(plain(h.local.model.finalState()), financial, '显示、排序和来源详情不修改排除决定或金融事实')
  await reconfirm(h, excludedId)
  assert.equal(h.network.length, 0)
})

test('单笔排除后的69笔信用卡再次共同确认及冷恢复一致，逐笔排除记录不被复活', async t => {
  const h = await setup(t), excludedId = await excludeOne(h)
  await reconfirm(h, excludedId)
  const financial = plain(h.local.model.finalState())
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('本机恢复不得访问网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.createPage({}, false)
  t.after(() => page.onUnload())
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  assertJoined(page, h.credit)
  assert.equal(local.model.events.get(excludedId).status, 'excluded')
  assert.ok(local.model.events.get(excludedId).reasonCodes.includes('manual_exclusion'))
  assert.deepEqual(plain(local.model.finalState()), financial)
  assert.equal(h.network.length, 0)
})

test('整账户不计入、外部归属、不同账户仍不并入另一张已确认信用卡', async t => {
  for (const mode of ['ignore', 'external', 'different']) await t.test(mode, async t => {
    const h = await setup(t, { bank: 2, alipay: 2, savings: 0, huabei: 0 })
    assert.equal(h.page.data.accountMappings.length, 1)
    h.local.call('reviewIssues.reviseAccountMapping', { requestId: randomUUID(), issueId: h.bankIssue.issueId,
      decision: mode === 'ignore' ? 'exclude_events' : 'apply_fields',
      ...(mode === 'external' ? { paymentRuleAction: 'external' } : {}),
      fields: mode === 'different' ? { mappingAccountId: h.other.accountId } : {} })
    await h.page.applyUpdateView(h.local.view)
    await h.page.loadActivePage(true)
    const cards = h.page.data.accountMappings
    assert.equal(cards.length, 2)
    assert.ok(cards.every(card => !card.groupId && card.memberCount === 2))
    const bank = cards.find(card => card.sourceLabel === alias)
    assert.equal(bank.choiceValue, mode === 'different' ? 'account:' + h.other.accountId : mode)
    assert.equal(h.page.data.accountMappingsExcluded.length, mode === 'ignore' ? 1 : 0)
    assert.equal(h.network.length, 0)
  })
})
