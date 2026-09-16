const { createCommandResult } = require('./transaction-command-result')
const { createBatchDelete } = require('./transaction-batch-delete')
const { createTransactionCategoryService } = require('./transaction-category')
const { createReportingService, monthSequence } = require('./reporting-service')
const { createTransactionCommandService } = require('./transaction-command-service')
const { buildManualTransaction, transactionToPublic } = require('./transaction-domain')
const { createTransactionQueryService, normalizeListFilters } = require('./transaction-query-service')

function createTransactionService({ getPool }) {
  const commands = createTransactionCommandService({ getPool })
  const queries = createTransactionQueryService({ getPool })
  const reporting = createReportingService({ getPool })

  return {
    commandResult: createCommandResult({ getPool }),
    setCategory: createTransactionCategoryService({ getPool }),
    create: commands.create,
    dashboard: reporting.dashboard,
    list: queries.list,
    linkRefund: commands.linkRefund,
    refundable: queries.refundable,
    remove: commands.remove,
    removeMany: createBatchDelete({ getPool }),
    statistics: reporting.statistics,
    update: commands.update
  }
}

module.exports = {
  buildManualTransaction,
  createTransactionService,
  monthSequence,
  normalizeListFilters,
  transactionToPublic
}
