// 现金分期放款对：信用卡账单里的两行合起来才是一笔真实业务。
//
//   第一行「合成现金分期12期」        支出 ¥1,200   —— 放款本金计入本期应还
//   第二行「合成现金分期12期 转分期付款」 收入 ¥1,200   —— 把这笔本金从本期应还转进分期未还
//
// 钱确实到了持卡人的另一张卡：卡上的欠款多了 1,200，资产多了 1,200，所以第一行是
// 一笔借款（负债 → 资产），不是支出。第二行只是卡内的记账调整，既不产生资金流，也不
// 改变欠款总额，只留作证据。
//
// 配对只在“同一张卡 + 同一天 + 同金额 + 恰好一行放款、一行对行”时成立；独立结转行
// 只登记计划，不补造缺失放款。多候选或事实冲突继续逐笔核对。行文规则在
// profiles/bank-installment.disbursementRole，这里只做配对和语义改写。

const { getRowSemantic, RESOLUTION_STATUS, MONEY_EFFECT, SOURCE_ACTION } = require('./row-semantic-resolver')
const { disbursementRole } = require('./profiles/bank-installment')
const { planNameFromItem } = require('./installment-plan')

const PAIR_VERSION = 'installment-disbursement-pair-v2'
const PAIR_RULE = 'bank.pair.cash-installment-disbursement.v2'
// 这两条来源缺陷由放款对这一事实解释，识别后不再是待人工确认的问题。
const EXPLAINED_ISSUES = new Set(['row_transaction_type_unknown', 'account_endpoint_unknown'])

function text(row, key) {
  return String((row && row[key]) || '').normalize('NFKC').trim()
}

// 计划名取放款摘要去掉期数：「电销现金分期12期」→「电销现金分期」。
function planLabelOf(row) {
  const name = planNameFromItem(text(row, 'item').replace(/(?:转分期付款|转分期|转入分期|分期转入|分期转出|分期结转)\s*$/u, '').trim())
  return name.replace(/[\s·:：\-—_]*\d{1,3}\s*期\s*$/u, '').trim() || name
}

// 配对的全部前提：同一份账单、同一来源账户、同一天、同金额、同币种。账单文件本身就是一张卡，
// 所以先按导入文件隔开，两张卡的记录不会跨文件配对；账户优先用固化的引用键，没有键时才退回
// 账单上的账户名（很多账单只写“银行”这一层）。
function bucketKey(row) {
  return [text(row, 'importId'), text(row, 'sourceType'), text(row, 'paymentMethodKey') || text(row, 'paymentMethod'),
    text(row, 'localDate'), row.amountMinor == null ? '' : String(row.amountMinor), text(row, 'currency') || 'CNY'].join('|')
}

function candidates(rows) {
  const buckets = new Map()
  for (const row of rows || []) {
    if (row.parseState && row.parseState !== 'valid') continue
    const role = disbursementRole(row)
    if (!role) continue
    const semantic = getRowSemantic(row)
    // 已经改写过语义的行按识别结果重新配对，否则对行的“不产生资金流”会让自己落选。
    const recognized = Boolean(semantic.relationHints && semantic.relationHints.disbursement)
    // 状态未知、失败或已关闭的行不参与：来源自己还没说清这笔钱动没动；金额或语义冲突也不猜。
    if (!recognized && (semantic.moneyEffect !== MONEY_EFFECT.FINANCIAL ||
        [RESOLUTION_STATUS.INVALID, RESOLUTION_STATUS.CONFLICT].includes(semantic.resolutionStatus))) continue
    const key = bucketKey(row)
    const bucket = buckets.get(key) || { disbursements: [], offsets: [] }
    ;(role.role === 'offset' ? bucket.offsets : bucket.disbursements).push({ row, role })
    buckets.set(key, bucket)
  }
  return buckets
}

// rowId → { role, partnerRowId, totalTerms, planLabel }；没有配成对的行不出现在结果里。
function pairsOf(rows) {
  const pairs = new Map()
  for (const bucket of candidates(rows).values()) {
    // 唯一才配对：两条同额放款或两条同额对行时，谁也说不清谁配谁。
    if (bucket.disbursements.length !== 1 || bucket.offsets.length !== 1) continue
    const [disbursement] = bucket.disbursements
    const [offset] = bucket.offsets
    const offsetLabel = planLabelOf(offset.row), label = planLabelOf(disbursement.row)
    if (offset.role.totalTerms && offset.role.totalTerms !== disbursement.role.totalTerms ||
        offsetLabel && offsetLabel !== label || offset.role.referenceKey && disbursement.role.referenceKey &&
        offset.role.referenceKey !== disbursement.role.referenceKey) continue
    const shared = { totalTerms: disbursement.role.totalTerms, planLabel: label,
      referenceKey: disbursement.role.referenceKey || offset.role.referenceKey || null }
    // 放款行记下同笔的另一行：详情里两行并列，用户看到的是同一笔业务的两条来源，
    // 而不是一笔借款外加一条来历不明的排除记录。
    const partner = (row) => ({ rowId: row.rowId, item: text(row, 'item'), localDate: text(row, 'localDate'),
      amountMinor: row.amountMinor == null ? null : String(row.amountMinor) })
    pairs.set(disbursement.row.rowId, { ...shared, role: 'disbursement', partnerRowId: offset.row.rowId,
      partner: partner(offset.row) })
    pairs.set(offset.row.rowId, { ...shared, role: 'offset', partnerRowId: disbursement.row.rowId })
  }
  return pairs
}

function patched(semantic, pair) {
  const issues = (semantic.issues || []).filter((issue) => !EXPLAINED_ISSUES.has(issue.code))
  const hint = { schema: 1, version: PAIR_VERSION, role: pair.role, totalTerms: pair.totalTerms, planLabel: pair.planLabel,
    referenceKey: pair.referenceKey || null, partnerRowId: pair.partnerRowId || null,
    ...(pair.partner ? { partner: pair.partner } : {}) }
  return {
    ...semantic,
    resolutionStatus: RESOLUTION_STATUS.RESOLVED,
    issues,
    // 放款行本身不再是分期账单行；分期事实改成这一对放款，由收入端和还款端分别消费。
    relationHints: { ...(semantic.relationHints || {}), installment: null, disbursement: hint },
    ruleIds: [...new Set([...(semantic.ruleIds || []), PAIR_RULE])].sort()
  }
}

// 返回改写后的规划行；输入行的来源语义不动，下游仍以 getRowSemantic 读取。
function applyInstallmentDisbursements(rows) {
  const pairs = pairsOf(rows)
  // 只有缺少放款候选的一侧才独立登记；冲突或多候选仍逐条待核对，不能靠隐藏消除歧义。
  for (const bucket of candidates(rows).values()) if (!bucket.disbursements.length) {
    for (const { row, role } of bucket.offsets) pairs.set(row.rowId, {
      ...role, role: 'registration', planLabel: planLabelOf(row), partnerRowId: null
    })
  }
  if (!pairs.size) return rows
  return (rows || []).map((row) => {
    const pair = pairs.get(row.rowId)
    if (!pair) return row
    const semantic = getRowSemantic(row)
    if (pair.role === 'registration') return { ...row, semantic: { ...patched(semantic, pair),
      moneyEffect: MONEY_EFFECT.NON_FINANCIAL, sourceAction: null, fromAccountRef: null, toAccountRef: null,
      fundsProjection: null,
      legacy: { ...semantic.legacy, kind: 'unknown', transactionType: 'transfer', rule: PAIR_RULE } } }
    if (pair.role === 'disbursement') {
      // 放款行保留账单上的账户引用：它是这笔借款的负债账户，资产端由用户选到账账户。
      return { ...row, semantic: { ...patched(semantic, pair),
        moneyEffect: MONEY_EFFECT.FINANCIAL,
        sourceAction: SOURCE_ACTION.BORROW,
        toAccountRef: null,
        fundsProjection: null,
        legacy: { ...semantic.legacy, kind: 'borrow', transactionType: 'transfer', rule: PAIR_RULE } } }
    }
    // 对行是卡内的记账调整：不产生资金流，账户端不再需要确认，只留原文和证据。
    return { ...row, semantic: { ...patched(semantic, pair),
      moneyEffect: MONEY_EFFECT.NON_FINANCIAL,
      sourceAction: null,
      ledgerAccountRef: null,
      fromAccountRef: null,
      toAccountRef: null,
      fundsProjection: null,
      legacy: { ...semantic.legacy, kind: 'unknown', transactionType: 'transfer', rule: PAIR_RULE } } }
  })
}

module.exports = { PAIR_RULE, PAIR_VERSION, applyInstallmentDisbursements, pairsOf }
