const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { prepare } = require('./loan-deletion-scope')
const { deactivatePayment, deleteTransactions } = require('./loan-payment-maintenance')
const { lockAccounts } = require('./transaction-command-service')
const { assertCashBalanceChanges } = require('./cash-balance-guard')
const { sourceEvent, writeSourceEvent } = require('./loan-source')
const store = require('./loan-charge-store')

function createLoanDeletionService({getPool,selectLoan}) {
  async function deleteImpact(context) {
    return executeLedgerRead({getPool,...context,consistentSnapshot:true,operation:async(c,uid)=>(await prepare(c,uid,context.data,context.subjectHash,selectLoan)).impact})
  }
  async function remove(context) {
    return executeIdempotentMutation({getPool,...context,action:'loans.delete',operation:async(c,uid,data)=>{
      const scope=await prepare(c,uid,data,context.subjectHash,selectLoan)
      const {loan,contract,charges,items,payments,transactions,impact}=scope
      if(data.confirmed!==true||data.previewToken!==impact.previewToken)throw ledgerError('CONFLICT')
      if(!impact.canDelete)throw ledgerError('LOAN_DELETE_BLOCKED')
      const revoked=transactions.filter(t=>t.disposition==='revoke'),ids=new Set(revoked.map(t=>t.transactionId))
      const accounts=await lockAccounts(c,uid,revoked.flatMap(t=>[t.sourceAccountId,t.destinationAccountId]),{allowArchived:true})
      await assertCashBalanceChanges(c,uid,accounts,revoked.map(transaction=>({transaction,multiplier:-1n})))
      await require('./loan-deletion-review').record(c,uid,loan,contract,scope.reviews)
      // 清除的是当前占用；从不调用会恢复旧错误原账的 reversePayment。
      for(const p of payments){
        const [source]=p.sources
        if(source?.eventId){
          const event=await sourceEvent(c,uid,source.eventId),fields={...event.fieldSources}
          if(fields.loanPaymentId===p.paymentId)delete fields.loanPaymentId
          if(fields.loanSettlement)fields.loanSettlement={...fields.loanSettlement,allocations:[]}
          await writeSourceEvent(c,uid,event,{...event,fieldSources:fields},p.paymentId,'detach_deleted_loan')
        }
        await deactivatePayment(c,uid,p.paymentId)
      }
      await deleteTransactions(c,uid,revoked)
      const removed=[],retained=[],byCharge=new Map(charges.map(f=>[f.chargeId,f]))
      for(const f of charges){
        const financial=byCharge.get(f.coveredByChargeId)||f
        const withdrawn=financial.transactionId&&ids.has(financial.transactionId)
        // 单独抑制/取消始终保留。只为本次撤销或尚未发生的计划项打可重建标记。
        if(withdrawn||['planned','baseline'].includes(f.state)&&!f.planRemovedAt){
          removed.push(f.chargeId)
        }else if(f.state==='recorded'){
          retained.push({id:f.chargeId,settled:String(BigInt(f.settledMinor)+BigInt(f.historicalCoveredMinor))})
        }
      }
      for(let offset=0;offset<removed.length;offset+=200){
        const batch=removed.slice(offset,offset+200)
        await c.execute(`UPDATE catledger_loan_charges SET state='paused',plan_removed_at=CURRENT_TIMESTAMP(3),transaction_id=NULL,
          balance_adjustment_id=NULL,covered_by_charge_id=NULL,historical_settled_minor=0,version=version+1 WHERE uid=? AND charge_id IN (${batch.map(()=>'?').join(',')})`,[uid,...batch])
      }
      for(let offset=0;offset<retained.length;offset+=200){
        const batch=retained.slice(offset,offset+200)
        await c.execute(`UPDATE catledger_loan_charges SET historical_settled_minor=CASE charge_id ${batch.map(()=>'WHEN ? THEN ?').join(' ')} END,
          version=version+1 WHERE uid=? AND charge_id IN (${batch.map(()=>'?').join(',')})`,[...batch.flatMap(f=>[f.id,f.settled]),uid,...batch.map(f=>f.id)])
      }
      if(contract){
        await c.execute('UPDATE catledger_loan_charge_contracts SET authorization_json=?,version=version+1 WHERE uid=? AND contract_id=?',[
          JSON.stringify({...contract.authorization,mode:'paused',stopReason:'plan_deleted'}),uid,contract.contractId])
        await store.audit(c,uid,contract.contractId,null,'delete_plan',{loanId:loan.loanId,version:Number(loan.version),charges,impact})
      }
      await c.execute(`UPDATE catledger_installment_items SET loan_id=NULL,active=IF(${ids.size?'transaction_id IN ('+[...ids].map(()=>'?').join(',')+')':'FALSE'},0,active),
        version=version+1 WHERE uid=? AND loan_id=?`,[...ids,uid,loan.loanId])
      await c.execute('DELETE FROM catledger_installment_bindings WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      await c.execute('UPDATE catledger_loan_period_allocations SET active=0 WHERE uid=? AND loan_id=? AND active=1',[uid,loan.loanId])
      await c.execute('UPDATE catledger_loan_periods SET cancelled=1,version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      await c.execute(`UPDATE catledger_loans SET deleted_at=CURRENT_TIMESTAMP(3),archived_at=CURRENT_TIMESTAMP(3),
        deletion_snapshot_json=?,baseline_principal_minor=0,progress_json=NULL,version=version+1 WHERE uid=? AND loan_id=?`,[
        JSON.stringify({schema:1,baselinePrincipalMinor:loan.baselinePrincipalMinor,progress:loan.progress,items,payments,impact}),uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1,deleted:true,counts:impact.counts}
    }})
  }
  return {deleteImpact,delete:remove}
}
module.exports={createLoanDeletionService}
