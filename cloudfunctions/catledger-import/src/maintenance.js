const TIMER_TYPES = new Set(['Timer', 'timer'])

function isTimerEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false
  return TIMER_TYPES.has(event.Type) || TIMER_TYPES.has(event.type)
}

function isScheduledMaintenance(event, wxContext) {
  // A WeChat client can forge an event payload, but it always carries OPENID.
  // Timer invocations have no WeChat identity, so only those may run global cleanup.
  return isTimerEvent(event) && !(wxContext && wxContext.OPENID)
}

module.exports = { isTimerEvent, isScheduledMaintenance }
