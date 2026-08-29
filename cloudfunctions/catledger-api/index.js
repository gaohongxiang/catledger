const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

exports.main = async (event = {}) => {
  if (event.action !== 'health') {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_ACTION',
        message: '当前操作尚未开放'
      }
    }
  }

  const { OPENID } = cloud.getWXContext()

  return {
    ok: true,
    data: {
      authenticated: Boolean(OPENID),
      service: 'catledger-api',
      version: '0.1.0'
    }
  }
}
