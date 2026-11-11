const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { validateId } = require('./transaction-domain')
const { ITEM_SELECT, publicItem, canonicalItem, assertCostSource } = require('./installment-items')

async function collapseDuplicate(c,uid,item,canonical) {
  if (!item.transactionId || item.transactionId===canonical.transactionId) return
  await require('./loan-charge-store').assertNoCharges(c,uid,[item.transactionId,canonical.transactionId])
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
  // 无编号、无共同交易时，用「同一计划名 + 同一期次」把本金与利息归成一组（同一笔分期的两行）。
  const planLabel=String(source.planLabel||'').trim()
  while (first || referenceKeys.length || transactionIds.length) {
    const filters=[],values=[uid,loan.accountId]
    if(first){filters.push('i.item_id=?');values.push(source.itemId)}
    for(const [column,keys] of [['reference_key',referenceKeys],['transaction_id',transactionIds]]) {
      if(keys.length){filters.push(`i.${column} IN (${keys.map(()=>'?').join(',')})`);values.push(...keys)}
    }
    // 首轮按计划名+期次兜底圈同组（仅当计划名非空，避免误把同额不同笔合并）。
    if(first && planLabel){filters.push('(i.plan_label=? AND i.period_number=?)');values.push(planLabel,source.periodNumber)}
    referenceKeys.forEach(key=>references.add(key));transactionIds.forEach(id=>transactions.add(id))
    const [rows]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.account_id=? AND i.active=1 AND (${filters.join(' OR ')})
      ORDER BY i.period_number,i.created_at,i.item_id LIMIT 3601`,values)
    if(rows.length>3600)throw ledgerError('LOAN_SOURCE_TOO_LARGE')
    referenceKeys=[];transactionIds=[];first=false
    for(const row of rows) {
      const item=publicItem(row)
      if(!item.active || items.has(item.itemId))continue
      if(item.loanId && item.loanId!==loan.loanId)throw ledgerError('LOAN_SOURCE_MISMATCH')
      if(item.periodNumber>Number(loan.scheduleTerms) || item.totalTerms && item.totalTerms!==Number(loan.scheduleTerms))throw ledgerError('LOAN_SOURCE_MISMATCH')
      // 「计划名+期次」兜底只用于把同一笔分期的本金/利息/费用（不同组件）归一组。
      // 若同期同组件已有一行，说明可能是另一笔同名分期（判不准），不并入，留待用户核对。
      const slot=item.periodNumber+':'+item.component
      if([...items.values()].some(existing=>existing.periodNumber===item.periodNumber && existing.component===item.component)) continue
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
  const [[selected]]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.item_id=?',[uid,validateId(itemId)])
  if (!selected) throw ledgerError('NOT_FOUND')
  const source=publicItem(selected)
  if (!source.active || source.accountId!==loan.accountId || source.loanId && source.loanId!==loan.loanId) throw ledgerError('LOAN_SOURCE_MISMATCH')
  const group=await sourceGroup(c,uid,loan,source)
  // 记住用户的手动归属：无真实合同编号时，按「计划名+起始月+总期数」写一条合成绑定，
  // 下月同名单期能据此自动延续到本计划（见 prepareImport 的合成键查找）。有真实编号仍用编号绑定。
  const planLabel=String(loan.name||'').trim()
  const startMonth=String(loan.startDate||loan.baselineDate||'').slice(0,7)
  if(planLabel&&startMonth&&loan.scheduleTerms){
    const syntheticKey=require('./installment-plan-fingerprint').planBindingKey(planLabel,startMonth,loan.scheduleTerms)
    const [[sb]]=await c.execute('SELECT loan_id AS loanId FROM catledger_installment_bindings WHERE uid=? AND account_id=? AND reference_key=?',[uid,loan.accountId,syntheticKey])
    if(sb&&sb.loanId!==loan.loanId)throw ledgerError('LOAN_SOURCE_MISMATCH')
    if(!sb)await c.execute('INSERT INTO catledger_installment_bindings (uid,account_id,reference_key,loan_id) VALUES (?,?,?,?)',[uid,loan.accountId,syntheticKey,loan.loanId])
  }
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
