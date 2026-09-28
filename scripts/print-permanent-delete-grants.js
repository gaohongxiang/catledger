// 只生成授权 SQL，不连接数据库、不自动执行。部署时使用已核实的 API 运行账号。
const TABLES = Object.freeze(['catledger_transactions', 'catledger_economic_event_transactions', 'catledger_review_issue_members'])
function statements({ database, user, host }) {
  if (![database, user].every(value => typeof value === 'string' && /^[a-zA-Z0-9_]+$/.test(value)) ||
      typeof host !== 'string' || !/^[a-zA-Z0-9._%:-]+$/.test(host)) throw new Error('需要明确且合法的 database、user、host')
  return TABLES.map(table => `GRANT DELETE ON \`${database}\`.\`${table}\` TO '${user}'@'${host}';`)
}
if (require.main === module) {
  const [database, user, host] = process.argv.slice(2)
  process.stdout.write(statements({ database, user, host }).join('\n') + '\n')
}
module.exports = { statements, TABLES }
