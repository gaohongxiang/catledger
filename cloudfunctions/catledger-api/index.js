const cloud = require('wx-server-sdk')

const { getPool } = require('./src/database')
const { createHandler } = require('./src/handler')
const { createUserRepository } = require('./src/user-repository')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const repository = createUserRepository({
  getPool
})

exports.main = createHandler({
  getWxContext: () => cloud.getWXContext(),
  repository,
  logger: console
})
