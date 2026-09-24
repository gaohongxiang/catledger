const { randomUUID } = require('node:crypto')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { executeLedgerRead } = require('./ledger-read')
const { ledgerError } = require('./ledger-errors')
const { validateId,parseVersion } = require('./transaction-domain')
const { encodeCursor,decodeCursor } = require('./cursor')
const { populatePrincipal,selectPayment,selectAllocations,advanceLoans } = require('./loan-payment-repository')
const { FIELDS,PERIOD_SQL,capital,parse,amounts,periodValues,publicPeriod,period,allocations,advancePeriods } = require('./loan-period-repository')
const { parseSetup } = require('./loan-installment')
function createLoanPeriodService({getPool,selectLoan}) {
  const read=(context,operation)=>executeLedgerRead({getPool,...context,consistentSnapshot:true,operation})
  const write=(context,action,operation)=>executeIdempotentMutation({getPool,...context,currentReads:true,action,operation})
  async function currentLoan(c,uid,data) {const loan=await selectLoan(c,uid,data.loanId,true);loan.version=Number(loan.version);if(loan.version!==parseVersion(data.loanVersion)) throw ledgerError('CONFLICT');return loan}
  function pageSize(data){const size=data.pageSize==null?20:data.pageSize;if(!Number.isInteger(size)||size<1||size>40)throw ledgerError('VALIDATION_ERROR');return size}
  async function periods(context) {
    return read(context,async(c,uid)=>{
      const data=context.data,loan=await selectLoan(c,uid,data.loanId),size=pageSize(data)
      loan.version=Number(loan.version)
      Object.assign(loan,(await populatePrincipal(c,uid,[loan]))[0])
      const cursor=data.cursor?decodeCursor(context.subjectHash,data.cursor):null
      const ids=data.periodIds
      if(ids && (!Array.isArray(ids)||!ids.length||ids.length>40||new Set(ids).size!==ids.length||cursor))throw ledgerError('VALIDATION_ERROR')
      if(ids)ids.forEach(validateId)
      if(cursor && (cursor.action!=='loans.periods'||cursor.uid!==uid||cursor.loanId!==loan.loanId||cursor.version!==loan.version||typeof cursor.date!=='string'||typeof cursor.id!=='string')) throw ledgerError('CONFLICT')
      const [rows]=await c.execute(PERIOD_SQL+` WHERE p.uid=? AND p.loan_id=? ${ids?'AND p.period_id IN ('+ids.map(()=>'?').join(',')+')':''} ${cursor?'AND (p.due_date>? OR (p.due_date=? AND p.period_id>?))':''}
        GROUP BY p.uid,p.period_id ORDER BY p.due_date,p.period_id LIMIT ?`,[uid,loan.loanId,...(ids||[]),...(cursor?[cursor.date,cursor.date,cursor.id]:[]),size+1])
      if(ids && rows.length!==ids.length)throw ledgerError('NOT_FOUND')
      const base=PERIOD_SQL+' WHERE p.uid=? AND p.loan_id=? AND p.cancelled=0 GROUP BY p.uid,p.period_id'
      const [[totals]]=await c.execute(`SELECT ${FIELDS.map(f=>`COALESCE(SUM(${f}Minor-paid${capital(f)}Minor),0) AS unpaid${capital(f)}Minor`).join(',')},
        COALESCE(SUM(principalMinor=paidPrincipalMinor AND interestMinor=paidInterestMinor AND feeMinor=paidFeeMinor),0) AS paidPeriods,
        MIN(CASE WHEN principalMinor>paidPrincipalMinor OR interestMinor>paidInterestMinor OR feeMinor>paidFeeMinor THEN dueDate END) AS nextDueDate
        FROM (${base}) confirmed`,[uid,loan.loanId])
      const setup=parseSetup(loan.installmentSetup)
      const summary={...totals,paidPeriods:Number(totals.paidPeriods),...(setup?{historicalPaidTerms:setup.historicalPaidTerms,totalTerms:Number(loan.scheduleTerms)}:{}),...Object.fromEntries(FIELDS.map(f=>['unpaid'+capital(f)+'Minor',String(totals['unpaid'+capital(f)+'Minor'])])),
        remainingPrincipalMinor:loan.remainingPrincipalMinor,principalGapMinor:loan.remainingPrincipalMinor==null?null:String(BigInt(totals.unpaidPrincipalMinor)-BigInt(loan.remainingPrincipalMinor))}
      const items=rows.slice(0,size).map(publicPeriod),last=items.at(-1)
      return {loanId:loan.loanId,loanName:loan.name,loanVersion:loan.version,summary,items,nextCursor:rows.length>size?encodeCursor(context.subjectHash,{action:'loans.periods',uid,loanId:loan.loanId,version:loan.version,date:last.dueDate,id:last.periodId}):null}
    })
  }
  async function savePeriod(context) {
    return write(context,'loans.savePeriod',async(c,uid,data)=>{
      const loan=await currentLoan(c,uid,data),value=periodValues(data),id=data.periodId?validateId(data.periodId):randomUUID()
      const setup=parseSetup(loan.installmentSetup)
      if(setup && value.periodNumber<=setup.historicalPaidTerms && data.historicalRevision!==true)throw ledgerError('VALIDATION_ERROR')
      if(loan.scheduleTerms && value.periodNumber>Number(loan.scheduleTerms))throw ledgerError('VALIDATION_ERROR')
      const [[duplicate]]=await c.execute('SELECT period_id FROM catledger_loan_periods WHERE uid=? AND loan_id=? AND period_number=? AND period_id<>?',[uid,loan.loanId,value.periodNumber,id])
      if(duplicate)throw ledgerError('CONFLICT')
      let version=1
      if(data.periodId){
        const old=await period(c,uid,id)
        if(old.loanId!==loan.loanId) throw ledgerError('NOT_FOUND')
        if(old.version!==parseVersion(data.version)) throw ledgerError('CONFLICT')
        if(FIELDS.some(f=>BigInt(value[f+'Minor'])<BigInt(old['paid'+capital(f)+'Minor']) || (value.cancelled&&old['paid'+capital(f)+'Minor']!=='0'))) throw ledgerError('LOAN_PLAN_OVERALLOCATED')
        version=old.version+1
        await c.execute(`UPDATE catledger_loan_periods SET period_number=?,due_date=?,principal_minor=?,interest_minor=?,fee_minor=?,cancelled=?,version=? WHERE uid=? AND period_id=?`,
          [value.periodNumber,value.dueDate,value.principalMinor,value.interestMinor,value.feeMinor,value.cancelled?1:0,version,uid,id])
      }else await c.execute(`INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled) VALUES (?,?,?,?,?,?,?,?,?)`,
        [uid,id,loan.loanId,value.periodNumber,value.dueDate,value.principalMinor,value.interestMinor,value.feeMinor,value.cancelled?1:0])
      await c.execute('INSERT INTO catledger_loan_period_revisions (uid,period_id,version,snapshot_json) VALUES (?,?,?,?)',[uid,id,version,JSON.stringify(value)])
      await advanceLoans(c,uid,new Map([[loan.loanId,loan]]))
      return {loanId:loan.loanId,loanVersion:loan.version+1,periodId:id,version}
    })
  }
  async function paymentAllocation(c,uid,loanId,paymentId) {
    const payment=await selectPayment(c,uid,paymentId)
    if(payment.kind!=='repayment') throw ledgerError('VALIDATION_ERROR')
    const share=(await selectAllocations(c,uid,payment.paymentId)).find(a=>a.loanId===loanId)
    if(!share) throw ledgerError('NOT_FOUND')
    const items=await allocations(c,uid,payment.paymentId,loanId)
    const unallocated=Object.fromEntries(FIELDS.map(f=>[f+'Minor',String(BigInt(share[f+'Minor'])-items.reduce((s,a)=>s+BigInt(a[f+'Minor']),0n))]))
    return {payment,share,items,unallocated}
  }
  async function planAllocation(context) {return read(context,async(c,uid)=>{const loan=await selectLoan(c,uid,context.data.loanId);return {...await paymentAllocation(c,uid,loan.loanId,context.data.paymentId),loanVersion:Number(loan.version)}})}
  async function allocatePeriods(context) {
    return write(context,'loans.allocatePeriods',async(c,uid,data)=>{
      if(data.confirmed!==true || !Array.isArray(data.items)||data.items.length>40) throw ledgerError('VALIDATION_ERROR')
      const loan=await currentLoan(c,uid,data),current=await paymentAllocation(c,uid,loan.loanId,data.paymentId)
      if(current.payment.status!=='active'||current.payment.version!==parseVersion(data.version))throw ledgerError('CONFLICT')
      const ids=new Set(),items=[]
      for(const input of data.items){
        const id=validateId(input.periodId),values=amounts(input),p=await period(c,uid,id)
        if(p.loanId!==loan.loanId)throw ledgerError('NOT_FOUND')
        if(ids.has(id)||FIELDS.every(f=>values[f+'Minor']==='0'))throw ledgerError('VALIDATION_ERROR')
        ids.add(id)
        if(p.cancelled||p.version!==parseVersion(input.version))throw ledgerError('CONFLICT')
        const old=current.items.find(a=>a.periodId===id)
        if(FIELDS.some(f=>BigInt(p['paid'+capital(f)+'Minor'])-BigInt(old?old[f+'Minor']:'0')+BigInt(values[f+'Minor'])>BigInt(p[f+'Minor'])))throw ledgerError('LOAN_PLAN_OVERALLOCATED')
        items.push({periodId:id,version:p.version,...values})
      }
      if(FIELDS.some(f=>items.reduce((s,a)=>s+BigInt(a[f+'Minor']),0n)>BigInt(current.share[f+'Minor'])))throw ledgerError('LOAN_PLAN_OVERALLOCATED')
      await c.execute('UPDATE catledger_loan_period_allocations SET active=0 WHERE uid=? AND payment_id=? AND loan_id=? AND active=1',[uid,current.payment.paymentId,loan.loanId])
      for(const a of items)await c.execute(`INSERT INTO catledger_loan_period_allocations
        (uid,allocation_id,payment_id,loan_id,period_id,principal_minor,interest_minor,fee_minor,confirmed_period_version,confirmed_payment_version)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,[uid,randomUUID(),current.payment.paymentId,loan.loanId,a.periodId,a.principalMinor,a.interestMinor,a.feeMinor,a.version,current.payment.version])
      await advancePeriods(c,uid,current.items.concat(items).map(a=>a.periodId))
      await c.execute('UPDATE catledger_loan_payments SET version=version+1 WHERE uid=? AND payment_id=?',[uid,current.payment.paymentId])
      await advanceLoans(c,uid,new Map([[loan.loanId,loan]]))
      return {paymentId:current.payment.paymentId,version:current.payment.version+1,loanId:loan.loanId,loanVersion:loan.version+1,allocatedPeriods:items.length}
    })
  }
  async function periodHistory(context) {
    return read(context,async(c,uid)=>{
      const data=context.data,p=await period(c,uid,data.periodId),size=pageSize(data),kind=data.kind
      if(!['payment','plan'].includes(kind))throw ledgerError('VALIDATION_ERROR')
      const cursor=data.cursor?decodeCursor(context.subjectHash,data.cursor):null
      if(cursor&&(cursor.action!=='loans.periodHistory'||cursor.uid!==uid||cursor.periodId!==p.periodId||cursor.kind!==kind))throw ledgerError('VALIDATION_ERROR')
      let rows
      if(kind==='plan') [rows]=await c.execute(`SELECT version,snapshot_json AS snapshot,created_at AS createdAt FROM catledger_loan_period_revisions
        WHERE uid=? AND period_id=? ${cursor?'AND version<?':''} ORDER BY version DESC LIMIT ?`,[uid,p.periodId,...(cursor?[cursor.version]:[]),size+1])
      else [rows]=await c.execute(`SELECT a.allocation_id AS allocationId,a.payment_id AS paymentId,a.principal_minor AS principalMinor,a.interest_minor AS interestMinor,a.fee_minor AS feeMinor,
        a.confirmed_period_version AS confirmedPeriodVersion,a.active,p.status AS paymentStatus,a.created_at AS createdAt FROM catledger_loan_period_allocations a
        JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id WHERE a.uid=? AND a.period_id=?
        ${cursor?'AND (a.created_at<? OR (a.created_at=? AND a.allocation_id<?))':''} ORDER BY a.created_at DESC,a.allocation_id DESC LIMIT ?`,[uid,p.periodId,...(cursor?[cursor.at,cursor.at,cursor.id]:[]),size+1])
      const items=rows.slice(0,size).map(r=>kind==='plan'?{...r,version:Number(r.version),snapshot:parse(r.snapshot)}:{...r,active:Boolean(r.active)&&r.paymentStatus==='active',confirmedPeriodVersion:Number(r.confirmedPeriodVersion),...Object.fromEntries(FIELDS.map(f=>[f+'Minor',String(r[f+'Minor'])]))}),last=items.at(-1)
      return {periodId:p.periodId,kind,items,nextCursor:rows.length>size?encodeCursor(context.subjectHash,{action:'loans.periodHistory',uid,periodId:p.periodId,kind,version:last.version||null,at:last.createdAt,id:last.allocationId||null}):null}
    })
  }
  return {periods,savePeriod,allocatePeriods,planAllocation,periodHistory}
}
module.exports={createLoanPeriodService}
