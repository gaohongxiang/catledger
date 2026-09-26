const { randomUUID } = require('node:crypto')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { parseLocalDateTime } = require('./local-time')
const { today } = require('./loan-charge-domain')
const store = require('./loan-charge-store')

// 每次重新选择缺项，无客户端日期或偏移决定写入范围；收费唯一键保住跨批次/换请求号重试。
const DUE_FROM = `FROM catledger_loan_charges f
  JOIN catledger_loan_charge_contracts k ON k.uid=f.uid AND k.contract_id=f.contract_id
  JOIN catledger_loans l ON l.uid=k.uid AND l.loan_id=k.loan_id
  JOIN catledger_accounts a ON a.uid=k.uid AND a.account_id=k.account_id
  JOIN catledger_categories g ON g.uid=f.uid AND g.category_id=f.category_id
  WHERE f.uid=? AND f.state='planned' AND l.archived_at IS NULL AND a.archived_at IS NULL
    AND a.type IN ('credit','other_liability') AND g.archived_at IS NULL AND g.kind='expense'
    AND f.charge_date<=? AND f.charge_date>=JSON_UNQUOTE(JSON_EXTRACT(k.authorization_json,'$.fromDate'))
    AND f.charge_date<=JSON_UNQUOTE(JSON_EXTRACT(k.authorization_json,'$.throughDate'))
    AND (JSON_UNQUOTE(JSON_EXTRACT(k.authorization_json,'$.mode'))='auto'
      OR (? IS NOT NULL AND JSON_UNQUOTE(JSON_EXTRACT(k.authorization_json,'$.mode'))='once' AND k.contract_id=?))
    AND (? IS NULL OR k.loan_id=?)
    AND NOT EXISTS(SELECT 1 FROM catledger_loan_periods p WHERE p.uid=k.uid AND p.loan_id=k.loan_id
      AND p.period_number=f.period_number AND p.cancelled=1)`
function scope(data,cutoff,uid) {
  if (data.cutoff!==undefined || data.uid!==undefined || data.throughDate!==undefined) throw ledgerError('VALIDATION_ERROR')
  const contractId=data.confirmed===true&&typeof data.contractId==='string'?data.contractId:null
  if (data.contractId && !contractId) throw ledgerError('VALIDATION_ERROR')
  const loanId=data.loanId||null
  return [uid,cutoff,contractId,contractId,loanId,loanId]
}
function createLoanChargeSync({getPool,now=Date.now}) {
  async function dueCharges(context) {
    return executeLedgerRead({getPool,...context,consistentSnapshot:true,operation:async(c,uid)=>{
      const cutoff=today(now()),values=scope(context.data,cutoff,uid)
      const [[row]]=await c.execute('SELECT COUNT(*) AS count,COALESCE(SUM(f.amount_minor),0) AS amount '+DUE_FROM,values)
      return {cutoff,count:Number(row.count),amountMinor:String(row.amount),batchLimit:40}
    }})
  }
  async function syncCharges(context) {
    return executeIdempotentMutation({getPool,...context,action:'loans.syncCharges',operation:async(c,uid,data)=>{
      const cutoff=today(now()),limit=data.limit==null?40:data.limit,values=scope(data,cutoff,uid)
      if(!Number.isInteger(limit)||limit<1||limit>40)throw ledgerError('VALIDATION_ERROR')
      const [due]=await c.execute(`SELECT f.charge_id AS chargeId,f.contract_id AS contractId,f.component,
        f.amount_minor AS amountMinor,f.charge_date AS chargeDate,f.category_id AS categoryId,
        k.account_id AS accountId,k.loan_id AS loanId,l.name,f.period_number AS periodNumber
        ${DUE_FROM} ORDER BY f.charge_date,f.charge_id LIMIT ?`,[...values,limit+1])
      const created=[],loans=new Set()
      for(const item of due.slice(0,limit)) {
        const time=parseLocalDateTime(item.chargeDate+'T12:00:00',-480),transactionId=randomUUID()
        await c.execute(`INSERT INTO catledger_transactions
          (uid,transaction_id,type,source_account_id,amount_minor,category_id,occurred_local_date,occurred_local_at,
           timezone_offset_minutes,occurred_at_utc,note,origin)
          VALUES(?,?,'expense',?,?,?,?,?,?,?,?,'loan_plan')`,[uid,transactionId,item.accountId,String(item.amountMinor),item.categoryId,
          time.localDate,time.localAt,time.timezoneOffsetMinutes,time.occurredAtUtc,
          item.name+' '+(item.periodNumber?'第'+item.periodNumber+'期':'一次性')+(item.component==='interest'?'利息':'费用')+'（按确认方案，待核对）'])
        const [result]=await c.execute("UPDATE catledger_loan_charges SET state='recorded',basis='plan',transaction_id=?,version=version+1 WHERE uid=? AND charge_id=? AND state='planned'",[transactionId,uid,item.chargeId])
        if(result.affectedRows!==1)throw ledgerError('CONFLICT')
        await store.audit(c,uid,item.contractId,item.chargeId,'accrue',{transactionId,amountMinor:String(item.amountMinor),chargeDate:item.chargeDate,cutoff})
        created.push({chargeId:item.chargeId,transactionId,amountMinor:String(item.amountMinor),chargeDate:item.chargeDate})
        loans.add(item.loanId)
      }
      for(const loanId of loans)await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loanId])
      return {cutoff,created,createdCount:created.length,amountMinor:created.reduce((s,i)=>s+BigInt(i.amountMinor),0n).toString(),hasMore:due.length>limit}
    }})
  }
  return {dueCharges,syncCharges}
}
module.exports={createLoanChargeSync,DUE_FROM}
