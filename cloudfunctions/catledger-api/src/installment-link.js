const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { validateId } = require('./transaction-domain')
const { ITEM_SELECT, publicItem, canonicalItem, assertCostSource } = require('./installment-items')

async function collapseDuplicate(c,uid,item,canonical) {
  if (!item.transactionId || item.transactionId===canonical.transactionId) return
  const [[dependencies]]=await c.execute(`SELECT
    EXISTS(SELECT 1 FROM catledger_transactions WHERE uid=? AND original_transaction_id=? AND deleted_at IS NULL) AS refunds,
    EXISTS(SELECT 1 FROM catledger_loan_payment_transactions WHERE uid=? AND transaction_id=? AND active=1) AS payments`,
    [uid,item.transactionId,uid,item.transactionId])
  if (Number(dependencies.refunds) || Number(dependencies.payments)) throw ledgerError('LOAN_TRANSACTION_LOCKED')
  const [links]=await c.execute(`SELECT update_id AS updateId,event_id AS eventId,role FROM catledger_economic_event_transactions
    WHERE uid=? AND transaction_id=? AND superseded_at IS NULL`,[uid,item.transactionId])
  await c.execute(`UPDATE catledger_economic_event_transactions SET superseded_at=CURRENT_TIMESTAMP(3)
    WHERE uid=? AND transaction_id=? AND superseded_at IS NULL`,[uid,item.transactionId])
  for (const link of links) await c.execute(`INSERT INTO catledger_economic_event_transactions
    (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version)
    VALUES (?,?,?,?,?,?,'reused','installment-link-v1',?)`,[uid,randomUUID(),link.updateId,link.eventId,canonical.transactionId,link.role,canonical.transactionVersion])
  const [changed]=await c.execute(`UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1
    WHERE uid=? AND transaction_id=? AND version=? AND deleted_at IS NULL`,[uid,item.transactionId,item.transactionVersion])
  if (changed.affectedRows!==1) throw ledgerError('CONFLICT')
  await c.execute(`UPDATE catledger_installment_items SET transaction_id=?,canonical=0,version=version+1 WHERE uid=? AND transaction_id=?`,
    [canonical.transactionId,uid,item.transactionId])
}
// 删除后，同一费用的手动/导入来源可能同时待关联。沿明确编号或同一交易收集，
// 不能让一笔已入账费用留在另一个待建分期里；不按金额、日期猜测关联。
async function sourceGroup(c,uid,loan,source) {
  const items=new Map(),references=new Set(),transactions=new Set()
  let referenceKeys=source.referenceKey?[source.referenceKey]:[],transactionIds=source.transactionId?[source.transactionId]:[],first=true
  while (first || referenceKeys.length || transactionIds.length) {
    const filters=[],values=[uid,loan.accountId]
    if(first){filters.push('i.item_id=?');values.push(source.itemId)}
    for(const [column,keys] of [['reference_key',referenceKeys],['transaction_id',transactionIds]]) {
      if(keys.length){filters.push(`i.${column} IN (${keys.map(()=>'?').join(',')})`);values.push(...keys)}
    }
    referenceKeys.forEach(key=>references.add(key));transactionIds.forEach(id=>transactions.add(id))
    const [rows]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.account_id=? AND i.active=1 AND (${filters.join(' OR ')})
      ORDER BY i.period_number,i.created_at,i.item_id LIMIT 3601 FOR UPDATE`,values)
    if(rows.length>3600)throw ledgerError('LOAN_SOURCE_TOO_LARGE')
    referenceKeys=[];transactionIds=[];first=false
    for(const row of rows) {
      const item=publicItem(row)
      if(!item.active || items.has(item.itemId))continue
      if(item.loanId && item.loanId!==loan.loanId)throw ledgerError('LOAN_SOURCE_MISMATCH')
      if(item.periodNumber>Number(loan.scheduleTerms) || item.totalTerms && item.totalTerms!==Number(loan.scheduleTerms))throw ledgerError('LOAN_SOURCE_MISMATCH')
      items.set(item.itemId,item)
      if(items.size>3600)throw ledgerError('LOAN_SOURCE_TOO_LARGE')
      if(item.referenceKey && !references.has(item.referenceKey)){references.add(item.referenceKey);referenceKeys.push(item.referenceKey)}
      if(item.transactionId && !transactions.has(item.transactionId)){transactions.add(item.transactionId);transactionIds.push(item.transactionId)}
    }
  }
  return {items:[...items.values()],references:[...references]}
}
async function attachSource(c,uid,loan,itemId) {
  if (loan.kind!=='installment' || !loan.scheduleTerms) throw ledgerError('VALIDATION_ERROR')
  const [[selected]]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.item_id=? FOR UPDATE',[uid,validateId(itemId)])
  if (!selected) throw ledgerError('NOT_FOUND')
  const source=publicItem(selected)
  if (!source.active || source.accountId!==loan.accountId || source.loanId && source.loanId!==loan.loanId) throw ledgerError('LOAN_SOURCE_MISMATCH')
  const group=await sourceGroup(c,uid,loan,source)
  for (const referenceKey of group.references) {
    const [[binding]]=await c.execute('SELECT loan_id AS loanId FROM catledger_installment_bindings WHERE uid=? AND account_id=? AND reference_key=?',
      [uid,loan.accountId,referenceKey])
    if (binding && binding.loanId!==loan.loanId) throw ledgerError('LOAN_SOURCE_MISMATCH')
    if (!binding) await c.execute('INSERT INTO catledger_installment_bindings (uid,account_id,reference_key,loan_id) VALUES (?,?,?,?)',
      [uid,loan.accountId,referenceKey,loan.loanId])
  }
  let count=0
  for (const item of group.items) {
    if (!item.active || item.loanId===loan.loanId) continue
    if (item.periodNumber>Number(loan.scheduleTerms) || item.totalTerms && item.totalTerms!==Number(loan.scheduleTerms)) throw ledgerError('LOAN_SOURCE_MISMATCH')
    const canonical=await canonicalItem(c,uid,loan.loanId,item.periodNumber,item.component)
    if (canonical && canonical.amountMinor!==item.amountMinor) throw ledgerError('LOAN_SOURCE_MISMATCH')
    await assertCostSource(c,uid,item,canonical)
    if (canonical) {
      const previousTransactionId=item.transactionId
      await collapseDuplicate(c,uid,item,canonical)
      // 合并可能同时更新多个来源；后续项沿用新的交易，不能再次删除旧交易。
      for (const peer of group.items) if(peer.transactionId && peer.transactionId===previousTransactionId) {
        peer.transactionId=canonical.transactionId;peer.transactionVersion=canonical.transactionVersion
      }
    }
    await c.execute('UPDATE catledger_installment_items SET loan_id=?,canonical=?,transaction_id=?,version=version+1 WHERE uid=? AND item_id=?',
      [loan.loanId,canonical?0:1,canonical?canonical.transactionId:item.transactionId,uid,item.itemId])
    count++
  }
  return count
}
module.exports={attachSource}
