const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { chargeLab, prepareBank, postBank } = require('./helpers/loan-charges')

test('历史确认使用当时事实，计划修订不改变本金与清偿', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const h = await chargeLab()
  const view = loan => h.api('loans.installments', { loanId: loan.loanId, pageSize: 40 })
  const confirm = async (loan, paid) => h.api('loans.confirmInstallments', {
    requestId: randomUUID(), loanId: loan.loanId, version: (await view(loan)).loanVersion,
    repayments: [{ periodNumber: 1, paid }]
  })
  try {
    for (const revised of ['60000', '40000']) await t.test('6000确认500，计划改' + revised + '分再撤回仍为6000', async () => {
      const loan = await h.create({ repaymentMinor: '50000' })
      await confirm(loan, true)
      assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '550000')
      const current = await view(loan), row = current.items[0]
      await h.api('loans.savePeriod', { requestId: randomUUID(), loanId: loan.loanId, loanVersion: current.loanVersion,
        periodId: row.periodId, version: row.version, periodNumber: 1, dueDate: row.dueDate,
        principalMinor: revised, interestMinor: '0', feeMinor: '0', cancelled: false })
      await confirm(loan, false)
      assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '600000')
      await confirm(loan, false)
      assert.equal((await h.api('loans.get', { loanId: loan.loanId })).loan.remainingPrincipalMinor, '600000')
    })
    await t.test('已导入利息确认历史已还，不增加交易或调整，并退出待清偿', async () => {
      await postBank(h, await prepareBank(h, { period: 1, date: '2026-01-31' }))
      const source = (await h.api('loans.installmentSources')).items[0]
      const loan = await h.create({ sourceItemId: source.itemId })
      const before = await h.api('accounts.list')
      await confirm(loan, true)
      const charge = (await h.state(loan)).items.find(i => i.chargeKey === 'period:1:interest')
      assert.equal(charge.transactionId, source.transactionId)
      assert.equal(charge.balanceAdjustmentId, null)
      assert.equal(charge.outstandingMinor, '0')
      assert.deepEqual((await h.api('accounts.list')).accounts, before.accounts)
      await confirm(loan, false)
      const restored = (await h.state(loan)).items.find(i => i.chargeId === charge.chargeId)
      assert.equal(restored.transactionId, source.transactionId)
      assert.equal(restored.outstandingMinor, '2000')
    })
    await t.test('已进入新流程的贷款不能由旧进度入口绕过事实', async () => {
      const loan = await h.create({ repaymentMinor: '50000' })
      await confirm(loan, true)
      await assert.rejects(h.api('loans.setInstallmentProgress', {
        requestId: randomUUID(), loanId: loan.loanId, version: (await view(loan)).loanVersion,
        periodNumber: 1, status: 'unpaid'
      }), { publicCode: 'LOAN_TRANSACTION_LOCKED' })
      assert.equal((await view(loan)).items[0].complete, true)
    })
    await t.test('先修订再首次确认，原请求重放和重复确认均只影响一次', async () => {
      const loan=await h.create({repaymentMinor:'50000'}), initial=await view(loan), row=initial.items[0]
      await h.api('loans.savePeriod',{requestId:randomUUID(),loanId:loan.loanId,loanVersion:initial.loanVersion,
        periodId:row.periodId,version:row.version,periodNumber:1,dueDate:row.dueDate,principalMinor:'60000',interestMinor:'0',feeMinor:'0'})
      const payload={requestId:randomUUID(),loanId:loan.loanId,version:(await view(loan)).loanVersion,repayments:[{periodNumber:1,paid:true}]}
      const result=await h.api('loans.confirmInstallments',payload)
      assert.deepEqual(await h.api('loans.confirmInstallments',payload),result)
      await confirm(loan,true)
      assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'540000')
      await assert.rejects(h.api('loans.confirmInstallments',{...payload,requestId:randomUUID()}),{publicCode:'CONFLICT'})
      await confirm(loan,false)
      assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'600000')
    })
    await t.test('已有实际还款后，历史确认不能制造负本金；审计失败全部回滚', async () => {
      const loan=await h.create({repaymentMinor:'50000'})
      await h.api('loans.record',{requestId:randomUUID(),mode:'new',kind:'repayment',assetAccountId:h.assetAccountId,totalMinor:'570000',
        occurredLocalAt:'2026-02-28T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
        allocations:[{loanId:loan.loanId,version:1,principalMinor:'570000',interestMinor:'0',feeMinor:'0',interestTreatment:'expense',feeTreatment:'expense'}]})
      const before=await view(loan)
      await assert.rejects(confirm(loan,true),{publicCode:'LOAN_PRINCIPAL_EXCEEDED'})
      assert.deepEqual(await view(loan),before)
      const other=await h.create({repaymentMinor:'50000'}), original=await view(other)
      await h.owner.query("CREATE TRIGGER fail_history_fact BEFORE INSERT ON catledger_loan_charge_audit FOR EACH ROW BEGIN IF NEW.action='save_repayments' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic fact rollback'; END IF; END")
      try { await assert.rejects(confirm(other,true),{publicCode:'INTERNAL_ERROR'}) }
      finally { await h.owner.query('DROP TRIGGER fail_history_fact') }
      assert.deepEqual(await view(other),original)
      assert.equal((await h.api('loans.get',{loanId:other.loanId})).loan.remainingPrincipalMinor,'600000')
    })
    await t.test('历史本金与利息后补真实凭证仅升级；撤销关联仍保留历史事实', async () => {
      const loan=await h.create()
      await confirm(loan,true)
      const charge=(await h.state(loan)).items[0], beforePrincipal=(await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor
      const txn=await h.api('transactions.create',{requestId:randomUUID(),type:'transfer',sourceAccountId:h.assetAccountId,
        destinationAccountId:h.accountId,amountMinor:'100000',occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480})
      const before=(await h.api('accounts.list')).accounts, current=await view(loan)
      const source=(await h.api('loans.source',{transactionIds:[txn.transactionId]})).source
      const payload={requestId:randomUUID(),mode:'associate',kind:'repayment',source,assetAccountId:h.assetAccountId,totalMinor:'100000',unallocatedMinor:'48000',
        occurredLocalAt:'2026-01-31T12:00:00',timezoneOffsetMinutes:-480,confirmed:true,
        allocations:[{loanId:loan.loanId,version:current.loanVersion,period:{periodNumber:1,version:current.items[0].version},
          principalMinor:'50000',interestMinor:'2000',feeMinor:'0',interestTreatment:'accrued',feeTreatment:'expense',
          chargeAllocations:[{chargeId:charge.chargeId,component:'interest',amountMinor:'2000'}]}]}
      const paid=await h.api('loans.record',payload)
      assert.deepEqual(await h.api('loans.record',payload),paid)
      assert.deepEqual((await h.api('accounts.list')).accounts,before)
      assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,beforePrincipal)
      const fee=(await h.state(loan)).items[0]
      assert.equal(fee.settledMinor,'2000');assert.equal(fee.historicalCoveredMinor,'0');assert.equal(fee.outstandingMinor,'0')
      await assert.rejects(confirm(loan,false),{publicCode:'LOAN_TRANSACTION_LOCKED'})
      await h.api('loans.reverse',{requestId:randomUUID(),paymentId:paid.paymentId,version:1,loans:paid.loans,confirmed:true})
      assert.deepEqual((await h.api('accounts.list')).accounts,before)
      assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,beforePrincipal)
      assert.equal((await h.state(loan)).items[0].historicalCoveredMinor,'2000')
    })
    await t.test('历史补费20更正18，保全与覆盖同步；真实退款不重复冲减覆盖', async () => {
      const loan=await h.create(),before=(await h.api('accounts.list')).accounts
      await confirm(loan,true)
      let charge=(await h.state(loan)).items[0]
      const input={loanId:loan.loanId,chargeId:charge.chargeId,operation:'adjust',amountMinor:'1800'}
      const impact=await h.api('loans.chargeImpact',input)
      assert.equal(impact.canChange,true)
      await h.api('loans.changeCharge',{...input,previewToken:impact.previewToken,requestId:randomUUID(),confirmed:true})
      charge=(await h.state(loan)).items[0]
      assert.equal(charge.historicalSettledMinor,'1800');assert.equal(charge.outstandingMinor,'0')
      assert.deepEqual((await h.api('accounts.list')).accounts,before)
      const refund={loanId:loan.loanId,chargeId:charge.chargeId,operation:'refund',amountMinor:'200',destinationAccountId:h.assetAccountId,occurredLocalAt:'2026-02-01T12:00:00',timezoneOffsetMinutes:-480}
      const preview=await h.api('loans.chargeImpact',refund)
      await h.api('loans.changeCharge',{...refund,previewToken:preview.previewToken,requestId:randomUUID(),confirmed:true})
      charge=(await h.state(loan)).items[0]
      assert.equal(charge.netAmountMinor,'1600');assert.equal(charge.historicalCoveredMinor,'1600');assert.equal(charge.outstandingMinor,'0')
      await assert.rejects(confirm(loan,false),{publicCode:'LOAN_TRANSACTION_LOCKED'})
    })
    await t.test('无法证明的旧确认保留原状，读不回填，拒绝按现计划撤回', async () => {
      const loan=await h.create({repaymentMinor:'50000'})
      await confirm(loan,true)
      await h.owner.execute("UPDATE catledger_loans SET progress_json=JSON_REMOVE(progress_json,'$.historyFacts') WHERE uid=? AND loan_id=?",[h.uid,loan.loanId])
      const old=await view(loan)
      assert.equal(old.summary.historyNeedsReview,true)
      await assert.rejects(confirm(loan,false),{publicCode:'LOAN_HISTORY_REVIEW_REQUIRED'})
      assert.deepEqual(await view(loan),old)
      assert.equal((await h.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'550000')
    })
  } finally { await h.close() }
})
