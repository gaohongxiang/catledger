const PUBLIC_ACTIONS = Object.freeze([
  'imports.commandResult',
  'financeUpdates.rows',
  'reviewIssues.members',
  'financeUpdates.options',
  'financeUpdates.summary',
  'financeUpdates.list',
  'economicEvents.detail',
  'economicEvents.list',
  'economicEvents.correct',
  'economicEvents.correctionImpact',
  'economicEvents.evidence',
  'financeUpdates.abandon',
  'financeUpdates.organize',
  'financeUpdates.prepare',
  'financeUpdates.post',
  'financeUpdates.undo',
  'financeUpdates.undoImpact',
  'imports.discardFile',
  'imports.getFile',
  'imports.parseFile',
  'imports.prepareMany',
  'reviewIssues.get',
  'reviewIssues.refreshAccountGroups',
  'reviewIssues.list',
  'reviewIssues.resolveAccountMappings',
  'reviewIssues.resolve'
])

function createActionHandlers(service) {
  return {
    'imports.commandResult': service.commandResult,
    'financeUpdates.rows': service.financeUpdateRows,
    'reviewIssues.members': service.reviewIssueMembers,
    'financeUpdates.options': service.financeUpdateOptions,
    'financeUpdates.summary': service.financeUpdateSummary,
    'financeUpdates.list': service.financeUpdateList,
    'economicEvents.detail': service.economicEventDetail,
    'economicEvents.list': service.economicEventList,
    'economicEvents.correct': service.economicEventCorrect,
    'economicEvents.correctionImpact': service.economicEventCorrectionImpact,
    'economicEvents.evidence': service.economicEventEvidence,
    'financeUpdates.abandon': service.financeUpdateAbandon,
    'financeUpdates.organize': service.financeUpdateOrganize,
    'financeUpdates.prepare': service.financeUpdatePrepare,
    'financeUpdates.post': service.financeUpdatePost,
    'financeUpdates.undo': service.financeUpdateUndo,
    'financeUpdates.undoImpact': service.financeUpdateUndoImpact,
    'imports.discardFile': service.discardFile,
    'imports.getFile': service.getFile,
    'imports.parseFile': service.parseFile,
    'imports.prepareMany': service.prepareMany,
    'reviewIssues.get': service.reviewIssueGet,
    'reviewIssues.refreshAccountGroups': service.reviewIssueRefreshAccountGroups,
    'reviewIssues.list': service.reviewIssueList,
    'reviewIssues.resolveAccountMappings': service.reviewIssueResolveAccountMappings,
    'reviewIssues.resolve': service.reviewIssueResolve
  }
}

module.exports = {
  PUBLIC_ACTIONS,
  createActionHandlers
}
