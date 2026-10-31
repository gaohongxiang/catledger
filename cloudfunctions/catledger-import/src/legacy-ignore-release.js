// 旧版本把「仅本次不计入」发布成永久忽略，整理时据此直接把记录排除。
// 现在只认本批核对时明确选定的忽略，这类只由旧规则造成的排除要在原地升级时
// 恢复成待确认，让账户步骤重新问一次。人工排除、已入账、失败或关闭、非资金
// 记录和分期对行各有自己的排除理由，不能跟着一起放开。
const EXCLUSION_REASONS = new Set([
  'already_posted',
  'transaction_failed',
  'transaction_closed',
  'source_non_financial',
  'installment_offset_pair',
  'account_mapping_excluded',
  'manual_exclusion'
])

function releaseLegacyIgnore(event) {
  if (!event || event.status !== 'excluded') return null
  const reasons = event.reasonCodes || []
  if (!reasons.includes('source_account_ignored_default')) return null
  if (reasons.some((reason) => EXCLUSION_REASONS.has(reason))) return null
  if ((event.existingTransactionIds || []).length) return null
  return { ...event, status: 'needs_action',
    reasonCodes: reasons.filter((reason) => reason !== 'source_account_ignored_default') }
}

module.exports = { releaseLegacyIgnore, EXCLUSION_REASONS }
