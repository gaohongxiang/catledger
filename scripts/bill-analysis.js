const path = require('node:path')
const { createRequire } = require('node:module')
const { digestParts, sha256 } = require('../cloudfunctions/catledger-import/src/digest')
const { buildAnalysisSnapshot } = require('../cloudfunctions/catledger-import/src/analysis-snapshot')

function legacyAction(action, row) {
  const fixed = { top_up: 'top_up', withdrawal: 'withdrawal', repayment: 'repayment', borrow: 'borrow',
    fee: 'fee', refund: 'refund_credit', yield_income: 'yield', savings_in: 'transfer_received', savings_out: 'transfer_sent' }
  if (fixed[action.kind]) return fixed[action.kind]
  if (action.kind === 'external_transfer') return row.direction === 'income' ? 'transfer_received' : row.direction === 'expense' ? 'transfer_sent' : null
  if (action.kind === 'payment') return row.direction === 'income' ? 'receipt' : row.direction === 'expense' ? 'purchase' : null
  return null
}

async function analyzeBills(sourceRoot, inputs, options = {}) {
  const requireSource = createRequire(path.join(sourceRoot, 'index.js'))
  const { parseEvidenceFile } = requireSource('./parsers')
  const { buildOrganizePlan } = requireSource('./organizer-planner')
  const { buildRowIdentity, buildSourceProfile, buildPaymentMethodKey } = requireSource('./identity')
  const { classifySourceAction, isNonFinancialSourceRecord } = requireSource('./source-action')
  const { ledgerAccountReferenceForRow, projectSourceFunds } = requireSource('./source-funds')
  const rows = [], profiles = [], diagnostics = [], files = []
  let complete = true
  for (const [sourceOrder, input] of inputs.entries()) {
    const fileHash = sha256(input.content)
    let document
    try { document = await parseEvidenceFile({ ...input, timezoneOffsetMinutes: options.timezoneOffsetMinutes ?? -480 }) }
    catch (error) {
      complete = false
      files.push({ key: fileHash, parsed: false })
      diagnostics.push({ input: sourceOrder + 1, code: error.publicCode || 'ANALYSIS_FAILED' })
      continue
    }
    files.push({ key: fileHash, parsed: true, issues: (document.issues || []).map((issue) => issue.code).sort(), controls: document.controls || [] })
    const profile = buildSourceProfile({ sourceType: document.descriptor.sourceType, candidate: document.metadata.sourceProfile })
    profiles.push({ input: sourceOrder + 1, sourceFormat: document.descriptor.sourceFormat,
      parserVersion: document.descriptor.parserVersion, policyVersion: document.profile && document.profile.policyVersion || null })
    for (const parsed of document.rows) {
      const identity = parsed.parseState === 'valid' ? buildRowIdentity({ sourceType: document.descriptor.sourceType, sourceProfileKey: profile.profileKey, fileSha256: fileHash, row: parsed }) : { identityKey: null }
      const row = { ...parsed.normalized, rowId: digestParts('physical-row', fileHash, parsed.sourceLocator),
        evidenceKey: digestParts('physical-row', fileHash, parsed.sourceLocator), batchId: fileHash,
        sourceType: document.descriptor.sourceType, sourceFormat: document.descriptor.sourceFormat,
        sourceOrder, rowNumber: parsed.rowNumber, parseState: parsed.parseState,
        rawStatus: parsed.raw.status, rawTransactionType: parsed.raw.transactionType, paymentMethod: parsed.raw.paymentMethod,
        sourceNote: parsed.raw.note, sourceTransactionId: parsed.identifiers.transactionId,
        sourceOrderId: parsed.identifiers.orderId, sourceMerchantOrderId: parsed.identifiers.merchantOrderId,
        identityId: identity.identityKey, identityState: 'new', semantic: parsed.semantic,
        paymentMethodKey: buildPaymentMethodKey(document.descriptor.sourceType, parsed.raw.paymentMethod) }
      row.analysisAction = isNonFinancialSourceRecord(row) ? null : classifySourceAction(row).sourceAction || legacyAction(classifySourceAction(row), row)
      row.analysisMoneyEffect = isNonFinancialSourceRecord(row) ? 'non_financial' :
        ['normal', 'refund'].includes(row.economicEffect) ? 'financial' : ['failed', 'closed'].includes(row.economicEffect) ? row.economicEffect : 'unknown'
      row.analysisEndpoint = ledgerAccountReferenceForRow(row)
      row.analysisProjection = projectSourceFunds(row) || {
        from: ['purchase', 'transfer_sent', 'fee'].includes(row.analysisAction) ? row.analysisEndpoint : null,
        to: ['receipt', 'transfer_received', 'refund_credit', 'yield'].includes(row.analysisAction) ? row.analysisEndpoint : null
      }
      row.analysisResolution = row.semantic ? row.semantic.resolutionStatus : (row.parseState !== 'valid' ? 'invalid' :
        row.analysisMoneyEffect !== 'unknown' && (row.analysisMoneyEffect !== 'financial' || row.analysisAction &&
          (row.analysisEndpoint || row.analysisProjection.from && row.analysisProjection.to)) ? 'resolved' : 'unknown')
      rows.push(row)
    }
    diagnostics.push(...(document.issues || []).map((issue) => ({ input: sourceOrder + 1, code: issue.code })))
  }
  const plan = buildOrganizePlan({ updateId: 'analysis-only', rows, ...options })
  const snapshot = buildAnalysisSnapshot({ rows, plan, files, versions: { profiles: [...profiles].map(({ input, ...profile }) => profile).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), planVersion: plan.planVersion }, decisions: options.decisions })
  const counts = {}
  for (const row of rows) {
    const key = [row.sourceFormat, row.semantic && row.semantic.resolutionStatus || 'legacy', row.analysisAction || 'none', row.analysisMoneyEffect].join(':')
    counts[key] = (counts[key] || 0) + 1
  }
  return { snapshot, profiles, diagnostics, counts, complete }
}
module.exports = { analyzeBills }
