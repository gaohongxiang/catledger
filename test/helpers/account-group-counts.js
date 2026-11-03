const { createHash, randomUUID } = require('node:crypto')
const { parseEvidenceFile } = require('../../cloudfunctions/catledger-import/src/parsers')
const { buildOrganizePlan, PLAN_VERSION } = require('../../cloudfunctions/catledger-import/src/organizer-planner')
const { publicIssue } = require('../../cloudfunctions/catledger-import/src/review-presentation')
const { statementAnalysis } = require('../../cloudfunctions/catledger-import/src/statement-analysis')
const { buildSourceProfile, buildRowIdentity } = require('../../cloudfunctions/catledger-import/src/identity')

const label = '合成测试银行信用卡(6106)'
const account = (name, type) => ({ accountId: randomUUID(), name, type,
  nature: type === 'credit' ? 'liability' : 'asset', currency: 'CNY', version: 1 })

// 71 genuine parser rows: bank 40, WeChat 30, Alipay 1. The 29 card purchases
// and two wallet repayments can be explicitly paired, yielding 40 events.
async function accountGroupCountsFacts({ duplicateWechat = false } = {}) {
  const credit = account(label, 'credit'), wechat = account('微信零钱', 'wallet'), alipay = account('支付宝账户余额', 'wallet')
  const accounts = [credit, wechat, alipay], updateId = randomUUID(), documents = []
  const contents = [Buffer.from([
    '交易日期,交易金额,收支,交易类型,摘要,账户,交易流水号',
    ...Array.from({ length: 40 }, (_, index) => index === 29
      ? '2026-09-02 09:10,1000.00,收入,,财付通还款,主卡6106,SYNTHETIC-GROUP-COUNT-BANK-WXREPAY'
      : index === 30 ? '2026-09-03 09:10,2000.00,收入,,支付宝还款,主卡6106,SYNTHETIC-GROUP-COUNT-BANK-ALIREPAY'
      : `2026-09-01 12:${String(index).padStart(2, '0')},${index + 1}.00,支出,消费,财付通-合成商户,主卡6106,SYNTHETIC-GROUP-COUNT-BANK-${index}`)
  ].join('\n')), Buffer.from([
    '微信支付账单明细,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
    ...Array.from({ length: 29 }, (_, index) =>
      `2026-09-01 12:${String(index).padStart(2, '0')}:45,商户消费,合成商户,合成商品,支出,${index + 1}.00,${label},支付成功,SYNTHETIC-GROUP-COUNT-WX-${index},,,`),
    '2026-09-02 08:35:45,信用卡还款,信用卡,信用卡还款,支出,1000.00,微信零钱,还款成功,SYNTHETIC-GROUP-COUNT-WX-REPAY,,,'
  ].join('\n')), Buffer.from([
    '导出信息:合成来源计数',
    '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-09-03 08:35:45,信用借还,信用卡,信用卡还款,支出,2000.00,余额,还款成功,SYNTHETIC-GROUP-COUNT-ALI-REPAY,,'
  ].join('\n'))]
  if (duplicateWechat) contents.push(Buffer.from(contents[1].toString().split('\n').slice(0, 3).join('\n')))
  for (const content of contents) {
    const input = { content, extension: 'csv', timezoneOffsetMinutes: -480 }
    let document = await parseEvidenceFile(input)
    if (document.bankPreview) {
      const preview = document.bankPreview
      document = await parseEvidenceFile({ ...input, bankMapping: { ...preview.suggested,
        schemaVersion: 1, headerRow: preview.headerRow, sheetIndex: preview.sheetIndex,
        headerToken: preview.headerToken, statementKind: 'credit' } })
    }
    documents.push({ document, batchId: randomUUID(), fileSha256: createHash('sha256').update(content).digest('hex') })
  }
  const rows = [], raw = [], identities = new Map(), profiles = new Map()
  documents.forEach(({ document, batchId, fileSha256 }, sourceOrder) => document.rows.forEach((row, index) => {
    const rowId = randomUUID()
    const profile = buildSourceProfile({ sourceType: document.descriptor.sourceType, candidate: document.metadata.sourceProfile })
    if (!profiles.has(profile.profileKey)) profiles.set(profile.profileKey, randomUUID())
    const identity = buildRowIdentity({ sourceType: document.descriptor.sourceType, sourceProfileKey: profile.profileKey, fileSha256, row })
    // Mirrors the repository's unique source identity: repeated exports share
    // identity while their separate evidence rows and file scopes stay intact.
    if (!identities.has(identity.identityKey)) identities.set(identity.identityKey, randomUUID())
    rows.push({ ...row.normalized, rowId, batchId, sourceOrder, rowNumber: index + 1,
      parseState: row.parseState, identityId: identities.get(identity.identityKey), identityState: 'new', identityKind: identity.kind,
      sourceProfileId: profiles.get(profile.profileKey), sourceProfileKey: profile.profileKey,
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
  const sources = documents.map(({ document, batchId }, index) => ({ sourceId: 'synthetic-count-source-' + index,
    batchId, fileName: '合成账户计数账单' + index + '.csv', sourceType: document.descriptor.sourceType,
    sourceFormat: document.descriptor.sourceFormat, parserVersion: document.descriptor.parserVersion,
    normalizationVersion: document.descriptor.normalizationVersion, identityVersion: document.identityVersion,
    contentState: 'review_ready', contentDeletedAt: null, summary: { total: document.rows.length }, analysis: statementAnalysis(document) }))
  const value = JSON.parse(JSON.stringify({ protocolVersion: 3, ruleVersion: PLAN_VERSION, snapshotId: randomUUID(),
    update: { updateId, version: 2, status: 'review', reviewMode: 'local_v3', planVersion: PLAN_VERSION, counts: plan.counts },
    sources, events, issues, members: plan.members, rows, raw,
    evidence: plan.evidence.map(link => ({ ...link, identityKind: rowById.get(link.rowId).identityKind })),
    relations: plan.relations, links: [], accounts, accountDrafts: [], categories: [], loans: [], contracts: [], charges: [],
    actions: [], paymentMappings: [], history: [], historyGroups: [], refundCandidates: [],
    historyCoverage: { duplicates: events.map(event => Object.fromEntries(
      ['eventId', 'amountMinor', 'utcAt', 'ledgerAccountId', 'counterpartyLedgerAccountId', 'flowDirection'].map(key => [key, event[key]]))), refunds: [] },
    summary: { sources } }))
  return { value, credit, wechat, alipay }
}

module.exports = { accountGroupCountsFacts }
