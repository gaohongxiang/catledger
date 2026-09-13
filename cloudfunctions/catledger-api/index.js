const cloud = require('wx-server-sdk')

const { createLoanService } = require('./src/loan-service')
const { createDataExportService } = require('./src/data-export-service')

const { createAccountService } = require('./src/account-service')
const { createActionHandlers } = require('./src/action-registry')
const { createCategoryService } = require('./src/category-service')
const { createCatalogService } = require('./src/catalog-service')
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
const loanService = createLoanService({ getPool })
const dataExportService = createDataExportService({ getPool })
const accountService = createAccountService({ getPool })
const categoryService = createCategoryService({ getPool })
const catalogService = createCatalogService({ getPool })
const transactionService = createTransactionService({ getPool })

const handler = createHandler({
  getWxContext: () => cloud.getWXContext(),
  repository,
  services: createActionHandlers({ accountService, categoryService, catalogService, transactionService, loanService, dataExportService }),
  logger: console
})

exports.main = (event, context) => handler(event, context)
