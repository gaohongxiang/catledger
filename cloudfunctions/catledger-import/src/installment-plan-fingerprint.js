// 分期计划指纹：把「这一行说的是哪一笔分期」压成可比较的五项事实。
//
// 同一张卡上可能有两笔同名、同总期数的计划（都叫“电销现金分期”、都是 12 期），所以
// 只用“卡 + 计划名 + 总期数”认不出是哪一笔，要再加上本金和起始月。放款行有总本金；
// 第 n 期账单行没有本金，只能比其余四项——判不出来是来源事实的边界，不按金额相似度补猜。
//
// 期次行按账单月反推首期月；放款日或登记日不代表首期还款日。
// 本模块是纯计算，只给结论；查库和写入由调用方负责。

const { sha256 } = require('./portable-digest')
const { planNameFromItem, effectiveInstallment, confirmedPlan } = require('./installment-plan')

const FINGERPRINT_VERSION = 'installment-plan-fingerprint-v1'
const DECISION_VERSION = 'installment-plan-decision-v1'
const ACTIONS = new Set(['link', 'create', 'skip'])
// 计划名里的总期数后缀要一起去掉，才能和放款行的计划名对齐：
// 「电销总账分月12期第12期共12期」→「电销总账分月」。
const TERMS_SUFFIX = /[\s·:：\-—_]*\d{1,3}\s*期\s*$/u

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim()
}

function planLabelFromItem(item) {
  return planNameFromItem(item).replace(TERMS_SUFFIX, '').trim()
}

function monthOf(value) {
  const match = /^(\d{4})-(\d{2})/.exec(text(value))
  const month = match ? Number(match[2]) : 0
  return match && month >= 1 && month <= 12 ? match[1] + '-' + match[2] : ''
}

// 账单月 − (期次 − 1)，只用年月做整数运算，不经过本地时区。
function startMonthFromPeriod(localDate, periodNumber) {
  const month = monthOf(localDate)
  const period = Number(periodNumber)
  if (!month || !Number.isInteger(period) || period < 1) return ''
  const [year, value] = month.split('-').map(Number)
  const index = year * 12 + (value - 1) - (period - 1)
  return String(Math.floor(index / 12)).padStart(4, '0') + '-' + String(index % 12 + 1).padStart(2, '0')
}

// 无合同编号时写绑定的合成键；与 reference_key 同列，64 位小写十六进制。
function bindingKey(planLabel, startMonth, principalMinor) {
  return sha256('plan:' + text(planLabel) + ':' + text(startMonth) + ':' + String(principalMinor))
}

function fingerprint({ accountId, planLabel, totalTerms, principalMinor, startMonth }) {
  const terms = Number(totalTerms)
  return Object.freeze({
    version: FINGERPRINT_VERSION,
    accountId: text(accountId),
    planLabel: text(planLabel).slice(0, 120),
    totalTerms: Number.isInteger(terms) && terms > 0 && terms <= 600 ? terms : null,
    principalMinor: principalMinor == null || principalMinor === '' ? null : String(principalMinor),
    startMonth: monthOf(startMonth)
  })
}

// 放款/登记行不猜首期月，只有已确认的计划决定才能提供它。
function fromDisbursement(event) {
  const fields = event && event.fieldSources || {}
  const hint = fields.disbursement
  if (!hint || !['disbursement', 'registration'].includes(hint.role)) return null
  const planLabel = text(hint.planLabel) || planLabelFromItem(event && event.item)
  const value = fingerprint({ accountId: event.ledgerAccountId, planLabel, totalTerms: hint.totalTerms,
    principalMinor: event.amountMinor, startMonth: monthOf(fields.installmentPlan && fields.installmentPlan.startMonth) })
  return value.planLabel && value.totalTerms && value.accountId ? value : null
}

// 第 n 期账单行：本金未知，计划名只能来自本金摘要或人工确认的归属。
function fromInstallment(event) {
  const fields = event && event.fieldSources || {}
  const installment = effectiveInstallment(event)
  if (!installment || !Number.isInteger(installment.periodNumber)) return null
  const attribution = fields.installmentAttribution || {}
  const planLabel = confirmedPlan(event) || text(attribution.planLabel) || planLabelFromItem(event && event.item)
  const value = fingerprint({ accountId: event.ledgerAccountId, planLabel, totalTerms: installment.totalTerms,
    principalMinor: null, startMonth: startMonthFromPeriod(event.localDate, installment.periodNumber) })
  return value.planLabel && value.totalTerms && value.accountId && value.startMonth ? value : null
}

function fingerprintOf(event) {
  return fromDisbursement(event) || fromInstallment(event)
}

// 计划行是否就是这一枚指纹：账户、名称、总期数必比；起始月和本金只在指纹有值时比。
function matches(fingerprintValue, loan) {
  if (!fingerprintValue || !loan) return false
  if (text(loan.accountId) !== fingerprintValue.accountId) return false
  if (text(loan.name) !== fingerprintValue.planLabel) return false
  if (Number(loan.scheduleTerms) !== fingerprintValue.totalTerms) return false
  const startMonth = monthOf(loan.startDate) || monthOf(loan.baselineDate)
  if (!startMonth || startMonth !== fingerprintValue.startMonth) return false
  if (fingerprintValue.principalMinor != null) {
    const setup = parseSetup(loan.installmentSetup)
    const principal = setup && setup.originalPrincipalMinor != null ? setup.originalPrincipalMinor
      : loan.baselinePrincipalMinor
    if (principal == null || String(principal) !== fingerprintValue.principalMinor) return false
  }
  return true
}

function parseSetup(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch (_) { return null }
}

// 核对阶段保存的计划决定。link / create 必须带计划 ID；skip 表示先不挂，照常入账。
// 校验只做结构，计划是否属于这个账户、是否还可用由保存时查库确认。
function inspectDecision(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!ACTIONS.has(raw.action)) return null
  const planLabel = text(raw.planLabel).slice(0, 120)
  const totalTerms = Number(raw.totalTerms)
  const principalMinor = raw.principalMinor == null || raw.principalMinor === '' ? null : String(raw.principalMinor)
  const startMonth = monthOf(raw.startMonth)
  const accountId = text(raw.accountId)
  const loanId = text(raw.loanId) || null
  if (raw.action !== 'skip') {
    if (!loanId || !planLabel || !Number.isInteger(totalTerms) || totalTerms < 1 || totalTerms > 600 || !startMonth || !accountId) return null
  }
  if (principalMinor != null && !/^(?:0|[1-9]\d{0,18})$/.test(principalMinor)) return null
  return { version: DECISION_VERSION, action: raw.action, loanId, planLabel, totalTerms: Number.isInteger(totalTerms) ? totalTerms : null,
    principalMinor, startMonth, accountId }
}

function decisionFor(event) {
  const fields = event && event.fieldSources || {}
  const value = fields.installmentPlan
  return value && value.version === DECISION_VERSION ? value : value || null
}

// 同一张卡上的同计划候选分组键；本批内也用它判断是否已经出现第二笔同名计划。
function bucketKey(value) {
  return value && value.accountId && value.planLabel && value.totalTerms
    ? [value.accountId, value.planLabel, value.totalTerms].join('|') : ''
}

module.exports = {
  FINGERPRINT_VERSION,
  DECISION_VERSION,
  fingerprint,
  planLabelFromItem,
  startMonthFromPeriod,
  bindingKey,
  bucketKey,
  fromDisbursement,
  fromInstallment,
  fingerprintOf,
  matches,
  inspectDecision,
  decisionFor
}
