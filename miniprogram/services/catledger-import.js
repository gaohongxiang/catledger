const cloudFunctionClient = require('./cloud-function-client')
const cache = require('./read-cache')
const { mutationTags } = require('./read-policy')

const client = cloudFunctionClient.createCloudFunctionClient({
  functionName: 'catledger-import',
  fallbackMessage: '这一步暂时没完成，已解析账单不会丢失，请重试'
})

function callImport(action, data) {
  const tags = mutationTags(action)
  return tags.length ? cache.mutate(tags, () => client.call(action, data)) : cache.guard(() => client.call(action, data))
}

module.exports = {
  callImport: callImport,
  createRequestId: cloudFunctionClient.createRequestId
}
