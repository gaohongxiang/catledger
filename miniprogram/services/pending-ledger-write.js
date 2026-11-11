// 账务写入只保留一份在途原请求；不是余额缓存，也不凭表单变化替换请求身份。
const api = require('./catledger-api')
const importApi = require('./catledger-import')
const config = require('../config/cloudbase')
const clone = value => JSON.parse(JSON.stringify(value))
const rejected = new Set(['LOCAL_RECHECK_REQUIRED','LOCAL_REVIEW_REQUIRED','LOCAL_REVIEW_CAPACITY','UNSUPPORTED_ACTION','LOAN_DELETE_BLOCKED','LOAN_CHARGE_COVERAGE','LOAN_CHARGE_PAUSED','LOAN_CHARGE_DIFFERENCE','LOAN_COVERAGE_REQUIRED','LOAN_PERIOD_REQUIRED','VALIDATION_ERROR', 'CONFLICT', 'NOT_FOUND', 'ACCOUNT_INACTIVE', 'ACCOUNT_HAS_RECORDS', 'ACCOUNT_NAME_CONFLICT', 'INSUFFICIENT_CASH_BALANCE',
  'REFUND_EXCEEDS_ORIGINAL', 'REFUNDED_TRANSACTION_LOCKED', 'TRANSACTION_GROUP_LOCKED', 'UNSUPPORTED_CURRENCY', 'UNRESOLVED_IMPORT', 'LOAN_TRANSACTION_LOCKED', 'LOAN_BASELINE_LOCKED', 'LOAN_HISTORY_REVIEW_REQUIRED', 'LOAN_PRINCIPAL_UNCONFIRMED', 'LOAN_PRINCIPAL_EXCEEDED', 'LOAN_SOURCE_MISMATCH', 'LOAN_SOURCE_TOO_LARGE', 'LOAN_PLAN_OVERALLOCATED', 'LOAN_PLAN_EXISTS', 'LOAN_PLAN_HAS_PAYMENTS', 'LOAN_PLAN_HAS_ITEMS',
  // 分期参数的结构化校验错误码（被明确拒绝=写入未发生，必须清包，否则会卡成僵尸请求阻塞后续写/费用同步）。
  'SCHEDULE_PRINCIPAL_REQUIRED', 'SCHEDULE_METHOD_INVALID', 'SCHEDULE_TERMS_INVALID', 'SCHEDULE_MEASUREMENT_INVALID',
  'SCHEDULE_FIELD_CONFLICT', 'SCHEDULE_QUOTE_REQUIRED', 'SCHEDULE_RATE_REQUIRED', 'SCHEDULE_PAYMENT_REQUIRED',
  'SCHEDULE_INSTALLMENT_NEEDS_FLAT', 'SCHEDULE_AMOUNT_REQUIRED', 'SCHEDULE_AMOUNT_INVALID', 'SCHEDULE_UPFRONT_FEE_TOO_HIGH',
  'SCHEDULE_DATE_INVALID', 'SCHEDULE_DISCOUNT_INVALID', 'SCHEDULE_ROUNDING_INVALID', 'SCHEDULE_PAYMENT_TOO_LOW', 'SCHEDULE_PAYMENT_TOO_LOW_TOTAL'])
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
  function confirmed(storageKey, packet, result, recovered) {
    const confirmedResult = { action: packet.action, result, recovered }
    try {
      const current = options.read(storageKey)
      if (current && current.payload.requestId === packet.payload.requestId) {
        if (options.onConfirmed) options.onConfirmed(packet, result, storageKey.slice('catledger_pending_ledger_v1:'.length))
        clear(storageKey, packet)
      }
    } catch (error) {
      // 服务端已成功；交接本机恢复指针失败时保留原请求，不能误报命令失败。
      error.confirmedResult = confirmedResult
      throw error
    }
    return confirmedResult
  }
  async function verifyPacket(storageKey, packet) {
    const value = await options.call(packet.target, packet.target === 'import' ? 'imports.commandResult' : 'transactions.commandResult',
      { requestId: packet.payload.requestId, commandAction: packet.action })
    // 服务端权威回答"查无此回执"=该请求从未成功落库（幂等回执只在成功后写），确认原操作未生效：
    // 安全丢弃这份僵尸包，返回"未生效"，不再永久阻塞后续写入/费用同步。
    if (value && value.found === false) {
      clear(storageKey, packet)
      return { action: packet.action, result: null, recovered: false, notApplied: true }
    }
    if (!value || value.action !== packet.action) throw Object.assign(new Error('上次操作结果仍待核实'), { code: 'OPERATION_UNCONFIRMED' })
    return confirmed(storageKey, packet, packet.target === 'import' ? value : value.result, true)
  }
  return {
    pending,
    async verify() {
      const storageKey = key(), packet = pending()
      if (!packet) return null
      const outcome = await verifyPacket(storageKey, packet)
      // 僵尸包（服务端查无回执=原操作从未生效）已丢弃 → 返回 null，调用方据此当作"没有待恢复操作"，正常继续。
      if (outcome && outcome.notApplied) return null
      return outcome
    },
    // 丢弃一份已确认不会生效的在途请求（例如删除账户被 ACCOUNT_HAS_RECORDS 明确拒绝却未清理的旧包）。
    // 仅供确定原操作未落地时显式调用，绝不用于"结果未知"的请求。
    discard() { const storageKey = key(), packet = pending(); if (packet) clear(storageKey, packet); return packet },
    async send(target, action, data, settings) {
      const storageKey = key()
      const canSend = () => {
        if (settings && settings.canSend && !settings.canSend()) throw Object.assign(new Error('页面已离开，原请求仍可恢复'), { code: 'VIEW_INACTIVE' })
      }
      canSend()
      if(target==='import'&&require('./import-local-router').session(data.updateId)?.state.postFlight)throw Object.assign(new Error('入账结果待核实，请先继续原请求'),{code:'OPERATION_UNCONFIRMED'})
      let packet = pending()
      if (packet && settings && settings.exact) {
        const content = value => { const copy = clone(value); delete copy.requestId; return JSON.stringify(copy) }
        if (packet.target !== target || packet.action !== action || content(packet.payload) !== content(data)) {
          let verified
          try { verified = await verifyPacket(storageKey, packet) }
          catch (error) {
            if (error.code !== 'OPERATION_UNCONFIRMED') throw error
            throw Object.assign(new Error('另一次操作还未完成，请先返回原页面继续处理'), { code: 'PENDING_OPERATION_EXISTS' })
          }
          if (key() !== storageKey) throw Object.assign(new Error('登录状态已变化，请重新打开页面'), { code: 'LOGIN_REQUIRED' })
          // 原请求已核实（成功或僵尸包被丢弃）→ 让位给本次新请求，继续提交当前选择。
          packet = null
        }
      }
      if (packet) {
        let verified
        try { verified = await verifyPacket(storageKey, packet) }
        catch (error) { if (error.code !== 'OPERATION_UNCONFIRMED') throw error }
        // 核实成功（原操作已生效）→ 直接返回。
        if (verified && verified.recovered) return verified
        // found:false 的僵尸包已被 verifyPacket 丢弃（原操作从未生效）→ 本次按新请求重新提交。
        if (verified && verified.notApplied) packet = null
        // 其余：verify 抛 OPERATION_UNCONFIRMED（服务端暂时读不到）→ 保留 packet 重发原冻结请求。
      }
      if (!packet) {
        canSend()
        packet = { schema: 1, target, action, payload: Object.assign({}, clone(data), { requestId: options.requestId() }) }
        persist(storageKey, packet)
      }
      // 核实原回执期间可能换用户；不得在新身份下重发旧用户的冻结请求。
      if (key() !== storageKey) throw Object.assign(new Error('登录状态已变化，请重新打开页面'), { code: 'LOGIN_REQUIRED' })
      canSend()
      try {
        const result = await options.call(packet.target, packet.action, packet.payload)
        return confirmed(storageKey, packet, result, false)
      } catch (error) {
        if (rejected.has(error.code)) clear(storageKey, packet)
        throw error
      }
    }
  }
}
const current = createPendingWrite({
  scope: () => { const app = getApp(), uid = app.globalData.uid; return app.hasLoginApproval() && uid && config.envId + ':' + uid },
  read: key => wx.getStorageSync(key), write: (key, value) => wx.setStorageSync(key, value), remove: key => wx.removeStorageSync(key),
  requestId: api.createRequestId,
  call: (target, action, data) => target === 'import' ? importApi.callImport(action, data) : api.callApi(action, data),
  onConfirmed: (packet, result, scope) => {
    if (packet.target === 'import' && packet.action === 'financeUpdates.prepare') {
      require('./import-draft-session').rememberLast(result.update.updateId, scope)
    }
  }
})
module.exports = { createPendingWrite, pending: current.pending, verify: current.verify, send: current.send, discard: current.discard }
