// 只释放整组撤销产生的失效计划项。用户单独取消/抑制的费用没有该标记。
async function releaseRemoved(c,uid,contractId) {
  await c.execute("UPDATE catledger_loan_charges SET state='planned',plan_removed_at=NULL,version=version+1 WHERE uid=? AND contract_id=? AND plan_removed_at IS NOT NULL",[uid,contractId])
}
module.exports={releaseRemoved}
