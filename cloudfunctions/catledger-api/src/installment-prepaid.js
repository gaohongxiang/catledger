// 一次性费用已从资产账户实付时，逐期分摊用于核对，不能再次当作待付款。
async function prepaidFees(c,uid,ids){
 if(!ids.length)return []
 const [rows]=await c.execute(`SELECT k.loan_id AS loanId,child.period_number AS periodNumber,child.amount_minor AS amountMinor
  FROM catledger_loan_charges child JOIN catledger_loan_charge_contracts k ON k.uid=child.uid AND k.contract_id=child.contract_id
  JOIN catledger_loan_charges parent ON parent.uid=child.uid AND parent.charge_id=child.covered_by_charge_id AND parent.state='recorded'
  JOIN catledger_transactions t ON t.uid=parent.uid AND t.transaction_id=parent.transaction_id AND t.deleted_at IS NULL
  JOIN catledger_accounts a ON a.uid=t.uid AND a.account_id=t.source_account_id
  WHERE child.uid=? AND k.loan_id IN (${ids.map(()=>'?').join(',')}) AND child.state='covered' AND child.component='fee'
    AND a.type IN ('cash','bank','wallet','other_asset')`,[uid,...ids])
 return rows
}
module.exports={prepaidFees}
