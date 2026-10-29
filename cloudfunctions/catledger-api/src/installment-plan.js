// 分期计划归属：判断一笔利息／手续费属于哪个分期计划。
//
// 账单原文的事实是：本金行摘要带计划名（“电销总账分月12期第12期共12期”），利息行摘要只到
// 期次（“分期付款利息第12期共12期”）。同一账单期次里可能同时存在多个计划，金额、日期、卡号
// 和行序都没有区分度，所以归属只能按下面的顺序判定：
//   人工确认 → 费用摘要里写明了计划名 → 本期次只有一笔本金。
// 三条都不成立时不猜，交给用户指定；不用金额大小或行的先后顺序替代证据。
//
// 本模块保持无依赖的纯计算，只给出结论；写回事件由整理器负责。

const VALUE_VERSION = 'installment-attribution-v1'
const REASON_CODE = 'installment_attribution_required'
const COMPONENTS = new Set(['principal', 'interest', 'fee'])
// 期次后缀：第几期，其后可能接“共几期”或“／共几期”。
const PERIOD_SUFFIX = /第\s*\d{1,3}\s*期(?:\s*[／/]\s*共\s*\d{1,3}\s*期|\s*共\s*\d{1,3}\s*期)?\s*$/u

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim()
}

// 计划名 = 摘要去掉期次后缀。同一计划的各期摘要前缀一致，所以它可以跨期次稳定标识一个计划。
function planNameFromItem(item) {
  const value = text(item)
  return value.replace(PERIOD_SUFFIX, '').trim() || value
}

// 生效分期属性：人工修正过的期次优先，与读取层下发口径保持一致。
function effectiveInstallment(event) {
  const fields = event && event.fieldSources || {}
  const installment = fields.installment
  if (!installment || installment.creditStatement !== true || !COMPONENTS.has(installment.component)) return null
  const editor = fields.editorOverrides
  const corrections = editor && editor.version === 1 ? editor.sourceCorrection : null
  return corrections ? { ...installment, ...corrections } : installment
}

// 人工确认的计划归属；写入通道是核对编辑器的 sourceCorrection.planLabel。
function confirmedPlan(event) {
  const fields = event && event.fieldSources || {}
  const editor = fields.editorOverrides
  const corrections = editor && editor.version === 1 ? editor.sourceCorrection : null
  return text(corrections && corrections.planLabel)
}

function displayItem(event) {
  const display = event && event.display || {}
  const evidence = event && event.primaryEvidence || {}
  return display.item || evidence.item || ''
}

// 分期归属的分组键：同一来源账户 + 同一期次 + 同一总期数。
// 用来源账户身份而不是账本账户，是因为账户尚未确认时后者为空，会把不同卡片的同名期次混成一组。
function groupKeyOf(event) {
  const installment = effectiveInstallment(event)
  if (!installment || !Number.isInteger(installment.periodNumber)) return ''
  const identity = text(event && event.accountGroupingKey) || text(event && event.ledgerAccountId)
  if (!identity) return ''
  return [identity, installment.periodNumber, installment.totalTerms == null ? '' : installment.totalTerms].join('|')
}

// 能自动定下来的归属；空字符串表示判不出来。
function resolvedPlan(event, plans) {
  const confirmed = confirmedPlan(event)
  if (confirmed) return confirmed
  const item = text(displayItem(event))
  const named = plans.find((plan) => plan && item.includes(plan))
  if (named) return named
  return plans.length === 1 ? plans[0] : ''
}

// 这一行是否还需要用户指定归属：自己判不出来，而本期次确实有可选的计划。
// 没有候选就是来源侧的问题（比如没识别到本金行），拦下来也指定不了，不算归属待办。
// 整理阶段写原因码、入账门禁、以及指定完后的整组收尾都走这一个判定，避免三处口径漂移。
function needsAttribution(event) {
  const attribution = event && event.fieldSources && event.fieldSources.installmentAttribution
  return Boolean(attribution && attribution.role === 'charge' && !attribution.planLabel &&
    (attribution.plans || []).length && !confirmedPlan(event))
}

// 归属结论：eventId → 结论。费用行拿到的是「这笔属于哪个计划」：planLabel 有值就是结论，
// 为空才是待办（此时 plans 里是本期次的可选计划）。本金行拿到的是本组上下文：它自己不需要
// 指定归属，但它是那张卡片的入口，编辑器要靠 plans 与待指定清单把利息配过来；整组都定完就
// 不再写，免得留下会随用户操作立刻过期的快照。
// 客户端据此渲染，不再自己重算一遍归属规则；旧批次没有这个字段时才回退本地口径。
function attributionFor(events) {
  const groups = new Map()
  ;(events || []).forEach((event) => {
    const key = groupKeyOf(event)
    if (!key) return
    const group = groups.get(key) || { key: key, principals: [], charges: [] }
    const entry = { event: event, planName: planNameFromItem(displayItem(event)) }
    if (effectiveInstallment(event).component === 'principal') group.principals.push(entry)
    else group.charges.push(entry)
    groups.set(key, group)
  })
  const result = new Map()
  groups.forEach((group) => {
    if (!group.charges.length) return
    // 同一计划可能有多笔本金行（重复出账或分期跨账期），按计划名去重后才是本期次的计划数。
    const candidates = []
    group.principals.forEach((entry) => {
      if (!entry.planName || candidates.some((item) => item.planName === entry.planName)) return
      candidates.push({
        planName: entry.planName,
        eventId: entry.event.eventId,
        amountMinor: entry.event.amountMinor == null ? null : String(entry.event.amountMinor)
      })
    })
    const plans = candidates.map((item) => item.planName)
    const installment = effectiveInstallment(group.charges[0].event)
    const pendingCharges = group.charges.filter((entry) => !resolvedPlan(entry.event, plans)).length
    const shared = {
      version: VALUE_VERSION,
      groupKey: group.key,
      periodNumber: installment.periodNumber,
      totalTerms: installment.totalTerms == null ? null : installment.totalTerms,
      // 只有多计划才是真正的“待用户指定”；唯一计划已自动归属，无计划时也没有可选项。
      plans: plans.length > 1 ? candidates : []
    }
    group.charges.forEach((entry) => {
      result.set(entry.event.eventId, Object.assign({}, shared, {
        role: 'charge',
        planLabel: resolvedPlan(entry.event, plans)
      }))
    })
    // 本金行拿到的不是“待办”，而是本组上下文：它的编辑器要据此列出本期次还没指定归属的利息，
    // 让用户在本金这一张卡里把利息配过来。归属全部定完就不再写，避免留一份没用的快照。
    if (!pendingCharges) return
    group.principals.forEach((entry) => {
      result.set(entry.event.eventId, Object.assign({}, shared, {
        role: 'principal',
        planLabel: entry.planName
      }))
    })
  })
  return result
}

module.exports = {
  REASON_CODE,
  VALUE_VERSION,
  planNameFromItem,
  effectiveInstallment,
  confirmedPlan,
  groupKeyOf,
  needsAttribution,
  attributionFor
}
