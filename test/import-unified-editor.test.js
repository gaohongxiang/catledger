const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const model = require('../miniprogram/pages/import-workbench/review-editor-model')
const policy = require('../cloudfunctions/catledger-import/src/review/editor-policy')
const roles = require('../cloudfunctions/catledger-import/src/editor-fields')
const { evaluatePostability } = require('../cloudfunctions/catledger-import/src/organizer-model')
const { FIELD_MASK } = require('../cloudfunctions/catledger-import/src/manual-field-mask')
const { transactionDrafts } = require('../cloudfunctions/catledger-import/src/finance-update-posting')
const refund = require('../cloudfunctions/catledger-import/src/review/editor-refund')
const { runtime, fixture, flush } = require('./helpers/paged-workbench')
const wallet = { accountId: randomUUID(), type: 'wallet', name: '合成钱包', currency: 'CNY' }
const credit = { accountId: randomUUID(), type: 'credit', name: '合成信用卡', currency: 'CNY' }
const debt = { accountId: randomUUID(), type: 'other_liability', name: '合成借款', currency: 'CNY' }
const bank = { accountId: randomUUID(), type: 'bank', name: '合成银行卡', currency: 'CNY' }
const catalog = { accounts: [wallet, credit, debt, bank], categories: [] }
const base = (nature = 'expense', patch = {}) => ({ eventId: randomUUID(), updateId: randomUUID(), version: 1, status: 'needs_action',
  economicNature: nature, flowDirection: nature === 'income' || nature === 'refund' ? 'inflow' : ['borrow','repayment','internal_transfer'].includes(nature) ? 'neutral' : 'outflow',
  amountMinor: '10000', currency: 'CNY', localAt: '2026-09-01 12:00:00.000', utcAt: '2026-09-01 04:00:00.000', timezoneOffsetMinutes: -480,
  ledgerAccountId: wallet.accountId, counterpartyLedgerAccountId: null, categoryId: null, sourceDirection: 'expense',
  primaryEvidence: { counterparty: '合成原对方', note: '合成原备注' }, manualFieldMask: 0, reasonCodes: [], fieldSources: {}, ...patch })
function publicRow(row) { return { ...row, editorFacts: policy.capability(row), ...(row.fieldSources.installment ? { installment: row.fieldSources.installment } : {}) } }
function change(row, edits) { let draft = model.create(publicRow(row)); for (const [key, value] of edits) draft = model.change(publicRow(row), draft, key, value); return model.derive(publicRow(row), draft, catalog) }
const prepare = (event, patch) => policy.prepare(event, { editorVersion: 1, fields: {}, ...patch })
const invalid = fn => assert.throws(fn, error => error.code === 'VALIDATION_ERROR' || error.publicCode === 'VALIDATION_ERROR')

for (const nature of ['expense','income','refund','internal_transfer','borrow','repayment','fee']) for (const sourceDirection of ['expense','income']) {
  test('自动与手选同一表单、端点和约束：' + nature + '/' + sourceDirection, () => {
    const row = base(nature, { sourceDirection, ledgerAccountId: sourceDirection === 'income' ? credit.accountId : wallet.accountId })
    const manual = { ...row, economicNature: 'unknown', reasonCodes: ['economic_nature_required'] }
    const autoView = model.derive(publicRow(row), model.create(publicRow(row)), catalog)
    const manualView = change(manual, [['economicNature', nature]])
    for (const key of ['natureLabel','routeFields','categoryKind','showOwnership','showLoan','refund','showStructure']) assert.deepEqual(manualView[key], autoView[key], key)
    assert.equal(manualView.payload.fields.economicNature, nature)
    assert.equal(JSON.stringify(row).includes('editorFacts'), false, '派生不能修改源对象')
  })
}
test('两种来源方向下，手动还款与最终 transfer 的资金角色一致', () => {
  for (const sourceDirection of ['income','expense']) {
    const row = base('unknown', { sourceDirection, ledgerAccountId: sourceDirection === 'income' ? credit.accountId : wallet.accountId })
    const view = change(row, [['economicNature','repayment'], ['counterpartyLedgerAccountId', sourceDirection === 'income' ? wallet.accountId : credit.accountId]])
    assert.equal(view.canSave, true)
    const next = prepare(row, view.payload)
    assert.equal(roles.accountRolesValid(next, new Map(catalog.accounts.map(account => [account.accountId, account]))), true)
    const posted = transactionDrafts(next)[0]
    assert.equal(posted.sourceAccountId, wallet.accountId); assert.equal(posted.destinationAccountId, credit.accountId)
    assert.equal(evaluatePostability(next).status, 'ready')
  }
})
test('付款/负债端约束不依赖 bank projection；空账户仍是合法未完成草稿', () => {
  for (const fieldSources of [{}, { fundsProjection: { kind: 'repayment', to: { referenceKind: 'atomic', label: '合成信用卡' } } }]) {
    const row = base('repayment', { fieldSources, counterpartyLedgerAccountId: bank.accountId })
    const accounts = new Map(catalog.accounts.map(account => [account.accountId, account]))
    assert.equal(roles.accountRolesValid(row, accounts), false)
    assert.equal(roles.accountRolesValid({ ...row, counterpartyLedgerAccountId: credit.accountId }, accounts), true)
    assert.equal(roles.accountRolesValid({ ...row, counterpartyLedgerAccountId: null }, accounts), true)
  }
})
test('记账文本明确清空、严格日期、空与零及越权键', () => {
  const row = base(), before = JSON.stringify(row)
  const next = prepare(row, { fields: { note: '', counterparty: '', amountMinor: '0', occurredLocalAt: '2024-02-29 12:00:00', timezoneOffsetMinutes: -480 } })
  assert.deepEqual(roles.effectiveText(next, { note: '原备注', counterparty: '原对方' }), { note: '', counterparty: '' })
  assert.equal(next.amountMinor, '0'); assert.match(next.utcAt, /04:00:00/)
  assert.equal(next.manualFieldMask & FIELD_MASK.note, FIELD_MASK.note)
  assert.equal(JSON.stringify(row), before)
  const blank = prepare(row, { fields: { amountMinor: null, occurredLocalAt: null } })
  assert.equal(blank.amountMinor, null); assert.equal(blank.utcAt, null); assert.equal(evaluatePostability(blank).status, 'needs_action')
  for (const fields of [{ occurredLocalAt:'2026-02-30 00:00:00', timezoneOffsetMinutes:-480 }, { amountMinor:'9223372036854775808' }, { amountMinor:'-1' }, { status:'ready' }, { rawFields:{} }, { note:'字'.repeat(201) }]) invalid(() => prepare(row,{ fields }))
  invalid(() => prepare(row, { uid:'foreign' }))
})
test('保存普通字段不能清除来源/身份/同笔冲突；未知不等于支出', () => {
  for (const reason of ['row_status_unknown','identity_conflict','same_event_candidate','refund_source_conflict','core_fields_conflict']) {
    const row = base('unknown', { reasonCodes:[reason], fieldSources:{ semanticBlockers:[reason] } })
    const next = prepare(row, { fields:{economicNature:'income',note:'人工核对说明'} })
    assert.ok(next.reasonCodes.includes(reason)); assert.equal(evaluatePostability(next, { openBlockingIssues: reason === 'same_event_candidate' ? 1 : 0 }).status,'needs_action')
  }
  assert.equal(model.create(publicRow(base('unknown'))).economicNature, 'unknown')
})
test('模式往返保留 ID，隐藏账户/分类/分配不提交', () => {
  const row = base('repayment', { counterpartyLedgerAccountId:credit.accountId })
  let draft = model.create(publicRow(row))
  draft = model.change(publicRow(row), draft, 'owner','other')
  draft = model.change(publicRow(row), draft, 'otherTreatment','expense')
  let view = model.derive(publicRow(row), draft, catalog)
  assert.equal(view.routeFields.length,1); assert.equal(view.routeFields[0].accountId,wallet.accountId)
  assert.equal(view.payload.fields.counterpartyLedgerAccountId,null)
  draft = model.change(publicRow(row),draft,'owner','self')
  view = model.derive(publicRow(row),draft,catalog)
  assert.equal(view.routeFields[1].accountId,credit.accountId)
  draft = model.change(publicRow(row),draft,'economicNature','income')
  view = model.derive(publicRow(row),draft,catalog)
  assert.equal(view.payload.fields.counterpartyLedgerAccountId,null); assert.equal(view.showLoan,false)
})
test('本人归属切换独立于银行解析，代还 pending 不虚构应收或自己的负债', () => {
  const row=base('repayment',{counterpartyLedgerAccountId:credit.accountId})
  const next=prepare(row,{fields:{economicNature:'unknown',counterpartyLedgerAccountId:null},decisions:{ownership:{owner:'other',treatment:'pending'}}})
  assert.equal(next.counterpartyLedgerAccountId,null); assert.equal(next.economicNature,'unknown')
  assert.equal(evaluatePostability(next).status,'needs_action')
  const self=prepare(next,{fields:{economicNature:'repayment',counterpartyLedgerAccountId:credit.accountId},decisions:{ownership:{owner:'self'}}})
  assert.equal(evaluatePostability(self).status,'ready')
})
test('手动组合支付、未完成组成、完整确认、结构切换说明', () => {
  const row=base(), source=JSON.stringify(row)
  let next=prepare(row,{composition:{kind:'payment',incomplete:true,evidenceNote:'合成支付详情',parts:[{accountId:wallet.accountId,amountMinor:'2500'},{accountId:null,amountMinor:null}]}})
  assert.ok(next.fieldSources.editorOverrides.incompleteComposition); assert.equal(next.fieldSources.paymentResolution,undefined)
  assert.equal(evaluatePostability(next).status,'needs_action')
  next=prepare(next,{composition:{kind:'payment',evidenceNote:'合成支付详情',parts:[{accountId:wallet.accountId,amountMinor:'2500'},{accountId:credit.accountId,amountMinor:'7500'}]}})
  assert.equal(next.fieldSources.paymentResolution.version,'payment-resolution-v3')
  assert.equal(next.fieldSources.editorOverrides.incompleteComposition,undefined)
  assert.equal(evaluatePostability(next).status,'ready')
  assert.deepEqual(transactionDrafts(next).map(part=>part.amountMinor),['2500','7500'])
  invalid(()=>prepare(next,{composition:{kind:'single',evidenceNote:'合成纠正说明'}}))
  next=prepare(next,{fields:{ledgerAccountId:bank.accountId},composition:{kind:'single',evidenceNote:'合成纠正说明'},acknowledgedChanges:['composition']})
  assert.equal(transactionDrafts(next).length,1); assert.equal(transactionDrafts(next)[0].sourceAccountId,bank.accountId)
  assert.equal(JSON.stringify(row),source)
})
test('分配超额/重复/负数拒绝；组合还款与多还入分配只产生各自明细', () => {
  const row=base('repayment',{counterpartyLedgerAccountId:credit.accountId})
  for (const parts of [[{accountId:wallet.accountId,amountMinor:'10001'}],[{accountId:wallet.accountId,amountMinor:'5000'},{accountId:wallet.accountId,amountMinor:'5000'}],[{accountId:wallet.accountId,amountMinor:'-1'}]]) invalid(()=>prepare(row,{composition:{kind:'payment',incomplete:true,evidenceNote:'说明',parts}}))
  const next=prepare(row,{composition:{kind:'repayment',parts:[{accountId:credit.accountId,amountMinor:'6000'},{accountId:debt.accountId,amountMinor:'4000'}]}})
  assert.equal(next.counterpartyLedgerAccountId,null)
  const byTarget = (left, right) => left[1].localeCompare(right[1])
  assert.deepEqual(transactionDrafts(next).map(part=>[part.sourceAccountId,part.destinationAccountId,part.amountMinor]).sort(byTarget),
    [[wallet.accountId,credit.accountId,'6000'],[wallet.accountId,debt.accountId,'4000']].sort(byTarget))
})
test('分期本金仅修改来源事实、显示同一账户控件，不能改成实付', () => {
  const row=base('repayment',{ledgerAccountId:credit.accountId,fieldSources:{installment:{creditStatement:true,component:'principal',periodNumber:2,totalTerms:12}}})
  const next=prepare(row,{fields:{amountMinor:'9000'},sourceCorrection:{periodNumber:3,totalTerms:12}})
  assert.equal(next.fieldSources.installment.periodNumber,2)
  assert.equal(next.fieldSources.editorOverrides.sourceCorrection.periodNumber,3)
  assert.equal(model.derive(publicRow(row),model.create(publicRow(row)),catalog).showLoan,false)
  invalid(()=>prepare(row,{fields:{economicNature:'expense'}}));invalid(()=>prepare(row,{sourceCorrection:{periodNumber:13,totalTerms:12}}));invalid(()=>prepare(row,{sourceCorrection:{periodNumber:601,totalTerms:601}}))
})
test('不完整本息费保留明确零值；不把错误输入悄悄当零或旧金额', () => {
  const row=base('repayment',{counterpartyLedgerAccountId:debt.accountId})
  const view=change(row,[['repaymentMode','loan'],['principalInput','90'],['interestInput',''],['feeInput','0']])
  assert.equal(view.canSave,true);assert.equal(view.complete,false)
  const next=prepare(row,view.payload)
  assert.equal(next.fieldSources.loanRepayment.mode,'review');assert.equal(next.fieldSources.editorOverrides.incompleteRepayment.feeMinor,'0')
  assert.equal(evaluatePostability(next).status,'needs_action')
  const bad=change(row,[['repaymentMode','loan'],['principalInput','90x']]);assert.equal(bad.canSave,false)
})
test('合并唯一人工文本含显式清空；两个冲突值不静默选主记录', () => {
  const primary=base(), secondary=prepare(base(),{fields:{note:'',counterparty:'合成修改对方'}})
  const merged=roles.mergeText(primary,[primary,secondary]);assert.equal(roles.overrides(merged).note,'');assert.equal(roles.overrides(merged).counterparty,'合成修改对方')
  const conflicting=prepare(primary,{fields:{note:'另一说明'}})
  invalid(()=>roles.mergeText(conflicting,[conflicting,secondary]))
})
test('退款候选 SQL 仅绑定查询，历史累计包含未入账引用，不能以分页末页判无候选', async () => {
  for (const kind of ['event','transaction']) {
    const row=base('refund'), queries=[]
    const connection={execute:async(sql,values)=>{queries.push({sql,values});assert.match(sql,/^SELECT/);assert.equal((sql.match(/\?/g)||[]).length,values.length);return [[/SELECT COUNT/.test(sql)?{count:4}:{id:randomUUID(),version:2,amountMinor:'10000',remainingMinor:'8000'}]]}}
    const result=await refund.candidates(connection,'synthetic-user',row,kind,{after:randomUUID(),limit:1})
    assert.equal(result.total,4);assert.equal(result.items[0].kind,kind)
    assert.ok(queries.every(item=>item.values.includes('synthetic-user')))
    if(kind==='transaction') assert.match(queries[1].sql,/historical_primary/)
  }
})
const tap=(data)=>({currentTarget:{dataset:data}})
test('真实 Page：点同组第二笔只打开第二笔，已填值可改且只保存本笔',async()=>{
  const h=runtime(fixture(2,true)),page=h.page
  await page.setStep({currentStep:3})
  const row=h.events[1]
  await page.openPendingRecord(tap({id:row.eventId,issueId:h.issues[0].issueId}))
  assert.equal(page._reviewEditToken.eventId,row.eventId)
  page.changeEditorText({currentTarget:{dataset:{field:'note'}},detail:{value:'只改第二笔'}})
  assert.equal(page._reviewEditToken.view.payload.fields.note,'只改第二笔')
  assert.equal(h.events[0].note,undefined)
  page.onUnload()
})
test('真实 Page：退款候选晚到或失败不能替新金额启用暂记；输入不被读取覆盖',async()=>{
  const data=fixture(1,true);data.events[0].economicNature='refund'
  const h=runtime(data),page=h.page
  await page.openReviewEdit(tap({id:h.events[0].eventId}))
  let release
  h.intercept=(action)=>action==='economicEvents.refundCandidates'?new Promise(resolve=>{release=resolve}):undefined
  const loading=page.loadEditorRefunds(tap({kind:'event'}));await flush()
  page.changeEditorText({currentTarget:{dataset:{field:'amountInput'}},detail:{value:'2.00'}})
  release({viewVersion:h.summary.viewVersion,items:[],total:0,nextCursor:null});await loading
  assert.equal(page.data.reviewEditSheet.draft.amountInput,'2.00');assert.notEqual(page.data.reviewEditSheet.refundCanPending,true)
  assert.equal(page.data.reviewEditSheet.refundTotal,null)
  page.onUnload()
})

test('隐藏本息费不随多账户模式提交；缺账户的组成保留合法未完成草稿', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId })
  let draft = model.create(publicRow(row))
  for (const [key, value] of [['repaymentMode','loan'], ['principalInput','100'], ['interestInput','0'], ['feeInput','0']]) draft = model.change(publicRow(row), draft, key, value)
  const partial = model.derive(publicRow(row), model.change(publicRow(row), draft, 'counterpartyLedgerAccountId', ''), catalog)
  assert.equal(partial.canSave, true)
  assert.equal(partial.payload.decisions.repayment.mode, 'review')
  const split = model.derive(publicRow(row), model.change(publicRow(row), draft, 'composition', 'payment'), catalog)
  assert.equal(split.showLoan, false)
  assert.ok(split.accountFields.find(field => field.label === '还入账户').allowedTypes.includes('credit'))
  assert.equal(split.payload.decisions && split.payload.decisions.repayment, undefined)
})
