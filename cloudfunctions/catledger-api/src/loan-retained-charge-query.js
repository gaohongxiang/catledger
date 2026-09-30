const {executeLedgerRead}=require('./ledger-read')
const {ledgerError}=require('./ledger-errors')
const {validateId}=require('./transaction-domain')
const {decodeCursor,encodeCursor}=require('./cursor')
function createRetainedChargesQuery({getPool}){
  return async context=>executeLedgerRead({getPool,...context,consistentSnapshot:true,operation:async(c,uid)=>{
    const data=context.data||{},accountId=data.accountId==null?null:validateId(data.accountId),pageSize=data.pageSize==null?20:data.pageSize
    if(!Number.isInteger(pageSize)||pageSize<1||pageSize>40)throw ledgerError('VALIDATION_ERROR')
    let cursor=null
    if(data.cursor){
      cursor=decodeCursor(context.subjectHash,data.cursor)
      if(cursor.action!=='loans.retainedCharges'||cursor.uid!==uid||cursor.accountId!==accountId||typeof cursor.date!=='string'||typeof cursor.id!=='string')throw ledgerError('VALIDATION_ERROR')
    }
    const scope=`FROM catledger_loan_charges f JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id
      JOIN catledger_loans l ON l.uid=k.uid AND l.loan_id=k.loan_id JOIN catledger_accounts a ON a.uid=k.uid AND a.account_id=k.account_id
      JOIN catledger_transactions t ON t.uid=f.uid AND t.transaction_id=f.transaction_id
      WHERE f.uid=? AND l.deleted_at IS NOT NULL AND f.state='recorded' AND f.plan_removed_at IS NULL AND t.deleted_at IS NULL${accountId?' AND k.account_id=?':''}`
    const values=[uid,...accountId?[accountId]:[]]
    const [[count]]=await c.execute('SELECT COUNT(*) AS total '+scope,values)
    const [rows]=await c.execute(`SELECT f.charge_id AS chargeId,f.component,f.charge_date AS chargeDate,f.amount_minor AS amountMinor,
      a.name AS accountName,l.name AS loanName `+scope+(cursor?' AND (f.charge_date<? OR (f.charge_date=? AND f.charge_id<?))':'')+
      ' ORDER BY f.charge_date DESC,f.charge_id DESC LIMIT ?',[...values,...cursor?[cursor.date,cursor.date,cursor.id]:[],pageSize+1])
    const items=rows.slice(0,pageSize).map(r=>({...r,amountMinor:String(r.amountMinor)})),last=items.at(-1)
    return {items,total:Number(count.total),nextCursor:rows.length>pageSize?encodeCursor(context.subjectHash,{action:'loans.retainedCharges',uid,accountId,date:last.chargeDate,id:last.chargeId}):null}
  }})
}
module.exports={createRetainedChargesQuery}
