const RUNTIME_PERMISSION_REQUIREMENTS = Object.freeze([
  Object.freeze({
    table: 'catledger_finance_update_sources',
    privilege: 'UPDATE',
    columns: Object.freeze([]),
    reason: 'SELECT ... FOR UPDATE 锁定来源归属'
  }),
  Object.freeze({
    table: 'catledger_import_transaction_links',
    privilege: 'UPDATE',
    columns: Object.freeze([]),
    reason: 'SELECT ... FOR UPDATE 锁定既有交易链接'
  }),
  Object.freeze({
    table: 'catledger_review_issue_members',
    privilege: 'UPDATE',
    columns: Object.freeze(['object_version']),
    reason: '账户归属批处理同步 ReviewIssueMember 的事件版本'
  })
])

function unquoteIdentifier(value) {
  return String(value || '').replaceAll('`', '').trim().toLowerCase()
}

function targetTable(grant) {
  const match = String(grant || '').match(/\sON\s+([^\s]+)\s+TO\s+/i)
  if (!match) return ''
  const target = unquoteIdentifier(match[1])
  return target.split('.').pop()
}

function privilegeClause(grant) {
  const match = String(grant || '').match(/^GRANT\s+(.+?)\s+ON\s+/i)
  return match ? match[1] : ''
}

function grantedColumns(grant, privilege) {
  const clause = privilegeClause(grant)
  const expression = new RegExp(`(?:^|,\\s*)${privilege}(?:\\s*\\(([^)]*)\\))?(?=\\s*,|$)`, 'i')
  const match = clause.match(expression)
  if (!match) return null
  if (match[1] == null) return '*'
  return new Set(match[1].split(',').map(unquoteIdentifier).filter(Boolean))
}

function grantSatisfies(grant, requirement) {
  if (targetTable(grant) !== requirement.table.toLowerCase()) return false
  const columns = grantedColumns(grant, requirement.privilege)
  if (!columns) return false
  if (columns === '*') return true
  return requirement.columns.length > 0 && requirement.columns.every((column) => columns.has(column.toLowerCase()))
}

function missingRuntimePermissions(grants, requirements = RUNTIME_PERMISSION_REQUIREMENTS) {
  const grantLines = Array.isArray(grants) ? grants.map(String) : []
  return requirements.filter((requirement) => !grantLines.some((grant) => grantSatisfies(grant, requirement)))
}

function assertRuntimePermissions(grants) {
  const missing = missingRuntimePermissions(grants)
  if (!missing.length) return
  const details = missing.map((requirement) => {
    const columns = requirement.columns.length ? `(${requirement.columns.join(',')})` : ''
    return `${requirement.privilege}${columns} ON ${requirement.table}`
  })
  const error = new Error(`Missing Catledger runtime database privileges: ${details.join('; ')}`)
  error.code = 'CATLEDGER_DB_PERMISSION_MISSING'
  error.missing = missing
  throw error
}

module.exports = {
  RUNTIME_PERMISSION_REQUIREMENTS,
  assertRuntimePermissions,
  missingRuntimePermissions
}
