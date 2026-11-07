const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { localServices, call } = require('./helpers/local-services')
const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])

// 未来分期欠款边界：有账单来源时用「账单锚点（最早期次）」，只算锚点之后的期次；
// 即使这些期次的到期日早于账单到期还款日也一样（不再靠日期猜）。
test('未来分期欠款用账单锚点作边界：锚点及之前不计，之后才计入', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const db = await require('../scripts/isolated-mysql').isolatedMysql()
  try {
    const grants = require('../scripts/runtime-role-grants')
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const api = (action, data) => call(services.api, action, data)
    const identity = await api('bootstrap'), uid = identity.uid
    const account = await api('accounts.create', { requestId: randomUUID(), name: '合成锚点卡' + randomUUID().slice(0, 6), type: 'credit',
      occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    // 账单到期还款日为 2026-09-02；但锚点按账单里出现的最早期次=第8期判定。
    await db.owner.execute('UPDATE catledger_accounts SET statement_due_minor=?,statement_due_date=? WHERE uid=? AND account_id=?',
      ['100000', '2026-09-02', uid, account.accountId])
    const loanId = randomUUID()
    await db.owner.execute('INSERT INTO catledger_loans (uid,loan_id,account_id,name,kind,baseline_principal_minor,baseline_date,version) VALUES (?,?,?,?,?,?,?,1)',
      [uid, loanId, account.accountId, '锚点分期', 'installment', '600000', '2026-08-01'])
    // 期次 8..12，每期本金50000 利息0（含手续费0）。注意：期次8、9 的 due_date 都 <= 2026-09-02。
    for (const n of [8, 9, 10, 11, 12]) {
      await db.owner.execute('INSERT INTO catledger_loan_periods (uid,period_id,loan_id,period_number,due_date,principal_minor,interest_minor,fee_minor,cancelled,version) VALUES (?,?,?,?,?,?,?,?,0,1)',
        [uid, randomUUID(), loanId, n, n === 8 ? '2026-08-13' : n === 9 ? '2026-09-01' : '2026-10-13', '50000', '0', '0'])
    }
    const find = async () => (await api('accounts.list')).accounts.find(a => a.accountId === account.accountId)

    await t.test('无账单来源时按到期还款日算：期次8、9(<=9/2)不算，10、11、12算', async () => {
      const a = await find()
      // 未来期次：10、11、12 各 50000 = 150000；账单本期应还 100000 → 总欠款 250000
      assert.equal(a.debtMinor, '250000')
    })

    await t.test('关联账单来源(最早期次=8)后，只算第9期及之后(锚点之后)', async () => {
      // 插入账单来源：第8期 principal，锚点=8。
      await db.owner.execute('INSERT INTO catledger_installment_items (uid,item_id,account_id,loan_id,period_number,total_terms,component,amount_minor,occurred_date,origin,canonical,active,version) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1)',
        [uid, randomUUID(), account.accountId, loanId, 8, 12, 'principal', '50000', '2026-08-13', 'import'])
      const a = await find()
      // 锚点=8 → 只算期次 9、10、11、12 = 4×50000 = 200000；+ 本期应还100000 = 300000
      assert.equal(a.debtMinor, '300000')
    })

    await t.test('锚点提前到第10期后，11、12 才算未来', async () => {
      await db.owner.execute('UPDATE catledger_installment_items SET active=0 WHERE uid=? AND loan_id=? AND period_number=8', [uid, loanId])
      await db.owner.execute('INSERT INTO catledger_installment_items (uid,item_id,account_id,loan_id,period_number,total_terms,component,amount_minor,occurred_date,origin,canonical,active,version) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,1)',
        [uid, randomUUID(), account.accountId, loanId, 10, 12, 'principal', '50000', '2026-10-13', 'import'])
      const a = await find()
      // 锚点=10 → 只算 11、12 = 100000；+100000 = 200000
      assert.equal(a.debtMinor, '200000')
    })

    await t.test('有未归分期来源(loan_id=NULL)时提示待处理，归入后不再提示', async () => {
      // 新增一条完全未归的来源（loan_id=NULL）
      const itemId = randomUUID()
      await db.owner.execute('INSERT INTO catledger_installment_items (uid,item_id,account_id,loan_id,period_number,total_terms,component,amount_minor,occurred_date,origin,canonical,active,version) VALUES (?,?,?,NULL,?,?,?,?,?,?,1,1,1)',
        [uid, itemId, account.accountId, 5, 12, 'principal', '50000', '2026-07-13', 'import'])
      let a = await find()
      assert.equal(a.needsInstallmentPlan, true)
      // 归入后（loan_id 有值）不再提示
      await db.owner.execute('UPDATE catledger_installment_items SET loan_id=? WHERE uid=? AND item_id=?', [loanId, uid, itemId])
      a = await find()
      assert.equal(a.needsInstallmentPlan, false)
    })
  } finally {
    await db.close()
  }
})
