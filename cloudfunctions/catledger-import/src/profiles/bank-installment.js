const { createHash } = require('node:crypto')
const clean = value => String(value == null ? '' : value).normalize('NFKC').trim()

// 银行账单的固定本金摘要；不把泛称“现分”、金额或相邻利息行当作归属证据。
function principalLabel(values) {
  for (const value of values) {
    const found = value.replace(/\s+/gu, '').match(/^(电销现分按月收|电销总账分月)(\d{1,3})期第(\d{1,3})期共(\d{1,3})期$/u)
    if (found && Number(found[2]) === Number(found[4])) return {
      periodNumber: Number(found[3]), totalTerms: Number(found[4]),
      originKind: found[1] === '电销现分按月收' ? 'cash_borrowing' : 'unconfirmed'
    }
  }
  return null
}

// 只识别明确分期字段/文案，不凭金额、日期或“还款”二字推断分期。
function installmentEvidence(row) {
  if (row.bankStatementKind !== 'credit') return null
  const explicit = row.installmentFields || {}
  const values = [row.rawTransactionType || row.transactionType, row.item, row.note].map(clean)
  const text = values.join(' ')
  if (/放款|到账|借入|支用|提现|实际扣款|还款扣款/.test(text)) return null
  const principal = principalLabel(values)
  if (!/分期/.test(text) && !explicit.period && !explicit.reference && !principal) return null
  const part = clean(explicit.component) || text
  const components = [(/(?:本金|principal)/i.test(part) || principal && !clean(explicit.component)) && 'principal', /(?:利息|interest)/i.test(part) && 'interest',
    /(?:手续费|服务费|fee)/i.test(part) && 'fee'].filter(Boolean)
  if (components.length !== 1 || principal && components[0] !== 'principal') return null
  const term = text.match(/(?:第\s*)?(\d{1,3})\s*(?:期\s*)?[/／]\s*(\d{1,3})\s*(?:期)?/) || text.match(/第\s*(\d{1,3})\s*期(?:\s*[,，/]?\s*(?:共|总)\s*(\d{1,3})\s*期)?/)
  const periodNumber = Number(clean(explicit.period) || term && term[1])
  const totalTerms = Number(clean(explicit.terms) || term && term[2]) || null
  if (!Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > 600 ||
      totalTerms != null && (!Number.isInteger(totalTerms) || totalTerms < periodNumber || totalTerms > 600) ||
      principal && (periodNumber !== principal.periodNumber || totalTerms !== principal.totalTerms)) return null
  const named = text.match(/(?:分期(?:计划)?(?:编号|号)|计划编号|合同(?:编号|号))\s*[:：#]?\s*([\p{L}\p{N}_-]{2,80})/u)
  const reference = clean(explicit.reference) || named && named[1] || ''
  return { schema: 2, creditStatement: true, factKind:'billing', originKind:principal ? principal.originKind : /现金分期|现金借款|取现分期/.test(text)?'cash_borrowing':'unconfirmed', periodNumber, totalTerms, component: components[0],
    referenceKey: reference ? createHash('sha256').update('bank-installment-v1:' + reference).digest('hex') : null,
    referenceLabel: reference.slice(0, 120) || null }
}

module.exports = { installmentEvidence }
