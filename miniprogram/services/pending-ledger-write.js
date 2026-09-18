// 账务写入只保留一份在途原请求；不是余额缓存，也不凭表单变化替换请求身份。
const api = require('./catledger-api')
const importApi = require('./catledger-import')
const config = require('../config/cloudbase')
const clone = value => JSON.parse(JSON.stringify(value))
const rejected = new Set(['VALIDATION_ERROR', 'CONFLICT', 'NOT_FOUND', 'ACCOUNT_INACTIVE', 'INSUFFICIENT_CASH_BALANCE',
  'REFUND_EXCEEDS_ORIGINAL', 'REFUNDED_TRANSACTION_LOCKED', 'UNSUPPORTED_CURRENCY', 'UNRESOLVED_IMPORT', 'LOAN_TRANSACTION_LOCKED', 'LOAN_BASELINE_LOCKED', 'LOAN_PRINCIPAL_UNCONFIRMED', 'LOAN_PRINCIPAL_EXCEEDED', 'LOAN_SOURCE_MISMATCH', 'LOAN_SOURCE_TOO_LARGE', 'LOAN_PLAN_OVERALLOCATED', 'LOAN_PLAN_EXISTS'])
function createPendingWrite(options) {
  const key = () => {
    const scope = options.scope()
    if (!scope) throw Object.assign(new Error('请先确认账本身份'), { code: 'LOGIN_REQUIRED' })
    return 'catledger_pending_ledger_v1:' + scope
  }
  function pending() { const stored = options.read(key()); return stored ? clone(stored) : null }
  function clear(storageKey, packet) {
    const current = options.read(storageKey)
    if (current && current.payload.requestId === packet.payload.requestId) options.remove(storageKey)
  }
  function persist(storageKey, packet) {
    try {
      options.write(storageKey, clone(packet))
      if (JSON.stringify(options.read(storageKey)) !== JSON.stringify(packet)) throw new Error('write not persisted')
    } catch (_) { throw Object.assign(new Error('本机未能保存请求，请释放空间后重试'), { code: 'DRAFT_STORAGE_FAILED' }) }
  }
  async function verifyPacket(storageKey, packet) {
    const value = await options.call(packet.target, packet.target === 'import' ? 'imports.commandResult' : 'transactions.commandResult',
      { requestId: packet.payload.requestId, commandAction: packet.action })
    if (!value || value.action !== packet.action) throw Object.assign(new Error('上次操作结果仍待核实'), { code: 'OPERATION_UNCONFIRMED' })
    clear(storageKey, packet)
    return { action: packet.action, result: packet.target === 'import' ? value : value.result, recovered: true }
  }
  return {
    pending,
    async verify() { const storageKey = key(), packet = pending(); return packet ? verifyPacket(storageKey, packet) : null },
    async send(target, action, data, settings) {
      const storageKey = key()
      let packet = pending()
      if (packet && settings && settings.exact) {
        const content = value => { const copy = clone(value); delete copy.requestId; return JSON.stringify(copy) }
        if (packet.target !== target || packet.action !== action || content(packet.payload) !== content(data)) {
          try { await verifyPacket(storageKey, packet) }
          catch (error) {
            if (error.code !== 'OPERATION_UNCONFIRMED') throw error
            throw Object.assign(new Error('另一次操作还未完成，请先返回原页面继续处理'), { code: 'PENDING_OPERATION_EXISTS' })
          }
          if (key() !== storageKey) throw Object.assign(new Error('登录状态已变化，请重新打开页面'), { code: 'LOGIN_REQUIRED' })
          packet = null
        }
      }
      if (packet) {
        try { return await verifyPacket(storageKey, packet) }
        catch (error) { if (error.code !== 'OPERATION_UNCONFIRMED') throw error }
        // 用户再次提交仅重试冻结的原操作；新表单不能替换它。
      } else {
        packet = { schema: 1, target, action, payload: Object.assign({}, clone(data), { requestId: options.requestId() }) }
        persist(storageKey, packet)
      }
      try {
        const result = await options.call(packet.target, packet.action, packet.payload)
        clear(storageKey, packet)
        return { action: packet.action, result, recovered: false }
      } catch (error) {
        if (rejected.has(error.code)) clear(storageKey, packet)
        throw error
      }
    }
  }
}
const current = createPendingWrite({
  scope: () => { const uid = getApp().globalData.uid; return uid && config.envId + ':' + uid },
  read: key => wx.getStorageSync(key), write: (key, value) => wx.setStorageSync(key, value), remove: key => wx.removeStorageSync(key),
  requestId: api.createRequestId,
  call: (target, action, data) => target === 'import' ? importApi.callImport(action, data) : api.callApi(action, data)
})
module.exports = { createPendingWrite, pending: current.pending, verify: current.verify, send: current.send }
