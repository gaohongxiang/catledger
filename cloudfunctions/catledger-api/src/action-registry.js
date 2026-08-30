const PUBLIC_ACTIONS = Object.freeze([
  'bootstrap',
  'accounts.archive',
  'accounts.correctBalance',
  'accounts.create',
  'accounts.list',
  'accounts.update',
  'categories.archive',
  'categories.create',
  'categories.list',
  'categories.reorder',
  'categories.restore',
  'categories.update',
  'dashboard.get',
  'statistics.get',
  'transactions.create',
  'transactions.delete',
  'transactions.list',
  'transactions.refundable',
  'transactions.update'
])

function createActionHandlers({ accountService, categoryService, transactionService }) {
  return {
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
  }
}

module.exports = { PUBLIC_ACTIONS, createActionHandlers }
