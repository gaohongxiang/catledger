const cloudFunctionClient = require('./cloud-function-client')

const client = cloudFunctionClient.createCloudFunctionClient({
  functionName: 'catledger-api',
  fallbackMessage: '服务暂时不可用，请稍后重试'
})

function callApi(action, data) {
  return client.call(action, data)
}

function bootstrapInternal() {
  return client.callInternal('bootstrap', {}, '账本初始化失败')
}

function bootstrap() {
  return client.call('bootstrap', {})
}

function bootstrapAfterConsent() {
  return bootstrapInternal()
}

module.exports = {
  bootstrap: bootstrap,
  callApi: callApi,
  createRequestId: cloudFunctionClient.createRequestId,
  bootstrapAfterConsent: bootstrapAfterConsent
}
