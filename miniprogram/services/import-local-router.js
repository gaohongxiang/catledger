// Main-package bridge: the finance subpackage owns the model and file store.
// Once a complete session is bound, review calls never fall through to network.
const sessions = new Map()
let cleanup = null
function session(updateId) { return updateId ? sessions.get(updateId) || null : null }
function route(action, data = {}) {
  let current = session(data.updateId)
  if (!current) for (const value of sessions.values()) {
    if (data.eventId && value.hasEvent(data.eventId) || data.issueId && value.hasIssue(data.issueId) ||
      action === 'imports.commandResult' && value.hasReceipt(data.requestId)) { current = value; break }
  }
  return current ? { value: current.call(action, data) } : null
}
function reset() {
  for (const value of sessions.values()) value.destroy()
  sessions.clear()
  if (cleanup) cleanup()
}
module.exports = { route, session, bind(value) { sessions.set(value.view.update.updateId, value) },
  unbind(updateId) { sessions.delete(updateId) }, reset, setCleanup(value) { cleanup = value } }
