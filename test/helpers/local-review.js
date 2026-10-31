const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { parseEvidenceFile } = require('../../cloudfunctions/catledger-import/src/parsers')
const { buildOrganizePlan, PLAN_VERSION } = require('../../cloudfunctions/catledger-import/src/organizer-planner')
const protocol = require('../../cloudfunctions/catledger-import/src/local-review-protocol')
const { statementAnalysis } = require('../../cloudfunctions/catledger-import/src/statement-analysis')
const { syntheticBill } = require('./local-services')
async function facts({ count = 3, content, mapped = true, accounts: suppliedAccounts, paymentMappings = [] } = {}) {
  const updateId = randomUUID(), snapshotId = randomUUID(), documents = []
  for(let offset=0;offset<(content?1:count);offset+=4998){
    const document=await parseEvidenceFile({content:content||syntheticBill(Math.min(4998,count-offset),'SYNTHETIC-LOCAL-'+offset),extension:'csv',timezoneOffsetMinutes:-480})
    documents.push({document,batchId:randomUUID()})
  }
  const accounts = suppliedAccounts || [{ accountId: randomUUID(), name: '微信零钱', type: 'wallet', nature: 'asset', currency: 'CNY', version: 1 },
    { accountId: randomUUID(), name: '合成信用卡', type: 'credit', nature: 'liability', currency: 'CNY', version: 1 },
    { accountId: randomUUID(), name: '合成借款', type: 'other_liability', nature: 'liability', currency: 'CNY', version: 1 }]
  const categories = ['expense','income'].map(kind => ({ categoryId: randomUUID(), name: '合成分类', kind, version: 1 }))
  const rows = documents.flatMap(({document,batchId},sourceOrder)=>document.rows.map((row, index) => ({ ...row.normalized, rowId: randomUUID(), batchId, sourceOrder,
    rowNumber: index + 1, parseState: row.parseState, identityId: randomUUID(), identityState: 'new',
    sourceType: document.descriptor.sourceType, sourceFormat: document.descriptor.sourceFormat,
    paymentMethod: row.raw.paymentMethod, rawStatus: row.raw.status, rawTransactionType: row.raw.transactionType, semantic: row.semantic,
    sourceTransactionId: row.identifiers.transactionId, sourceOrderId: row.identifiers.orderId,
    sourceMerchantOrderId: row.identifiers.merchantOrderId })))
  const plan = buildOrganizePlan({ updateId, rows, accounts: mapped ? accounts : [], paymentMappings })
  const { publicIssue } = require('../../cloudfunctions/catledger-import/src/review-presentation')
  const eventById = new Map(plan.events.map(event => [event.eventId, event]))
  const rowById = new Map(rows.map(row => [row.rowId, row]))
  const primaryRows = new Map(plan.evidence.filter(link => link.evidenceRole === 'primary').map(link => [link.eventId, rowById.get(link.rowId)]))
  const issues = plan.issues.map(issue => {
    const members = plan.members.filter(row => row.issueId === issue.issueId && row.objectType === 'event' && row.memberRole !== 'candidate')
    const member = members.find(row => row.sortOrder === 0), event = member && eventById.get(member.objectId), row = event && primaryRows.get(event.eventId)
    // 与真实快照使用同一公开投影，账户成分的资金角色不能在夹具里丢失。
    const { accountContext } = publicIssue({ ...issue, subjectEventId: event?.eventId, subjectMemberRole: member?.memberRole,
      subjectFieldSources: event?.fieldSources, subjectLedgerAccountId: event?.ledgerAccountId,
      subjectCounterpartyLedgerAccountId: event?.counterpartyLedgerAccountId,
      subjectSourceType: row?.sourceType, subjectPaymentMethod: row?.paymentMethod })
    return { ...issue, accountContext, subjectEventIds: [...new Set(members.map(row => row.objectId))] }
  })
  const events = plan.events.map(({ relationEvidence, sameEventCandidateKey, ...event }) => event)
  const evidence = plan.evidence.map(link => ({ ...link, identityKind: 'source_transaction_id' }))
  const sources = documents.map(({document,batchId},index)=>({ sourceId: 'synthetic-source-'+index, batchId, fileName: '合成本地账单'+index+'.csv',
    sourceType: document.descriptor.sourceType, sourceFormat: document.descriptor.sourceFormat, parserVersion: document.descriptor.parserVersion,
    normalizationVersion: document.descriptor.normalizationVersion, identityVersion: document.identityVersion, contentState: 'review_ready',
    contentDeletedAt: null, summary: { total: document.rows.length }, analysis: statementAnalysis(document) }))
  const rawRows=documents.flatMap(({document})=>document.rows)
  return JSON.parse(JSON.stringify({ protocolVersion: 3, ruleVersion: PLAN_VERSION, snapshotId,
    update: { updateId, version: 2, status: 'review', reviewMode: 'local_v3', planVersion: PLAN_VERSION, counts: plan.counts },
    sources, events, issues, members: plan.members, rows, raw: rows.map((row, index) => ({ rowId: row.rowId, fields: rawRows[index].raw })),
    evidence, relations: plan.relations, links: [], accounts, accountDrafts: [], categories, loans: [], contracts: [], charges: [],
    actions: [], paymentMappings, history: [], historyGroups: [], refundCandidates: [],
    historyCoverage: { duplicates: events.map(event => Object.fromEntries(['eventId','amountMinor','utcAt','ledgerAccountId','counterpartyLedgerAccountId','flowDirection'].map(key => [key,event[key]]))), refunds: [] },
    summary: { sources } }))
}
function packed(value, kind = 'snapshot') {
  const wire=kind==='snapshot'?require('../../cloudfunctions/catledger-import/src/local-review-snapshot').encode(value):value
  const result = protocol.split(JSON.stringify(wire)), objectId = kind === 'snapshot' ? value.snapshotId : randomUUID()
  const header = { protocolVersion: 3, kind, objectId, updateId: value.update.updateId, baseVersion: value.update.version,
    ruleVersion: value.ruleVersion, ...(kind==='snapshot'?{counts:require('../../cloudfunctions/catledger-import/src/local-review-snapshot').counts(value)}:{}), digest: result.digest, bytes: result.bytes, chunkCount: result.chunkCount }
  return { header, parts: result.parts, async call(action, data) {
    if (action === 'financeUpdates.snapshotManifest') return { header, parts: result.parts.map(({ content, ...part }) => part), nextOffset: null }
    if (action === 'financeUpdates.snapshotChunk') return { ...result.parts[data.index], objectId, baseVersion: header.baseVersion }
    throw Error('Unexpected network action: ' + action)
  } }
}
function filesystem() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catledger-local-review-'))
  const fault = { fn: null }, invoke = (name, args, work) => { if (fault.fn) fault.fn(name, ...args); return work() }
  const adapter = {
    accessSync: fs.accessSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
    mkdirSync: (file, recursive) => fs.mkdirSync(file, { recursive }),
    writeFileSync: (...args) => invoke('write', args, () => fs.writeFileSync(...args)),
    renameSync: (...args) => invoke('rename', args, () => fs.renameSync(...args)),
    rmdirSync: (file, recursive) => invoke('remove', [file], () => fs.rmSync(file, { recursive }))
  }
  return { fs: adapter, root, fault, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}
module.exports = { facts, packed, filesystem }
