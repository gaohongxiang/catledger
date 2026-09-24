const { importError } = require('./errors')
const { executeIdempotentMutation } = require('./import-transaction')
const { validateUuid, validateVersion } = require('./validation')
const { validateDecision } = require('./review/policy')
const { refreshAccountGroups: refreshAccountGroupsInTransaction, resolveAccountMappings: resolveAccountMappingsInTransaction, reviseAccountMapping: reviseAccountMappingInTransaction } = require('./review/account-mapping')
const { resolve: resolveInTransaction } = require('./review/event-decisions')
const { setRepayment: setRepaymentInTransaction } = require('./review/repayment')

function createReviewIssueService({ getPool }) {
  async function refreshAccountGroups(context) {
    const updateId = validateUuid(context.data.updateId)
    validateUuid(context.data.requestId)
    const version = validateVersion(context.data.version)
    return executeIdempotentMutation({ getPool, ...context, action: 'reviewIssues.refreshAccountGroups',
      operation: async (connection, uid, data, requestDigest) => refreshAccountGroupsInTransaction(connection, uid, data, requestDigest, { updateId, version }, context.data)
    })
  }

  async function resolveAccountMappings(context) {
    const updateId = validateUuid(context.data.updateId)
    validateUuid(context.data.requestId)
    if (!Array.isArray(context.data.decisions) || context.data.decisions.length < 1 || context.data.decisions.length > 50) {
      throw importError('VALIDATION_ERROR')
    }
    const decisions = context.data.decisions.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw importError('VALIDATION_ERROR')
      const operation = item.operation
      if (!['resolve', 'revise'].includes(operation)) throw importError('VALIDATION_ERROR')
      const decision = item.decision
      if (!['apply_fields', 'exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
      return {
        issueId: validateUuid(item.issueId),
        issueVersion: validateVersion(item.issueVersion),
        operation,
        decision,
        fields: item.fields,
        paymentRuleAction: item.paymentRuleAction
      }
    })
    if (new Set(decisions.map((item) => item.issueId)).size !== decisions.length) {
      throw importError('VALIDATION_ERROR')
    }

    return executeIdempotentMutation({       getPool,
      ...context,
      action: 'reviewIssues.resolveAccountMappings',
      operation: (connection, uid, data, requestDigest) => resolveAccountMappingsInTransaction(connection, uid, data, requestDigest, { updateId, decisions }, context.data)
    })
  }

  async function setRepayment(context) {
    const updateId = validateUuid(context.data.updateId), eventId = validateUuid(context.data.eventId)
    const updateVersion = validateVersion(context.data.updateVersion), eventVersion = validateVersion(context.data.eventVersion)
    return executeIdempotentMutation({ getPool,...context,action:'financeUpdates.setRepayment',
      operation:async (connection,uid,data,requestDigest) => setRepaymentInTransaction(connection, uid, data, requestDigest, { updateId, eventId, updateVersion, eventVersion }) })
  }

  async function resolve(context) {
    const updateId = validateUuid(context.data.updateId)
    const issueId = validateUuid(context.data.issueId)
    const updateVersion = validateVersion(context.data.updateVersion)
    const issueVersion = validateVersion(context.data.issueVersion)
    const decision = validateDecision(context.data.decision)
    return executeIdempotentMutation({       getPool,
      ...context,
      action: 'reviewIssues.resolve',
      operation: async (connection, uid, data, requestDigest) => resolveInTransaction(connection, uid, data, requestDigest, { updateId, issueId, updateVersion, issueVersion, decision })
    })
  }

  async function reviseAccountMapping(context) {
    const updateId = validateUuid(context.data.updateId)
    const issueId = validateUuid(context.data.issueId)
    const updateVersion = validateVersion(context.data.updateVersion)
    const issueVersion = validateVersion(context.data.issueVersion)
    const decision = context.data.decision
    if (!['apply_fields', 'exclude_events'].includes(decision)) throw importError('VALIDATION_ERROR')
    return executeIdempotentMutation({       getPool,
      ...context,
      action: 'reviewIssues.reviseAccountMapping',
      operation: async (connection, uid, data, requestDigest) => reviseAccountMappingInTransaction(connection, uid, data, requestDigest, { updateId, issueId, updateVersion, issueVersion, decision }, context.data)
    })
  }

  return { setRepayment, resolve, resolveAccountMappings, reviseAccountMapping, refreshAccountGroups }
}

module.exports = { createReviewIssueService }
