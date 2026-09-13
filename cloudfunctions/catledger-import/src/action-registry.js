const PUBLIC_ACTIONS = Object.freeze([
  'financeUpdates.rows',
  'reviewIssues.members',
  'financeUpdates.options',
  'financeUpdates.summary',
  'economicEvents.detail',
  'economicEvents.list',
  'economicEvents.correct',
  'economicEvents.correctionImpact',
  'economicEvents.evidence',
  'financeUpdates.abandon',
  'financeUpdates.get',
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
    'financeUpdates.rows': service.financeUpdateRows,
    'reviewIssues.members': service.reviewIssueMembers,
    'financeUpdates.options': service.financeUpdateOptions,
    'financeUpdates.summary': service.financeUpdateSummary,
    'economicEvents.detail': service.economicEventDetail,
    'economicEvents.list': service.economicEventList,
    'economicEvents.correct': service.economicEventCorrect,
    'economicEvents.correctionImpact': service.economicEventCorrectionImpact,
    'economicEvents.evidence': service.economicEventEvidence,
    'financeUpdates.abandon': service.financeUpdateAbandon,
    'financeUpdates.get': service.financeUpdateGet,
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
