// 负债占比与分期利息统计的唯一真源（统计页「负债与分期」区块）。
//
// 口径（与 net-worth.js / 贷款页对齐）：
//   · 只算「未归档」负债账户；欠款取 account.debtMinor（账单本期应还 + 未来未到期分期本息），与账户页/首页负债一致。
//   · 各卡负债占比 = 该卡欠款 / 全部负债合计（负债合计为 0 时各项占比记 0，不产生除零）。
//   · 分期利息取 account.installmentTotalInterestMinor（所有生效分期计划的全期总利息，含已还）。
//     利息占比 = 该卡分期利息 / 全部负债账户分期利息合计。
//   · 已还利息按「全期总利息 − 未还利息期次」推导（installment-service.paidInterestByAccount），只用来把
//     总利息拆成「已还 / 待付」，两块之和仍等于该卡全期总利息，避免出现第三套口径。
//
// 占比以 basis points（万分比）返回整数，避免浮点；前端只格式化、不再累加或重新相除。

function bp(amount, total) {
  if (total <= 0n) return 0
  return Number((amount * 10000n + total / 2n) / total)
}

// 返回 { liabilities: { ... } }，与 statistics() 的其它分块同形，便于响应里平铺展开。
function liabilitySummary(accounts, paidInterestByAccount) {
  const paid = paidInterestByAccount instanceof Map ? paidInterestByAccount : new Map()
  const rows = []
  let debtTotal = 0n
  let interestTotal = 0n
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || account.archived || account.nature !== 'liability') continue
    const debt = account.debtMinor == null ? 0n : BigInt(account.debtMinor)
    const interest = account.installmentTotalInterestMinor == null ? 0n : BigInt(account.installmentTotalInterestMinor)
    const paidInterest = paid.has(account.accountId) ? BigInt(paid.get(account.accountId)) : 0n
    debtTotal += debt
    interestTotal += interest
    rows.push({ accountId: account.accountId, name: account.name, type: account.type, debtMinor: debt, interestMinor: interest, paidInterestMinor: paidInterest })
  }
  rows.sort((a, b) => a.debtMinor === b.debtMinor ? String(a.accountId).localeCompare(String(b.accountId)) : a.debtMinor > b.debtMinor ? -1 : 1)
  let paidTotal = 0n
  for (const row of rows) paidTotal += row.paidInterestMinor
  return {
    liabilities: {
      debtTotalMinor: debtTotal.toString(),
      interestTotalMinor: interestTotal.toString(),
      paidInterestTotalMinor: paidTotal.toString(),
      accounts: rows.map((row) => ({
        accountId: row.accountId,
        name: row.name,
        type: row.type,
        debtMinor: row.debtMinor.toString(),
        debtShareBasisPoints: bp(row.debtMinor, debtTotal),
        interestMinor: row.interestMinor.toString(),
        interestShareBasisPoints: bp(row.interestMinor, interestTotal),
        paidInterestMinor: row.paidInterestMinor.toString(),
        // 待付利息 = 全期总利息 − 已还，最小 0，避免个别历史数据让已还大于全期时出现负数。
        unpaidInterestMinor: (row.interestMinor > row.paidInterestMinor ? row.interestMinor - row.paidInterestMinor : 0n).toString()
      }))
    }
  }
}

module.exports = { liabilitySummary }
