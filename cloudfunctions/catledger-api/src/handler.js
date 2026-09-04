const crypto = require('node:crypto')
const { databaseErrorCode, isRetryableDatabaseError } = require('./database-errors')

const IDENTITY_FIELDS = ['uid', 'openid', 'openId', 'OPENID']

const ERROR_MESSAGES = Object.freeze({
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
