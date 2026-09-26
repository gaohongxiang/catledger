// 两支云函数独立打包相同领域文件；任何入账/关联都在原用户锁事务中执行。
const { randomUUID } = require('node:crypto')
const fail = code => { throw Object.assign(new Error(code), { code, publicCode: code }) }
// 调用方持有用户级写锁；附加只读收费来源关系不申请 UPDATE 锁。
const ITEM_SELECT = `SELECT i.item_id AS itemId,i.account_id AS accountId,i.loan_id AS loanId,
  i.reference_key AS referenceKey,i.reference_label AS referenceLabel,i.period_number AS periodNumber,i.total_terms AS totalTerms,
  i.component,i.amount_minor AS amountMinor,i.occurred_date AS occurredDate,i.origin,i.source_event_id AS eventId,
  i.source_identity_id AS identityId,i.transaction_id AS transactionId,i.canonical,i.active,i.version,
  t.version AS transactionVersion,t.deleted_at AS transactionDeleted,t.amount_minor AS transactionAmount,
  t.source_account_id AS transactionAccount,t.type AS transactionType,e.status AS eventStatus,e.update_id AS updateId,
  u.status AS updateStatus,
  cover.amount_minor AS coveredAmount,cover.state AS coverageState,cover.transaction_id AS registeredTransactionId,parent.transaction_id AS coveringTransactionId,
  EXISTS(SELECT 1 FROM catledger_economic_event_transactions h WHERE h.uid=i.uid AND h.event_id=i.source_event_id
    AND h.transaction_id=i.transaction_id AND h.role='historical_primary' AND h.superseded_at IS NULL
    AND h.transaction_version=t.version) AS historicalSource
  FROM catledger_installment_items i
  LEFT JOIN catledger_loan_charge_sources cs ON cs.uid=i.uid AND cs.item_id=i.item_id
  LEFT JOIN catledger_loan_charges cover ON cover.uid=cs.uid AND cover.charge_id=cs.charge_id
  LEFT JOIN catledger_loan_charges parent ON parent.uid=cover.uid AND parent.charge_id=cover.covered_by_charge_id
  LEFT JOIN catledger_transactions t ON t.uid=i.uid AND t.transaction_id=i.transaction_id
  LEFT JOIN catledger_economic_events e ON e.uid=i.uid AND e.event_id=i.source_event_id
  LEFT JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id`
function publicItem(row) {
  const reviewed = row.eventStatus==='excluded' && row.updateStatus==='posted' && Number(row.historicalSource)===1
  const valid = Boolean(row.active) && (!row.eventId || row.updateStatus==='posted' && ['posted','corrected'].includes(row.eventStatus) || reviewed) &&
    (row.component === 'principal' || row.transactionId && row.transactionDeleted == null && row.transactionType === 'expense' &&
      (row.transactionAccount === row.accountId || row.registeredTransactionId === row.transactionId) && (String(row.transactionAmount) === String(row.amountMinor) || row.coverageState === 'covered' && row.coveringTransactionId === row.transactionId && String(row.coveredAmount) === String(row.amountMinor)))
  return { itemId:row.itemId,accountId:row.accountId,loanId:row.loanId,referenceKey:row.referenceKey,referenceLabel:row.referenceLabel,
    periodNumber:Number(row.periodNumber),totalTerms:row.totalTerms==null?null:Number(row.totalTerms),component:row.component,
    amountMinor:String(row.amountMinor),occurredDate:row.occurredDate,origin:row.origin,eventId:row.eventId,updateId:row.updateId,
    identityId:row.identityId,transactionId:row.transactionId,transactionVersion:Number(row.transactionVersion || 0),
    canonical:Boolean(row.canonical),active:valid,version:Number(row.version) }
}
async function boundLoan(c,uid,accountId,referenceKey) {
  if (!referenceKey) return null
  const [[row]]=await c.execute(`SELECT l.loan_id AS loanId,l.account_id AS accountId,l.schedule_terms AS terms,l.archived_at AS archivedAt
    FROM catledger_installment_bindings b JOIN catledger_loans l ON l.uid=b.uid AND l.loan_id=b.loan_id
    WHERE b.uid=? AND b.account_id=? AND b.reference_key=?`,[uid,accountId,referenceKey])
  return row && row.archivedAt==null ? row : null
}
async function canonicalItem(c,uid,loanId,periodNumber,component) {
  if (!loanId) return null
  const [[row]]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.loan_id=? AND i.period_number=? AND i.component=? AND i.canonical=1 AND i.active=1',
    [uid,loanId,periodNumber,component])
  if (!row) return null
  const item=publicItem(row)
  if (item.active) return item
  // 删除或撤销过的来源保留审计，但不能挡住后续合法补录。
  if (row.component!=='principal' && row.transactionDeleted==null && row.transactionId) fail('LOAN_SOURCE_MISMATCH')
  await c.execute('UPDATE catledger_installment_items SET canonical=0,active=0,version=version+1 WHERE uid=? AND item_id=?',[uid,row.itemId])
  return null
}
async function insertItem(c,uid,value) {
  const itemId=value.itemId || randomUUID()
  await c.execute(`INSERT INTO catledger_installment_items
    (uid,item_id,account_id,loan_id,reference_key,reference_label,period_number,total_terms,component,amount_minor,occurred_date,origin,source_event_id,source_identity_id,transaction_id,canonical)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[uid,itemId,value.accountId,value.loanId||null,value.referenceKey||null,value.referenceLabel||null,
    value.periodNumber,value.totalTerms||null,value.component,String(value.amountMinor),value.occurredDate,value.origin,
    value.eventId||null,value.identityId||null,value.transactionId||null,value.canonical===false?0:1])
  return itemId
}
async function assertCostSource(c,uid,incoming,canonical) {
  if (!canonical || incoming.component==='principal' || !canonical.transactionId) return
  if (incoming.transactionId===canonical.transactionId) return
  // 明确期号可以归属分期，但两条不同银行流水不能仅因金额相同就合并费用。
  const [sources]=await c.execute(ITEM_SELECT+` WHERE i.uid=? AND i.transaction_id=? AND i.origin='import' AND i.active=1`,[uid,canonical.transactionId])
  if (sources.some(row=>publicItem(row).active && row.eventId!==incoming.eventId && (!incoming.identityId || row.identityId!==incoming.identityId))) fail('LOAN_SOURCE_MISMATCH')
}
async function prepareImport(c,uid,event,identityIds,reviewedTransactionId=null) {
  const evidence=event.fieldSources && event.fieldSources.installment
  if (!evidence) return null
  if (evidence.component==='principal' ? event.economicNature!=='repayment' : !['expense','fee'].includes(event.economicNature)) return null
  if (evidence.creditStatement!==true) fail('LOAN_SOURCE_MISMATCH')
  const [[account]]=await c.execute('SELECT type FROM catledger_accounts WHERE uid=? AND account_id=?',[uid,event.ledgerAccountId])
  if (!account || account.type!=='credit') fail('LOAN_SOURCE_MISMATCH')
  const identityId=identityIds.length===1?identityIds[0]:null
  const loan=await boundLoan(c,uid,event.ledgerAccountId,evidence.referenceKey)
  if (loan && (evidence.periodNumber>Number(loan.terms) || evidence.totalTerms && evidence.totalTerms!==Number(loan.terms))) fail('LOAN_SOURCE_MISMATCH')
  let previous=null
  if (identityId) {
    const [[row]]=await c.execute(ITEM_SELECT+' WHERE i.uid=? AND i.source_identity_id=?',[uid,identityId])
    if (row) {
      previous=publicItem(row)
      if (!previous.active) {
        // 失效来源不复活旧交易；释放原身份占位，保留旧来源记录。
        await c.execute('UPDATE catledger_installment_items SET source_identity_id=NULL,canonical=0,active=0,version=version+1 WHERE uid=? AND item_id=?',[uid,row.itemId])
        previous=null
      }
    }
  }
  const chargeMatch=await require('./loan-charge-import').prepare(c,uid,event,evidence,loan && loan.loanId)
  const canonical=chargeMatch ? null : previous || await canonicalItem(c,uid,loan && loan.loanId,evidence.periodNumber,evidence.component)
  if (canonical && (canonical.amountMinor!==String(event.amountMinor) || canonical.accountId!==event.ledgerAccountId)) fail('LOAN_SOURCE_MISMATCH')
  if (reviewedTransactionId && canonical && canonical.transactionId!==reviewedTransactionId) fail('LOAN_SOURCE_MISMATCH')
  if (!reviewedTransactionId) await assertCostSource(c,uid,{...evidence,eventId:event.eventId,identityId},canonical)
  return { ...evidence,accountId:event.ledgerAccountId,loanId:chargeMatch && chargeMatch.loanId || loan && loan.loanId || previous && previous.loanId || null,
    amountMinor:String(event.amountMinor),occurredDate:event.localDate,origin:'import',eventId:event.eventId,identityId,
    chargeMatch,existingItem:previous,canonicalItem:canonical,reuseTransactionId:chargeMatch && chargeMatch.transactionId || canonical && canonical.transactionId,
    reuseTransactionVersion:chargeMatch && chargeMatch.transactionVersion || canonical && canonical.transactionVersion }
}
async function persistImport(c,uid,prepared,transactionId) {
  if (!prepared || prepared.existingItem) return
  const itemId=await insertItem(c,uid,{...prepared,transactionId:prepared.reuseTransactionId || transactionId,canonical:!prepared.canonicalItem&&!prepared.chargeMatch})
  await require('./loan-charge-import').persist(c,uid,prepared.chargeMatch,itemId,prepared.reuseTransactionId || transactionId)
  if (prepared.loanId) await c.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?',[uid,prepared.loanId])
}
async function persistReviewedImports(c,uid,updateId,events,identities) {
  const selected=events.filter(event=>event.status==='excluded' && event.fieldSources && event.fieldSources.installment)
  if (!selected.length) return
  const [links]=await c.execute(`SELECT h.event_id AS eventId,h.transaction_id AS transactionId,t.type,
    t.source_account_id AS accountId,t.amount_minor AS amountMinor
    FROM catledger_economic_event_transactions h JOIN catledger_transactions t ON t.uid=h.uid AND t.transaction_id=h.transaction_id
    WHERE h.uid=? AND h.update_id=? AND h.role='historical_primary' AND h.superseded_at IS NULL
      AND t.deleted_at IS NULL AND t.version=h.transaction_version`,[uid,updateId])
  for (const event of selected) {
    const link=links.find(row=>row.eventId===event.eventId)
    if (!link) continue
    const prepared=await prepareImport(c,uid,event,identities.get(event.eventId)||[],link.transactionId)
    if (!prepared) continue
    if (prepared.component==='principal' || link.type!=='expense' || link.accountId!==prepared.accountId || String(link.amountMinor)!==prepared.amountMinor) fail('LOAN_SOURCE_MISMATCH')
    // 用户明确确认同一笔历史费用，只保存归期来源；不再写一笔 expense。
    await persistImport(c,uid,prepared,link.transactionId)
  }
}
module.exports={ITEM_SELECT,publicItem,boundLoan,canonicalItem,insertItem,assertCostSource,prepareImport,persistImport,persistReviewedImports}
