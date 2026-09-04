const cloud = require('wx-server-sdk')

const { createActionHandlers } = require('./src/action-registry')
const { getPool } = require('./src/database')
const { createHandler } = require('./src/handler')
const { createImportService } = require('./src/import-service')
const { createStorageGateway } = require('./src/storage-gateway')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const service = createImportService({
  getPool,
  storage: createStorageGateway(cloud)
})

const handler = createHandler({
  getWxContext: () => cloud.getWXContext(),
  services: createActionHandlers(service)
})

exports.main = (event, context) => handler(event, context)
