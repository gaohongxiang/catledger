const { randomUUID } = require('node:crypto')
const { executeLedgerRead } = require('./ledger-read')
const { executeIdempotentMutation } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { validateId, parseVersion } = require('./transaction-domain')
const { parseLocalDateTime } = require('./local-time')
const { decodeCursor,encodeCursor } = require('./cursor')
const { PERIOD_SQL,publicPeriod } = require('./loan-period-repository')
const { ITEM_SELECT,publicItem,canonicalItem,insertItem } = require('./installment-items')
const { buildView,updateProgress } = require('./installment-view')
const { attachSource } = require('./installment-link')

async function loadView(c,uid,loan) {
  const [periods]=await c.execute(PERIOD_SQL+' WHERE p.uid=? AND p.loan_id=? GROUP BY p.uid,p.period_id ORDER BY p.period_number LIMIT 601',[uid,loan.loanId])
  const [items]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.loan_id=? AND i.active=1 ORDER BY i.period_number LIMIT 3601',[uid,loan.loanId])
  if (periods.length>600 || items.length>3600) throw ledgerError('LOAN_SOURCE_TOO_LARGE')
  return buildView(loan,periods.map(publicPeriod),items.map(publicItem))
}
async function populateTracking(c,uid,loans) {
  const tracked=loans.filter(l=>l.kind==='installment'&&l.scheduleTerms&&l.scheduleMethod&&(l.installmentSetup||l.baselinePrincipalMinor&&String(l.baselinePrincipalMinor)!=='0'))
  if(!tracked.length)return loans
  const ids=tracked.map(l=>l.loanId),marks=ids.map(()=>'?').join(',')
  const [periods]=await c.execute(PERIOD_SQL+` WHERE p.uid=? AND p.loan_id IN (${marks}) GROUP BY p.uid,p.period_id`,[uid,...ids])
  const [items]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.loan_id IN (${marks}) AND i.active=1`,[uid,...ids])
  const summaries=new Map(tracked.map(loan=>[loan.loanId,buildView(loan,periods.filter(p=>p.loanId===loan.loanId).map(publicPeriod),items.filter(i=>i.loanId===loan.loanId).map(publicItem)).summary]))
  return loans.map(loan=>({...loan,installmentSummary:summaries.get(loan.loanId)||null}))
}
function size(data) { const n=data.pageSize==null?20:data.pageSize;if(!Number.isInteger(n)||n<1||n>40)throw ledgerError('VALIDATION_ERROR');return n }
function createInstallmentService({getPool,selectLoan}) {
  const read=(context,operation)=>executeLedgerRead({getPool,...context,consistentSnapshot:true,operation})
  const write=(context,action,operation)=>executeIdempotentMutation({getPool,...context,currentReads:true,action,operation})
  async function editable(c,uid,data) {
    const loan=await selectLoan(c,uid,data.loanId,true)
    if (Number(loan.version)!==parseVersion(data.version)) throw ledgerError('CONFLICT')
    if (loan.archivedAt!=null) throw ledgerError('NOT_FOUND')
    if (loan.kind!=='installment' || !loan.scheduleTerms) throw ledgerError('VALIDATION_ERROR')
    return loan
  }
  async function installments(context) {
    return read(context,async(c,uid,revision)=>{
      const data=context.data,loan=await selectLoan(c,uid,data.loanId),view=await loadView(c,uid,loan),limit=size(data)
      const cursor=data.cursor?decodeCursor(context.subjectHash,data.cursor):null
      if (cursor && (cursor.action!=='loans.installments'||cursor.uid!==uid||cursor.loanId!==loan.loanId||cursor.version!==Number(loan.version)||cursor.revision!==revision)) throw ledgerError('CONFLICT')
      const offset=cursor?cursor.offset:0
      return {loanId:loan.loanId,loanVersion:Number(loan.version),archived:loan.archivedAt!=null,summary:view.summary,
        items:view.rows.slice(offset,offset+limit),nextCursor:offset+limit<view.rows.length?encodeCursor(context.subjectHash,
          {action:'loans.installments',uid,loanId:loan.loanId,version:Number(loan.version),revision,offset:offset+limit}):null}
    })
  }
  async function installment(context) {
    return read(context,async(c,uid)=>{
      const data=context.data,loan=await selectLoan(c,uid,data.loanId),view=await loadView(c,uid,loan)
      const row=view.rows.find(row=>row.periodNumber===data.periodNumber)
      if (!row) throw ledgerError('VALIDATION_ERROR')
      const [sources]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.loan_id=? AND i.period_number=? ORDER BY i.created_at DESC,i.item_id DESC LIMIT 41',[uid,loan.loanId,data.periodNumber])
      const [legacy]=await c.execute(`SELECT DISTINCT a.payment_id AS paymentId,p.status,p.total_minor AS totalMinor,p.occurred_local_at AS occurredLocalAt
        FROM catledger_loan_period_allocations a JOIN catledger_loan_periods t ON t.uid=a.uid AND t.period_id=a.period_id
        JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
        WHERE a.uid=? AND a.loan_id=? AND t.period_number=? AND a.active=1 ORDER BY p.occurred_local_at DESC LIMIT 20`,[uid,loan.loanId,data.periodNumber])
      return {loanId:loan.loanId,loanVersion:Number(loan.version),archived:loan.archivedAt!=null,period:row,
        sources:sources.slice(0,40).map(publicItem),moreSources:sources.length>40,legacyPayments:legacy.map(p=>({...p,totalMinor:String(p.totalMinor)}))}
    })
  }
  async function setInstallmentProgress(context) {
    return write(context,'loans.setInstallmentProgress',async(c,uid,data)=>{
      const loan=await editable(c,uid,data),progress=updateProgress(loan,data)
      if (data.completedThrough===undefined && data.periodNumber===undefined) throw ledgerError('VALIDATION_ERROR')
      if (data.bookCosts!==undefined && typeof data.bookCosts!=='boolean') throw ledgerError('VALIDATION_ERROR')
      if (data.bookCosts) {
        if (await require('./loan-charge-store').contract(c,uid,loan.loanId)) throw ledgerError('LOAN_TRANSACTION_LOCKED')
        if (data.status!=='completed' || !data.periodNumber) throw ledgerError('VALIDATION_ERROR')
        const view=await loadView(c,uid,loan),row=view.rows.find(row=>row.periodNumber===data.periodNumber)
        const [[account]]=await c.execute('SELECT type,archived_at AS archivedAt FROM catledger_accounts WHERE uid=? AND account_id=? FOR UPDATE',[uid,loan.accountId])
        if (!account || account.archivedAt!=null) throw ledgerError('ACCOUNT_INACTIVE')
        // 信用卡利息记在信用账户，随后整单转账清偿；不制造银行卡扣款。
        if (account.type!=='credit') throw ledgerError('VALIDATION_ERROR')
        const time=parseLocalDateTime(row.dueDate+'T12:00:00',-480)
        for (const component of ['interest','fee']) {
          const amount=row[component+'Minor']
          if (amount==='0' || await canonicalItem(c,uid,loan.loanId,row.periodNumber,component)) continue
          const transactionId=randomUUID()
          await c.execute(`INSERT INTO catledger_transactions
            (uid,transaction_id,type,source_account_id,amount_minor,occurred_local_date,occurred_local_at,timezone_offset_minutes,occurred_at_utc,note,origin)
            VALUES (?,?,'expense',?,?,?,?,?,?,?,'manual')`,[uid,transactionId,loan.accountId,amount,time.localDate,time.localAt,time.timezoneOffsetMinutes,time.occurredAtUtc,
            `${loan.name} 第${row.periodNumber}期${component==='interest'?'利息':'手续费'}`])
          await insertItem(c,uid,{accountId:loan.accountId,loanId:loan.loanId,periodNumber:row.periodNumber,totalTerms:Number(loan.scheduleTerms),
            component,amountMinor:amount,occurredDate:row.dueDate,origin:'manual',transactionId})
        }
      }
      await c.execute('UPDATE catledger_loans SET progress_json=?,version=version+1 WHERE uid=? AND loan_id=?',[JSON.stringify(progress),uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1}
    })
  }
  async function installmentSources(context) {
    return read(context,async(c,uid,revision)=>{
      const data=context.data,limit=size(data),accountId=data.accountId?validateId(data.accountId):null
      const itemId=data.itemId?validateId(data.itemId):null,cursor=data.cursor?decodeCursor(context.subjectHash,data.cursor):null
      if(cursor&&(cursor.action!=='loans.installmentSources'||cursor.uid!==uid||cursor.accountId!==accountId||cursor.itemId!==itemId||cursor.revision!==revision))throw ledgerError('CONFLICT')
      const [rows]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.active=1 AND i.loan_id IS NULL
        ${accountId?'AND i.account_id=?':''} ${itemId?'AND i.item_id=?':''} ${cursor?'AND i.item_id>?':''}
        AND (i.source_event_id IS NULL OR e.status IN ('posted','corrected') OR (e.status='excluded' AND u.status='posted'
          AND EXISTS(SELECT 1 FROM catledger_economic_event_transactions h WHERE h.uid=i.uid AND h.event_id=i.source_event_id
            AND h.transaction_id=i.transaction_id AND h.role='historical_primary' AND h.superseded_at IS NULL AND h.transaction_version=t.version)))
        AND (i.component='principal' OR (t.deleted_at IS NULL AND t.transaction_id IS NOT NULL))
        ORDER BY i.item_id LIMIT ?`,[uid,...(accountId?[accountId]:[]),...(itemId?[itemId]:[]),...(cursor?[cursor.last]:[]),limit+1])
      const items=rows.slice(0,limit).map(publicItem).filter(item=>item.active)
      return {items,nextCursor:rows.length>limit?encodeCursor(context.subjectHash,{action:'loans.installmentSources',uid,accountId,itemId,revision,last:rows[limit-1].itemId}):null}
    })
  }
  async function linkInstallmentSource(context) {
    return write(context,'loans.linkInstallmentSource',async(c,uid,data)=>{
      const loan=await editable(c,uid,data),linked=await attachSource(c,uid,loan,data.itemId)
      await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1,linked}
    })
  }
  async function archiveInstallment(context) {
    return write(context,'loans.archiveInstallment',async(c,uid,data)=>{
      const loan=await selectLoan(c,uid,data.loanId,true)
      if (Number(loan.version)!==parseVersion(data.version) || typeof data.archived!=='boolean') throw ledgerError('CONFLICT')
      if (loan.kind!=='installment') throw ledgerError('VALIDATION_ERROR')
      if (data.archived) {
        const store = require('./loan-charge-store'), contract = await store.contract(c,uid,loan.loanId)
        if (contract) {
          await c.execute('UPDATE catledger_loan_charge_contracts SET authorization_json=?,version=version+1 WHERE uid=? AND contract_id=?',
            [JSON.stringify({...contract.authorization,mode:'paused'}),uid,contract.contractId])
          await store.audit(c,uid,contract.contractId,null,'archive',{authorization:contract.authorization})
        }
        // 只释放管理关系；原始来源、费用交易及来源身份仍保留，重新关联不再次记账。
        await c.execute('UPDATE catledger_installment_items SET loan_id=NULL,version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
        await c.execute('DELETE FROM catledger_installment_bindings WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      }
      await c.execute('UPDATE catledger_loans SET archived_at='+ (data.archived?'CURRENT_TIMESTAMP(3)':'NULL') +',version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1,archived:data.archived}
    })
  }
  async function removeInstallmentItem(context) {
    return write(context,'loans.removeInstallmentItem',async(c,uid,data)=>{
      const loan=await editable(c,uid,data)
      const [[raw]]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.item_id=?',[uid,validateId(data.itemId)])
      if (!raw || raw.loanId!==loan.loanId || raw.origin!=='manual') throw ledgerError('VALIDATION_ERROR')
      const item=publicItem(raw)
      await require('./loan-charge-store').assertNoCharges(c,uid,[item.transactionId].filter(Boolean))
      if (item.version!==parseVersion(data.itemVersion)) throw ledgerError('CONFLICT')
      const [[used]]=await c.execute(`SELECT
        EXISTS(SELECT 1 FROM catledger_economic_event_transactions WHERE uid=? AND transaction_id=? AND superseded_at IS NULL) AS imported,
        EXISTS(SELECT 1 FROM catledger_transactions WHERE uid=? AND original_transaction_id=? AND deleted_at IS NULL) AS refunded`,[uid,item.transactionId,uid,item.transactionId])
      if (Number(used.imported) || Number(used.refunded)) throw ledgerError('LOAN_TRANSACTION_LOCKED')
      if (item.transactionId) await c.execute('UPDATE catledger_transactions SET deleted_at=CURRENT_TIMESTAMP(3),version=version+1 WHERE uid=? AND transaction_id=? AND deleted_at IS NULL',[uid,item.transactionId])
      await c.execute('UPDATE catledger_installment_items SET active=0,version=version+1 WHERE uid=? AND item_id=?',[uid,item.itemId])
      await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,loan.loanId])
      return {loanId:loan.loanId,version:Number(loan.version)+1}
    })
  }
  return {installments,installment,setInstallmentProgress,installmentSources,linkInstallmentSource,archiveInstallment,removeInstallmentItem}
}
module.exports={createInstallmentService,loadView,populateTracking}
