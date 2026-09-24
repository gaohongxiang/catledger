const { createHash } = require('node:crypto')
const clean = value => String(value == null ? '' : value).normalize('NFKC').trim()

// 只识别明确分期字段/文案，不凭金额、日期或“还款”二字推断分期。
function installmentEvidence(row) {
  if (row.bankStatementKind !== 'credit') return null
  const explicit = row.installmentFields || {}
  const text = [row.rawTransactionType || row.transactionType, row.item, row.note].map(clean).join(' ')
  if (!/分期/.test(text) && !explicit.period && !explicit.reference) return null
  const part = clean(explicit.component) || text
  const components = [/(?:本金|principal)/i.test(part) && 'principal', /(?:利息|interest)/i.test(part) && 'interest',
    /(?:手续费|服务费|fee)/i.test(part) && 'fee'].filter(Boolean)
  if (components.length !== 1) return null
  const term = text.match(/(?:第\s*)?(\d{1,3})\s*(?:期\s*)?[/／]\s*(\d{1,3})\s*(?:期)?/) || text.match(/第\s*(\d{1,3})\s*期(?:\s*[,，/ ]\s*(?:共|总)\s*(\d{1,3})\s*期)?/)
  const periodNumber = Number(clean(explicit.period) || term && term[1])
  const totalTerms = Number(clean(explicit.terms) || term && term[2]) || null
  if (!Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > 600 ||
      totalTerms != null && (!Number.isInteger(totalTerms) || totalTerms < periodNumber || totalTerms > 600)) return null
  const named = text.match(/(?:分期(?:计划)?(?:编号|号)|计划编号|合同(?:编号|号))\s*[:：#]?\s*([\p{L}\p{N}_-]{2,80})/u)
  const reference = clean(explicit.reference) || named && named[1] || ''
  return { schema: 1, creditStatement: true, periodNumber, totalTerms, component: components[0],
    referenceKey: reference ? createHash('sha256').update('bank-installment-v1:' + reference).digest('hex') : null,
    referenceLabel: reference.slice(0, 120) || null }
}

module.exports = { installmentEvidence }
