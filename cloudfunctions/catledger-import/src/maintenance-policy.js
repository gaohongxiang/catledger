const MAINTENANCE_POLICY_VERSION = 'import-maintenance-v2'
function accountImpacts(before, after) {
  const amounts = new Map()
  for (const [side, transactions] of [['oldMinor', before], ['newMinor', after]]) {
    for (const transaction of transactions) {
      for (const [id, sign] of [[transaction.sourceAccountId, -1n], [transaction.destinationAccountId, 1n]]) {
        if (!id) continue
        const value = amounts.get(id) || { oldMinor: 0n, newMinor: 0n }
        value[side] += BigInt(transaction.amountMinor) * sign
        amounts.set(id, value)
      }
    }
  }
  return [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([accountId, value]) => ({
    accountId, oldMinor: String(value.oldMinor), newMinor: String(value.newMinor), deltaMinor: String(value.newMinor - value.oldMinor)
  }))
}
function cashDeficits(impacts, accounts) {
  const byId = new Map(accounts.map((account) => [account.accountId, account]))
  return impacts.filter((impact) => {
    const account = byId.get(impact.accountId)
    if (!account || account.type !== 'cash') return false
    const before = BigInt(account.balanceMinor), after = before + BigInt(impact.deltaMinor)
    return after < 0n && after < before
  }).map((impact) => impact.accountId)
}
function reversibleMappings(saved, current, independentlyUsed) {
  const byId = new Map(current.map((row) => [row.mappingId, row]))
  const revert = [], retain = []
  for (const item of saved || []) {
    const row = byId.get(item.after.mappingId)
    if (row && Number(row.version) === Number(item.after.version) && !independentlyUsed.has(row.mappingId)) revert.push(item)
    else retain.push(item)
  }
  return { revert, retain }
}
module.exports = { MAINTENANCE_POLICY_VERSION, accountImpacts, cashDeficits, reversibleMappings }
