const crypto = require('node:crypto')

const IDENTITY_FIELDS = ['uid', 'openid', 'openId', 'OPENID']

const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: '未取得可信微信身份',
  INTERNAL_ERROR: '服务暂时不可用，请稍后重试',
  INVALID_REQUEST: '请求中不能包含用户身份',
  SERVICE_NOT_CONFIGURED: '猫账数据库尚未配置',
  UNSUPPORTED_ACTION: '当前操作尚未开放'
})
const PUBLIC_ERROR_CODES = new Set(['SERVICE_NOT_CONFIGURED'])

function hasClientIdentity(event) {
  const candidates = [event, event && event.data]
  return candidates.some((candidate) => (
    candidate &&
    typeof candidate === 'object' &&
    IDENTITY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(candidate, field))
  ))
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

function createHandler({ getWxContext, repository, logger = console }) {
  return async function handler(event = {}) {
    const action = event.action

    if (action !== 'bootstrap') {
      return failure('UNSUPPORTED_ACTION')
    }

    if (hasClientIdentity(event)) {
      return failure('INVALID_REQUEST')
    }

    const { OPENID } = getWxContext()
    if (!OPENID) {
      return failure('AUTH_REQUIRED')
    }

    try {
      const result = await repository.bootstrap({
        provider: 'wechat-mini',
        subjectHash: hashWechatSubject(OPENID)
      })

      return {
        ok: true,
        data: {
          initialized: true,
          isNewUser: result.isNewUser,
          categories: result.categories
        }
      }
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
