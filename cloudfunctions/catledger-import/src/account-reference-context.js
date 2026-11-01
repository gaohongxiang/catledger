// 只读取已持久化的来源引用，不推导交易性质或账户归属。
function memberReference(event, member) {
  const sources = event.fieldSources || {}, projection = sources.fundsProjection
  return sources.bankChannelAccountContexts?.[member.issueId] ||
    (sources.paymentAccountReferences || []).find(reference => reference.memberRole === member.memberRole) ||
    (member.memberRole === 'mapping_from' ? projection?.from : member.memberRole === 'mapping_to' ? projection?.to
      : member.memberRole === 'subject' ? sources.ledgerAccountReference : null) || null
}
module.exports = { memberReference }
