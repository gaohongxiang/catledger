// 账户合计的唯一真源。dashboard.get 与 accounts.list 都必须只走 accountTotals()，不得各自累加或拼字段。
//
// 口径（2026-11-09 定稿，2026-11-11 收敛为单一出口）：
//   净资产 = 所有「未归档」账户的资产合计 − 负债合计
//   · 资产账户取账面余额 bookBalanceMinor（含负余额，负余额即透支/待校正，照实相减）
//   · 负债账户取欠款 debtMinor（账单本期应还 + 未来未到期分期本息），不用账面净额
//   · 归档（archived）账户历史账目仍保留，但钱已不在账上，不计入净资产
//   · liabilitiesInterestMinor：所有未归档负债账户的全期分期总利息合计（含已还），只作展示，不参与净资产
//
// 返回结构（accountTotals）就是前端 totals 的契约，字段固定、含义稳定：
//   { assetsMinor, liabilitiesMinor, netWorthMinor, liabilitiesInterestMinor }
// 金额一律 BigInt/字符串，避免浮点误差。

function accountTotals(accounts) {
  let assets = 0n
  let liabilities = 0n
  let liabilitiesInterest = 0n
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account || account.archived) continue
    if (account.nature === 'liability') {
      liabilities += account.debtMinor == null ? 0n : BigInt(account.debtMinor)
      // 全期总利息（含已还）由账户装配层的 installmentTotalInterestMinor 提供；缺失按 0。
      if (account.installmentTotalInterestMinor != null) liabilitiesInterest += BigInt(account.installmentTotalInterestMinor)
    } else {
      assets += BigInt(account.bookBalanceMinor || '0')
    }
  }
  return {
    assetsMinor: assets.toString(),
    liabilitiesMinor: liabilities.toString(),
    netWorthMinor: (assets - liabilities).toString(),
    liabilitiesInterestMinor: liabilitiesInterest.toString()
  }
}

// 兼容旧调用：只取净资产三项时用（保留原函数签名，内部走 accountTotals，杜绝第二套算法）。
function netWorthTotals(accounts) {
  const totals = accountTotals(accounts)
  return { assetsMinor: totals.assetsMinor, liabilitiesMinor: totals.liabilitiesMinor, netWorthMinor: totals.netWorthMinor }
}

module.exports = { accountTotals, netWorthTotals }
