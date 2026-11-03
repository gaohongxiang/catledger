const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { parseEvidenceFile } = require('../cloudfunctions/catledger-import/src/parsers')
const { buildOrganizePlan, PLAN_VERSION } = require('../cloudfunctions/catledger-import/src/organizer-planner')
const { publicIssue } = require('../cloudfunctions/catledger-import/src/review-presentation')
const { statementAnalysis } = require('../cloudfunctions/catledger-import/src/statement-analysis')
const { localWorkbench } = require('./helpers/local-workbench')
const { syntheticBill } = require('./helpers/local-services')
const sessions = require('../miniprogram/packages/finance/services/import-local-session')
const accountTypes = require('../miniprogram/packages/finance/domain/import-review/account-type-policy')

const plain = value => JSON.parse(JSON.stringify(value))
const tap = data => ({ currentTarget: { dataset: data } })
const fullLabel = '合成测试银行信用卡(6106)'
const aliasLabel = '主卡6106'
const account = (name, type, extra = {}) => ({ accountId: randomUUID(), name, type,
  nature: type === 'credit' ? 'liability' : 'asset', currency: 'CNY', version: 1, ...extra })

// Real parser/planner output, including the bank mapping and original timestamp
// required by repayment pairing. No source semantics or member roles are faked.
async function pairedFacts(accounts) {
  const updateId = randomUUID(), documents = []
  const contents = [Buffer.from([
    '导出信息:合成还款验收',
    '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    `2026-09-02 08:35:45,信用借还,${fullLabel},信用卡还款,支出,500.00,余额,还款成功,SYNTHETIC-PAIRED-TYPE-ALI-REPAY,,`,
    `2026-09-03 08:35:45,餐饮美食,合成商户,合成商品,支出,1.00,${fullLabel},交易成功,SYNTHETIC-PAIRED-TYPE-ALI-EXPENSE,,`
  ].join('\n')), Buffer.from([
    '交易日期,交易金额,收支,交易类型,摘要,账户,交易流水号',
    `2026-09-02 09:10,500.00,收入,,支付宝还款,${aliasLabel},SYNTHETIC-PAIRED-TYPE-BANK-REPAY`,
    `2026-09-04 09:10,2.00,支出,消费,合成商品,${aliasLabel},SYNTHETIC-PAIRED-TYPE-BANK-EXPENSE`
  ].join('\n')), syntheticBill(5, 'SYNTHETIC-PAIRED-TYPE-UNSELECTED')]
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
  for (const [{ document, batchId }, sourceOrder] of documents.map((value, index) => [value, index])) {
    document.rows.forEach((row, index) => {
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
    })
  }
  const plan = buildOrganizePlan({ updateId, rows, accounts, paymentMappings: [] })
  const events = plan.events.map(({ relationEvidence, sameEventCandidateKey, ...event }) => event)
  const eventById = new Map(events.map(event => [event.eventId, event]))
  const rowById = new Map(rows.map(row => [row.rowId, row]))
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
  const sources = documents.map(({ document, batchId }, index) => ({ sourceId: 'synthetic-paired-source-' + index,
    batchId, fileName: '合成配对账单' + index + '.csv', sourceType: document.descriptor.sourceType,
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

async function setupPaired(t) {
  const credit = account(fullLabel, 'credit'), wallet = account('支付宝账户余额', 'wallet')
  const wrong = [account('合成储蓄卡', 'bank'), account('合成美元信用卡', 'credit', { currency: 'USD' }),
    account('合成已停用信用卡', 'credit', { disabledAt: '2026-09-01 00:00:00.000' })]
  const data = await pairedFacts([credit, wallet, ...wrong]), h = await localWorkbench(t, data)
  const original = [...h.local.model.issues.values()].filter(issue => issue.issueType === 'account_mapping')
  const relevant = original.filter(issue => issue.accountContext.sourceType !== 'wechat')
  const bankIssue = relevant.find(issue => issue.accountContext.label === aliasLabel)
  h.local.call('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), decisions: relevant.map(issue => ({
    issueId: issue.issueId, decision: 'apply_fields', fields: {
      mappingAccountId: /余额/.test(issue.accountContext.label) ? wallet.accountId : credit.accountId }
  })) })
  const pairs = h.local.call('reviewIssues.pairings', { mode: 'suggested', pageSize: 20 })
  assert.equal(pairs.items.length, 1)
  assert.equal(pairs.items[0].pairKind, 'repayment')
  h.local.call('reviewIssues.resolvePairings', { requestId: randomUUID(), scopeToken: pairs.scopeToken,
    selection: { mode: 'explicit', pairs: [{ pairKey: pairs.items[0].pairKey, decision: 'same', repaymentConfirmed: true }] } })
  await h.page.applyUpdateView(h.local.view)
  await h.page.setStep({ currentStep: 2 })
  return { ...h, credit, wallet, wrong, bankIssue, relevant }
}

function assertCreditCard(page, credit) {
  const raw = page.mappingState().rawMappings.find(mapping => mapping.sourceLabel === aliasLabel)
  assert.deepEqual(plain(raw.accountContext.allowedAccountTypes), ['credit'])
  assert.equal(raw.accountContext.fundsRole, 'destination')
  assert.equal(raw.validationText, '')
  assert.equal(raw.canConfirm, true)
  assert.equal(raw.needsConfirmation, false)
  const joint = page.data.accountMappings.find(mapping => mapping.choiceValue === 'account:' + credit.accountId)
  assert.ok(joint?.groupId, '同一信用卡的银行来源和支付宝来源仍合为一张卡')
  assert.equal(joint.memberCount, 3, '两端已确认同笔的还款只算一笔，加两笔独立消费')
  assert.equal(joint.validationText, '')
  assert.equal(joint.canConfirm, true)
  assert.equal(joint.needsConfirmation, false)
  assert.equal(page.data.accountMappings[0].sourceLabel, '微信零钱', '未确认组仍排在已确认信用卡前面')
  return joint
}

test('真实银行还款配对后回到账户页：主卡已确认信用卡不被付款端重判，同ID合卡按唯一笔数排序', async t => {
  const h = await setupPaired(t), joint = assertCreditCard(h.page, h.credit)
  const context = h.page.mappingState().rawMappings.find(mapping => mapping.sourceLabel === aliasLabel).accountContext
  assert.equal(context.fundsSide, 'ordinary', '保留旧快照来源上下文，真正资金角色由完整成员决定')
  for (const invalid of h.wrong) assert.equal(accountTypes.compatible(context, invalid), false)
  await h.page.openAccountChoice(tap({ id: joint.issueId }))
  assert.deepEqual(plain(h.page.data.accountChoiceResults.map(row => row.accountId)), [h.credit.accountId])
  h.page.closeAccountChoice()
  await h.page.openAccountRecords(tap({ id: joint.issueId }))
  assert.equal(h.page.data.accountRecordsSheet.count, 3)
  assert.equal(new Set(h.page.data.accountRecordsSheet.records.map(row => row.eventId)).size, 3)
  assert.equal(h.network.length, 0)
})

test('真实银行还款配对的本机日志冷恢复：信用卡归属、合卡和类型限制保持', async t => {
  const h = await setupPaired(t)
  assertCreditCard(h.page, h.credit)
  h.page.onUnload()
  const local = sessions.create({ files: h.files, restored: h.files.restore(), requestId: randomUUID,
    callNetwork() { assert.fail('本机恢复不得补读网络') } })
  h.load(path.resolve(__dirname, '../miniprogram/services/import-local-router.js')).bind(local)
  h.summary = local.view
  const page = h.createPage({}, false)
  t.after(() => page.onUnload())
  await page.applyUpdateView(local.view)
  await page.setStep({ currentStep: 2 })
  assertCreditCard(page, h.credit)
  assert.equal(local.model.choices.pairings.size, 1)
  assert.equal(local.model.choices.accounts.size, h.relevant.length)
  assert.equal(h.network.length, 0)
})
