// 信用卡账单表头区的汇总数解析。只读账单事实，不复制交易明细。
// 支持两种账单布局：
//   1) 键值文本：`本期应还款总额=¥8137.39`；
//   2) 表头行 + 值行（兴业 6106 实际布局）：
//        账单日 | 到期还款日 | 账单周期 | 本期应还款总额 | 本期最低还款额
//        20260813 | 20260902 | 20260714-20260813 | ¥8137.39 | ¥7016.04
const clean = value => String(value == null ? '' : value).normalize('NFKC').replace(/\s+/gu, '')

function parseMoney(text) {
  const matched = String(text || '').match(/[¥￥]?\s*-?\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?/u)
  if (!matched) return null
  const whole = matched[1].replace(/,/gu, '')
  const fraction = (matched[2] || '').padEnd(2, '0')
  return whole + '.' + (fraction || '00')
}

function parseDate(text) {
  const value = String(text || '')
  const compact = value.match(/(\d{4})(\d{2})(\d{2})/u)
  if (compact) return compact[1] + '-' + compact[2] + '-' + compact[3]
  const dashed = value.match(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/u)
  if (dashed) return dashed[1] + '-' + dashed[2].padStart(2, '0') + '-' + dashed[3].padStart(2, '0')
  return null
}

function normalizeCycle(text) {
  const value = String(text || '')
  const matched = value.match(/(\d{8})\s*[-~至]\s*(\d{8})/u) ||
    value.match(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})\s*[至~-]\s*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/u)
  if (!matched) return null
  const start = parseDate(matched[1]), end = parseDate(matched[2] || (matched[4] ? matched[4] + matched[5] + matched[6] : ''))
  return start && end ? start.replace(/-/gu, '') + '-' + end.replace(/-/gu, '') : null
}

// 把二维 records（每个 record 是 values 数组）拆成扁平文本单元格序列，找到「表头行→值行」的列对齐。
// 表头行某单元格匹配 label，则值行同一列位置即该字段值。
function summaryFromRecords(recordRows) {
  const rows = (recordRows || []).map(values => (Array.isArray(values) ? values : []).map(clean))
  if (!rows.length) return null
  const labels = [
    { key: 'statementDueMinor', test: /^本期应还(?:款)?总额$/, kind: 'money' },
    { key: 'statementMinimumMinor', test: /^本期最低还款额$/, kind: 'money' },
    { key: 'statementDueDate', test: /^到期还款日$/, kind: 'date' },
    { key: 'statementCycle', test: /^账单周期$/, kind: 'cycle' }
  ]
  const result = {}
  for (let r = 0; r < rows.length; r += 1) {
    const header = rows[r]
    // 该行是否是账务信息表头行（至少命中两个已知标签）
    const hits = []
    header.forEach((cell, col) => {
      for (const label of labels) if (label.test.test(cell)) hits.push({ col, label })
    })
    if (hits.length < 2) continue
    // 在后续若干行里找值行：同列位置出现金额/日期/周期格式
    for (let v = r + 1; v < rows.length && v <= r + 3; v += 1) {
      const valueRow = rows[v]
      let got = 0
      for (const hit of hits) {
        const cell = valueRow[hit.col]
        if (!cell) continue
        if (hit.label.kind === 'money') { const m = parseMoney(cell); if (m != null) { result[hit.label.key] = m; got += 1 } }
        else if (hit.label.kind === 'date') { const d = parseDate(cell); if (d) { result[hit.label.key] = d; got += 1 } }
        else if (hit.label.kind === 'cycle') { const c = normalizeCycle(cell); if (c) { result[hit.label.key] = c; got += 1 } }
      }
      if (got >= 2) break
    }
    if (Object.keys(result).length >= 2) break
  }
  return Object.keys(result).length ? result : null
}

// metadata 既可以是二维 records 数组，也可以是表头前的拼接纯文本。
function summaryFromText(text) {
  const value = clean(text)
  if (!value) return null
  const dueMatch = value.match(/本期应还款?总额[=:：]?([¥￥]?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/u) ||
    value.match(/应还款?总额[=:：]?([¥￥]?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/u)
  const minimumMatch = value.match(/最低还款额[=:：]?([¥￥]?[0-9][0-9,]*(?:\.[0-9]{1,2})?)/u)
  const dueDateMatch = value.match(/到期还款日[=:：]?([0-9]{8}|[0-9]{4}[年/.-][0-9]{1,2}[月/.-][0-9]{1,2})/u)
  const cycleMatch = value.match(/账单周期[=:：]?([0-9]{8}[-~至][0-9]{8}|[0-9]{4}[年/.-][0-9]{1,2}[月/.-][0-9]{1,2}[至~-][0-9]{4}[年/.-][0-9]{1,2}[月/.-][0-9]{1,2})/u)
  const out = {}
  if (dueMatch) { const m = parseMoney(dueMatch[1]); if (m != null) out.statementDueMinor = m }
  if (minimumMatch) { const m = parseMoney(minimumMatch[1]); if (m != null) out.statementMinimumMinor = m }
  if (dueDateMatch) { const d = parseDate(dueDateMatch[1]); if (d) out.statementDueDate = d }
  if (cycleMatch) { const c = normalizeCycle(cycleMatch[1]); if (c) out.statementCycle = c }
  return Object.keys(out).length ? out : null
}

// 返回可保存到账单账户的汇总快照，缺项不带该键；完全解析不到返回 null。
function statementSummary(metadata) {
  if (Array.isArray(metadata)) {
    return summaryFromRecords(metadata) || summaryFromText(metadata.map(v => (Array.isArray(v) ? v.join(' ') : String(v))).join('\n'))
  }
  return summaryFromText(metadata)
}

module.exports = { statementSummary, parseMoney, parseDate, normalizeCycle }
