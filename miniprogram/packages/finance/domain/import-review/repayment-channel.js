const { digestParts } = require('./portable-digest')
const { getRowSemantic } = require('./row-semantic-resolver')
const { semanticBlockers } = require('./semantic-policy')
const { importError } = require('./errors')

const VERSION = 'repayment-channel-v1'
const ALLOWED_REASONS = new Set(['category_required', 'ledger_account_required', 'repayment_account_required',
  'repayment_ownership_required', 'source_account_endpoint_unknown', 'strong_same_event', 'account_mapping_confirmed',
  'same_event_candidate', 'relation_ambiguous', 'bank_channel_same_event_candidate'])
const ASSETS = new Set(['cash', 'bank', 'wallet', 'other_asset'])
const rowsFor = event => event.relationEvidence && event.relationEvidence.rows || []
const clean = value => String(value || '').normalize('NFKC').trim()
const positive = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
const nonnegative = value => value === '0' || positive(value)

function channel(row) {
  const channels = new Set()
  for (const value of [row.rawTransactionType, row.item]) {
    const label = clean(value)
    if (label === '支付宝还款') channels.add('alipay')
    if (['财付通还款', '微信还款', '微信支付还款'].includes(label)) channels.add('wechat')
  }
  return channels.size === 1 ? [...channels][0] : null
}
function date(row) {
  // 此路径比较账单本地日期，不把仅有日期的银行凭据补成“同一分钟”。
  const raw = clean(row.rawTransactionTime)
  const local = clean(row.localDate || row.localAt).slice(0, 10)
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(local) ? local : ''
}
function locator(value) {
  const text = clean(value)
  const match = text.match(/(?:尾号|末四位|后四位|[*xX]{2,})\s*\(?([0-9]{4})\)?/u) ||
    text.match(/(?:银行|信用卡|贷记卡|储蓄卡|借记卡)\s*\(([0-9]{4})\)/u)
  const fullAccount = text.match(/(?:^|\D)([0-9]{12,19})(?:\D|$)/u)
  return match ? match[1] : fullAccount ? fullAccount[1].slice(-4) : ''
}
function targetCompatible(bank, platform) {
  const target = platform.fieldSources.fundsProjection && platform.fieldSources.fundsProjection.to
  if (!target || target.referenceKind !== 'atomic') return false
  const targetText = clean(target.value || target.label)
  const reference = bank.fieldSources.ledgerAccountReference || {}
  const bankHints = [reference.value, reference.label, bank.ledgerAccountFacts && bank.ledgerAccountFacts.name,
    ...rowsFor(bank).map(row => row.paymentMethod)].map(clean)
  const bankText = bankHints.join(' '), targetLocator = locator(targetText)
  const bankLocators = [...new Set(bankHints.map(locator).filter(Boolean))]
  if (targetLocator && bankLocators.some(value => value !== targetLocator)) return false
  if (platform.counterpartyLedgerAccountId) return platform.counterpartyLedgerAccountId === bank.ledgerAccountId
  const targetBank = targetText.match(/([\p{Script=Han}]{2,12})银行/u)
  // 银行名/尾号只是提供人工候选的线索；只有逐对明确确认才绑定还入账户。
  if (targetBank) return bankText.includes(targetBank[1])
  return Boolean(targetLocator && bankLocators.includes(targetLocator))
}
function sourceEligible(event) {
  if (!['ready', 'needs_action'].includes(event.status) || event.economicNature !== 'repayment' ||
      event.flowDirection !== 'neutral' || event.currency !== 'CNY' || !positive(event.amountMinor)) return false
  const fields = event.fieldSources || {}
  if (fields.installment || fields.loanRepayment || fields.paymentResolution || fields.repaymentChannelResolution ||
      fields.repaymentAllocations || fields.repaymentAllocationVersion || fields.refundSourceConflict || fields.evidenceGroupConflictKey ||
      fields.editorOverrides && fields.editorOverrides.composition && fields.editorOverrides.composition !== 'single' ||
      fields.repaymentOwnership && fields.repaymentOwnership.owner === 'other') return false
  if ((event.reasonCodes || []).some(reason => !ALLOWED_REASONS.has(reason))) return false
  const rows = rowsFor(event)
  if (!rows.length || new Set(rows.map(row => row.sourceType)).size !== 1) return false
  return rows.every(row => {
    const semantic = getRowSemantic(row)
    return semantic.sourceAction === 'repayment' && semantic.moneyEffect === 'financial' && !semanticBlockers(semantic).length &&
      !semantic.relationHints?.installment && row.identityState !== 'identity_conflict' && !row.existingTransactionId &&
      String(row.amountMinor) === event.amountMinor && row.currency === event.currency && date(row) &&
      date(row) === clean(event.localDate || event.localAt).slice(0, 10) &&
      clean(row.localAt).slice(0, 19) === clean(event.localAt).slice(0, 19)
  })
}
function pairFacts(bank, platform) {
  if (!sourceEligible(bank) || !sourceEligible(platform)) return null
  const bankRows = rowsFor(bank), platformRows = rowsFor(platform)
  if (!platform.fieldSources.fundsProjection?.from || !bank.fieldSources.ledgerAccountReference?.paymentMethodKey) return null
  if (bankRows[0].sourceType !== 'bank' || !['alipay', 'wechat'].includes(platformRows[0].sourceType)) return null
  const account = bank.ledgerAccountFacts
  if (!bank.ledgerAccountId || !account || account.type !== 'credit' || account.currency !== 'CNY' || account.archivedAt != null) return null
  if (!bankRows.every(row => row.direction === 'income' && channel(row) === platformRows[0].sourceType) ||
      !platformRows.every(row => ['expense', 'neutral'].includes(row.direction)) || date(bankRows[0]) !== date(platformRows[0])) return null
  if (platform.ledgerAccountId && (!ASSETS.has(platform.ledgerAccountFacts?.type) || platform.ledgerAccountFacts.currency !== 'CNY' ||
      platform.ledgerAccountFacts.archivedAt != null)) return null
  if (bank.counterpartyLedgerAccountId && bank.counterpartyLedgerAccountId !== platform.ledgerAccountId ||
      bank.ledgerAccountId === platform.ledgerAccountId || !targetCompatible(bank, platform)) return null
  if (platform.fieldSources.fundsProjection?.to?.referenceKind === 'aggregate') return null
  const fee = BigInt(platform.amountMinor) - BigInt(bank.amountMinor)
  if (fee < 0n) return null
  return { version: 1, totalMinor: platform.amountMinor, repaymentMinor: bank.amountMinor, feeMinor: String(fee),
    targetAccountId: bank.ledgerAccountId, targetAccountName: account.name,
    targetConfirmed: platform.counterpartyLedgerAccountId === bank.ledgerAccountId }
}
function pairKey(bank, platform) {
  return digestParts(VERSION, ...rowsFor(bank).concat(rowsFor(platform)).map(row => row.rowId).sort())
}
function edges(events, maxEdges = 10000) {
  const buckets = new Map()
  for (const event of events.filter(event => !event.sameEventCandidateKey && sourceEligible(event))) {
    const day = date(rowsFor(event)[0])
    if (!buckets.has(day)) buckets.set(day, [])
    buckets.get(day).push(event)
  }
  const pairs = []
  for (const bucket of buckets.values()) for (const bank of bucket.filter(event => rowsFor(event)[0].sourceType === 'bank')) {
    for (const platform of bucket.filter(event => event !== bank && rowsFor(event)[0].sourceType !== 'bank')) {
      const repayment = pairFacts(bank, platform), key = pairKey(bank, platform)
      if (!repayment || [bank, platform].some(event => (event.fieldSources.bankChannelDistinctPairs || []).includes(key))) continue
      if (pairs.length >= maxEdges) throw importError('PAIRING_LIMIT_EXCEEDED')
      pairs.push({ bank, platform, pairKey: key, pairKind: 'repayment', repayment })
    }
  }
  return pairs
}
function evidenceDigest(rows) {
  return digestParts(VERSION, ...rows.map(row => JSON.stringify([row.rowId, row.identityId || '', row.sourceType,
    String(row.amountMinor), row.currency, row.direction, row.localDate, row.localAt, row.utcAt, row.rawTransactionTime,
    row.rawTransactionType, row.rawStatus, row.paymentMethodKey, row.paymentMethod, row.counterparty, row.item])).sort())
}
function resolutionFor(event) { return event.fieldSources && event.fieldSources.repaymentChannelResolution || null }
// 同笔来源关系独立于手续费确认；待补全分项时仍须保护冻结金额、账户及证据。
function relationValid(event) {
  const value = resolutionFor(event), fields = event.fieldSources || {}
  return Boolean(value && value.version === VERSION && value.confirmedBy === 'user' && typeof value.repaymentConfirmed === 'boolean' &&
    positive(value.totalMinor) && positive(value.repaymentMinor) && nonnegative(value.feeMinor) &&
    BigInt(value.totalMinor) === BigInt(value.repaymentMinor) + BigInt(value.feeMinor) &&
    event.economicNature === 'repayment' && event.flowDirection === 'neutral' && event.currency === 'CNY' && event.sourceDirection !== 'income' &&
    event.amountMinor === value.totalMinor && event.counterpartyLedgerAccountId === value.targetAccountId &&
    event.localAt === value.localAt && event.utcAt === value.utcAt &&
    fields.repaymentOwnership?.owner === 'self' && !fields.loanRepayment && !fields.installment &&
    !fields.paymentResolution && !fields.repaymentAllocations && !fields.repaymentAllocationVersion &&
    !fields.editorOverrides?.incompleteComposition && !fields.editorOverrides?.incompleteRepayment &&
    (!fields.editorOverrides?.composition || fields.editorOverrides.composition === 'single'))
}
function valid(event) {
  return relationValid(event) && resolutionFor(event).repaymentConfirmed === true
}
function evidenceValid(event, rows) {
  if (!relationValid(event)) return false
  const value = resolutionFor(event), expected = new Set([...value.bankRowIds || [], ...value.platformRowIds || []])
  if (!expected.size || rows.length !== expected.size || rows.some(row => !expected.has(row.rowId)) || evidenceDigest(rows) !== value.basisDigest) return false
  return rows.every(row => {
    const semantic = getRowSemantic(row), bank = value.bankRowIds.includes(row.rowId)
    return semantic.sourceAction === 'repayment' && semantic.moneyEffect === 'financial' && !semanticBlockers(semantic).length &&
      row.identityState !== 'identity_conflict' && row.currency === 'CNY' &&
      String(row.amountMinor) === (bank ? value.repaymentMinor : value.totalMinor) &&
      (bank ? row.sourceType === 'bank' && row.direction === 'income' && channel(row) === value.platformType
        : row.sourceType === value.platformType && ['expense', 'neutral'].includes(row.direction))
  })
}
function postingEvidenceValid(event, rows) {
  return valid(event) && evidenceValid(event, rows)
}
function semanticRows(event, rows) {
  return evidenceValid(event, rows) ? rows.filter(row => resolutionFor(event).platformRowIds.includes(row.rowId)) : rows
}
function publicResolution(event) {
  const value = resolutionFor(event)
  return value ? { version: 1, confirmed: value.repaymentConfirmed === true, totalMinor: value.totalMinor, repaymentMinor: value.repaymentMinor,
    feeMinor: value.feeMinor, targetAccountId: value.targetAccountId } : null
}
function drafts(event) {
  if (!valid(event) || !event.ledgerAccountId || event.ledgerAccountId === event.counterpartyLedgerAccountId) throw importError('UNRESOLVED_IMPORT')
  const value = resolutionFor(event)
  const result = [{ type: 'transfer', sourceAccountId: event.ledgerAccountId, destinationAccountId: value.targetAccountId,
    amountMinor: value.repaymentMinor, categoryId: null, originalTransactionId: null, role: 'payment_allocation' }]
  if (value.feeMinor !== '0') result.push({ type: 'expense', sourceAccountId: event.ledgerAccountId, destinationAccountId: null,
    amountMinor: value.feeMinor, categoryId: value.feeCategoryId || null, originalTransactionId: null, role: 'payment_allocation' })
  return result
}

module.exports = { VERSION, pairFacts, pairKey, edges, evidenceDigest, resolutionFor, relationValid, valid,
  evidenceValid, postingEvidenceValid, semanticRows, publicResolution, drafts }
