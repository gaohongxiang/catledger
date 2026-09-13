const { randomUUID } = require('node:crypto')
const { ledgerError } = require('./ledger-errors')
const { validateId } = require('./transaction-domain')
const { selectTransaction, protectRefundedExpense } = require('./transaction-command-service')
const { digestRequest } = require('./request-digest')
const { encodeCursor } = require('./cursor')
const { parseLocalDateTime } = require('./local-time')
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const MAX_TRANSACTIONS = 60
async function sourceEvent(connection, uid, eventId, forUpdate = false) {
  const [[event]] = await connection.execute(`SELECT e.event_id AS eventId,e.update_id AS updateId,e.version,e.state,e.status,
    e.economic_nature AS economicNature,e.flow_direction AS flowDirection,e.ledger_account_id AS ledgerAccountId,
    e.counterparty_ledger_account_id AS counterpartyLedgerAccountId,e.category_id AS categoryId,
    e.manual_field_mask AS manualFieldMask,e.field_sources_json AS fieldSources,e.reason_codes_json AS reasonCodes,
    u.version AS updateVersion,u.status AS updateStatus FROM catledger_economic_events e
    JOIN catledger_finance_updates u ON u.uid=e.uid AND u.update_id=e.update_id WHERE e.uid=? AND e.event_id=?${forUpdate ? ' FOR UPDATE' : ''}`, [uid,eventId])
  if (!event || event.updateStatus !== 'posted' || !['posted','corrected'].includes(event.status)) throw ledgerError('CONFLICT')
  const result = { ...event, version: Number(event.version), updateVersion: Number(event.updateVersion), manualFieldMask: Number(event.manualFieldMask),
    fieldSources: parse(event.fieldSources) || {}, reasonCodes: parse(event.reasonCodes) || [] }
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw ledgerError('LOAN_SOURCE_TOO_LARGE')
  return result
}
async function eventLinks(connection, uid, event, forUpdate = false) {
  const [links] = await connection.execute(`SELECT link_id AS linkId,transaction_id AS transactionId,transaction_version AS transactionVersion,
    role,creation_method AS creationMethod FROM catledger_economic_event_transactions
    WHERE uid=? AND update_id=? AND event_id=? AND superseded_at IS NULL ORDER BY link_id LIMIT 61${forUpdate ? ' FOR UPDATE' : ''}`, [uid,event.updateId,event.eventId])
  if (!links.length || links.length > MAX_TRANSACTIONS || links.some(l => l.role === 'refund_original')) throw ledgerError('LOAN_SOURCE_MISMATCH')
  return links.map(l => ({ ...l, transactionVersion: Number(l.transactionVersion) }))
}
async function assertSourceUnbound(connection, uid, ids, allowedPaymentId = null) {
  const [rows] = await connection.execute(`SELECT payment_id AS paymentId FROM catledger_loan_payment_transactions
    WHERE uid=? AND active_transaction_id IN (${ids.map(() => '?').join(',')})`, [uid,...ids])
  if (rows.some(row => row.paymentId !== allowedPaymentId)) throw ledgerError('LOAN_TRANSACTION_LOCKED')
}
async function assertNoExternalLinks(connection, uid, ids, eventId = null) {
  const [[row]] = await connection.execute(`SELECT link_id FROM catledger_economic_event_transactions WHERE uid=?
    AND transaction_id IN (${ids.map(() => '?').join(',')}) AND superseded_at IS NULL
    ${eventId ? 'AND event_id<>?' : ''} LIMIT 1`, [uid,...ids,...(eventId ? [eventId] : [])])
  if (row) throw ledgerError('LOAN_TRANSACTION_LOCKED')
}
async function loadSource(connection, uid, requestedIds, { forUpdate = false, allowedPaymentId = null } = {}) {
  if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > MAX_TRANSACTIONS) throw ledgerError('VALIDATION_ERROR')
  let ids = [...new Set(requestedIds.map(validateId))].sort()
  if (ids.length !== requestedIds.length) throw ledgerError('VALIDATION_ERROR')
  // 先验证所选正式交易属于当前用户，再按经济事件扩大整个集合。
  for (const id of ids) {
    const row = await selectTransaction(connection, uid, id, { forUpdate })
    if (row.deletedAt) throw ledgerError('NOT_FOUND')
  }
  await assertSourceUnbound(connection, uid, ids, allowedPaymentId)
  const [refs] = await connection.execute(`SELECT DISTINCT event_id AS eventId FROM catledger_economic_event_transactions
    WHERE uid=? AND transaction_id IN (${ids.map(() => '?').join(',')}) AND superseded_at IS NULL AND role<>'refund_original' LIMIT 2`, [uid,...ids])
  if (refs.length > 1) throw ledgerError('LOAN_SOURCE_MISMATCH')
  const event = refs.length ? await sourceEvent(connection, uid, refs[0].eventId, forUpdate) : null
  const links = event ? await eventLinks(connection, uid, event, forUpdate) : []
  if (event) {
    const expanded = [...new Set(links.map(l => l.transactionId))].sort()
    if (ids.some(id => !expanded.includes(id))) throw ledgerError('LOAN_SOURCE_MISMATCH')
    ids = expanded
  }
  const transactions = []
  for (const id of ids) {
    const row = await selectTransaction(connection, uid, id, { forUpdate })
    if (row.deletedAt || !['expense','income','transfer'].includes(row.type)) throw ledgerError('LOAN_SOURCE_MISMATCH')
    if (links.some(l => l.transactionId === id && l.transactionVersion !== Number(row.version))) throw ledgerError('CONFLICT')
    // 读取也明确提示已有退款依赖；写入在同一用户锁下复核。
    await protectRefundedExpense(connection, uid, row, null)
    transactions.push(row)
  }
  await assertSourceUnbound(connection, uid, ids, allowedPaymentId)
  await assertNoExternalLinks(connection, uid, ids, event && event.eventId)
  return { transactions, event, links }
}
function sourceSelection(uid, secret, source) {
  const transactionIds = source.transactions.map(t => t.transactionId).sort()
  const digest = digestRequest('loans.source', { transactions: source.transactions.map(t => ({ id:t.transactionId,version:Number(t.version) })).sort((a,b) => a.id.localeCompare(b.id)),
    event: source.event ? { id:source.event.eventId,version:source.event.version,updateVersion:source.event.updateVersion } : null })
  return { transactionIds, fingerprint: encodeCursor(secret, { action:'loans.source',uid,digest }),
    event: source.event ? { eventId:source.event.eventId,updateId:source.event.updateId,eventVersion:source.event.version,updateVersion:source.event.updateVersion } : null }
}
function sourceTime(value, offset) { return parseLocalDateTime(String(value).replace(' ', 'T'), Number(offset)).localAt }
function signature(transaction) {
  return JSON.stringify([transaction.type,transaction.sourceAccountId || null,transaction.destinationAccountId || null,transaction.categoryId || null,
    sourceTime(transaction.localAt || transaction.occurredLocalAt,transaction.timezoneOffsetMinutes),Number(transaction.timezoneOffsetMinutes)])
}
function groupedAmounts(transactions) {
  const map = new Map()
  for (const row of transactions) { const key=signature(row);map.set(key,(map.get(key)||0n)+BigInt(row.amountMinor)) }
  return map
}
function validateSourceAmounts(source, input, drafts, loans, exact) {
  const liabilities = new Set([...loans.values()].map(l => l.accountId))
  let sum=0n
  for (const row of source.transactions) {
    const time=sourceTime(row.occurredLocalAt,row.timezoneOffsetMinutes)
    if (time!==input.localAt || Number(row.timezoneOffsetMinutes)!==input.timezoneOffsetMinutes) throw ledgerError('LOAN_SOURCE_MISMATCH')
    if (input.kind==='repayment') {
      if (!['expense','transfer'].includes(row.type) || row.sourceAccountId!==input.assetAccountId || (row.type==='transfer' && !liabilities.has(row.destinationAccountId))) throw ledgerError('LOAN_SOURCE_MISMATCH')
    } else if (!['income','transfer'].includes(row.type) || row.destinationAccountId!==input.assetAccountId || (row.type==='transfer' && !liabilities.has(row.sourceAccountId))) throw ledgerError('LOAN_SOURCE_MISMATCH')
    sum+=BigInt(row.amountMinor)
  }
  if (sum!==BigInt(input.totalMinor)) throw ledgerError('LOAN_SOURCE_MISMATCH')
  if (exact) {
    const actual=groupedAmounts(source.transactions), expected=groupedAmounts(drafts)
    if (actual.size!==expected.size || [...actual].some(([key,value]) => expected.get(key)!==value)) throw ledgerError('LOAN_SOURCE_MISMATCH')
  }
}
async function storedSource(connection, uid, paymentId) {
  const [[row]]=await connection.execute(`SELECT update_id AS updateId,event_id AS eventId,original_event_json AS originalEvent,
    original_links_json AS originalLinks,applied_event_version AS appliedEventVersion,active
    FROM catledger_loan_payment_sources WHERE uid=? AND payment_id=?`,[uid,paymentId])
  return row ? {...row,originalEvent:parse(row.originalEvent),originalLinks:parse(row.originalLinks),appliedEventVersion:row.appliedEventVersion==null?null:Number(row.appliedEventVersion)} : null
}
async function writeSourceEvent(connection, uid, event, next, paymentId, actionType) {
  const actionId=randomUUID(), digest=digestRequest(actionType,{paymentId,eventId:event.eventId,version:event.version})
  await connection.execute(`INSERT INTO catledger_finance_actions
    (uid,action_id,update_id,expected_update_version,applied_update_version,action_type,idempotency_key_digest,request_digest,status,decision_json,reason_codes_json,started_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,'applied',?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,[uid,actionId,event.updateId,event.updateVersion,event.updateVersion+1,actionType,digest,digest,JSON.stringify({paymentId}),JSON.stringify([actionType])])
  const [changedEvent]=await connection.execute(`UPDATE catledger_economic_events SET state=?,status=?,economic_nature=?,flow_direction=?,ledger_account_id=?,counterparty_ledger_account_id=?,
    category_id=?,manual_field_mask=?,field_sources_json=?,reason_codes_json=?,version=version+1 WHERE uid=? AND event_id=? AND version=?`,
  [next.state,next.status,next.economicNature,next.flowDirection,next.ledgerAccountId,next.counterpartyLedgerAccountId,next.categoryId,next.manualFieldMask,
    JSON.stringify(next.fieldSources),JSON.stringify(next.reasonCodes),uid,event.eventId,event.version])
  const [changedUpdate]=await connection.execute('UPDATE catledger_finance_updates SET version=version+1,current_action_id=? WHERE uid=? AND update_id=? AND version=?',[actionId,uid,event.updateId,event.updateVersion])
  if(changedEvent.affectedRows!==1 || changedUpdate.affectedRows!==1) throw ledgerError('CONFLICT')
  return event.version+1
}
async function saveSource(connection, uid, paymentId, source, input, { original = null, newTransactions = [] } = {}) {
  const rootEvent=original ? original.originalEvent : source.event, rootLinks=original ? original.originalLinks : source.links
  let applied=null
  if (source.event) {
    const event=source.event
    const next=input.mode==='associate' ? {...event,fieldSources:{...event.fieldSources,loanPaymentId:paymentId}} : {...event,state:'corrected',status:'corrected',economicNature:input.kind==='drawdown'?'borrow':'repayment',
      flowDirection:'neutral',ledgerAccountId:input.assetAccountId,counterpartyLedgerAccountId:null,categoryId:null,manualFieldMask:event.manualFieldMask|143,
      fieldSources:{...event.fieldSources,paymentResolution:null,repaymentAllocations:[],loanPaymentId:paymentId,loanSettlementVersion:1,
        loanSettlement:{totalMinor:input.totalMinor,kind:input.kind,allocations:input.allocations.map(a=>({loanId:a.loanId,principalMinor:a.principalMinor,interestMinor:a.interestMinor,feeMinor:a.feeMinor}))}},
      reasonCodes:[...new Set([...event.reasonCodes,'loan_payment_corrected'])]}
    if (input.mode!=='associate') {
      await connection.execute('UPDATE catledger_economic_event_transactions SET superseded_at=CURRENT_TIMESTAMP(3) WHERE uid=? AND event_id=? AND superseded_at IS NULL',[uid,event.eventId])
      for(const transaction of newTransactions) await connection.execute(`INSERT INTO catledger_economic_event_transactions
        (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version)
        VALUES (?,?,?,?,?,?,'created','loan-settlement-v1',1)`,[uid,randomUUID(),event.updateId,event.eventId,transaction.transactionId,input.kind==='drawdown'?'primary':'repayment_allocation'])
    }
    applied=await writeSourceEvent(connection,uid,event,next,paymentId,input.mode==='associate'?'associate_loan_payment':'correct_loan_payment')
  }
  await connection.execute(`INSERT INTO catledger_loan_payment_sources
    (uid,payment_id,update_id,event_id,original_event_json,original_links_json,applied_event_version) VALUES (?,?,?,?,?,?,?)`,
  [uid,paymentId,source.event&&source.event.updateId,source.event&&source.event.eventId,rootEvent?JSON.stringify(rootEvent):null,JSON.stringify(rootLinks),applied])
}
module.exports={MAX_TRANSACTIONS,sourceTime,loadSource,sourceSelection,validateSourceAmounts,sourceEvent,eventLinks,assertNoExternalLinks,storedSource,writeSourceEvent,saveSource}
