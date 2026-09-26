// 从 loan-cost-calculator 的 loan-form 适配；账户和本金核对使用本账本契约。
const { addMinor } = require('../../utils/minor-arithmetic')
const money = require('../../utils/money')
const scheduleForm = require('../loan-detail/schedule-form')
const TYPE_OPTIONS = [{value:'',label:'不选择'},{value:'credit_card',label:'信用卡分期'},{value:'bank_loan',label:'银行借款'},{value:'online_loan',label:'网络借款'},{value:'other',label:'其他'}]
const DISCOUNT_OPTIONS = [{value:'interest_rate',label:'利息打折'},{value:'per_period',label:'每期减免'},{value:'total',label:'总额减免'}]
function today() { const d=new Date(),pad=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()) }
function previewInput(data) {
  const principalMinor = money.yuanToMinor(data.principalYuan)
  const schedule = scheduleForm.payload(data.schedule,data.principalYuan)
  if (!schedule) throw new Error('请填写总期数及还款额或利率')
  if (!schedule.firstPaymentDate) throw new Error('请选择首次还款日期，用于安排后续期次')
  const text = String(data.paidTerms).trim(),paidTerms = Number(text)
  if (!/^\d+$/.test(text) || !Number.isInteger(paidTerms) || paidTerms < 0 || paidTerms > schedule.scheduleTerms) throw new Error('历史已还期数应为 0 至总期数，没有请填 0')
  const type=TYPE_OPTIONS[data.typeIndex] || TYPE_OPTIONS[0],discountText=String(data.discountValue || '').trim()
  let discountKind=null,discountValue=null
  if (discountText) {
    discountKind=DISCOUNT_OPTIONS[data.discountIndex].value
    if (discountKind==='interest_rate') {
      if (!/^\d+(\.\d{1,5})?$/.test(discountText) || Number(discountText)<=0 || Number(discountText)>10) throw new Error('利息折扣应大于 0 且不超过 10 折')
      discountValue=String(Math.round(Number(discountText)*100000))
    } else discountValue=money.yuanToMinor(discountText)
  }
  return Object.assign({},schedule,{ principalMinor,installmentSetup:{ schema:1,originalPrincipalMinor:principalMinor,historicalPaidTerms:data.loan ? paidTerms : 0,
    recordType:type.value,customRecordType:type.value==='other' ? String(data.customRecordType || '').trim() : '',discountKind,discountValue } })
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
  if (!data.baselineDate) throw new Error('请选择开始核对日期')
  const input=previewInput(data); delete input.principalMinor
  if(data.baselineMode===1&&Number(data.paidTerms)!==0)throw new Error('新现金借款尚未到账，历史已还期数应为 0')
  return Object.assign(input,{ ...(data.baselineMode===1?{originKind:'cash_borrowing'}:{}),name:String(data.name).trim(),institution:null,kind:'installment',accountId:account.accountId,
    repayments:(data.repaymentRows || []).map(({periodNumber,paid})=>({periodNumber,paid})),
    baselinePrincipalMinor:data.baselineMode===1?'0':remaining(preview,data.repaymentRows || []),baselineDate:data.baselineDate,startDate:null,endDate:null,
    repaymentMethod:scheduleForm.METHOD_LABELS[input.scheduleMethod],generatePlan:true,confirmed:true })
}
function remaining(preview, rows) {
  const paid = new Set(rows.filter(r=>r.paid).map(r=>r.periodNumber))
  return preview.periods.filter(r=>!paid.has(r.periodNumber)).reduce((sum,r)=>addMinor(sum,String(r.principalMinor)),'0')
}
module.exports={TYPE_OPTIONS,DISCOUNT_OPTIONS,today,previewInput,fields,createPayload,remaining}
