// 资金证据的唯一事实源：一笔事件“实际的钱怎么走”只由这里判定一次。
// 复核、入账与投影共用同一结论，避免“核对放行、入账拒绝”的两套标准分叉。
//
// 判定顺序是“用户决定优先于来源”：
//   1. 用户在编辑器里把组成确认成单账户（editorOverrides.composition === 'single'），
//      整笔金额落到当前事实的付款/还入账户，逐成分的组成事实随之失效。
//      这类旧数据若仍留着 paymentResolution / repaymentAllocations / paymentAccounts /
//      paymentAccountReferences 以及 payment_components_ambiguous 阻断，一律视为过期证据，
//      不参与判定——这正是“复核通过、入账拒绝”的根源。
//   2. 保存了完整的组成决定（paymentResolution / repaymentAllocations）。
//   3. 尚未决定的半成品（incompleteComposition，含 payment_components_ambiguous）。
//   4. 没有组成问题：单来源资金路径。
const singleComposition = (event) => {
  const editor = event && event.fieldSources && event.fieldSources.editorOverrides
  return Boolean(editor && editor.version === 1 && editor.composition === 'single')
}
const pendingComposition = (event) => {
  const editor = event && event.fieldSources && event.fieldSources.editorOverrides
  return Boolean(editor && editor.version === 1 && editor.incompleteComposition)
}
// 用户已把组成确认成单账户且没有未完成的重新拆分：逐成分证据全部作废。
function single(event) {
  return singleComposition(event) && !pendingComposition(event)
}
// 用户选择单账户后，逐成分的账户证据不再代表实际资金。
function componentEvidenceActive(event) {
  if (single(event)) return false
  const fields = event && event.fieldSources || {}
  return Boolean((fields.paymentAccounts || []).length ||
    (fields.paymentAccountReferences || []).some(reference => /^payment_component_/.test(reference.memberRole || '')))
}
function pending(event) {
  // 单账户决定本身就是对“金额分不清”的答复，残留的歧义阻断随之失效。
  if (single(event)) return false
  const fields = event && event.fieldSources || {}
  return Boolean(pendingComposition(event) || (fields.semanticBlockers || []).includes('payment_components_ambiguous'))
}
module.exports = { singleComposition, pendingComposition, componentEvidenceActive, pending, single }
