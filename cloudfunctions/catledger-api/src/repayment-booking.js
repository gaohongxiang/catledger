// 两个独立云函数包保持此模块完全一致，scripts/check.js 检查部署副本。
const { randomUUID } = require('node:crypto')
const { route, writesLoanPayment } = require('./repayment-policy')
const DETAILS = `SELECT d.payment_id AS paymentId,d.liability_account_id AS liabilityAccountId,
  d.principal_minor AS principalMinor,d.interest_minor AS interestMinor,d.fee_minor AS feeMinor,
  d.interest_treatment AS interestTreatment,d.fee_treatment AS feeTreatment,
  d.interest_category_id AS interestCategoryId,d.fee_category_id AS feeCategoryId
  FROM catledger_loan_repayment_details d`
function createRepaymentBooking(error) {
  const { id, amount, normalize, drafts } = require('./repayment-policy').createRepaymentPolicy(error)
  async function relation(connection, uid, input) {
    const [accounts] = await connection.execute(`SELECT account_id AS accountId,type,currency,archived_at AS archivedAt FROM catledger_accounts
      WHERE uid=? AND account_id IN (?,?) ORDER BY account_id FOR UPDATE`, [uid,input.assetAccountId,input.liabilityAccountId])
    const asset = accounts.find(a => a.accountId === input.assetAccountId), debt = accounts.find(a => a.accountId === input.liabilityAccountId)
    if (!asset || !debt || accounts.some(a => a.currency !== 'CNY' || a.archivedAt != null)) throw error('VALIDATION_ERROR')
    return { asset, debt }
  }
  async function validateCategories(connection, uid, input) {
    for (const categoryId of new Set(drafts(input).map(d => d.categoryId).filter(Boolean))) {
      const [[category]] = await connection.execute("SELECT kind FROM catledger_categories WHERE uid=? AND category_id=? AND archived_at IS NULL", [uid,categoryId])
      if (!category || category.kind !== 'expense') throw error('VALIDATION_ERROR')
    }
  }
  // 付款记录的两端：资产账户 → 能持有计划的负债账户（信用卡的分期计划同样适用）。
  async function validateRelations(connection, uid, input) {
    const accounts = await relation(connection, uid, input)
    if (!route(accounts.asset, accounts.debt)) throw error('VALIDATION_ERROR')
    await validateCategories(connection, uid, input)
    return accounts
  }
  async function detail(connection, uid, paymentId) {
    const [[row]] = await connection.execute(DETAILS + ' WHERE d.uid=? AND d.payment_id=?', [uid,id(paymentId)])
    return row ? { ...row, principalMinor:String(row.principalMinor),interestMinor:String(row.interestMinor),feeMinor:String(row.feeMinor) } : null
  }
  async function assign(connection, uid, payment, input, { advancePayment = true } = {}) {
    const [[existing]] = await connection.execute('SELECT loan_id FROM catledger_loan_payment_allocations WHERE uid=? AND payment_id=? LIMIT 1', [uid,payment.paymentId])
    if (existing || payment.status !== 'active') throw error('CONFLICT')
    const [[loan]] = await connection.execute(`SELECT loan_id AS loanId,account_id AS accountId,baseline_principal_minor AS baselinePrincipalMinor,
      baseline_date AS baselineDate,deleted_at AS deletedAt,version FROM catledger_loans WHERE uid=? AND loan_id=? FOR UPDATE`, [uid,id(input.loanId)])
    if (!loan || loan.deletedAt!=null || Number(loan.version) !== input.loanVersion) throw error('CONFLICT')
    if (loan.accountId !== input.liabilityAccountId) throw error('VALIDATION_ERROR')
    if (loan.baselinePrincipalMinor == null || loan.baselineDate == null) throw error('LOAN_PRINCIPAL_UNCONFIRMED')
    if (String(payment.occurredLocalAt).slice(0,10) < String(loan.baselineDate)) throw error('VALIDATION_ERROR')
    // 付款记录已由 settle/persist 校验；这里只复核两端与分类，计划必须属于该收款账户。
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
  async function persistLoan(connection, uid, input, { totalMinor, localAt, utcAt, timezoneOffsetMinutes, transactions, source = null } = {}) {
    const coverage = input.chargeAllocations || []
    let chargeItems = []
    if (input.mode==='associate' || coverage.length || ['interest','fee'].some(f => input[f+'Treatment']==='accrued' && input[f+'Minor']!=='0')) {
      if (input.mode !== 'associate') throw error('LOAN_CHARGE_COVERAGE')
      const [[loan]] = await connection.execute('SELECT loan_id AS loanId,account_id AS accountId FROM catledger_loans WHERE uid=? AND loan_id=?',[uid,input.loanId])
      if (!loan || loan.accountId!==input.liabilityAccountId) throw error('LOAN_CHARGE_COVERAGE')
      chargeItems = await require('./loan-charge-payments').validate(connection,uid,loan,input,{ paymentDate:localAt.slice(0,10) })
    }
    // 来源事件只在确实要写贷款付款记录时才读取，信用卡拆分不产生无用的来源查询。
    const resolvedSource = typeof source === 'function' ? await source() : source
    const paymentId = randomUUID(), mode = resolvedSource ? 'associate' : 'new'
    await connection.execute(`INSERT INTO catledger_loan_payments
      (uid,payment_id,kind,origin_mode,asset_account_id,total_minor,occurred_local_at,occurred_at_utc,timezone_offset_minutes)
      VALUES (?,?,'repayment',?,?,?,?,?,?)`, [uid,paymentId,mode,input.assetAccountId,totalMinor,localAt,utcAt,timezoneOffsetMinutes])
    await connection.execute(`INSERT INTO catledger_loan_repayment_details
      (uid,payment_id,liability_account_id,principal_minor,interest_minor,fee_minor,interest_treatment,fee_treatment,interest_category_id,fee_category_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [uid,paymentId,input.liabilityAccountId,input.principalMinor,input.interestMinor,input.feeMinor,
      input.interestTreatment,input.feeTreatment,input.interestCategoryId,input.feeCategoryId])
    for (const transaction of transactions) await connection.execute(`INSERT INTO catledger_loan_payment_transactions
      (uid,payment_id,transaction_id,transaction_version,created_by_payment) VALUES (?,?,?,?,?)`, [uid,paymentId,transaction.transactionId,transaction.version || 1,resolvedSource ? 0 : 1])
    if (resolvedSource) await connection.execute(`INSERT INTO catledger_loan_payment_sources
      (uid,payment_id,update_id,event_id,original_event_json,original_links_json,applied_event_version) VALUES (?,?,?,?,?,?,?)`,
      [uid,paymentId,resolvedSource.event.updateId,resolvedSource.event.eventId,JSON.stringify(resolvedSource.event),JSON.stringify(resolvedSource.links),resolvedSource.event.version])
    await require('./loan-charge-payments').persist(connection,uid,paymentId,chargeItems,transactions)
    const loans = input.mode === 'associate' ? [await assign(connection, uid,
      { paymentId,status:'active',assetAccountId:input.assetAccountId,occurredLocalAt:localAt }, input, { advancePayment:false })] : []
    return { paymentId,version:1,transactionCount:transactions.length,pending:loans.length === 0,loans }
  }
  // 手工“记还款”只服务贷款账户：信用卡的还款来自真实流水，导入后按需关联计划。
  async function persist(connection, uid, input, options = {}) {
    const accounts = await validateRelations(connection, uid, input)
    if (accounts.debt.type !== 'other_liability') throw error('VALIDATION_ERROR')
    return persistLoan(connection, uid, input, options)
  }
  // 导入还款的落账：校验两端和分类。关联了计划才写贷款付款记录（信用卡的分期计划同样如此）；
  // 不关联就只记转账，已记费用计入转账金额，收费项只能随计划冲抵。
  async function settle(connection, uid, input, options = {}) {
    const accounts = await relation(connection, uid, input)
    if (!route(accounts.asset, accounts.debt)) throw error('VALIDATION_ERROR')
    if (input.mode !== 'associate' && (input.chargeAllocations || []).length) throw error('LOAN_CHARGE_COVERAGE')
    await validateCategories(connection, uid, input)
    return writesLoanPayment(input, accounts.debt) ? persistLoan(connection, uid, input, options) : null
  }
  return { normalize,drafts,route,validateRelations,detail,assign,persist,settle }
}
module.exports = { createRepaymentBooking, DETAILS }
