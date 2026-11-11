// 从 loan-cost-calculator 的 loan-form 适配；账户和本金核对使用本账本契约。
const money = require('../../../../utils/money')
const scheduleForm = require('../../../../services/loan-schedule-form')
const TYPE_OPTIONS = [{value:'',label:'不选择'},{value:'credit_card',label:'信用卡分期'},{value:'bank_loan',label:'银行借款'},{value:'online_loan',label:'网络借款'},{value:'other',label:'其他'}]
const DISCOUNT_OPTIONS = [{value:'interest_rate',label:'利息打折'},{value:'per_period',label:'每期减免'},{value:'total',label:'总额减免'}]
function today() { const d=new Date(),pad=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()) }
// 由「第 N 期落款日 + 每期间隔（整月）」反推第 1 期日期。账单只给到第 N 期的发生日，
// 首期日期不另行收集，用它反推；算不出返回空串。
function firstPaymentFromPeriod(occurredDate, periodNumber) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(occurredDate == null ? '' : occurredDate))
  const n = Number(periodNumber)
  if (!m || !Number.isInteger(n) || n < 1) return ''
  let index = Number(m[1]) * 12 + (Number(m[2]) - 1) - (n - 1)
  const year = Math.floor(index / 12), month = index % 12 + 1
  const day = Number(m[3]), last = new Date(year, month, 0).getDate()
  const pad = v => String(v).padStart(2, '0')
  return year + '-' + pad(month) + '-' + pad(Math.min(day, last))
}
// 已还期数：0 ~ 总期数的整数。空串按 0；非法抛错。
function paidTermsOf(data, terms) {
  const text = String(data.paidTerms == null ? '' : data.paidTerms).trim()
  if (text === '') return 0
  const n = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 0 || n > terms) throw new Error('已还期数应为 0 至总期数，没有请填 0')
  return n
}
function previewInput(data) {
  const principalMinor = money.yuanToMinor(data.principalYuan)
  const schedule = scheduleForm.payload(data.schedule,data.principalYuan)
  if (!schedule) throw new Error('请填写总期数及还款额或利率')
  if (!schedule.firstPaymentDate) throw new Error('请选择首期还款日，用于安排后续期次')
  const historicalPaidTerms = paidTermsOf(data, schedule.scheduleTerms)
  const type=TYPE_OPTIONS[data.typeIndex] || TYPE_OPTIONS[0],discountText=String(data.discountValue || '').trim()
  let discountKind=null,discountValue=null
  if (discountText) {
    discountKind=DISCOUNT_OPTIONS[data.discountIndex].value
    if (discountKind==='interest_rate') {
      if (!/^\d+(\.\d{1,5})?$/.test(discountText) || Number(discountText)<=0 || Number(discountText)>10) throw new Error('利息折扣应大于 0 且不超过 10 折')
      discountValue=String(Math.round(Number(discountText)*100000))
    } else discountValue=money.yuanToMinor(discountText)
  }
  // 起息日随分期配置一并持久化（仅日利率口径下发），供引擎按实际天数算首期利息。
  // 只放进 installmentSetup；不得平铺到顶层——loans.create/update 的 loanMetadata 白名单不含该键，平铺会被判 VALIDATION_ERROR。
  const interestStartDate = schedule.interestStartDate || null
  const scheduleFields = Object.assign({}, schedule)
  delete scheduleFields.interestStartDate
  return Object.assign({},scheduleFields,{ principalMinor,installmentSetup:{ schema:1,originalPrincipalMinor:principalMinor,historicalPaidTerms,
    recordType:type.value,customRecordType:type.value==='other' ? String(data.customRecordType || '').trim() : '',discountKind,discountValue,
    ...(interestStartDate ? { interestStartDate } : {}) } })
}
function fields(loan) {
  const setup=loan.installmentSetup
  return { name:loan.name,principalYuan:money.minorToYuan(setup.originalPrincipalMinor),schedule:scheduleForm.fromLoan(loan),paidTerms:String(setup.historicalPaidTerms),
    typeIndex:Math.max(0,TYPE_OPTIONS.findIndex(t=>t.value===setup.recordType)),customRecordType:setup.customRecordType,
    discountIndex:Math.max(0,DISCOUNT_OPTIONS.findIndex(d=>d.value===setup.discountKind)),
    discountValue:setup.discountValue == null ? '' : setup.discountKind==='interest_rate' ? String(Number(setup.discountValue)/100000) : money.minorToYuan(setup.discountValue),
    baselineDate:loan.baselineDate,feeIndex:loan.feePerTermMinor && loan.feePerTermMinor!=='0' ? 1 : 0,
    advancedOpen:!!setup.discountKind || Number(loan.feePerTermMinor)>0 || Number(loan.feeUpfrontMinor)>0 }
}
function createPayload(data, preview) {
  if (!String(data.name || '').trim()) throw new Error('请填写贷款名称')
  const account=data.accounts[data.accountIndex]
  if (!account) throw new Error('请选择关联负债账户')
  if (!preview || preview.summary.remainingPrincipalMinor == null) throw new Error('请先查看还款计划')
  const input=previewInput(data)
  // baseline_principal_minor 承载「原始借款本金」（借款金额），不是剩余本金。
  // 已还期数写进 installmentSetup.historicalPaidTerms，剩余本由后端按逐期未还本金动态算。
  const originalPrincipal = input.installmentSetup.originalPrincipalMinor
  delete input.principalMinor
  if(data.baselineMode===1&&input.installmentSetup.historicalPaidTerms!==0)throw new Error('新现金借款尚未到账，已还期数应为 0')
  return Object.assign(input,{ ...(data.baselineMode===1?{originKind:'cash_borrowing'}:{}),name:String(data.name).trim(),institution:null,kind:'installment',accountId:account.accountId,
    baselinePrincipalMinor:data.baselineMode===1?'0':originalPrincipal,baselineDate:null,startDate:null,endDate:null,
    repaymentMethod:scheduleForm.METHOD_LABELS[input.scheduleMethod],generatePlan:true,confirmed:true })
}
module.exports={TYPE_OPTIONS,DISCOUNT_OPTIONS,today,previewInput,fields,createPayload,firstPaymentFromPeriod,paidTermsOf}
