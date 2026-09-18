const crypto = require('node:crypto')
const { databaseErrorCode, isRetryableDatabaseError } = require('./database-errors')

const IDENTITY_FIELDS = ['uid', 'openid', 'openId', 'OPENID']

const ERROR_MESSAGES = Object.freeze({
  EXPORT_CHANGED: '导出期间账本发生变化，请重新生成完整导出',
  EXPORT_EXPIRED: '导出已过期，请重新生成',
  LOAN_SOURCE_MISMATCH: '原交易组与确认的金额、账户或本息费不符，请核对完整付款',
  LOAN_PLAN_OVERALLOCATED: '期次本金、利息或费用超过可分配金额，已付款也不能被计划改小或取消',
  LOAN_PLAN_EXISTS: '该贷款已有还款计划期次，不能重复生成',
  LOAN_SOURCE_TOO_LARGE: '来源组超过单次处理范围，请保留原账目核对',
  LOAN_PRINCIPAL_EXCEEDED: '该操作会使某个历史时点的本金不足，请核对构成与后续还款',
  LOAN_PRINCIPAL_UNCONFIRMED: '请先补充本金基准及日期',
  LOAN_BASELINE_LOCKED: '已有实际借还记录，请先在贷款管理处理关联后再修改本金基准或账户',
  LOAN_TRANSACTION_LOCKED: '这组交易已关联贷款，请前往贷款管理整组处理',
  OPERATION_UNCONFIRMED: '上次操作结果仍待核实，请恢复原请求',
  ACCOUNT_INACTIVE: '账户已停用',
  AUTH_REQUIRED: '未取得可信微信身份',
  CONFLICT: '数据已发生变化，请刷新后重试',
  IDEMPOTENCY_CONFLICT: '重复请求与首次内容不一致',
  INSUFFICIENT_CASH_BALANCE: '现金账户余额不足',
  INITIALIZATION_REQUIRED: '请先初始化招财猫记账本',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  INVALID_REQUEST: '请求中不能包含用户身份',
  NOT_FOUND: '未找到可用数据',
  REFUND_EXCEEDS_ORIGINAL: '退款金额超过原支出剩余可退金额',
  REFUNDED_TRANSACTION_LOCKED: '这笔支出已有退款，请先处理关联退款',
  SERVICE_NOT_CONFIGURED: '招财猫记账本数据库尚未配置',
  SERVICE_TEMPORARY_UNAVAILABLE: '服务连接短暂中断，请重试',
  UNSUPPORTED_CURRENCY: '当前只支持人民币账户',
  VALIDATION_ERROR: '请检查填写内容',
  UNSUPPORTED_ACTION: '当前操作尚未开放'
})
const PUBLIC_ERROR_CODES = new Set([
  'EXPORT_CHANGED',
  'EXPORT_EXPIRED',
  'LOAN_SOURCE_MISMATCH',
  'LOAN_PLAN_OVERALLOCATED',
  'LOAN_PLAN_EXISTS',
  'LOAN_SOURCE_TOO_LARGE',
  'LOAN_PRINCIPAL_EXCEEDED',
  'LOAN_PRINCIPAL_UNCONFIRMED',
  'LOAN_BASELINE_LOCKED',
  'LOAN_TRANSACTION_LOCKED',
  'OPERATION_UNCONFIRMED',
  'ACCOUNT_INACTIVE',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INSUFFICIENT_CASH_BALANCE',
  'INITIALIZATION_REQUIRED',
  'NOT_FOUND',
  'REFUND_EXCEEDS_ORIGINAL',
  'REFUNDED_TRANSACTION_LOCKED',
  'SERVICE_NOT_CONFIGURED',
  'SERVICE_TEMPORARY_UNAVAILABLE',
  'UNSUPPORTED_CURRENCY',
  'VALIDATION_ERROR'
])

function inspectClientData(event) {
  const pending = [event]
  const visited = new Set()
  let inspected = 0
  while (pending.length > 0) {
    const value = pending.pop()
    if (!value || typeof value !== 'object' || visited.has(value)) {
      continue
    }
    visited.add(value)
    inspected += 1
    if (inspected > 1000) return 'too-complex'

    if (IDENTITY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
      return 'identity'
    }
    for (const child of Object.values(value)) pending.push(child)
  }
  return null
}

function hashWechatSubject(openid) {
  return crypto
    .createHash('sha256')
    .update(`wechat-mini:${openid}`, 'utf8')
    .digest('hex')
}

function failure(code) {
  return {
    ok: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] || ERROR_MESSAGES.INTERNAL_ERROR
    }
  }
}

function traceIdFromContext(context) {
  const value = context && (context.request_id || context.requestId)
  return typeof value === 'string' && value.length <= 128 ? value : 'unavailable'
}

function writeLog(logger, level, entry) {
  const method = logger && typeof logger[level] === 'function'
    ? logger[level]
    : logger && typeof logger.log === 'function' ? logger.log : null
  if (method) method.call(logger, entry)
}

function createHandler({ getWxContext, repository, services = {}, logger = console, now = Date.now, slowThresholdMs = 1000 }) {
  return async function handler(event = {}, context = {}) {
    const startedAt = now()
    const action = event.action
    const actionHandler = action === 'bootstrap'
      ? repository && repository.bootstrap
      : services[action]

    if (action !== 'bootstrap' && typeof actionHandler !== 'function') {
      return failure('UNSUPPORTED_ACTION')
    }

    const publicData = event.data && typeof event.data === 'object'
      ? event.data
      : {}

    const clientDataIssue = inspectClientData(publicData)
    if (clientDataIssue) {
      return failure(clientDataIssue === 'identity' ? 'INVALID_REQUEST' : 'VALIDATION_ERROR')
    }

    try {
      const { OPENID } = getWxContext() || {}
      if (!OPENID) {
        return failure('AUTH_REQUIRED')
      }

      const identity = {
        provider: 'wechat-mini',
        subjectHash: hashWechatSubject(OPENID)
      }

      let response
      if (action === 'bootstrap') {
        const result = await actionHandler(identity)
        response = {
          ok: true,
          data: {
            initialized: true,
            uid: result.uid,
            isNewUser: result.isNewUser,
            categories: result.categories
          }
        }
      } else {
        const result = await actionHandler({
          ...identity,
          data: publicData
        })
        response = { ok: true, data: result }
      }
      const elapsedMs = Math.max(0, now() - startedAt)
      if (elapsedMs >= slowThresholdMs) {
        writeLog(logger, 'warn', {
          event: 'catledger-api-slow',
          action: typeof action === 'string' ? action : 'invalid',
          traceId: traceIdFromContext(context),
          elapsedMs
        })
      }
      return response
    } catch (error) {
      const code = PUBLIC_ERROR_CODES.has(error.publicCode)
        ? error.publicCode
        : isRetryableDatabaseError(error) ? 'SERVICE_TEMPORARY_UNAVAILABLE' : 'INTERNAL_ERROR'
      writeLog(logger, 'error', {
        event: 'catledger-api-failure',
        action: typeof action === 'string' ? action : 'invalid',
        traceId: traceIdFromContext(context),
        code,
        databaseCode: databaseErrorCode(error) || undefined,
        elapsedMs: Math.max(0, now() - startedAt)
      })
      return failure(code)
    }
  }
}

module.exports = {
  createHandler,
  hashWechatSubject,
  traceIdFromContext
}
