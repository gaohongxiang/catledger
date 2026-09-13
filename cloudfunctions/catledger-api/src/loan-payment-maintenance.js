const { ledgerError } = require('./ledger-errors')
const { parseVersion } = require('./transaction-domain')
const { selectTransaction, protectRefundedExpense } = require('./transaction-command-service')
const { selectPayment, selectAllocations } = require('./loan-payment-repository')
const { sourceEvent, eventLinks, storedSource, assertNoExternalLinks, writeSourceEvent } = require('./loan-source')
async function paymentLinks(connection, uid, paymentId) {
  const [rows] = await connection.execute(`SELECT transaction_id AS transactionId,transaction_version AS transactionVersion,
    created_by_payment AS createdByPayment,active FROM catledger_loan_payment_transactions WHERE uid=? AND payment_id=? ORDER BY transaction_id LIMIT 61`, [uid,paymentId])
  if (!rows.length || rows.length>60) throw ledgerError('CONFLICT')
  return rows
}
async function inspectPayment(connection, uid, paymentId, version) {
  const payment=await selectPayment(connection,uid,paymentId,true)
  if(payment.status!=='active' || payment.version!==parseVersion(version)) throw ledgerError('CONFLICT')
  const allocations=await selectAllocations(connection,uid,paymentId), links=await paymentLinks(connection,uid,paymentId)
  const originalSource=await storedSource(connection,uid,paymentId)
  const event=originalSource && originalSource.eventId ? await sourceEvent(connection,uid,originalSource.eventId,true) : null
  if(originalSource && (!originalSource.active || (event && event.version!==originalSource.appliedEventVersion))) throw ledgerError('CONFLICT')
  const source={event,links:event?await eventLinks(connection,uid,event,true):[]}, transactions=[]
  for(const link of links) {
    const row=await selectTransaction(connection,uid,link.transactionId,{forUpdate:true})
    if(!link.active || row.deletedAt || Number(row.version)!==Number(link.transactionVersion)) throw ledgerError('CONFLICT')
    await protectRefundedExpense(connection,uid,row,null)
    transactions.push({...row,createdByPayment:Boolean(link.createdByPayment)})
  }
  await assertNoExternalLinks(connection,uid,transactions.map(t=>t.transactionId),event&&event.eventId)
  if(event && (source.links.some(l=>!transactions.some(t=>t.transactionId===l.transactionId && Number(t.version)===l.transactionVersion)) ||
    transactions.some(t=>!source.links.some(l=>l.transactionId===t.transactionId)))) throw ledgerError('CONFLICT')
  const [roots]=await connection.execute(`SELECT transaction_id AS transactionId,deleted_version AS deletedVersion
    FROM catledger_loan_replaced_transactions WHERE uid=? AND payment_id=? ORDER BY transaction_id LIMIT 61`,[uid,paymentId])
  if(roots.length>60) throw ledgerError('CONFLICT')
  const originals=[]
  for(const root of roots) {
    const row=await selectTransaction(connection,uid,root.transactionId,{forUpdate:true})
    if(!row.deletedAt || Number(row.version)!==Number(root.deletedVersion)) throw ledgerError('CONFLICT')
    originals.push(row)
  }
  return {payment,allocations,links,transactions,source,originalSource,originals}
}
async function deactivatePayment(connection,uid,paymentId) {
  await connection.execute("UPDATE catledger_loan_payments SET status='reversed',version=version+1 WHERE uid=? AND payment_id=?",[uid,paymentId])
  await connection.execute('UPDATE catledger_loan_payment_transactions SET active=0 WHERE uid=? AND payment_id=?',[uid,paymentId])
  await connection.execute('UPDATE catledger_loan_payment_sources SET active=0 WHERE uid=? AND payment_id=?',[uid,paymentId])
}
async function deleteTransactions(connection,uid,transactions) {
  for(const row of transactions) {
    const [result]=await connection.execute(`UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1
      WHERE uid=? AND transaction_id=? AND version=? AND deleted_at IS NULL`,[uid,row.transactionId,Number(row.version)])
    if(result.affectedRows!==1) throw ledgerError('CONFLICT')
  }
}
async function reversePayment(connection,uid,inspection) {
  const {payment,transactions,originals,source,originalSource}=inspection
  await deactivatePayment(connection,uid,payment.paymentId)
  await deleteTransactions(connection,uid,transactions.filter(t=>t.createdByPayment))
  for(const row of originals) {
    const [result]=await connection.execute(`UPDATE catledger_transactions SET deleted_at=NULL,version=version+1
      WHERE uid=? AND transaction_id=? AND version=? AND deleted_at IS NOT NULL`,[uid,row.transactionId,Number(row.version)])
    if(result.affectedRows!==1) throw ledgerError('CONFLICT')
  }
  if(source.event) {
    if(payment.mode==='correctExisting') {
      await connection.execute('UPDATE catledger_economic_event_transactions SET superseded_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND event_id=? AND superseded_at IS NULL',[uid,source.event.eventId])
      const restored=new Map(originals.map(t=>[t.transactionId,Number(t.version)+1]))
      for(const link of originalSource.originalLinks) {
        if(!restored.has(link.transactionId)) throw ledgerError('CONFLICT')
        await connection.execute(`UPDATE catledger_economic_event_transactions SET superseded_at=NULL,transaction_version=?
          WHERE uid=? AND link_id=? AND event_id=?`,[restored.get(link.transactionId),uid,link.linkId,source.event.eventId])
      }
    }
    await writeSourceEvent(connection,uid,source.event,originalSource.originalEvent,payment.paymentId,'reverse_loan_payment')
  }
}
module.exports={paymentLinks,inspectPayment,deactivatePayment,deleteTransactions,reversePayment}
