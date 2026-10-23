const posting = require('./import-local-posting')
const failure = (code, message) => Object.assign(new Error(message), { code })

// A missing local journal cannot prove whether a ledger write was sent.
// Only an authoritative posted result or a locked server version transition
// allows us to replace it. No retry loop or ledger submission lives here.
async function recover({ updateId, deps, readRequest, saveRequest, clearRequest, publish, restart = false }) {
  const summary = () => deps.callNetwork('financeUpdates.summary', { updateId })
  const forgetConfirmedRequest = () => { try { clearRequest() } catch (_) { /* confirmed state remains authoritative */ } }
  const completed = view => {
    if (view.update.status === 'posted') {
      const receipt = { ...view, action:'financeUpdates.post', updateId, status:'posted' }
      posting.finish(receipt, deps)
      forgetConfirmedRequest()
      return { view:receipt, completed:true }
    }
    if (view.update.status === 'abandoned') {
      // The durable server tombstone prevents all old submissions, including
      // ones whose local request identity is no longer readable.
      const cleaned=deps.files.clear()
      try { deps.cleanup(cleaned) } catch (_) { /* server tombstone remains authoritative */ }
      forgetConfirmedRequest()
      return { view, restart:true }
    }
    return null
  }
  async function mutate(action, version, extra = {}) {
    let request = readRequest()
    if (!request || request.action !== action || request.data?.updateId !== updateId ||
      typeof request.data.requestId !== 'string' || !Number.isInteger(request.data.version)) {
      request = { action, data:{ requestId:deps.requestId(), updateId, version, ...extra } }
      saveRequest(request)
    }
    try { return await deps.callNetwork(action, request.data) }
    catch (error) {
      // A definite rejection releases only this recovery command. The
      // damaged original remains until a later server fence succeeds.
      if (['CONFLICT','VALIDATION_ERROR','SNAPSHOT_INCOMPLETE'].includes(error.code)) clearRequest()
      throw error
    }
  }
  try {
    let view = await summary()
    let result = completed(view)
    if (result) return result
    if (restart) {
      await mutate('financeUpdates.abandon', view.update.version)
      result = completed(await summary())
      if (result) return result
      throw failure('CONFLICT', '云端草稿已变化，请重新核实')
    }
    if (view.update.status !== 'review') throw failure('LOCAL_RESTART_REQUIRED', '云端已无法恢复这份草稿，请点“核实并重新开始”后重新选择账单')
    if (view.update.requiresReorganization) {
      view = await mutate('financeUpdates.organize', view.update.version)
      clearRequest()
    }
    const prepared = await mutate('financeUpdates.prepareSnapshot', view.update.version, { force:true })
    // A replayed preparation receipt may have become stale on another device.
    // Keep the damaged generation until the current server version is known.
    view = await summary()
    result = completed(view)
    if (result) return result
    if (view.update.status !== 'review' || view.update.version !== prepared.update.version) {
      clearRequest()
      throw failure('CONFLICT', '云端草稿已变化，请重新核实')
    }
    const restored = await publish(prepared)
    deps.guard(); forgetConfirmedRequest()
    return { view:restored, rebuilt:true }
  } catch (error) {
    if (error.code === 'CONFLICT') {
      const result = completed(await summary())
      if (result) return result
    }
    throw error
  }
}
module.exports = { recover }
