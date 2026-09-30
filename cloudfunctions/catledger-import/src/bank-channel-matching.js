const { digestParts } = require('./digest')
const { getRowSemantic } = require('./row-semantic-resolver')
const { semanticBlockers } = require('./semantic-policy')

const VERSION = 'bank-channel-match-v1'
const REASON = 'bank_channel_same_event_candidate'
const ACTIVE = new Set(['ready', 'needs_action'])
const ALLOWED_REASONS = new Set(['category_required', 'economic_nature_required', 'row_transaction_type_unknown',
  'refund_relation_required', 'refund_relation_ambiguous', 'same_event_candidate', 'relation_ambiguous', REASON,
  'strong_same_event', 'account_mapping_confirmed', 'auto_refund_exact_reference', 'auto_refund_explicit_evidence'])

function sourceRows(event) { return event.relationEvidence && event.relationEvidence.rows || [] }
function semantic(row) { return getRowSemantic(row) }
function bankChannelEvidenceForRow(row) {
  return { rowId: row.rowId, rawTransactionTime: row.rawTransactionTime, rawTransactionType: row.rawTransactionType,
    rawStatus: row.rawStatus, sourceFormat: row.sourceFormat, semantic: row.semantic }
}
function channel(row) {
  // 只识别摘要开头明确的支付渠道；商户名称或备注中偶然出现的品牌不算。
  const channels = new Set()
  for (const value of [row.item, row.counterparty]) {
    const match = String(value || '').normalize('NFKC').trim().match(/^(财付通(?:快捷)?|微信支付|支付宝(?:快捷)?)\s*[-－—:：]/u)
    if (match) channels.add(match[1].startsWith('支付宝') ? 'alipay' : 'wechat')
  }
  return channels.size === 1 ? [...channels][0] : null
}
function timestamp(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value || '').replace(' ', 'T').replace(/(?<!Z)$/u, 'Z'))
  return Number.isFinite(time) ? time : null
}
function minute(row) {
  const raw = String(row.rawTransactionTime || '').normalize('NFKC').trim().replace(/^'/u, '')
  const excelTime = /(?:xls|xlsx)$/u.test(row.sourceFormat || '') && /^\d{4,5}\.\d+$/u.test(raw) && Number(raw) % 1 !== 0
  if (!/(?:[ T]|日)\d{1,2}:\d{2}/u.test(raw) && !/^\d{14}$/u.test(raw.trim()) && !excelTime) return null
  const time = timestamp(row.utcAt)
  return time == null ? null : Math.floor(time / 60000)
}
function eligible(event) {
  if (!ACTIVE.has(event.status) || !event.ledgerAccountId || event.counterpartyLedgerAccountId) return false
  const fields = event.fieldSources || {}
  if (fields.fundsProjection || fields.installment || fields.paymentResolution || fields.loanRepayment || fields.refundSourceConflict || fields.evidenceGroupConflictKey) return false
  if ((event.reasonCodes || []).some(reason => !ALLOWED_REASONS.has(reason))) return false
  const rows = sourceRows(event)
  if (!rows.length || new Set(rows.map(row => row.sourceType)).size !== 1) return false
  return rows.every(row => {
    const value = semantic(row)
    const blockers = semanticBlockers(value)
    const action = value.sourceAction
    const bank = row.sourceType === 'bank'
    if (bank && !action && String(row.rawTransactionType || '').trim()) return false
    if (value.moneyEffect !== 'financial' || value.fundsProjection || value.relationHints && value.relationHints.installment) return false
    if (blockers.some(code => !bank || code !== 'row_transaction_type_unknown')) return false
    if (bank ? ![null, undefined, 'purchase', 'refund_credit'].includes(action) : !['purchase', 'refund_credit'].includes(action)) return false
    if (bank ? !['unknown', 'expense', 'refund'].includes(event.economicNature) : !['expense', 'refund'].includes(event.economicNature)) return false
    if (action === 'purchase' && (event.flowDirection !== 'outflow' || event.economicNature === 'refund')) return false
    if (action === 'refund_credit' && (event.flowDirection !== 'inflow' || event.economicNature === 'expense')) return false
    const direction = row.direction === 'expense' ? 'outflow' : row.direction === 'income' ? 'inflow' : null
    return direction && direction === event.flowDirection && minute(row) != null &&
      String(row.amountMinor) === String(event.amountMinor) && row.currency === event.currency &&
      timestamp(row.utcAt) === timestamp(event.utcAt)
  })
}
function pairKey(left, right) {
  return digestParts(VERSION, ...sourceRows(left).concat(sourceRows(right)).map(row => row.rowId).sort())
}
function bankChannelPair(left, right) {
  if (!eligible(left) || !eligible(right)) return false
  const a = sourceRows(left)[0], b = sourceRows(right)[0]
  const bank = a.sourceType === 'bank' ? left : b.sourceType === 'bank' ? right : null
  if (!bank) return false
  const platform = bank === left ? right : left
  const platformType = sourceRows(platform)[0].sourceType
  if (!['wechat', 'alipay'].includes(platformType) || bank.ledgerAccountId !== platform.ledgerAccountId ||
      bank.amountMinor !== platform.amountMinor || bank.currency !== platform.currency || bank.flowDirection !== platform.flowDirection) return false
  if (!sourceRows(bank).every(row => channel(row) === platformType)) return false
  if (minute(a) !== minute(b)) return false
  const key = pairKey(left, right)
  if ([left, right].some(event => (event.fieldSources.bankChannelDistinctPairs || []).includes(key))) return false
  return true
}

function bankChannelGroups(events) {
  const candidates = events.filter(event => !event.sameEventCandidateKey && eligible(event))
  const buckets = new Map()
  for (const event of candidates) {
    const key = [event.ledgerAccountId, event.amountMinor, event.currency, event.flowDirection, minute(sourceRows(event)[0])].join('|')
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(event)
  }
  const groups = []
  for (const bucket of buckets.values()) {
    const edges = new Map(bucket.map(event => [event, new Set()]))
    for (const bank of bucket.filter(event => sourceRows(event)[0].sourceType === 'bank')) {
      for (const other of bucket) if (bank !== other && bankChannelPair(bank, other)) {
        edges.get(bank).add(other); edges.get(other).add(bank)
      }
    }
    const seen = new Set()
    for (const event of bucket) {
      if (seen.has(event) || !edges.get(event).size) continue
      const group = [], pending = [event]
      while (pending.length) {
        const current = pending.pop()
        if (seen.has(current)) continue
        seen.add(current); group.push(current); pending.push(...edges.get(current))
      }
      group.sort((a, b) => a.eventKey.localeCompare(b.eventKey))
      const candidateKey = digestParts(VERSION, ...group.map(item => item.eventKey))
      for (const item of group) {
        item.sameEventCandidateKey = candidateKey
        item.fieldSources = { ...item.fieldSources, bankChannelCandidate: { version: VERSION, candidateKey } }
        item.reasonCodes = [...new Set([...item.reasonCodes, REASON, 'same_event_candidate', 'relation_ambiguous'])]
        item.status = 'needs_action'
      }
      groups.push({ candidateKey, events: group })
    }
  }
  return groups
}

// 人工合并只解释“银行缺少交易类型”这一种缺口。升级时仍重验来源、金额、方向和时间。
function semanticRowsAfterConfirmation(event, rows) {
  const resolution = event.fieldSources && event.fieldSources.bankChannelResolution
  if (!resolution || resolution.version !== VERSION || resolution.ledgerAccountId !== event.ledgerAccountId) return rows
  const primary = rows.find(row => row.rowId === resolution.primaryRowId)
  if (!primary || !['wechat', 'alipay'].includes(primary.sourceType)) return rows
  const base = { ...event, status: 'ready', reasonCodes: [], fieldSources: {}, relationEvidence: { rows: [primary] } }
  const explained = new Set(resolution.explainedBankRowIds || [])
  return rows.filter(row => {
    if (!explained.has(row.rowId)) return true
    const bank = { ...base, economicNature: 'unknown', utcAt: row.utcAt, relationEvidence: { rows: [row] } }
    return !bankChannelPair(bank, base)
  })
}

function explainedRowIds(events, rows) {
  const byId = new Map(rows.map(row => [row.rowId, row]))
  const explained = new Set()
  for (const event of events) {
    const resolution = event.fieldSources && event.fieldSources.bankChannelResolution
    if (!resolution) continue
    const evidence = [resolution.primaryRowId, ...(resolution.explainedBankRowIds || [])].map(id => byId.get(id)).filter(Boolean)
    const retained = new Set(semanticRowsAfterConfirmation(event, evidence).map(row => row.rowId))
    for (const row of evidence) if (!retained.has(row.rowId)) explained.add(row.rowId)
  }
  return explained
}

module.exports = { VERSION, REASON, bankChannelEvidenceForRow, bankChannelPair, bankChannelGroups, pairKey, semanticRowsAfterConfirmation, explainedRowIds }
