const { sha256 } = require('../portable-digest')
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
  const named = text.match(/(?:分期(?:计划)?(?:编号|号)|计划编号|合同(?:编号|号))\s*[:：#]?\s*([A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fa5\uff10-\uff19\uff21-\uff3a\uff41-\uff5a_-]{2,80})/)
  const reference = clean(explicit.reference) || named && named[1] || ''
  return { schema: 2, creditStatement: true, factKind:'billing', originKind:principal ? principal.originKind : /现金分期|现金借款|取现分期/.test(text)?'cash_borrowing':'unconfirmed', periodNumber, totalTerms, component: components[0],
    referenceKey: reference ? sha256('bank-installment-v1:' + reference) : null,
    referenceLabel: reference.slice(0, 120) || null }
}

// 现金分期放款对里这一行属于哪一半。信用卡账单把一笔现金分期写成两行：一行把放款本金
// 计入本期应还，紧接着一行「转分期付款」再把本金转进分期未还。两行的摘要都带分期字样，
// 金额和时间也一样，所以这里只读行文判断角色，配对由整理器按同卡、同日、同金额验证。
// 各行叫法不同：放款侧有现金分期、取现分期、预借现金、电销分期，也有银行自己的产品名；
// 对行有转分期付款、转分期、转入分期、分期转出。识别按动作而不是产品名——对行是锚点，
// 放款侧只要求写明分期并带期数。把已出账欠款或单笔消费转期的（账单分期、消费分期）
// 没有资金到账，不在此列；带期次、利息、费用的摘要是分期账单行，也不是放款那一行。
const OFFSET_LABEL = /转分期付款|转分期|转入分期|分期转入|分期转出|分期结转/u
const NON_CASH_LABEL = /账单分期|消费分期|购物分期|交易分期/u
// 有些产品只在摘要里写产品名、不写“分期”，这些名字本身就是现金类信用产品。
const CASH_PRODUCT_LABEL = /随借金|万用金|财智金|备用金|好享贷|e招贷|灵用金|随兴分|现金贷|随心贷/iu
const DISBURSEMENT_LABEL = /分期|预借现金|取现|现金借款/u
const BILLING_LABEL = /第\s*\d{1,3}\s*期|利息|手续费|服务费|年费/u

function disbursementRole(row) {
  if (!row || row.bankStatementKind !== 'credit') return null
  const values = [row.rawTransactionType || row.transactionType, row.item, row.note || row.sourceNote].map(clean)
  const text = values.join('').replace(/\s+/gu, '')
  if (!text) return null
  // 转分期付款只在本期应还这一侧成立：它是把欠款转进分期账单的收入行，不是放款本身。
  const terms = Number((text.match(/(\d{1,3})\s*期/u) || [])[1])
  const totalTerms = Number.isInteger(terms) && terms >= 1 && terms <= 600 ? terms : null
  const reference = clean((row.installmentFields || {}).reference) ||
    (text.match(/(?:分期(?:计划)?(?:编号|号)|计划编号|合同(?:编号|号))[:：#]?([A-Za-z0-9_-]{2,80})/u) || [])[1] || ''
  const referenceKey = reference ? sha256('bank-installment-v1:' + reference) : null
  if (OFFSET_LABEL.test(text)) return row.direction === 'income' && !BILLING_LABEL.test(text)
    ? { role: 'offset', totalTerms, referenceKey } : null
  if (row.direction !== 'expense' || NON_CASH_LABEL.test(text) || BILLING_LABEL.test(text)) return null
  if (!DISBURSEMENT_LABEL.test(text) && !CASH_PRODUCT_LABEL.test(text)) return null
  if (!Number.isInteger(terms) || terms < 2 || terms > 600) return null
  return { role: 'disbursement', totalTerms: terms, referenceKey }
}

module.exports = { disbursementRole, installmentEvidence }
