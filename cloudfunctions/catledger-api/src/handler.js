const crypto = require('node:crypto')

const IDENTITY_FIELDS = ['uid', 'openid', 'openId', 'OPENID']

const ERROR_MESSAGES = Object.freeze({
  ACCOUNT_INACTIVE: '账户已停用',
  AUTH_REQUIRED: '未取得可信微信身份',
  CONFLICT: '数据已发生变化，请刷新后重试',
  IDEMPOTENCY_CONFLICT: '重复请求与首次内容不一致',
  INITIALIZATION_REQUIRED: '请先初始化招财猫记账本',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  INVALID_REQUEST: '请求中不能包含用户身份',
  NOT_FOUND: '未找到可用数据',
  REFUND_EXCEEDS_ORIGINAL: '退款金额超过原支出剩余可退金额',
  REFUNDED_TRANSACTION_LOCKED: '这笔支出已有退款，请先处理关联退款',
  SERVICE_NOT_CONFIGURED: '招财猫记账本数据库尚未配置',
  UNSUPPORTED_CURRENCY: '当前只支持人民币账户',
  VALIDATION_ERROR: '请检查填写内容',
  UNSUPPORTED_ACTION: '当前操作尚未开放'
})
const PUBLIC_ERROR_CODES = new Set([
  'ACCOUNT_INACTIVE',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INITIALIZATION_REQUIRED',
  'NOT_FOUND',
  'REFUND_EXCEEDS_ORIGINAL',
  'REFUNDED_TRANSACTION_LOCKED',
  'SERVICE_NOT_CONFIGURED',
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

function createHandler({ getWxContext, repository, services = {}, logger = console }) {
  return async function handler(event = {}) {
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

      if (action === 'bootstrap') {
        const result = await actionHandler(identity)

        return {
          ok: true,
          data: {
            initialized: true,
            isNewUser: result.isNewUser,
            categories: result.categories
          }
        }
      }

      const result = await actionHandler({
        ...identity,
        data: publicData
      })

      return { ok: true, data: result }
    } catch (error) {
      const code = PUBLIC_ERROR_CODES.has(error.publicCode)
        ? error.publicCode
        : 'INTERNAL_ERROR'
      logger.error({
        event: 'catledger-api-failure',
        code,
        databaseCode: typeof error.code === 'string' ? error.code : undefined
      })
      return failure(code)
    }
  }
}

module.exports = {
  createHandler,
  hashWechatSubject
}
