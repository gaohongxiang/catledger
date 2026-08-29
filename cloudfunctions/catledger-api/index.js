const cloud = require('wx-server-sdk')

const { createAccountService } = require('./src/account-service')
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
    'dashboard.get': transactionService.dashboard,
    'statistics.get': transactionService.statistics,
    'transactions.create': transactionService.create,
    'transactions.delete': transactionService.remove,
    'transactions.list': transactionService.list,
    'transactions.update': transactionService.update
  },
  logger: console
})
