// 两个独立云函数包保持此模块完全一致，scripts/check.js 检查部署副本。
const { randomUUID } = require('node:crypto')
const DETAILS = `SELECT d.payment_id AS paymentId,d.liability_account_id AS liabilityAccountId,
  d.principal_minor AS principalMinor,d.interest_minor AS interestMinor,d.fee_minor AS feeMinor,
  d.interest_treatment AS interestTreatment,d.fee_treatment AS feeTreatment,
  d.interest_category_id AS interestCategoryId,d.fee_category_id AS feeCategoryId
  FROM catledger_loan_repayment_details d`
function createRepaymentBooking(error) {
  function id(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw error('VALIDATION_ERROR')
    return value
  }
  function amount(value, positive = false) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n || (positive && value === '0')) throw error('VALIDATION_ERROR')
    return value
  }
  function normalize(value, totalMinor) {
    if (!value || value.confirmed !== true || !['defer','associate'].includes(value.mode)) throw error('VALIDATION_ERROR')
    const result = { chargeAllocations: require('./loan-charge-payments').normalizeCoverage(value.chargeAllocations), confirmed: true, mode: value.mode, assetAccountId: id(value.assetAccountId), liabilityAccountId: id(value.liabilityAccountId) }
    for (const field of ['principal','interest','fee']) result[field + 'Minor'] = amount(value[field + 'Minor'])
    if (['principal','interest','fee'].reduce((sum, field) => sum + BigInt(result[field + 'Minor']), 0n) !== BigInt(amount(totalMinor, true))) throw error('VALIDATION_ERROR')
    for (const field of ['interest','fee']) {
      if (!['expense','accrued'].includes(value[field + 'Treatment'])) throw error('VALIDATION_ERROR')
      result[field + 'Treatment'] = value[field + 'Treatment']
      result[field + 'CategoryId'] = value[field + 'Treatment'] === 'expense' && result[field + 'Minor'] !== '0' ? id(value[field + 'CategoryId']) : null
    }
    if (result.mode === 'associate') {
      result.loanId = id(value.loanId)
      if (!Number.isSafeInteger(value.loanVersion) || value.loanVersion < 1) throw error('VALIDATION_ERROR')
      result.loanVersion = value.loanVersion
    }
    return result
  }
  function drafts(input) {
    const result = []
    let transfer = BigInt(input.principalMinor)
    for (const field of ['interest','fee']) {
      if (input[field + 'Treatment'] === 'accrued') transfer += BigInt(input[field + 'Minor'])
      else if (input[field + 'Minor'] !== '0') {
        const selected=(input.chargeAllocations||[]).filter(c=>c.component===field)
        const portions=selected.length?selected:[{amountMinor:input[field+'Minor']}]
        for(const portion of portions)result.push({type:'expense',sourceAccountId:input.assetAccountId,destinationAccountId:null,
          categoryId:input[field+'CategoryId'],originalTransactionId:null,amountMinor:portion.amountMinor,role:'repayment_allocation',
          ...(portion.chargeId?{chargeId:portion.chargeId}:{})})
      }
    }
    if (transfer) result.unshift({ type: 'transfer', sourceAccountId: input.assetAccountId, destinationAccountId: input.liabilityAccountId,
      categoryId: null, originalTransactionId: null, amountMinor: String(transfer), role: 'repayment_allocation' })
    return result
  }
  async function validateRelations(connection, uid, input) {
    const [accounts] = await connection.execute(`SELECT account_id AS accountId,type,currency,archived_at AS archivedAt FROM catledger_accounts
      WHERE uid=? AND account_id IN (?,?) ORDER BY account_id FOR UPDATE`, [uid,input.assetAccountId,input.liabilityAccountId])
    const asset = accounts.find(a => a.accountId === input.assetAccountId), debt = accounts.find(a => a.accountId === input.liabilityAccountId)
    if (!asset || !debt || accounts.some(a => a.currency !== 'CNY' || a.archivedAt != null) ||
      !['cash','bank','wallet','other_asset'].includes(asset.type) || debt.type !== 'other_liability') throw error('VALIDATION_ERROR')
    for (const categoryId of new Set(drafts(input).map(d => d.categoryId).filter(Boolean))) {
      const [[category]] = await connection.execute("SELECT kind FROM catledger_categories WHERE uid=? AND category_id=? AND archived_at IS NULL", [uid,categoryId])
      if (!category || category.kind !== 'expense') throw error('VALIDATION_ERROR')
    }
  }
  async function detail(connection, uid, paymentId) {
    const [[row]] = await connection.execute(DETAILS + ' WHERE d.uid=? AND d.payment_id=?', [uid,id(paymentId)])
    return row ? { ...row, principalMinor:String(row.principalMinor),interestMinor:String(row.interestMinor),feeMinor:String(row.feeMinor) } : null
  }
  async function assign(connection, uid, payment, input, { advancePayment = true } = {}) {
    const [[existing]] = await connection.execute('SELECT loan_id FROM catledger_loan_payment_allocations WHERE uid=? AND payment_id=? LIMIT 1', [uid,payment.paymentId])
    if (existing || payment.status !== 'active') throw error('CONFLICT')
    const [[loan]] = await connection.execute(`SELECT loan_id AS loanId,account_id AS accountId,baseline_principal_minor AS baselinePrincipalMinor,
      baseline_date AS baselineDate,version FROM catledger_loans WHERE uid=? AND loan_id=? FOR UPDATE`, [uid,id(input.loanId)])
    if (!loan || Number(loan.version) !== input.loanVersion) throw error('CONFLICT')
    if (loan.accountId !== input.liabilityAccountId) throw error('VALIDATION_ERROR')
    if (loan.baselinePrincipalMinor == null || loan.baselineDate == null) throw error('LOAN_PRINCIPAL_UNCONFIRMED')
    if (String(payment.occurredLocalAt).slice(0,10) < String(loan.baselineDate)) throw error('VALIDATION_ERROR')
    await validateRelations(connection, uid, { ...input, assetAccountId:payment.assetAccountId })
    if(advancePayment) {
      const charges=await require('./loan-charge-payments').validate(connection,uid,loan,input,{paymentDate:String(payment.occurredLocalAt).slice(0,10)})
      // 延后关联已有费用必须用真实付款组中的费用交易认领，禁止事后另造费用。
      const [transactions]=await connection.execute("SELECT t.transaction_id AS transactionId,t.amount_minor AS amountMinor,t.type FROM catledger_loan_payment_transactions p JOIN catledger_transactions t ON t.uid=p.uid AND t.transaction_id=p.transaction_id WHERE p.uid=? AND p.payment_id=? AND p.active=1",[uid,payment.paymentId])
      for(const charge of charges.filter(c=>c.treatment==='expense')) {
        const matches=transactions.filter(t=>t.type==='expense'&&String(t.amountMinor)===charge.amountMinor&&!t.chargeId)
        if(matches.length!==1)throw error('LOAN_CHARGE_COVERAGE')
        matches[0].chargeId=charge.chargeId
      }
      await require('./loan-charge-payments').persist(connection,uid,payment.paymentId,charges,transactions)
    }
    await connection.execute(`INSERT INTO catledger_loan_payment_allocations
      (uid,payment_id,loan_id,principal_minor,interest_minor,fee_minor,interest_treatment,fee_treatment,interest_category_id,fee_category_id,confirmed_loan_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [uid,payment.paymentId,input.loanId,input.principalMinor,input.interestMinor,input.feeMinor,
      input.interestTreatment,input.feeTreatment,input.interestCategoryId,input.feeCategoryId,input.loanVersion])
    // 同时检查所有历史时点，不能用今天的余额掩盖回溯还款造成的负本金。
    const [[timeline]] = await connection.execute(`SELECT MIN(balance) AS minimum,MAX(balance) AS maximum,MIN(localAt) AS firstAt FROM (
      SELECT p.occurred_local_at AS localAt,CAST(? AS DECIMAL(65,0)) + SUM(IF(p.kind='drawdown',CAST(a.principal_minor AS DECIMAL(65,0)),-CAST(a.principal_minor AS DECIMAL(65,0))))
      OVER (ORDER BY p.occurred_local_at,(p.kind='repayment'),p.payment_id ROWS UNBOUNDED PRECEDING) AS balance
      FROM catledger_loan_payment_allocations a JOIN catledger_loan_payments p ON p.uid=a.uid AND p.payment_id=a.payment_id
      WHERE a.uid=? AND a.loan_id=? AND p.status='active') timeline`, [String(loan.baselinePrincipalMinor),uid,input.loanId])
    if (timeline.minimum != null && (BigInt(timeline.minimum) < 0n || BigInt(timeline.maximum) > 9223372036854775807n)) throw error('LOAN_PRINCIPAL_EXCEEDED')
    if (timeline.firstAt && String(timeline.firstAt).slice(0,10) < String(loan.baselineDate)) throw error('VALIDATION_ERROR')
    await connection.execute('UPDATE catledger_loans SET version=version+1 WHERE uid=? AND loan_id=?', [uid,input.loanId])
    if (advancePayment) await connection.execute('UPDATE catledger_loan_payments SET version=version+1 WHERE uid=? AND payment_id=?', [uid,payment.paymentId])
    return { loanId:input.loanId,version:input.loanVersion + 1 }
  }
  async function persist(connection, uid, input, { totalMinor, localAt, utcAt, timezoneOffsetMinutes, transactions, source = null }) {
    await validateRelations(connection, uid, input)
    const coverage = input.chargeAllocations || []
    let chargeItems = []
    if (input.mode==='associate' || coverage.length || ['interest','fee'].some(f => input[f+'Treatment']==='accrued' && input[f+'Minor']!=='0')) {
      if (input.mode !== 'associate') throw error('LOAN_CHARGE_COVERAGE')
      const [[loan]] = await connection.execute('SELECT loan_id AS loanId,account_id AS accountId FROM catledger_loans WHERE uid=? AND loan_id=?',[uid,input.loanId])
      if (!loan || loan.accountId!==input.liabilityAccountId) throw error('LOAN_CHARGE_COVERAGE')
      chargeItems = await require('./loan-charge-payments').validate(connection,uid,loan,input,{paymentDate:localAt.slice(0,10)})
    }
    const paymentId = randomUUID(), mode = source ? 'associate' : 'new'
    await connection.execute(`INSERT INTO catledger_loan_payments
      (uid,payment_id,kind,origin_mode,asset_account_id,total_minor,occurred_local_at,occurred_at_utc,timezone_offset_minutes)
      VALUES (?,?,'repayment',?,?,?,?,?,?)`, [uid,paymentId,mode,input.assetAccountId,totalMinor,localAt,utcAt,timezoneOffsetMinutes])
    await connection.execute(`INSERT INTO catledger_loan_repayment_details
      (uid,payment_id,liability_account_id,principal_minor,interest_minor,fee_minor,interest_treatment,fee_treatment,interest_category_id,fee_category_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [uid,paymentId,input.liabilityAccountId,input.principalMinor,input.interestMinor,input.feeMinor,
      input.interestTreatment,input.feeTreatment,input.interestCategoryId,input.feeCategoryId])
    for (const transaction of transactions) await connection.execute(`INSERT INTO catledger_loan_payment_transactions
      (uid,payment_id,transaction_id,transaction_version,created_by_payment) VALUES (?,?,?,?,?)`, [uid,paymentId,transaction.transactionId,transaction.version || 1,source ? 0 : 1])
    if (source) await connection.execute(`INSERT INTO catledger_loan_payment_sources
      (uid,payment_id,update_id,event_id,original_event_json,original_links_json,applied_event_version) VALUES (?,?,?,?,?,?,?)`,
      [uid,paymentId,source.event.updateId,source.event.eventId,JSON.stringify(source.event),JSON.stringify(source.links),source.event.version])
    await require('./loan-charge-payments').persist(connection,uid,paymentId,chargeItems,transactions)
    const loans = input.mode === 'associate' ? [await assign(connection, uid,
      { paymentId,status:'active',assetAccountId:input.assetAccountId,occurredLocalAt:localAt }, input, { advancePayment:false })] : []
    return { paymentId,version:1,transactionCount:transactions.length,pending:loans.length === 0,loans }
  }
  return { normalize,drafts,validateRelations,detail,assign,persist }
}
module.exports = { createRepaymentBooking, DETAILS }
