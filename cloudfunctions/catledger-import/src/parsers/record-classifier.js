const { normalizeText } = require('./text')
const { parseAmountMinor } = require('./normalize')

const CONTROL_START = /^(?:共\s*\d+\s*笔(?:记录)?|总笔数|交易笔数|总收入|总支出|收入|支出|期初余额|期末余额|合计)(?:\s|[:：\d]|$)/u
const METADATA_START = /^(?:微信昵称|支付宝账户|支付宝账号|导出时间|起始(?:日期|时间)|终止(?:日期|时间)|开始(?:日期|时间)|结束(?:日期|时间))\s*[:：]/u

function hasTransactionStructure(record, positions) {
  const values = record.values.map((value) => normalizeText(value, 1024))
  // 日期损坏时，其他交易列仍是数据记录证据；此判断同样适用于表头之前。
  const occupied = ['transactionType', 'amount', 'status', 'transactionId']
    .filter((field) => positions[field] != null && values[positions[field]])
  return occupied.length >= 2 || /^\d{4}[-/]\d{2}/u.test(values[positions.transactionTime] || '')
}

function classifyRecord(record, positions) {
  const values = record.values.map((value) => normalizeText(value, 1024))
  if (values.every((value) => !value)) return 'decorative'
  if (/^-{10,}$/u.test(values[0]) && values.slice(1).every((value) => !value)) return 'decorative'
  if (hasTransactionStructure(record, positions)) return 'data'
  if (CONTROL_START.test(values[0])) return 'control'
  if (METADATA_START.test(values[0])) return 'metadata'
  return 'data'
}

function inspectControls(controlFields, rows, descriptor = {}) {
  const issues = []
  const controls = []
  for (const record of controlFields) {
    const text = record.values.join(' ').normalize('NFKC')
    let inspected = false
    const count = /(?:共\s*|(?:总笔数|交易笔数)\s*[:：]?\s*)(\d+)\s*(?:笔|$)/u.exec(text)
    if (count) {
      inspected = true
      const matches = Number(count[1]) === rows.length
      controls.push({ kind: 'row_count', sourceLocator: record.sourceLocator, passed: matches })
      if (!matches) issues.push({ code: 'statement_count_mismatch', field: 'statement', severity: 'warning' })
    }
    for (const [label, direction] of [['收入', 'income'], ['支出', 'expense']]) {
      const match = new RegExp(`${label}\\s*[:：]?\\s*(?:(\\d+)\\s*笔\\s*)?(\\d+(?:,\\d{3})*(?:\\.\\d{1,2})?)\\s*元`, 'u').exec(text)
      if (!match) continue
      inspected = true
      const amount = parseAmountMinor(match[2])
      const candidates = rows.filter((row) => row.normalized.direction === direction)
      if (match[1] != null) {
        const passed = candidates.length === Number(match[1])
        controls.push({ kind: `${direction}_count`, sourceLocator: record.sourceLocator, passed })
        if (!passed) issues.push({ code: 'statement_count_mismatch', field: 'statement', severity: 'warning' })
      }
      // 平台汇总沿用原始收支方向；不能把小荷包等语义推导重新计入平台支出。
      const amounts = candidates.filter((row) => !(descriptor.controlExcludedStatuses || []).includes(normalizeText(row.raw && row.raw.status, 128)))
      const known = amounts.every((row) => row.parseState === 'valid' && row.normalized.amountMinor != null)
      const total = amounts.reduce((sum, row) => sum + BigInt(row.normalized.amountMinor || '0'), 0n)
      const matches = known && amount != null && total === BigInt(amount)
      controls.push({ kind: `${direction}_total`, sourceLocator: record.sourceLocator, passed: matches })
      if (!matches) issues.push({ code: 'statement_amount_mismatch', field: 'statement', severity: 'warning' })
    }
    if (!inspected) {
      controls.push({ kind: 'unsupported', sourceLocator: record.sourceLocator, passed: false })
      issues.push({ code: 'statement_control_unknown', field: 'statement', severity: 'warning' })
    }
  }
  return { controls, issues }
}

module.exports = { classifyRecord, hasTransactionStructure, inspectControls }
