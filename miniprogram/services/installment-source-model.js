// 账单分期来源的展示态纯函数：把 installment-items 返回的「按账单行」来源，
// 聚合成「一笔分期一条」的展示项，供账户详情页与「账单里的分期」页共用，避免各写一套。
const money = require('../utils/money')

const COMPONENT_LABELS = { principal: '本金', interest: '利息', fee: '手续费' }

function sourceName(item) {
  return String(item.planLabel || item.referenceLabel || '').trim() || '待确认所属分期'
}

// 聚合键：同一笔同一期次才合并（本金/利息/手续费归一行）。
// - 有唯一合同编号：按 编号 + 期次（不同期次分开展示，不再只显示最近一期）。
// - 无编号：按 计划名 + 总期数 + 期次（同名同期数的不同期次各自展示，全部列出不遗漏，也符合"同名不合并"）。
function groupKey(item) {
  const term = item.periodNumber == null ? '-' : String(item.periodNumber)
  if (item.referenceKey) return 'ref:' + item.referenceKey + '@' + term
  return 'plan:' + sourceName(item) + '#' + (item.totalTerms == null ? '-' : item.totalTerms) + '@' + term
}

// 把同一笔分期的多行（本金/利息/手续费、多期）合并成一条展示项：
// 展示最近一期期次；本金/利息/手续费金额各自汇总（同一期内各组件一行）。
// 无编号时「计划名+总期数」只是展示近似：若同组内出现同期次同组件却金额不同的多行，
// 说明很可能混进了两笔同名分期（判不准），标记 ambiguous 交给用户核对，不静默当成一笔。
function aggregate(items) {
  const groups = new Map()
  for (const item of items || []) {
    const key = groupKey(item)
    let group = groups.get(key)
    if (!group) {
      group = { key, name: sourceName(item), totalTerms: item.totalTerms, referenceKey: item.referenceKey || null,
        latestPeriod: 0, components: {}, itemIds: [], componentItems: {}, accountId: item.accountId, occurredDate: item.occurredDate,
        updateId: item.updateId, eventId: item.eventId, ambiguous: false, seen: new Set() }
      groups.set(key, group)
    }
    // 同期次同组件出现第二条就是可疑（同名不同笔的迹象）。
    const slot = Number(item.periodNumber) + ':' + item.component
    if (group.seen.has(slot)) group.ambiguous = true
    group.seen.add(slot)
    if (Number(item.periodNumber) > group.latestPeriod) {
      group.latestPeriod = Number(item.periodNumber)
      group.occurredDate = item.occurredDate || group.occurredDate
    }
    // 以最近一期为准记录各组件金额与来源行（同一期不同组件各一行）。
    if (!group.components[item.component] || Number(item.periodNumber) >= group.latestPeriod) {
      group.components[item.component] = item.amountMinor
      group.componentItems[item.component] = item.itemId
    }
    group.itemIds.push(item.itemId)
    if (item.updateId) group.updateId = item.updateId
    if (item.eventId) group.eventId = item.eventId
  }
  return [...groups.values()]
    .sort((left, right) => right.latestPeriod - left.latestPeriod || String(left.name).localeCompare(String(right.name)))
}

function presentGroup(group) {
  const parts = ['principal', 'interest', 'fee']
    .filter(component => group.components[component] != null)
    .map(component => COMPONENT_LABELS[component] + ' ' + money.formatMinor(group.components[component]))
  // 不把内部去重集合 seen 泄露给展示层；ambiguous 保留供 UI 提示「疑似同名多笔，请核对」。
  const { seen, ...rest } = group
  return Object.assign({}, rest, {
    periodText: '第 ' + group.latestPeriod + (group.totalTerms ? ' / ' + group.totalTerms : '') + ' 期',
    amountText: parts.join(' · '),
    // 新建/归入针对该笔分期的一条来源行：优先最近一期的本金行，否则本金/利息/手续费中任一。
    sourceItemId: group.componentItems.principal || group.componentItems.interest || group.componentItems.fee || group.itemIds[0]
  })
}

module.exports = { aggregate, presentGroup, sourceName, COMPONENT_LABELS }
