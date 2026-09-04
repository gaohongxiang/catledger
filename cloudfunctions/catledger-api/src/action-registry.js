const PUBLIC_ACTIONS = Object.freeze([
  'bootstrap',
  'accounts.archive',
  'accounts.correctBalance',
  'accounts.create',
  'accounts.createBatch',
  'accounts.list',
  'accounts.update',
  'categories.archive',
  'categories.assignTransactions',
  'categories.create',
  'categories.list',
  'categories.unclassified',
  'categories.reorder',
  'categories.restore',
  'categories.update',
  'dashboard.get',
  'statistics.get',
  'transactions.create',
  'transactions.delete',
  'transactions.list',
  'transactions.linkRefund',
  'transactions.refundable',
  'transactions.update'
])

function createActionHandlers({ accountService, categoryService, transactionService }) {
  return {
    'accounts.archive': accountService.archive,
    'accounts.correctBalance': accountService.correctBalance,
    'accounts.create': accountService.create,
    'accounts.createBatch': accountService.createBatch,
    'accounts.list': accountService.list,
    'accounts.update': accountService.update,
    'categories.archive': categoryService.archive,
    'categories.assignTransactions': categoryService.assignTransactions,
    'categories.create': categoryService.create,
    'categories.list': categoryService.list,
    'categories.unclassified': categoryService.unclassified,
    'categories.reorder': categoryService.reorder,
    'categories.restore': categoryService.restore,
    'categories.update': categoryService.update,
    'dashboard.get': transactionService.dashboard,
    'statistics.get': transactionService.statistics,
    'transactions.create': transactionService.create,
    'transactions.delete': transactionService.remove,
    'transactions.list': transactionService.list,
    'transactions.linkRefund': transactionService.linkRefund,
    'transactions.refundable': transactionService.refundable,
    'transactions.update': transactionService.update
  }
}

module.exports = { PUBLIC_ACTIONS, createActionHandlers }
