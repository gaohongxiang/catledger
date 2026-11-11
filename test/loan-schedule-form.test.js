const test = require('node:test')
const assert = require('node:assert/strict')
const scheduleForm = require('../miniprogram/services/loan-schedule-form')
const planModel = require('../miniprogram/packages/loans/pages/loan-plan/model')

const base = () => Object.assign(scheduleForm.blank(), { terms: '12' })

test('整区留空返回 null，填写任一字段即参与提交', () => {
  assert.equal(scheduleForm.payload(scheduleForm.blank(), '1000'), null)
  assert.equal(scheduleForm.payload({ terms: '  ', ratePercent: '', repaymentYuan: '', feePerTermYuan: '', feeUpfrontYuan: '', firstPaymentDate: '' }, '1000'), null)
  assert.ok(scheduleForm.payload(Object.assign(base(), { ratePercent: '1' }), '1000'))
})

test('按利率提交：百分数转 ppm 字符串，费用转整数分，不适用字段为 null', () => {
  const result = scheduleForm.payload(Object.assign(base(), { ratePercent: '12.5', feePerTermYuan: '5', feeUpfrontYuan: '100', firstPaymentDate: '2026-10-01' }), '10000')
  assert.deepEqual(result, {
    scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'monthly',
    ratePpm: '125000', repaymentMinor: null, feePerTermMinor: '500', feeUpfrontMinor: '10000', firstPaymentDate: '2026-10-01',
    principalRounding: 'yuan'
  })
})

test('本金取整默认到元、可切到分，并按口径校验每期本金下限', () => {
  const state = base()
  assert.equal(state.roundingIndex, 0)
  assert.equal(scheduleForm.ROUNDING_OPTIONS[state.roundingIndex].value, 'yuan')
  assert.equal(scheduleForm.payload(Object.assign(base(), { ratePercent: '1' }), '1000').principalRounding, 'yuan')
  const cent = scheduleForm.selectRounding(base(), 1)
  assert.equal(cent.roundingIndex, 1)
  assert.equal(scheduleForm.payload(Object.assign(cent, { ratePercent: '1' }), '1000').principalRounding, 'cent')
  // 回填老贷款：缺省 principalRounding 视为到元？读取层把 NULL 映射为 'cent'，这里显式给 cent 还原到分。
  assert.equal(scheduleForm.fromLoan({ scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'monthly', ratePpm: '1', principalRounding: 'cent' }).roundingIndex, 1)
  assert.equal(scheduleForm.fromLoan({ scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'monthly', ratePpm: '1', principalRounding: 'yuan' }).roundingIndex, 0)
  // 整元口径每期本金 = floor(本金/期数/100)*100：10000/12 → 833 元 = 83300 分，还款额 833 刚好够、832 不足。
  assert.equal(scheduleForm.payload(repayment(0, { repaymentYuan: '833', roundingIndex: 0 }), '10000').repaymentMinor, '83300')
  assert.throws(() => scheduleForm.payload(repayment(0, { repaymentYuan: '832', roundingIndex: 0 }), '10000'), /每期本金/)
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
  const installmentIdx = scheduleForm.QUOTE_OPTIONS.findIndex(o => o.value === 'installment')
  const installment = Object.assign(base(), { quoteIndex: installmentIdx, methodIndex: 1, ratePercent: '1' })
  assert.throws(() => scheduleForm.payload(installment, '1000'), /等本等息/)
  const snapped = scheduleForm.selectQuote(Object.assign(base(), { methodIndex: 1 }), installmentIdx)
  assert.equal(snapped.methodIndex, 0)
  const back = scheduleForm.selectMethod(snapped, 2)
  assert.equal(back.quoteIndex, scheduleForm.QUOTE_DEFAULT_INDEX)
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
  assert.throws(() => scheduleForm.payload(repayment(1, { repaymentYuan: '900', firstPaymentDate: '' }), '10000'), /首期还款日/)
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
  const rate = { scheduleMethod: 'flat', scheduleTerms: 12, measurementKind: 'rate', quoteType: 'monthly', ratePpm: '125000' }
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

test('选择日利率口径时本金取整默认「到分」，其它口径默认「到元」', () => {
  const dailyIdx = scheduleForm.QUOTE_OPTIONS.findIndex(o => o.value === 'daily')
  const monthlyIdx = scheduleForm.QUOTE_OPTIONS.findIndex(o => o.value === 'monthly')
  assert.equal(scheduleForm.ROUNDING_OPTIONS[scheduleForm.selectQuote(base(), dailyIdx).roundingIndex].value, 'cent')
  assert.equal(scheduleForm.ROUNDING_OPTIONS[scheduleForm.selectQuote(base(), monthlyIdx).roundingIndex].value, 'yuan')
  // 用户切完口径后仍可手动改
  const daily = scheduleForm.selectQuote(base(), dailyIdx)
  assert.equal(scheduleForm.selectRounding(daily, 0).roundingIndex, 0)
})

test('首期天数 ↔ 起息日 双向联动：改起息日算出天数，改天数反推起息日', () => {
  const sf = scheduleForm
  const dailyIdx = sf.QUOTE_OPTIONS.findIndex(o => o.value === 'daily')
  // 首还 2018-11-18，起息 2018-10-21 → 28 天
  let s = Object.assign(sf.selectQuote(base(), dailyIdx), { firstPaymentDate: '2018-11-18', interestStartDate: '2018-10-21' })
  s = sf.syncFirstPeriod(s, 'date')
  assert.equal(s.firstPeriodDays, '28')
  // 反过来：填天数 28 → 反推起息 2018-10-21
  let s2 = Object.assign(sf.selectQuote(base(), dailyIdx), { firstPaymentDate: '2018-11-18', firstPeriodDays: '28' })
  s2 = sf.syncFirstPeriod(s2, 'days')
  assert.equal(s2.interestStartDate, '2018-10-21')
})

test('只填首期天数也能提交：payload 由首还日反推起息日', () => {
  const sf = scheduleForm
  const dailyIdx = sf.QUOTE_OPTIONS.findIndex(o => o.value === 'daily')
  const s = Object.assign(sf.selectQuote(base(), dailyIdx), { terms: '6', ratePercent: '0.045', firstPaymentDate: '2018-11-18', firstPeriodDays: '28', principalYuan: '5000' })
  const p = sf.payload(s, '5000')
  assert.equal(p.interestStartDate, '2018-10-21')
})

test('起息日晚于或等于首还日 → 报错，不静默算成 0 利息', () => {
  const sf = scheduleForm
  const dailyIdx = sf.QUOTE_OPTIONS.findIndex(o => o.value === 'daily')
  // 起息 2026-10-18 晚于首还 2018-11-18：必须报错
  const bad = Object.assign(sf.selectQuote(base(), dailyIdx), { terms: '6', ratePercent: '0.045', firstPaymentDate: '2018-11-18', interestStartDate: '2026-10-18', principalYuan: '5000' })
  assert.throws(() => sf.payload(bad, '5000'), /起息日不能晚于/)
  // 起息日 = 首还日 也拒绝
  const eq = Object.assign(sf.selectQuote(base(), dailyIdx), { terms: '6', ratePercent: '0.045', firstPaymentDate: '2018-11-18', interestStartDate: '2018-11-18', principalYuan: '5000' })
  assert.throws(() => sf.payload(eq, '5000'), /起息日不能晚于/)
})
