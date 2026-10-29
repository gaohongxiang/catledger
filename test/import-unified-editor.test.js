const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const model = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
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
    for (const key of ['natureLabel','routeFields','fundsEndpoints','categoryKind','showOwnership','showLoan','refund']) assert.deepEqual(manualView[key], autoView[key], key)
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
test('分期本金保留来源与单账户控件，可改判为支出、费用、收入或待确认', () => {
  const row=base('repayment',{ledgerAccountId:credit.accountId,fieldSources:{installment:{creditStatement:true,component:'principal',periodNumber:2,totalTerms:12}}})
  const next=prepare(row,{fields:{amountMinor:'9000'},sourceCorrection:{periodNumber:3,totalTerms:12}})
  assert.equal(next.fieldSources.installment.periodNumber,2)
  assert.equal(next.fieldSources.editorOverrides.sourceCorrection.periodNumber,3)
  assert.equal(model.derive(publicRow(row),model.create(publicRow(row)),catalog).showLoan,false)
  assert.deepEqual(policy.capability(row).natures,['repayment','expense','fee','income','unknown'])
  const view=change(row,[['economicNature','expense']])
  assert.equal(view.payload.fields.economicNature,'expense')
  const changed=prepare(row,view.payload)
  assert.equal(changed.economicNature,'expense');assert.equal(changed.flowDirection,'outflow')
  assert.deepEqual(evaluatePostability(changed).reasonCodes,['category_required'])
  const drafts=transactionDrafts(changed)
  assert.equal(drafts.length,1);assert.equal(drafts[0].type,'expense');assert.equal(drafts[0].sourceAccountId,credit.accountId)
  for(const nature of ['refund','internal_transfer','borrow']) invalid(()=>prepare(row,{fields:{economicNature:nature}}))
  invalid(()=>prepare(row,{sourceCorrection:{periodNumber:13,totalTerms:12}}));invalid(()=>prepare(row,{sourceCorrection:{periodNumber:601,totalTerms:601}}))
  // 本金行的字段冲突正是这次改判的字段：合法性质且来源没有别的硬阻断时随保存消除。
  const conflicted={...row,reasonCodes:['core_fields_conflict']}
  assert.equal(prepare(conflicted,{fields:{economicNature:'expense'}}).reasonCodes.includes('core_fields_conflict'),false)
  const blocked={...conflicted,fieldSources:{...row.fieldSources,semanticBlockers:['row_semantic_conflict']}}
  assert.ok(prepare(blocked,{fields:{economicNature:'expense'}}).reasonCodes.includes('core_fields_conflict'))
})
test('不完整本息费保留明确零值；不把错误输入悄悄当零或旧金额', () => {
  const row=base('repayment',{counterpartyLedgerAccountId:debt.accountId})
  const view=change(row,[['repaymentDetails',true],['principalInput','90'],['interestInput',''],['feeInput','0']])
  assert.equal(view.canSave,true);assert.equal(view.complete,false)
  const next=prepare(row,view.payload)
  assert.equal(next.fieldSources.loanRepayment.mode,'review');assert.equal(next.fieldSources.editorOverrides.incompleteRepayment.feeMinor,'0')
  assert.equal(evaluatePostability(next).status,'needs_action')
  const bad=change(row,[['repaymentDetails',true],['principalInput','90x']]);assert.equal(bad.canSave,false)
  assert.match(bad.fieldErrors.repayment,/格式不正确/)
  const over=change(row,[['repaymentDetails',true],['principalInput','110'],['interestInput',''],['feeInput','0']])
  assert.equal(over.canSave,false);assert.match(over.fieldErrors.repayment,/超过付款总额/)
  invalid(()=>prepare(row,over.payload))
})
test('还款分项填 0 不要求处理方式，整笔可直接确认', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId })
  const view = change(row, [['repaymentDetails',true], ['principalInput','100'], ['interestInput','0'], ['feeInput','0']])
  assert.equal(view.canSave, true); assert.equal(view.complete, true)
  const decision = view.payload.decisions.repayment
  assert.equal(decision.confirmed, true); assert.equal(decision.mode, 'defer')
  assert.equal(decision.interestMinor, '0'); assert.equal(decision.feeMinor, '0')
  assert.equal(decision.interestTreatment, 'expense'); assert.equal(decision.feeTreatment, 'expense')
  const next = prepare(row, view.payload)
  assert.equal(next.fieldSources.loanRepayment.mode, 'defer')
  assert.equal(next.fieldSources.loanRepayment.interestTreatment, 'expense')
})
test('利息／手续费留空不问处理方式，也不显示这两行', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: credit.accountId })
  const view = change(row, [['repaymentDetails',true], ['principalInput','100'], ['interestInput',''], ['feeInput','']])
  assert.equal(view.interestPositive, false); assert.equal(view.feePositive, false)
  assert.equal(view.canSave, true); assert.equal(view.complete, false)
  assert.equal(view.payload.decisions.repayment.mode, 'review')
  const filled = change(row, [['repaymentDetails',true], ['principalInput','90'], ['interestInput','10'], ['feeInput','0']])
  assert.equal(filled.interestPositive, true); assert.equal(filled.feePositive, false)
})
test('非零利息默认记一笔，选好分类即可确认；显式改成待核对才留空', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId })
  const view = change(row, [['repaymentDetails',true], ['principalInput','90'], ['interestInput','10'], ['feeInput','0']])
  assert.equal(view.interestTreatmentLabel, '没记过，记一笔')
  assert.equal(view.canSave, true); assert.equal(view.complete, false)
  assert.equal(view.payload.decisions.repayment.draft.interestTreatment, 'expense')
  const confirmed = change(row, [['repaymentDetails',true], ['principalInput','90'], ['interestInput','10'], ['feeInput','0'], ['interestCategoryId',randomUUID()]])
  assert.equal(confirmed.complete, true)
  assert.equal(confirmed.payload.decisions.repayment.confirmed, true)
  const pending = change(row, [['repaymentDetails',true], ['principalInput','90'], ['interestInput','10'], ['feeInput','0'], ['interestTreatment','']])
  assert.equal(pending.payload.decisions.repayment.mode, 'review')
  assert.equal(pending.payload.decisions.repayment.draft.interestTreatment, null)
  const next = prepare(row, pending.payload)
  assert.equal(next.fieldSources.loanRepayment.mode, 'review')
  assert.equal(next.fieldSources.editorOverrides.incompleteRepayment.interestTreatment, null)
})
test('只提交待核对状态时保留已填还款明细', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId })
  const first = prepare(row, { decisions: { repayment: { mode: 'review', draft: { mode:'defer', principalMinor:'9000',
    interestMinor:null, feeMinor:'0', interestTreatment:null, feeTreatment:null, interestCategoryId:null, feeCategoryId:null, chargeAllocations:[] } } } })
  assert.equal(first.fieldSources.editorOverrides.incompleteRepayment.principalMinor, '9000')
  const second = prepare(first, { decisions: { repayment: { mode: 'review' } } })
  assert.equal(second.fieldSources.editorOverrides.incompleteRepayment.principalMinor, '9000')
  assert.equal(second.fieldSources.loanRepayment.mode, 'review')
  const third = prepare(second, { fields: { note: '只改备注' } })
  assert.equal(third.fieldSources.editorOverrides.incompleteRepayment.principalMinor, '9000')
})
test('信用卡也能关联分期计划，与贷款同一套落账规则', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: credit.accountId }), loanId = randomUUID()
  const view = change(row, [['repaymentDetails',true], ['loanMode','associate'], ['loanId',loanId], ['loanVersion',2],
    ['principalInput','90'], ['interestInput','10'], ['feeInput','0'], ['interestTreatment','expense'], ['interestCategoryId',randomUUID()]])
  assert.equal(view.creditPayee, true); assert.equal(view.loanPayee, true)
  assert.equal(view.canSave, true); assert.equal(view.complete, true)
  const decision = view.payload.decisions.repayment
  assert.equal(decision.mode, 'associate'); assert.equal(decision.loanId, loanId)
  assert.equal(decision.interestTreatment, 'expense'); assert.equal(decision.chargeAllocations.length, 0)
  const next = prepare(row, view.payload)
  assert.equal(next.fieldSources.loanRepayment.mode, 'associate')
  assert.equal(next.fieldSources.loanRepayment.loanId, loanId)
  // 不展开明细也能整笔关联：整笔记为本金。
  const whole = change(row, [['loanMode','associate'], ['loanId',loanId], ['loanVersion',2]])
  assert.equal(whole.complete, true)
  assert.equal(whole.payload.decisions.repayment.mode, 'associate')
  assert.equal(whole.payload.decisions.repayment.principalMinor, '10000')
})
test('信用卡关联计划时“记过只冲抵”要选全收费项；不关联仍只计入转账', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: credit.accountId })
  const associated = change(row, [['repaymentDetails',true], ['loanMode','associate'], ['loanId',randomUUID()], ['loanVersion',2],
    ['principalInput','90'], ['interestInput','10'], ['feeInput','0'], ['interestTreatment','accrued']])
  assert.equal(associated.complete, false)
  assert.equal(associated.payload.decisions.repayment.mode, 'review')
  const deferred = change(row, [['repaymentDetails',true], ['principalInput','90'], ['interestInput','10'], ['feeInput','0'], ['interestTreatment','accrued']])
  assert.equal(deferred.complete, true)
  assert.equal(deferred.payload.decisions.repayment.interestTreatment, 'accrued')
  assert.equal(deferred.payload.decisions.repayment.chargeAllocations.length, 0)
})
test('信用卡已记利息只计入转账，不再生成费用', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: credit.accountId })
  const view = change(row, [['repaymentDetails',true], ['principalInput','90'], ['interestInput','10'], ['feeInput','0'], ['interestTreatment','accrued']])
  assert.equal(view.canSave, true); assert.equal(view.complete, true)
  const decision = view.payload.decisions.repayment
  assert.equal(decision.confirmed, true); assert.equal(decision.interestTreatment, 'accrued')
  assert.equal(decision.chargeAllocations.length, 0)
  const drafts = transactionDrafts(prepare(row, view.payload))
  assert.deepEqual(drafts.map(draft => [draft.type, String(draft.amountMinor)]), [['transfer','10000']])
})
test('收起还款明细会解除已保存决定，并保留确认要求', () => {
  const repayment = { confirmed: true, mode: 'defer', assetAccountId: wallet.accountId, liabilityAccountId: debt.accountId,
    principalMinor: '10000', interestMinor: '0', feeMinor: '0', interestTreatment: 'expense', feeTreatment: 'expense',
    interestCategoryId: null, feeCategoryId: null, chargeAllocations: [] }
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId, loanRepayment: repayment, fieldSources: { loanRepayment: repayment } })
  const view = change(row, [['repaymentDetails', false]])
  assert.equal(view.payload.decisions.repayment, null)
  assert.throws(() => prepare(row, view.payload), error => error.code === 'VALIDATION_ERROR' || error.publicCode === 'VALIDATION_ERROR')
  const next = prepare(row, { ...view.payload, acknowledgedChanges: ['repayment'] })
  assert.equal(next.fieldSources.loanRepayment, null)
})
test('贷款账户不展开明细也能整笔关联计划', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId })
  assert.equal(model.derive(publicRow(row), model.create(publicRow(row)), catalog).loanPayee, true)
  const view = change(row, [['loanMode','associate'], ['loanId',randomUUID()], ['loanVersion',2]])
  assert.equal(view.canSave, true); assert.equal(view.complete, true)
  const decision = view.payload.decisions.repayment
  assert.equal(decision.confirmed, true); assert.equal(decision.mode, 'associate')
  assert.equal(decision.principalMinor, '10000'); assert.equal(decision.interestMinor, '0'); assert.equal(decision.feeMinor, '0')
  assert.deepEqual(transactionDrafts(prepare(row, view.payload)).map(draft => [draft.type, String(draft.amountMinor)]), [['transfer','10000']])
  const missingPlan = change(row, [['loanMode','associate']])
  assert.equal(missingPlan.complete, false)
  assert.equal(missingPlan.payload.decisions.repayment.mode, 'review')
})
test('信用卡收款端同样显示贷款计划组', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: credit.accountId })
  const view = model.derive(publicRow(row), model.create(publicRow(row)), catalog)
  assert.equal(view.loanPayee, true); assert.equal(view.creditPayee, true); assert.equal(view.showLoan, true)
  // 只有付给资产账户时才没有计划可关联。
  const bankRow = base('repayment', { counterpartyLedgerAccountId: bank.accountId })
  assert.equal(model.derive(publicRow(bankRow), model.create(publicRow(bankRow)), catalog).loanPayee, false)
})
test('恢复只有待核对状态的重试请求不抹掉已填明细', () => {
  const row = publicRow(base('repayment', { counterpartyLedgerAccountId: debt.accountId, fieldSources: {
    loanRepayment: { mode: 'review' },
    editorOverrides: { version: 1, incompleteRepayment: { mode:'defer', principalMinor:'9000', interestMinor:null, feeMinor:'0',
      interestTreatment:null, feeTreatment:null, interestCategoryId:null, feeCategoryId:null, chargeAllocations:[] } } } }))
  const restored = model.restore(row, { decisions: { repayment: { mode: 'review' } } })
  assert.equal(restored.repaymentDetails, true)
  assert.equal(restored.principalInput, '90.00')
  assert.equal(restored.interestTreatment, '')
  assert.equal(restored.loanMode, 'defer')
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
test('退款暂记是用户决定：候选和其他待核对项不构成门禁，只有来源冲突拒绝', () => {
  const row = base('refund')
  assert.equal(refund.pendingState(row).allowed, true)
  // 有候选、有硬阻断或还没读另一个范围，都不替用户拒绝“先不关联”。
  assert.equal(refund.pendingState({ ...row, reasonCodes: ['row_status_unknown', 'refund_relation_required'] }).allowed, true)
  const conflict = refund.pendingState({ ...row, fieldSources: { refundSourceConflict: {} } })
  assert.equal(conflict.allowed, false); assert.equal(conflict.reason, 'source_conflict')
  assert.equal(refund.pendingState({ ...row, reasonCodes: ['refund_source_conflict'] }).reason, 'source_conflict')
  assert.equal(refund.pendingState({ ...row, economicNature: 'expense' }).reason, 'not_refund')
  // 这是一个纯判断，不再为暂记额外查询两个候选范围。
  assert.equal(refund.pendingState.length, 1)
})

const tap=(data)=>({currentTarget:{dataset:data}})
test('UE47 旧服务无 editorFacts 时只读，不能通过输入或保存伪造编辑成功',async()=>{
  const h=runtime(fixture(1,true)),page=h.page
  h.intercept=(action,input)=>action==='economicEvents.detail'&&!input.evidenceId
    ? {protocolVersion:2,viewVersion:h.summary.viewVersion,part:JSON.stringify(h.events[0]),nextCursor:null}:undefined
  await page.openReviewEdit(tap({id:h.events[0].eventId}))
  const before=JSON.stringify(page.data.reviewEditSheet.draft)
  assert.equal(page.data.reviewEditSheet.editor.supported,false)
  assert.match(page.data.reviewEditSheet.editor.readonlyReason,/更新导入服务/)
  page.changeEditorText({currentTarget:{dataset:{field:'note'}},detail:{value:'不应提交'}})
  await page.saveReviewEdit()
  assert.equal(JSON.stringify(page.data.reviewEditSheet.draft),before)
  assert.equal(page.data.reviewEditSheet.canSave,false)
  assert.equal(h.calls.some(call=>call.action==='financeUpdates.setReview'),false)
  page.onUnload()
})
test('真实 Page：普通字段点同组第二笔只打开第二笔，已填值可改且只保存本笔',async()=>{
  const data=fixture(2,true);data.issues[0].issueType='shared_fields'
  const h=runtime(data),page=h.page
  await page.setStep({currentStep:3})
  const row=h.events[1]
  await page.openPendingRecord(tap({id:row.eventId,issueId:h.issues[0].issueId}))
  assert.equal(page._reviewEditToken.eventId,row.eventId)
  page.changeEditorText({currentTarget:{dataset:{field:'note'}},detail:{value:'只改第二笔'}})
  assert.equal(page._reviewEditToken.view.payload.fields.note,'只改第二笔')
  assert.equal(h.events[0].note,undefined)
  page.onUnload()
})
test('真实 Page：退款候选晚到或失败不改写输入；暂记不依赖候选读取',async()=>{
  const data=fixture(1,true);data.events[0].economicNature='refund'
  const h=runtime(data),page=h.page
  let release, held = false
  // 打开编辑器就会读取本批候选，所以拦截必须在打开之前装好，才能拿到“晚到”的时机。
  // 只扣住第一次读取；本批为空后自动补查“已入账”的那次正常返回。
  h.intercept=(action)=>{ if (action!=='economicEvents.refundCandidates') return undefined; if (held) return undefined; held=true; return new Promise(resolve=>{release=resolve}) }
  await page.openReviewEdit(tap({id:h.events[0].eventId}))
  await flush()
  const loading=page._reviewEditToken.refundRead
  // 候选还在读时也可以先决定暂不关联：这个决定不等候选。
  assert.equal(page.data.reviewEditSheet.editor.refundActions.pending.enabled,true)
  page.selectEditorRefund(tap({mode:'pending'}))
  assert.equal(page.data.reviewEditSheet.draft.refund.mode,'pending')
  page.changeEditorText({currentTarget:{dataset:{field:'note'}},detail:{value:'先记下，稍后补关联'}})
  release({viewVersion:h.summary.viewVersion,items:[],total:0,nextCursor:null});await loading
  assert.equal(page.data.reviewEditSheet.draft.note,'先记下，稍后补关联')
  assert.equal(page.data.reviewEditSheet.refundTotal,0)
  // 晚到的候选不覆盖用户刚写的备注，也不改变暂记决定。
  assert.equal(page.data.reviewEditSheet.editor.refundStatus,'已设为暂记待关联')
  assert.equal(page.data.reviewEditSheet.editor.refundActions.pending.enabled,false)
  page.onUnload()
})

test('隐藏本息费不随多账户模式提交；缺账户的组成保留合法未完成草稿', () => {
  const row = base('repayment', { counterpartyLedgerAccountId: debt.accountId })
  let draft = model.create(publicRow(row))
  for (const [key, value] of [['repaymentDetails',true], ['principalInput','100'], ['interestInput','0'], ['feeInput','0']]) draft = model.change(publicRow(row), draft, key, value)
  const partial = model.derive(publicRow(row), model.change(publicRow(row), draft, 'counterpartyLedgerAccountId', ''), catalog)
  assert.equal(partial.canSave, true)
  assert.equal(partial.payload.decisions.repayment.mode, 'review')
  const split = model.derive(publicRow(row), model.change(publicRow(row), draft, 'composition', 'payment'), catalog)
  assert.equal(split.showLoan, false)
  assert.ok(split.accountFields.find(field => field.label === '还入账户').allowedTypes.includes('credit'))
  assert.equal(split.payload.decisions && split.payload.decisions.repayment, undefined)
})

test('UE24 资金结构往返保留各自账户和分配；代还仅提交当前单端', () => {
  const row = publicRow(base('repayment', { counterpartyLedgerAccountId: credit.accountId }))
  let draft = model.create(row)
  draft = model.change(row, draft, 'composition', 'payment')
  draft = model.change(row, draft, 'parts', [{ accountId: wallet.accountId, amountInput: '30' }, { accountId: bank.accountId, amountInput: '70' }])
  draft = model.change(row, draft, 'evidenceNote', '合成分配')
  draft = model.change(row, draft, 'composition', 'single')
  assert.equal(draft.ledgerAccountId, wallet.accountId); assert.equal(draft.counterpartyLedgerAccountId, credit.accountId)
  draft = model.change(row, draft, 'composition', 'payment')
  assert.deepEqual(draft.parts.map(part => part.amountInput), ['30','70'])
  draft = model.change(row, draft, 'owner', 'other')
  draft = model.change(row, draft, 'otherTreatment', 'expense')
  const other = model.derive(row, draft, catalog)
  assert.ok(other.fundsEndpoints.every(endpoint => !endpoint.multi)); assert.equal(other.payload.composition?.parts, undefined)
  assert.equal(other.payload.decisions.repayment, undefined)
  draft = model.change(row, draft, 'owner', 'self')
  assert.equal(draft.composition, 'payment'); assert.equal(draft.parts[1].accountId, bank.accountId)
})

test('UE10 贷款延后关联不提交隐藏计划和分类，切回恢复输入', () => {
  const row = publicRow(base('repayment', { counterpartyLedgerAccountId: debt.accountId }))
  let draft = model.create(row)
  for (const [key, value] of [['repaymentDetails',true], ['loanMode','associate'], ['loanId',randomUUID()],
    ['loanVersion',2], ['principalInput','90'], ['interestInput',''], ['interestCategoryId',randomUUID()], ['interestTreatment','accrued'], ['feeInput','0'], ['loanMode','defer']]) draft = model.change(row, draft, key, value)
  const saved = model.derive(row, draft, catalog).payload.decisions.repayment.draft
  assert.equal(saved.loanId, null); assert.equal(saved.loanVersion, null); assert.equal(saved.interestCategoryId, null)
  const selected = draft.loanId
  draft = model.change(row, draft, 'loanMode', 'associate')
  assert.equal(draft.loanId, selected); assert.equal(draft.principalInput, '90')
})

test('UE41 冻结请求恢复完整金额、时间、组成、贷款和明确清空值', () => {
  const row = publicRow(base())
  const restored = model.restore(row, { fields: { economicNature: 'repayment', amountMinor: '0', occurredLocalAt: null, note: '', counterparty: '', ledgerAccountId: null },
    composition: { kind: 'repayment', parts: [{ accountId: credit.accountId, amountMinor: null }], incomplete: true },
    decisions: { repayment: { mode: 'review', draft: { mode: 'associate', loanId: debt.accountId, loanVersion: 2, principalMinor: null, interestMinor: '0', feeMinor: null, chargeAllocations: [] } } } })
  assert.equal(restored.amountInput, '0.00'); assert.equal(restored.date, ''); assert.equal(restored.time, '')
  assert.equal(restored.note, ''); assert.equal(restored.counterparty, ''); assert.equal(restored.ledgerAccountId, '')
  assert.equal(restored.parts[0].amountInput, ''); assert.equal(restored.loanVersion, 2)
  assert.equal(restored.principalInput, ''); assert.equal(restored.interestInput, '0.00')
})

test('UE40 真实 Page 过期后重读保留完整草稿，必须人工再次保存', async () => {
  const h = runtime(fixture(1, true)), page = h.page
  await page.openReviewEdit(tap({ id: h.events[0].eventId }))
  for (const [field, value] of [['note',''], ['evidenceNote','冻结前保留的说明']]) page.changeEditorText({ currentTarget: { dataset: { field } }, detail: { value } })
  const originalDraft = JSON.stringify(page._reviewEditToken.draft)
  page.invalidateReviewEdit()
  h.summary = { ...h.summary, viewVersion: 'v2', update: { ...h.summary.update, version: 2 } }
  h.events[0].version = 2
  await page.refreshReviewEdit()
  assert.equal(JSON.stringify(page._reviewEditToken.draft), originalDraft)
  assert.equal(page._reviewEditToken.row.version, 2)
  assert.equal(page.data.reviewEditSheet.stale, false)
  assert.match(page.data.reviewEditSheet.error, /输入仍保留/)
  assert.equal(h.calls.some(call => call.action === 'financeUpdates.setReview'), false)
  page.onUnload()
})

test('UE25 真实 Page：暂记不等待候选，也不再要求用户先切换范围', async () => {
  const data = fixture(1, true); data.events[0].economicNature = 'refund'
  const h = runtime(data), page = h.page
  h.refundCandidates = { event: [], transaction: [] }
  await page.openReviewEdit(tap({ id: h.events[0].eventId }))
  await page._reviewEditToken.refundRead
  const pending = page.data.reviewEditSheet.editor.refundActions.pending
  assert.equal(pending.enabled, true)
  assert.match(pending.reason, /补关联/)
  assert.equal(h.calls.filter(call => call.action === 'economicEvents.refundCandidates' && call.input.kind === 'transaction').length, 0,
    '暂记不需要额外拉已入账列表')
  page.selectEditorRefund(tap({ mode: 'pending' }))
  assert.equal(page._reviewEditToken.view.payload.decisions.refund.mode, 'pending')
  // 草稿已经暂记时不再留一个重复的“暂记待关联”，改成可撤销的「取消暂记」。
  assert.equal(page.data.reviewEditSheet.editor.refundActions.pending.visible, false)
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.label, '取消暂记')
  page.selectEditorRefund(tap({ mode: 'clear' }))
  assert.equal(page.data.reviewEditSheet.draft.refund, null)
  assert.equal(page.data.reviewEditSheet.editor.refundActions.pending.enabled, true)
  page.onUnload()
})

test('UE25b 有候选时仍可暂记：含义是“这些都不是，先不关联”', async () => {
  const data = fixture(1, true); data.events[0].economicNature = 'refund'
  const h = runtime(data), page = h.page
  h.refundCandidates = { event: [{ id: 'synthetic-original', version: 1, kind: 'event', amountMinor: '100',
    remainingMinor: '100', localAt: '2026-09-01 10:00:00', utcAt: '2026-09-01 02:00:00', currency: 'CNY' }], transaction: [] }
  await page.openReviewEdit(tap({ id: h.events[0].eventId }))
  await page._reviewEditToken.refundRead
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '待选原消费')
  assert.equal(page.data.reviewEditSheet.editor.refundActions.pending.enabled, true)
  // 选了一笔后，暂记仍然可点；保存时会把这次选择换成“暂不关联”。
  page.selectEditorRefund(tap({ id: 'synthetic-original' }))
  assert.match(page.data.reviewEditSheet.editor.refundActions.pending.reason, /选中的原消费不会生效/)
  // 取消本次选择靠再点卡片；不再多出「取消选择」按钮，只保留暂记入口。
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.visible, false)
  page.selectEditorRefund(tap({ mode: 'pending' }))
  assert.equal(page._reviewEditToken.view.payload.decisions.refund.mode, 'pending')
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '已设为暂记待关联')
  // 再点已选中的候选即取消选择；暂记草稿已存在时先取消暂记。
  page.selectEditorRefund(tap({ mode: 'clear' }))
  assert.equal(page.data.reviewEditSheet.draft.refund, null)
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '待选原消费')
  page.selectEditorRefund(tap({ id: 'synthetic-original' }))
  assert.equal(page.data.reviewEditSheet.draft.refund.id, 'synthetic-original')
  page.selectEditorRefund(tap({ id: 'synthetic-original' }))
  assert.equal(page.data.reviewEditSheet.draft.refund, null)
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '待选原消费')
  page.onUnload()
})

test('UE25c 候选读取失败只影响候选列表，不阻塞暂记；重试后候选恢复', async () => {
  const data = fixture(1, true); data.events[0].economicNature = 'refund'
  const h = runtime(data), page = h.page
  h.refundCandidates = { event: [], transaction: [] }
  await page.openReviewEdit(tap({ id: h.events[0].eventId }))
  await page._reviewEditToken.refundRead
  h.intercept = action => { if (action === 'economicEvents.refundCandidates') throw Error('合成候选失败') }
  await page.loadEditorRefunds(tap({ kind: 'transaction' }))
  let pending = page.data.reviewEditSheet.editor.refundActions.pending
  assert.equal(pending.enabled, true, '候选读取失败不妨碍用户选择暂不关联')
  assert.match(page.data.reviewEditSheet.refundError, /合成候选失败/)
  page.selectEditorRefund(tap({ mode: 'pending' }))
  assert.equal(page._reviewEditToken.view.payload.decisions.refund.mode, 'pending')
  h.intercept = null
  await page.loadEditorRefunds(tap({ kind: 'transaction' }))
  pending = page.data.reviewEditSheet.editor.refundActions.pending
  // 草稿已暂记：暂记按钮让位给「取消暂记」，而不是变灰。
  assert.equal(pending.visible, false)
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.label, '取消暂记')
  page.onUnload()
})

test('UE25d 已保存关系再点候选是取消本次选择，清除已保存关系仍是明确动作', async () => {
  const data = fixture(1, true); data.events[0].economicNature = 'refund'
  data.events[0].detailFacts = { refund: { status: 'confirmed', autoLinked: false, originals: [
    { eventId: 'synthetic-original', localAt: '2026-09-01 10:00', amountMinor: '100', categoryName: '合成分类' }] } }
  const h = runtime(data), page = h.page
  h.refundCandidates = { event: [], transaction: [] }
  await page.openReviewEdit(tap({ id: h.events[0].eventId }))
  await page._reviewEditToken.refundRead
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '已关联原消费')
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.visible, true)
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.label, '清除关联')
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.target, 'saved')
  page.selectEditorRefund(tap({ mode: 'clear' }))
  assert.equal(page._reviewEditToken.view.payload.decisions.refund.mode, 'unlinked')
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '已清除关联')
  assert.equal(page.data.reviewEditSheet.editor.refundActions.clear.label, '撤销清除')
  page.selectEditorRefund(tap({ mode: 'clear' }))
  assert.equal(page.data.reviewEditSheet.draft.refund, null)
  assert.equal(page.data.reviewEditSheet.editor.refundStatus, '已关联原消费')
  page.onUnload()
})

test('UE25e 翻页后仍能选中上一页的候选，不会在点卡片时查不到数据', async () => {
  const data = fixture(1, true); data.events[0].economicNature = 'refund'
  const h = runtime(data), page = h.page
  const card = id => ({ id, version: 1, kind: 'event', amountMinor: '100', remainingMinor: '100',
    localAt: '2026-09-01 10:00:00', utcAt: '2026-09-01 02:00:00', currency: 'CNY', merchant: '合成商户-' + id })
  h.intercept = (action, input) => {
    if (action !== 'economicEvents.refundCandidates') return
    return input.cursor
      ? { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [card('synthetic-later')], total: 2, nextCursor: null }
      : { protocolVersion: 2, viewVersion: h.summary.viewVersion, items: [card('synthetic-earlier')], total: 2, nextCursor: '1' }
  }
  await page.openReviewEdit(tap({ id: h.events[0].eventId }))
  await page._reviewEditToken.refundRead
  await page.loadEditorRefunds(tap({ kind: 'event', more: true }))
  assert.equal(page.data.reviewEditSheet.refundChoices.length, 2)
  // 第一页的卡片在读完第二页后仍可点选；候选数据不能只剩最后一页。
  page.selectEditorRefund(tap({ id: 'synthetic-earlier' }))
  assert.equal(page._reviewEditToken.draft.refund?.id, 'synthetic-earlier')
  page.selectEditorRefund(tap({ id: 'synthetic-later' }))
  assert.equal(page._reviewEditToken.draft.refund?.id, 'synthetic-later')
  page.onUnload()
})

test('金额方向色按有效性质派生，与服务端 flowDirection 重算规则同源', () => {
  const expected = { expense: 'row-expense', fee: 'row-expense', unknown: 'row-expense',
    income: 'row-income', refund: 'row-income', internal_transfer: '', repayment: '', borrow: '' }
  for (const nature of Object.keys(expected)) {
    assert.equal(change(base(nature), []).directionClass, expected[nature], nature + ' 的方向色')
  }
})

test('切换性质后方向色同步变化；代还记为支出按支出着色', () => {
  assert.equal(change(base('repayment'), [['economicNature', 'expense']]).directionClass, 'row-expense')
  assert.equal(change(base('income'), [['economicNature', 'expense']]).directionClass, 'row-expense')
  assert.equal(change(base('expense'), [['economicNature', 'income']]).directionClass, 'row-income')
  const other = change(base('repayment', { repaymentOwnership: { owner: 'other', treatment: 'expense' } }), [])
  assert.equal(other.directionClass, 'row-expense')
  const keep = change(base('repayment', { repaymentOwnership: { owner: 'other', treatment: 'pending' } }), [])
  assert.equal(keep.directionClass, 'row-expense')
})

test('路由分组标题区分单端与双端，分期本金另列', () => {
  assert.equal(change(base('expense'), []).routeTitle, '资金账户')
  assert.equal(change(base('income'), []).routeTitle, '资金账户')
  assert.equal(change(base('internal_transfer'), []).routeTitle, '资金路径')
  assert.equal(change(base('borrow'), []).routeTitle, '资金路径')
  const installment = { creditStatement: true, component: 'principal', periodNumber: 3, totalTerms: 12 }
  const row = base('repayment', { fieldSources: { installment } })
  assert.equal(model.derive(publicRow({ ...row, installment }), model.create(publicRow({ ...row, installment })), catalog).routeTitle, '分期所属账户')
})

test('组合支付后仍可切回单账户：端点组不随账户行数量消失', () => {
  const row = publicRow(base('expense'))
  let draft = model.create(row)
  draft = model.change(row, draft, 'composition', 'payment')
  const payment = model.derive(row, draft, catalog)
  // 支出只有付款端一组：账户清单来自 parts，组本身不依赖 routeFields 是否有内容。
  assert.equal(payment.routeFields.length, 0)
  assert.equal(payment.fundsEndpoints.length, 1)
  assert.equal(payment.fundsEndpoints[0].key, 'payer')
  assert.equal(payment.fundsEndpoints[0].multi, true)
  assert.equal(payment.fundsEndpoints[0].accounts.length, 2)
  assert.equal(payment.routeTitle, '资金账户')
  draft = model.change(row, draft, 'composition', 'single')
  const back = model.derive(row, draft, catalog)
  assert.equal(back.fundsEndpoints.length, 1)
  assert.equal(back.fundsEndpoints[0].multi, false)
  assert.equal(back.routeTitle, '资金账户')
  assert.equal(back.routeFields.length, 1)
})

test('资金路径只按端点组渲染，模板不再判断结构模式', () => {
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../miniprogram/packages/finance/pages/import-workbench/review-editor-fields.wxml'), 'utf8')
  assert.match(text, /editor\.fundsEndpoints\.length/)
  assert.doesNotMatch(text, /showStructure|showComposition|editor\.routeFields|editor\.partFields/)
})

test('声明了多账户组成却没有任何分配时，端点组仍留一条空行', () => {
  const row = base('expense', { fieldSources: { paymentResolution: { version: 1 },
    editorOverrides: { version: 1, composition: 'payment', incompleteComposition: { parts: [] } } } })
  const draft = model.create(publicRow(row))
  assert.equal(draft.composition, 'payment')
  assert.equal(draft.parts.length, 1)
  assert.equal(draft.parts[0].accountId, '')
  const view = model.derive(publicRow(row), draft, catalog)
  assert.equal(view.fundsEndpoints.length, 1)
  assert.equal(view.fundsEndpoints[0].multi, true)
  assert.equal(view.fundsEndpoints[0].accounts.length, 1)
  // 只有一个账户就不算分摊：不出金额列，按单账户的样子显示。
  assert.equal(view.fundsEndpoints[0].split, false)
  assert.equal(view.payload.composition.incomplete, true)
})
