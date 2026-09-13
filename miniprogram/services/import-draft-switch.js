// 开发草稿的一次性格式切换；原在途请求只允许核实，不适配或重发旧协议。
function switchDraft(stored) {
  if (!stored || stored.schema !== 1) return stored
  const next = JSON.parse(JSON.stringify(stored))
  next.schema = 2
  if (next.flight) next.flight.reconcile = true
  if (next.postFlight) next.postFlight = { action: 'financeUpdates.post', payload: next.postFlight, reconcile: true }
  return next
}
module.exports = { switchDraft }
