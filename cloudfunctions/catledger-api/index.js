const cloud = require('wx-server-sdk')

const { createAccountService } = require('./src/account-service')
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
const transactionService = createTransactionService({ getPool, accountService })

exports.main = createHandler({
  getWxContext: () => cloud.getWXContext(),
  repository,
  services: {
    'accounts.archive': accountService.archive,
    'accounts.correctBalance': accountService.correctBalance,
    'accounts.create': accountService.create,
    'accounts.list': accountService.list,
    'accounts.update': accountService.update,
    'categories.archive': categoryService.archive,
    'categories.create': categoryService.create,
    'categories.list': categoryService.list,
    'categories.reorder': categoryService.reorder,
    'categories.restore': categoryService.restore,
    'categories.update': categoryService.update,
    'dashboard.get': transactionService.dashboard,
    'statistics.get': transactionService.statistics,
    'transactions.create': transactionService.create,
    'transactions.delete': transactionService.remove,
    'transactions.list': transactionService.list,
    'transactions.refundable': transactionService.refundable,
    'transactions.update': transactionService.update
  },
  logger: console
})
