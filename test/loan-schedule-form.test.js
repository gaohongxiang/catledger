const test = require('node:test')
const assert = require('node:assert/strict')
const scheduleForm = require('../miniprogram/pages/loan-detail/schedule-form')
const planModel = require('../miniprogram/pages/loan-plan/model')

const base = () => Object.assign(scheduleForm.blank(), { terms: '12' })

test('整区留空返回 null，填写任一字段即参与提交', () => {
  assert.equal(scheduleForm.payload(scheduleForm.blank(), '1000'), null)
  assert.equal(scheduleForm.payload({ terms: '  ', ratePercent: '', repaymentYuan: '', feePerTermYuan: '', feeUpfrontYuan: '', firstPaymentDate: '' }, '1000'), null)
  assert.ok(scheduleForm.payload(Object.assign(base(), { ratePercent: '1' }), '1000'))
})

test('按利率提交：百分数转 ppm 字符串，费用转整数分，不适用字段为 null', () => {
  const result = scheduleForm.payload(Object.assign(base(), { ratePercent: '12.5', feePerTermYuan: '5', feeUpfrontYuan: '100', firstPaymentDate: '2026-10-01' }), '10000')
  assert.deepEqual(result, {
    scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'annual',
    ratePpm: '125000', repaymentMinor: null, feePerTermMinor: '500', feeUpfrontMinor: '10000', firstPaymentDate: '2026-10-01'
  })
})

test('ppm 与百分数往返转换保持精度', () => {
  assert.equal(scheduleForm.percentToPpm('12.5'), '125000')
  assert.equal(scheduleForm.percentToPpm('0'), '0')
  assert.equal(scheduleForm.percentToPpm('0.05'), '500')
  assert.equal(scheduleForm.ppmToPercent('125000'), '12.5')
  assert.equal(scheduleForm.ppmToPercent('10000'), '1')
  assert.equal(scheduleForm.ppmToPercent('500'), '0.05')
  assert.equal(scheduleForm.ppmToPercent('0'), '0')
  for (const text of ['0', '0.05', '1', '12.5', '36', '0.0001']) {
    assert.equal(scheduleForm.ppmToPercent(scheduleForm.percentToPpm(text)), String(Number(text)))
  }
})

test('贷款回填后再提交得到同等参数（minor/ppm 往返）', () => {
  const loan = { scheduleMethod: 'equal_payment', scheduleTerms: 24, measurementKind: 'rate', quoteType: 'monthly',
    ratePpm: '8000', repaymentMinor: null, feePerTermMinor: '0', feeUpfrontMinor: null, firstPaymentDate: '2026-10-01' }
  const state = scheduleForm.fromLoan(loan)
  assert.equal(state.methodIndex, 1)
  assert.equal(state.ratePercent, '0.8')
  assert.equal(state.feePerTermYuan, '0.00')
  assert.equal(state.feeUpfrontYuan, '')
  const result = scheduleForm.payload(state, '20000')
  assert.equal(result.scheduleMethod, 'equal_payment')
  assert.equal(result.scheduleTerms, 24)
  assert.equal(result.quoteType, 'monthly')
  assert.equal(result.ratePpm, '8000')
  assert.equal(result.feePerTermMinor, '0')
  assert.equal(result.feeUpfrontMinor, null)
  assert.equal(scheduleForm.fromLoan({}).terms, '')
  assert.equal(scheduleForm.fromLoan(null).methodIndex, 0)
})

test('期数必须为 1 到 600 的整数', () => {
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { terms: '0' }), '1000'), /1 到 600/)
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { terms: '601' }), '1000'), /1 到 600/)
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { terms: '1.5' }), '1000'), /1 到 600/)
  assert.throws(() => scheduleForm.payload({ terms: '', ratePercent: '1' }, '1000'), /1 到 600/)
  assert.equal(scheduleForm.payload(Object.assign(base(), { terms: '600', ratePercent: '1' }), '1000').scheduleTerms, 600)
})

test('利率非负且必须是数字，每期费率口径强制等本等息', () => {
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { ratePercent: '' }), '1000'), /利率/)
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { ratePercent: 'abc' }), '1000'), /利率/)
  assert.equal(scheduleForm.payload(Object.assign(base(), { ratePercent: '0' }), '1000').ratePpm, '0')
  const installment = Object.assign(base(), { quoteIndex: 3, methodIndex: 1, ratePercent: '1' })
  assert.throws(() => scheduleForm.payload(installment, '1000'), /等本等息/)
  const snapped = scheduleForm.selectQuote(Object.assign(base(), { methodIndex: 1 }), 3)
  assert.equal(snapped.methodIndex, 0)
  const back = scheduleForm.selectMethod(snapped, 2)
  assert.equal(back.quoteIndex, 0)
})

test('一次性费用必须小于已确认本金，每期费用可空可为零', () => {
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { ratePercent: '1', feeUpfrontYuan: '1000' }), '1000'), /一次性费用/)
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { ratePercent: '1', feeUpfrontYuan: '1000.01' }), '1000'), /一次性费用/)
  assert.equal(scheduleForm.payload(Object.assign(base(), { ratePercent: '1', feeUpfrontYuan: '999.99' }), '1000').feeUpfrontMinor, '99999')
  assert.equal(scheduleForm.payload(Object.assign(base(), { ratePercent: '1', feeUpfrontYuan: '2000' }), '').feeUpfrontMinor, '200000')
  assert.throws(() => scheduleForm.payload(Object.assign(base(), { ratePercent: '1', feePerTermYuan: '-1' }), '1000'), /每期费用/)
})

const repayment = (methodIndex, extra) => Object.assign(base(), { measurementIndex: 1, methodIndex, firstPaymentDate: '2026-10-01' }, extra)

test('按还款额必须有首次还款日，等额本息总还款不能低于本金（含容差）', () => {
  assert.throws(() => scheduleForm.payload(repayment(1, { repaymentYuan: '900', firstPaymentDate: '' }), '10000'), /首次还款日/)
  assert.throws(() => scheduleForm.payload(repayment(1, { repaymentYuan: '800' }), '10000'), /总还款/)
  assert.equal(scheduleForm.payload(repayment(1, { repaymentYuan: '833.34' }), '10000').repaymentMinor, '83334')
  assert.equal(scheduleForm.payload(repayment(1, { repaymentYuan: '900' }), '10000').repaymentMinor, '90000')
  assert.throws(() => scheduleForm.payload(repayment(1, { repaymentYuan: '900' }), ''), /本金/)
})

test('等本等息与等额本金每期（首期）应还不能低于每期本金，先息后本可为零', () => {
  assert.throws(() => scheduleForm.payload(repayment(0, { repaymentYuan: '800' }), '10000'), /每期本金/)
  assert.equal(scheduleForm.payload(repayment(0, { repaymentYuan: '834' }), '10000').repaymentMinor, '83400')
  assert.throws(() => scheduleForm.payload(repayment(2, { repaymentYuan: '800' }), '10000'), /首期应还不能低于每期本金/)
  assert.equal(scheduleForm.payload(repayment(2, { repaymentYuan: '900' }), '10000').repaymentMinor, '90000')
  assert.throws(() => scheduleForm.payload(repayment(3, { repaymentYuan: '' }), '10000'), /每期利息/)
  assert.equal(scheduleForm.payload(repayment(3, { repaymentYuan: '0' }), '').repaymentMinor, '0')
  assert.equal(scheduleForm.payload(repayment(3, { repaymentYuan: '50' }), '').repaymentMinor, '5000')
})

test('还款计划生成入口只在参数齐备时出现', () => {
  const rate = { scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'annual', ratePpm: '125000' }
  assert.equal(planModel.canGenerate(rate), true)
  assert.equal(planModel.canGenerate(Object.assign({}, rate, { ratePpm: null })), false)
  assert.equal(planModel.canGenerate(Object.assign({}, rate, { scheduleTerms: null })), false)
  assert.equal(planModel.canGenerate({ scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'repayment', repaymentMinor: '90000' }), true)
  assert.equal(planModel.canGenerate({ scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'repayment', repaymentMinor: null }), false)
  assert.equal(planModel.canGenerate(null), false)
  assert.equal(planModel.canGenerate({}), false)
})

test('试算预览格式化汇总并截断长计划，生成载荷要求勾选确认', () => {
  const periods = Array.from({ length: 30 }, (_, n) => ({ periodNumber: n + 1, dueDate: '2026-10-01', principalMinor: '100', interestMinor: '10', feeMinor: '1' }))
  const view = planModel.previewView({ periods, summary: { totalPaymentMinor: '3330', totalInterestMinor: '300', totalFeeMinor: '30' } })
  assert.equal(view.periodCount, 30)
  assert.equal(view.rows.length, 24)
  assert.equal(view.truncated, true)
  assert.equal(view.rows[0].totalText, '¥1.11')
  assert.match(view.summaryText, /¥33.30/)
  assert.match(view.summaryText, /¥3.00/)
  assert.match(view.summaryText, /¥0.30/)
  assert.throws(() => planModel.generatePayload({ loanId: 'loan', loanVersion: 2, preview: view, generateConfirmed: false }), /确认/)
  assert.deepEqual(planModel.generatePayload({ loanId: 'loan', loanVersion: 2, preview: view, generateConfirmed: true }), { loanId: 'loan', version: 2, confirmed: true })
})
