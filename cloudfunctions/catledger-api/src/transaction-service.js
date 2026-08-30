const { createReportingService, monthSequence } = require('./reporting-service')
const { createTransactionCommandService } = require('./transaction-command-service')
const { buildManualTransaction, transactionToPublic } = require('./transaction-domain')
const { createTransactionQueryService, normalizeListFilters } = require('./transaction-query-service')

function createTransactionService({ getPool }) {
  const commands = createTransactionCommandService({ getPool })
  const queries = createTransactionQueryService({ getPool })
  const reporting = createReportingService({ getPool })

  return {
    create: commands.create,
    dashboard: reporting.dashboard,
    list: queries.list,
    refundable: queries.refundable,
    remove: commands.remove,
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
