const cloud = require('wx-server-sdk')

const { createAccountService } = require('./src/account-service')
const { createActionHandlers } = require('./src/action-registry')
const { createCategoryService } = require('./src/category-service')
const { getPool } = require('./src/database')
const { createHandler } = require('./src/handler')
const { createUserRepository } = require('./src/user-repository')
const { createTransactionService } = require('./src/transaction-service')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const repository = createUserRepository({
  getPool
})
const accountService = createAccountService({ getPool })
const categoryService = createCategoryService({ getPool })
const transactionService = createTransactionService({ getPool })

const handler = createHandler({
  getWxContext: () => cloud.getWXContext(),
  repository,
  services: createActionHandlers({ accountService, categoryService, transactionService }),
  logger: console
})

exports.main = (event, context) => handler(event, context)
