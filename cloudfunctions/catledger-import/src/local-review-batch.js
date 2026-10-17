// Only the v3 posting transaction installs this context. Existing connection-
// local decision kernels defer whole-batch derivation until all final choices
// have been applied. It is always removed before returning the connection.
const batches = new WeakMap()
function begin(connection, update) {
  if (batches.has(connection)) throw new Error('Nested local review batch')
  const value = { update, duplicateEvidenceDelta: 0, actionId: null }
  batches.set(connection, value)
  return value
}
function get(connection) { return batches.get(connection) }
function end(connection) { const value = get(connection); batches.delete(connection); return value }
function defer(connection, actionId, delta = 0) {
  const value = get(connection)
  if (!value) return false
  if (actionId) value.actionId = actionId
  value.duplicateEvidenceDelta += delta
  return true
}
module.exports = { begin, get, end, defer }
