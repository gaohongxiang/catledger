const test=require('node:test')
const assert=require('node:assert/strict')
const d=require('../cloudfunctions/catledger-api/src/loan-charge-domain')
test('L15 计费日按上海业务日，跨年、月末、闰年不滚到下个月',()=>{
  assert.equal(d.today(Date.parse('2026-01-31T16:00:00Z')),'2026-02-01')
  assert.equal(d.monthDate('2023-12-31',2),'2024-02-29')
  assert.equal(d.monthDate('2024-01-31',2),'2024-03-31')
  assert.equal(d.monthDate('2025-01-31',1),'2025-02-28')
  assert.throws(()=>d.date('2026-02-29'),{publicCode:'VALIDATION_ERROR'})
})
test('L03/L04 授权包含明确历史、固定分项、日期与覆盖确认；起算含当天，未来不写',()=>{
  const a={mode:'auto',fromDate:'2026-04-01',throughDate:'2026-12-31',firstChargeDate:'2026-01-01',historyChoice:'continue',fixedConfirmed:true,dateConfirmed:true,coverageConfirmed:true}
  for(const key of ['fixedConfirmed','dateConfirmed','coverageConfirmed'])assert.throws(()=>d.authorization({...a,[key]:false}),{publicCode:'VALIDATION_ERROR'})
  const auth=d.authorization(a)
  assert.equal(d.eligible({state:'planned',chargeDate:'2026-03-01'},auth,'2026-04-01'),false)
  assert.equal(d.eligible({state:'planned',chargeDate:'2026-04-01'},auth,'2026-04-01'),true)
  assert.equal(d.eligible({state:'planned',chargeDate:'2026-05-01'},auth,'2026-04-01'),false)
  assert.equal(d.eligible({state:'suppressed',chargeDate:'2026-04-01'},auth,'2026-04-01'),false)
})
