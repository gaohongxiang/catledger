// 场景断言专用读取器：写入始终调用当前小回执API，随后逐页收集用于核对的小型合成夹具。
// 不在运行代码中提供全集接口；性能/回执冻结测试直接使用真实service，不经过本读取器。
const { createImportService } = require('../../src/import-service')
function createScenarioService(options) {
  const service = createImportService(options)
  const withData = (context, data) => ({ ...context, data })
  async function pages(method, context, data) {
    let cursor = null, version, rows = []
    do {
      const page = await service[method](withData(context, { ...data, pageSize: 100, cursor, viewVersion: version }))
      rows.push(...page.items); cursor = page.nextCursor; version = page.viewVersion
    } while (cursor)
    return rows
  }
  async function directory(context, updateId) {
    const result = {}
    for (const kind of ['accounts', 'categories', 'accountDrafts']) result[kind] = await pages('financeUpdateOptions', context, { updateId, kind })
    return result
  }
  async function view(context) {
    const summary = await service.financeUpdateSummary(context), updateId = summary.update.updateId
    const issues = await pages('reviewIssueList', context, { updateId })
    for (const issue of issues) {
      const members = await pages('reviewIssueMembers', context, { updateId, issueId: issue.issueId })
      issue.subjectEventIds = members.filter(m => m.objectType === 'event' && m.memberRole !== 'candidate').map(m => m.objectId)
    }
    return { ...summary, issues, events: await pages('economicEventList', context, { updateId }),
      ...await directory(context, updateId), accountMappingDrafts: [],
      freshness: { ...summary.freshness, viewRevision: summary.viewVersion } }
  }
  async function issue(context) {
    const detail = await service.reviewIssueGet(context), updateId = detail.update.updateId
    return { ...detail, members: await pages('reviewIssueMembers', context, { updateId, issueId: context.data.issueId }),
      ...await directory(context, updateId) }
  }
  const result = { ...service, financeUpdateGet: view, reviewIssueGet: issue,
    reviewIssueList: async context => ({ issues: await pages('reviewIssueList', context, context.data) }),
    economicEventEvidence: async context => {
      const evidence = await pages('economicEventEvidence', context, context.data)
      for (const row of evidence) {
        let cursor = null, raw = ''
        do {
          const part = await service.economicEventDetail(withData(context, { ...context.data, evidenceId: row.evidenceId, cursor }))
          raw += part.part; cursor = part.nextCursor
        } while (cursor)
        row.rawFields = JSON.parse(raw)
      }
      return { evidence }
    } }
  for (const method of ['financeUpdatePrepare','financeUpdateOrganize','financeUpdatePost','financeUpdateUndo',
    'economicEventCorrect','reviewIssueResolve','reviewIssueResolveAccountMappings','reviewIssueReviseAccountMapping','reviewIssueRefreshAccountGroups']) {
    result[method] = async context => {
      let data = { ...context.data }
      if (method === 'reviewIssueResolveAccountMappings') {
        const summary = await service.financeUpdateSummary(withData(context, { updateId: data.updateId }))
        if (data.updateVersion == null) data.updateVersion = summary.update.version
        data.decisions = await Promise.all(data.decisions.map(async choice => {
          if (choice.issueVersion != null) return choice
          const detail = await service.reviewIssueGet(withData(context, { issueId: choice.issueId }))
          return { ...choice, issueVersion: detail.issue.version }
        }))
      }
      const receipt = await service[method](withData(context, data))
      const current = await view(withData(context, { updateId: receipt.updateId }))
      if (method.startsWith('reviewIssue') && data.issueId) {
        if (!current.issues.some(item => item.issueId === data.issueId)) return { ...current, issue: null, members: [] }
        return { ...current, ...await issue(withData(context, { issueId: data.issueId })) }
      }
      return current
    }
  }
  return result
}
module.exports = { createScenarioService }
