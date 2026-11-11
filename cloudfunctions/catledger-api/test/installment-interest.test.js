const assert = require('node:assert/strict')
const test = require('node:test')

const { totalInterestByAccount, unpaidDebtByAccount } = require('../src/installment-service')

// 只返回一条贷款行、空期次/来源/预付：让 buildView 用 loan 字段重算整期计划。
// 8000 元 / 10 期 / 年利率 18.25% / 等额本金 → 总利息应 = 66917 分（669.17 元），与本项目排期引擎一致。
function stubConnection(loanRows) {
  return {
    async execute(sql) {
      if (/FROM catledger_loans l/.test(sql)) return [loanRows, []]
      return [[], []]
    }
  }
}

const loan = {
  loanId: 'loan-1', accountId: 'acct-credit', name: '合成分期', institution: null, kind: 'installment',
  baselinePrincipalMinor: '800000', baselineDate: null, startDate: null, endDate: null,
  repaymentMethod: null, scheduleMethod: 'equal_principal', scheduleTerms: 10,
  measurementKind: 'rate', quoteType: 'annual', ratePpm: '182500', repaymentMinor: null,
  feePerTermMinor: '0', feeUpfrontMinor: '0', firstPaymentDate: '2017-03-27',
  principalRounding: 'cent', installmentSetup: null, progress: null, version: 1
}

test('totalInterestByAccount 汇总各计划全期总利息（含已还）', async () => {
  const map = await totalInterestByAccount(stubConnection([loan]), 'user-1')
  assert.equal(map.get('acct-credit'), '66917')
})

test('同一账户多笔计划利息相加', async () => {
  const second = { ...loan, loanId: 'loan-2' }
  const map = await totalInterestByAccount(stubConnection([loan, second]), 'user-1')
  assert.equal(map.get('acct-credit'), '133834')
})

test('没有生效计划时返回空 Map', async () => {
  const map = await totalInterestByAccount(stubConnection([]), 'user-1')
  assert.equal(map.size, 0)
})

test('unpaidDebtByAccount 与 totalInterestByAccount 共用同一份 plan summary（欠款=本+息+费，未还口径）', async () => {
  const debt = await unpaidDebtByAccount(stubConnection([loan]), 'user-1')
  // 全部期次未还时，欠款 = 本金 800000 + 利息 66917 = 866917 分
  assert.equal(debt.get('acct-credit'), '866917')
})
