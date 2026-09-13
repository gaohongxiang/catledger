const { ledgerError } = require('./ledger-errors')
const { parseMinorUnits } = require('./money')
const { parseLocalDate } = require('./local-time')
const { validateId } = require('./transaction-domain')
const FIELDS = ['principal','interest','fee']
const PERIOD_SQL = `SELECT p.period_id AS periodId,p.loan_id AS loanId,p.period_number AS periodNumber,p.due_date AS dueDate,p.cancelled,p.version,
  p.principal_minor AS principalMinor,p.interest_minor AS interestMinor,p.fee_minor AS feeMinor,
  COALESCE(SUM(CASE WHEN a.active=1 AND actual.status='active' THEN a.principal_minor ELSE 0 END),0) AS paidPrincipalMinor,
  COALESCE(SUM(CASE WHEN a.active=1 AND actual.status='active' THEN a.interest_minor ELSE 0 END),0) AS paidInterestMinor,
  COALESCE(SUM(CASE WHEN a.active=1 AND actual.status='active' THEN a.fee_minor ELSE 0 END),0) AS paidFeeMinor
  FROM catledger_loan_periods p LEFT JOIN catledger_loan_period_allocations a ON a.uid=p.uid AND a.period_id=p.period_id AND a.active=1
  LEFT JOIN catledger_loan_payments actual ON actual.uid=a.uid AND actual.payment_id=a.payment_id`
const capital = value => value[0].toUpperCase()+value.slice(1)
const parse = value => typeof value==='string'?JSON.parse(value):value
function amounts(data) { return Object.fromEntries(FIELDS.map(f=>[f+'Minor',parseMinorUnits(data[f+'Minor'],{allowZero:true}).toString()])) }
function periodValues(data) {
  if(!Number.isInteger(data.periodNumber) || data.periodNumber<1 || data.periodNumber>9999 || (data.cancelled!==undefined && typeof data.cancelled!=='boolean')) throw ledgerError('VALIDATION_ERROR')
  const value={periodNumber:data.periodNumber,dueDate:parseLocalDate(data.dueDate).startDate,...amounts(data),cancelled:data.cancelled===true}
  if(FIELDS.every(f=>value[f+'Minor']==='0')) throw ledgerError('VALIDATION_ERROR')
  return value
}
function publicPeriod(row) {
  const result={...row,periodNumber:Number(row.periodNumber),version:Number(row.version),cancelled:Boolean(row.cancelled)}
  for(const f of FIELDS) {
    result[f+'Minor']=String(row[f+'Minor']);result['paid'+capital(f)+'Minor']=String(row['paid'+capital(f)+'Minor'])
    result['unpaid'+capital(f)+'Minor']=String(BigInt(result[f+'Minor'])-BigInt(result['paid'+capital(f)+'Minor']))
  }
  result.status=result.cancelled?'cancelled':FIELDS.every(f=>result['unpaid'+capital(f)+'Minor']==='0')?'paid':FIELDS.some(f=>result['paid'+capital(f)+'Minor']!=='0')?'partial':'unpaid'
  return result
}
async function period(connection,uid,periodId) {
  const [[row]]=await connection.execute(PERIOD_SQL+' WHERE p.uid=? AND p.period_id=? GROUP BY p.uid,p.period_id',[uid,validateId(periodId)])
  if(!row) throw ledgerError('NOT_FOUND')
  return publicPeriod(row)
}
async function allocations(connection,uid,paymentId,loanId) {
  const [rows]=await connection.execute(`SELECT a.allocation_id AS allocationId,a.period_id AS periodId,a.principal_minor AS principalMinor,
    a.interest_minor AS interestMinor,a.fee_minor AS feeMinor,p.period_number AS periodNumber,p.due_date AS dueDate,p.version
    FROM catledger_loan_period_allocations a JOIN catledger_loan_periods p ON p.uid=a.uid AND p.period_id=a.period_id
    WHERE a.uid=? AND a.payment_id=? AND a.loan_id=? AND a.active=1 ORDER BY p.due_date,p.period_id LIMIT 41`,[uid,paymentId,loanId])
  if(rows.length>40) throw ledgerError('CONFLICT')
  return rows.map(r=>({...r,version:Number(r.version),periodNumber:Number(r.periodNumber),...Object.fromEntries(FIELDS.map(f=>[f+'Minor',String(r[f+'Minor'])]))}))
}
async function advancePeriods(connection,uid,ids) {
  const distinct=[...new Set(ids)]
  for(let at=0;at<distinct.length;at+=100) {
    const part=distinct.slice(at,at+100)
    await connection.execute(`UPDATE catledger_loan_periods SET version=version+1 WHERE uid=? AND period_id IN (${part.map(()=>'?').join(',')})`,[uid,...part])
  }
}
async function deactivatePaymentPeriods(connection,uid,paymentId) {
  const [rows]=await connection.execute('SELECT period_id AS periodId FROM catledger_loan_period_allocations WHERE uid=? AND payment_id=? AND active=1 LIMIT 801',[uid,paymentId])
  if(rows.length>800) throw ledgerError('CONFLICT')
  if(!rows.length) return
  await connection.execute('UPDATE catledger_loan_period_allocations SET active=0 WHERE uid=? AND payment_id=? AND active=1',[uid,paymentId])
  await advancePeriods(connection,uid,rows.map(r=>r.periodId))
}
module.exports={FIELDS,PERIOD_SQL,capital,parse,amounts,periodValues,publicPeriod,period,allocations,advancePeriods,deactivatePaymentPeriods}
