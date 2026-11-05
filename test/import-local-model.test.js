const test = require('node:test')
const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')
const { facts } = require('./helpers/local-review')
const local = require('../miniprogram/packages/finance/services/import-local-model')
const read = require('../miniprogram/packages/finance/services/import-local-read')
const { buildCoverageReport } = require('../cloudfunctions/catledger-import/src/coverage-report')
const { workbenchSummary } = require('../cloudfunctions/catledger-import/src/workbench-summary')
function compare(model, reader) {
  const events=[...model.events.values()],issues=[...model.issues.values()],counts=new Map()
  for(const issue of issues){const key=issue.issueType+':'+issue.status,value=counts.get(key)||{issueType:issue.issueType,status:issue.status,count:0,blockingCount:0};value.count++;if(issue.blocking&&issue.issueType!=='category_assignment')value.blockingCount++;counts.set(key,value)}
  const pending=events.map(event=>{const open=model.eventIssues(event.eventId).filter(row=>row.status==='open');return{eventId:event.eventId,review:model.invalid.has(event.eventId)||open.some(row=>row.blocking&&row.issueType!=='category_assignment'),category:open.some(row=>row.issueType==='category_assignment')}})
  const coverage=buildCoverageReport({...model.facts,events,issues,evidence:[...model.evidence.values()]})
  coverage.serverReviewPending=model.needsCheck.size;if(model.invalid.size)coverage.selectedEventsReadyToPost=false
  const workbench=workbenchSummary(events,pending,[...counts.values()],[...model.evidence.values()].filter(row=>['supporting','duplicate'].includes(row.evidenceRole)).length,model.drafts.size)
  workbench.pairingSuggestedCount=model.suggestedCount
  assert.deepEqual(reader.summary().coverage,coverage)
  assert.deepEqual(reader.summary().workbench,workbench)
}

test('局部累计与服务端全批规则一致：分类、金额、性质、组成及明确范围排除', async () => {
  const value=await facts({count:180}),model=local.create(value),reader=read.create(model),ids=[...model.events.keys()]
  compare(model,reader)
  model.edit({eventId:ids[0],editorVersion:1,fields:{categoryId:value.categories[0].categoryId,amountMinor:'2400',note:'独立编辑'}});compare(model,reader)
  model.edit({eventId:ids[1],editorVersion:1,fields:{economicNature:'income',categoryId:value.categories[1].categoryId}});compare(model,reader)
  model.edit({eventId:ids[2],editorVersion:1,composition:{kind:'payment',evidenceNote:'合成拆分',parts:[{accountId:value.accounts[0].accountId,amountMinor:'30'},{accountId:value.accounts[1].accountId,amountMinor:'70'}]}});compare(model,reader)
  const issue=[...model.issues.values()].find(row=>row.status==='open'&&row.issueType==='category_assignment')
  model.review({issueId:issue.issueId,decision:'exclude_events',selection:{mode:'include',eventIds:[ids[3],ids[4]]}});compare(model,reader)
  model.review({issueId:issue.issueId,decision:'exclude_events',selection:{mode:'include',eventIds:[ids[5]]}});compare(model,reader)
  assert.equal(model.finalState().decisions.reviews[0].eventIds.length,3)
  assert.equal(model.events.get(ids[6]).status,'ready')
})

test('本地退款：日期/金额更新候选，排除原消费立即撤销关系有效性', async () => {
  const value=await facts({count:3}),model=local.create(value),reader=read.create(model),ids=[...model.events.keys()]
  model.edit({eventId:ids[0],editorVersion:1,fields:{economicNature:'refund',amountMinor:'60',occurredLocalAt:'2026-09-02 12:00:00',timezoneOffsetMinutes:-480}})
  assert.equal(model.refundCandidates(model.events.get(ids[0]),'event').length,2)
  model.edit({eventId:ids[0],editorVersion:1,decisions:{refund:{mode:'link',kind:'event',id:ids[1],version:model.events.get(ids[1]).version}}})
  assert.equal([...model.relations.values()].filter(row=>row.status==='confirmed').length,1)
  model.edit({eventId:ids[2],editorVersion:1,fields:{occurredLocalAt:'2026-09-03 12:00:00',timezoneOffsetMinutes:-480}})
  assert.deepEqual(model.refundCandidates(model.events.get(ids[0]),'event').map(row=>row.id),[ids[1]])
  const issue=[...model.issues.values()].find(row=>row.status==='open'&&row.subjectEventIds.includes(ids[1]))
  model.review({issueId:issue.issueId,decision:'exclude_events',selection:{mode:'include',eventIds:[ids[1]]}})
  assert.equal(model.invalid.has(ids[0]),true)
  assert.equal(model.events.get(ids[0]).status,'needs_action')
  assert.equal(model.refundCandidates(model.events.get(ids[0]),'event').length,0)
  compare(model,reader)
})

test('已下载历史随字段重算，旧人工确认失效；快照外范围保持待复核且基础事实只读',async()=>{
  const value=await facts({count:3}),{randomUUID}=require('node:crypto'),id=value.events[0].eventId
  value.history=[{transactionId:randomUUID(),version:1,type:'expense',amountMinor:'200',sourceAccountId:value.accounts[0].accountId,
    destinationAccountId:null,utcAt:value.events[0].utcAt,localAt:value.events[0].localAt,deletedAt:null}]
  const codec=require('../cloudfunctions/catledger-import/src/local-review-snapshot'),decoded=codec.decode(codec.encode(value))
  assert.deepEqual(decoded,value)
  const capture=structuredClone(value),encoded=codec.encodeText(capture,{consume:true})
  assert.deepEqual(codec.decode(JSON.parse(encoded)),value)
  assert.deepEqual(capture,{})
  const escaped=structuredClone(value)
  escaped.raw[0].fields.codec='标点[,]{}与转义\\"\n、表情😀'
  const text=codec.encodeText(escaped)
  function* fragments(){for(let index=0;index<text.length;index+=7)yield text.slice(index,index+7)}
  assert.deepEqual(codec.decodeParts(fragments()),escaped)
  for(const broken of [text.slice(0,-1),text+'{}',text.replace('"root":[','"root":[999999999,')])
    assert.throws(()=>codec.decodeParts([broken]),{code:'SNAPSHOT_INCOMPLETE'})
  const original=JSON.stringify(decoded),model=local.create(decoded)
  model.edit({eventId:id,editorVersion:1,fields:{amountMinor:'200'}})
  const issue=[...model.issues.values()].find(row=>row.primaryReasonCode==='historical_duplicate_candidate'&&row.status==='open')
  assert.ok(issue);assert.equal(model.members.get(issue.issueId).filter(row=>row.objectType==='transaction').length,1)
  model.review({issueId:issue.issueId,decision:'confirm_distinct'})
  assert.equal(model.finalState().decisions.reviews.length,1)
  const changes=model.edit({eventId:id,editorVersion:1,fields:{amountMinor:'300'}})
  assert.equal(model.finalState().decisions.reviews.length,0)
  assert.ok(changes.some(row=>row.kind==='reviews'&&row.value===null))
  assert.equal(model.needsCheck.has(id),true)
  assert.equal(JSON.stringify(decoded),original)
})

test('已确认的花呗信用购账户直接还入，不再留下还款分配', async () => {
  const value = await facts({ count: 2 })
  const huabei = value.accounts.find(account => account.type === 'credit')
  huabei.name = '支付宝花呗｜信用购'
  const bank = value.accounts.find(account => account.type === 'wallet')
  const spend = value.events[0], repay = value.events[1]
  spend.economicNature = 'expense'
  spend.flowDirection = 'outflow'
  spend.ledgerAccountId = huabei.accountId
  spend.fieldSources = { ...spend.fieldSources, ledgerAccountReference: { aggregateFamilies: ['alipay_huabei_credit'], label: '支付宝花呗｜信用购', sourceType: 'alipay' } }
  Object.assign(repay, { economicNature: 'repayment', flowDirection: 'neutral', ledgerAccountId: bank.accountId,
    counterpartyLedgerAccountId: null, status: 'needs_action', reasonCodes: ['repayment_allocation_required'], categoryId: null })
  repay.fieldSources = { ...repay.fieldSources, fundsProjection: { kind: 'repayment',
    to: { referenceKind: 'aggregate', aggregateFamily: 'alipay_huabei_credit', label: '支付宝花呗｜信用购', paymentMethodKey: null, candidates: [] } } }
  const model = local.create(value)
  const changes = model.settleHuabeiRepayments()
  const next = model.events.get(repay.eventId)
  assert.equal(next.counterpartyLedgerAccountId, huabei.accountId)
  assert.equal(next.fieldSources.editorOverrides.composition, 'single')
  assert.equal(next.reasonCodes.includes('repayment_allocation_required'), false)
  assert.equal(next.status, 'ready')
  assert.equal(model.finalState().decisions.events.some(row => row.eventId === repay.eventId && row.editor.composition.kind === 'single' && row.editor.fields.counterpartyLedgerAccountId === huabei.accountId), true)
  assert.ok(changes.some(row => row.kind === 'events'))
  assert.equal(model.settleHuabeiRepayments().length, 0)
  const ambiguousFacts = await facts({ count: 2 })
  const credit = ambiguousFacts.accounts.find(account => account.type === 'credit')
  credit.name = '支付宝花呗｜信用购'
  ambiguousFacts.accounts.push({ ...credit, accountId: require('node:crypto').randomUUID(), name: '花呗' })
  const pending = ambiguousFacts.events[1]
  Object.assign(pending, { economicNature: 'repayment', flowDirection: 'neutral', ledgerAccountId: ambiguousFacts.accounts.find(account => account.type === 'wallet').accountId,
    counterpartyLedgerAccountId: null, status: 'needs_action', categoryId: null })
  pending.fieldSources = { ...pending.fieldSources, fundsProjection: { to: { referenceKind: 'aggregate', aggregateFamily: 'alipay_huabei_credit', label: '支付宝花呗｜信用购', candidates: [] } } }
  assert.equal(local.create(ambiguousFacts).settleHuabeiRepayments().length, 0)
})

test('花呗|信用购还款并进已确认的花呗信用购账户，不再单独待确认', async () => {
  const { randomUUID } = require('node:crypto')
  const value = await facts({ count: 3, mapped: false })
  const huabei = value.accounts.find(account => account.type === 'credit')
  huabei.name = '支付宝花呗｜信用购'
  const bank = value.accounts.find(account => account.type === 'wallet')
  const spend = value.events[0], repay = value.events[1], other = value.events[2]
  spend.ledgerAccountId = huabei.accountId
  spend.fieldSources = { ...spend.fieldSources, ledgerAccountReference: {
    sourceType: 'alipay', label: '支付宝花呗｜信用购', aggregateFamilies: ['alipay_huabei_credit'], paymentMethodKey: 'family-key'
  } }
  Object.assign(repay, { economicNature: 'repayment', flowDirection: 'neutral', ledgerAccountId: bank.accountId,
    counterpartyLedgerAccountId: null, status: 'needs_action', reasonCodes: ['repayment_account_required'], categoryId: null })
  repay.fieldSources = { ...repay.fieldSources, ledgerAccountReference: {
    sourceType: 'alipay', label: '浙江农商联合银行储蓄卡(5564)', paymentMethodKey: 'bank-key'
  }, fundsProjection: { kind: 'repayment', to: {
    referenceKind: 'aggregate', aggregateFamily: 'alipay_huabei_credit', label: '支付宝花呗｜信用购', paymentMethodKey: null, candidates: []
  } } }
  other.fieldSources = { ...other.fieldSources, ledgerAccountReference: {
    sourceType: 'alipay', label: '浙江农商联合银行储蓄卡(5564)', paymentMethodKey: 'bank-key', value: '浙江农商联合银行储蓄卡(5564)'
  } }
  const familyId = randomUUID(), strayId = randomUUID(), bankIssueId = randomUUID()
  const member = (issueId, event, role) => ({ memberId: randomUUID(), issueId, objectType: 'event', objectId: event.eventId,
    objectVersion: event.version, memberRole: role, sortOrder: 0 })
  value.issues.push(
    { issueId: familyId, issueType: 'account_mapping', primaryReasonCode: 'account_mapping_confirmed', reasonCodes: ['account_mapping_confirmed'],
      status: 'resolved', blocking: false, version: 1, memberCount: 1, candidateCount: 0, subjectEventIds: [spend.eventId],
      accountContext: { label: '支付宝花呗｜信用购', recognized: true, sourceType: 'alipay', paymentMethodKey: 'family-key',
        accountId: huabei.accountId, mappingAction: 'account', currency: 'CNY' } },
    { issueId: strayId, issueType: 'account_mapping', primaryReasonCode: 'payment_reference_mapping_required',
      reasonCodes: ['payment_reference_mapping_required'], status: 'open', blocking: true, version: 1, memberCount: 1,
      candidateCount: 0, subjectEventIds: [repay.eventId] },
    { issueId: bankIssueId, issueType: 'account_mapping', primaryReasonCode: 'payment_reference_mapping_required',
      reasonCodes: ['payment_reference_mapping_required'], status: 'open', blocking: true, version: 1, memberCount: 1,
      candidateCount: 0, subjectEventIds: [other.eventId],
      accountContext: { label: '浙江农商联合银行储蓄卡(5564)', recognized: true, sourceType: 'alipay', paymentMethodKey: 'bank-key', currency: 'CNY' } }
  )
  value.members.push(member(familyId, spend, 'subject'), member(strayId, repay, 'subject'), member(bankIssueId, other, 'subject'))
  const model = local.create(value), reader = read.create(model)
  model.settleHuabeiRepayments()
  assert.equal(model.events.get(repay.eventId).counterpartyLedgerAccountId, huabei.accountId)
  assert.equal(model.events.get(repay.eventId).ledgerAccountId, bank.accountId)
  assert.equal(model.issues.get(strayId).status, 'superseded')
  assert.ok(model.issues.get(familyId).subjectEventIds.includes(repay.eventId))
  assert.equal(model.issues.get(familyId).subjectEventIds.length, 2)
  assert.equal(model.issues.get(bankIssueId).status, 'open')
  assert.equal(model.issues.get(bankIssueId).subjectEventIds.includes(repay.eventId), false)
  const page = reader.read('reviewIssues.list', { group: 'accounts', view: 'account_confirmations', pageSize: 100 })
  assert.equal(page.items.some(item => item.issueId === strayId), false)
  const shown = page.items.find(item => item.issueId === familyId)
  assert.ok(shown)
  assert.equal(shown.memberCount, 2)
  assert.equal(model.settleHuabeiRepayments().length, 0)
  assert.equal(model.issues.get(familyId).subjectEventIds.length, 2)
})

test('花呗|信用购还款的付款账户仍是5564，还入花呗信用购不会把它清成待补充', async () => {
  const { randomUUID } = require('node:crypto')
  const editorModel = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
  const value = await facts({ count: 3, mapped: false })
  const huabei = value.accounts.find(account => account.type === 'credit')
  huabei.name = '支付宝花呗｜信用购'
  const bank = value.accounts.find(account => account.type === 'wallet')
  bank.name = '浙江农商联合银行储蓄卡(5564)'
  const spend = value.events[0], repay = value.events[1], cardSpend = value.events[2]
  const bankReference = { sourceType: 'alipay', label: '浙江农商联合银行储蓄卡(5564)', paymentMethodKey: 'bank-5564' }
  spend.ledgerAccountId = huabei.accountId
  spend.fieldSources = { ...spend.fieldSources, ledgerAccountReference: {
    sourceType: 'alipay', label: '支付宝花呗｜信用购', aggregateFamilies: ['alipay_huabei_credit'], paymentMethodKey: 'family-key'
  } }
  cardSpend.ledgerAccountId = bank.accountId
  cardSpend.fieldSources = { ...cardSpend.fieldSources, ledgerAccountReference: bankReference }
  Object.assign(repay, { economicNature: 'repayment', flowDirection: 'neutral', ledgerAccountId: null,
    counterpartyLedgerAccountId: null, status: 'needs_action', reasonCodes: ['repayment_account_required'], categoryId: null })
  repay.fieldSources = { ...repay.fieldSources, ledgerAccountReference: bankReference, fundsProjection: { kind: 'repayment',
    from: bankReference, to: { referenceKind: 'aggregate', aggregateFamily: 'alipay_huabei_credit', label: '支付宝花呗｜信用购', paymentMethodKey: null, candidates: [] } } }
  const familyId = randomUUID()
  value.issues.push({ issueId: familyId, issueType: 'account_mapping', primaryReasonCode: 'account_mapping_confirmed',
    reasonCodes: ['account_mapping_confirmed'], status: 'resolved', blocking: false, version: 1, memberCount: 1,
    candidateCount: 0, subjectEventIds: [spend.eventId], accountContext: { label: '支付宝花呗｜信用购', recognized: true,
      sourceType: 'alipay', paymentMethodKey: 'family-key', accountId: huabei.accountId, currency: 'CNY' } })
  value.members.push({ memberId: randomUUID(), issueId: familyId, objectType: 'event', objectId: spend.eventId,
    objectVersion: spend.version, memberRole: 'subject', sortOrder: 0 })
  const model = local.create(value)
  model.edit({ eventId: repay.eventId, editorVersion: 1, fields: { ledgerAccountId: null, counterpartyLedgerAccountId: huabei.accountId },
    composition: { kind: 'single' } })
  assert.equal(model.events.get(repay.eventId).ledgerAccountId, null)
  model.settleHuabeiRepayments()
  const next = model.events.get(repay.eventId)
  assert.equal(next.ledgerAccountId, bank.accountId)
  assert.equal(next.counterpartyLedgerAccountId, huabei.accountId)
  const row = { ...model.publicRow(repay.eventId), editorFacts: { version: 1, composition: 'single' } }
  const draft = editorModel.create(row)
  const fields = editorModel.accountFields(row, draft, [...model.accounts.values()])
  assert.equal(fields.find(field => field.label === '付款账户').name, '浙江农商联合银行储蓄卡(5564)')
  assert.equal(fields.find(field => field.label === '还入账户').name, '支付宝花呗｜信用购')
  const decision = model.finalState().decisions.events.find(item => item.eventId === repay.eventId)
  assert.equal(decision.editor.fields.ledgerAccountId, bank.accountId)
  assert.equal(model.settleHuabeiRepayments().length, 0)
  const ambiguous = await facts({ count: 2, mapped: false })
  const credit = ambiguous.accounts.find(account => account.type === 'credit')
  credit.name = '支付宝花呗｜信用购'
  const first = ambiguous.accounts.find(account => account.type === 'wallet')
  first.name = '浙江农商联合银行储蓄卡(5564)'
  const second = { ...first, accountId: randomUUID(), name: '另一家银行储蓄卡(5564)' }
  ambiguous.accounts.push(second)
  const pending = ambiguous.events[1]
  Object.assign(pending, { economicNature: 'repayment', flowDirection: 'neutral', ledgerAccountId: null,
    counterpartyLedgerAccountId: null, status: 'needs_action', categoryId: null })
  pending.fieldSources = { ...pending.fieldSources, fundsProjection: { kind: 'repayment',
    from: { sourceType: 'alipay', label: '储蓄卡(5564)', paymentMethodKey: null },
    to: { referenceKind: 'aggregate', aggregateFamily: 'alipay_huabei_credit', label: '支付宝花呗｜信用购', candidates: [] } } }
  ambiguous.events[0].ledgerAccountId = credit.accountId
  ambiguous.events[0].fieldSources = { ...ambiguous.events[0].fieldSources, ledgerAccountReference: {
    sourceType: 'alipay', aggregateFamilies: ['alipay_huabei_credit'], label: '支付宝花呗｜信用购'
  } }
  const unresolved = local.create(ambiguous)
  unresolved.settleHuabeiRepayments()
  assert.equal(unresolved.events.get(pending.eventId).counterpartyLedgerAccountId, credit.accountId)
  assert.equal(unresolved.events.get(pending.eventId).ledgerAccountId, null)
})

test('关闭原单的退款：收款账户用本批已确认的同一张卡，两张对得上就不猜', async () => {
  const { randomUUID } = require('node:crypto')
  const editorModel = require('../miniprogram/packages/finance/pages/import-workbench/review-editor-model')
  const HEAD = ['微信支付账单明细,,,,,,,,,,,',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注']
  const value = await facts({ content: Buffer.from(HEAD.concat([
    '2026-08-05 15:40:58,商户消费,合成平台商户,合成订单-A,支出,0.90,合成信用卡(0001),交易关闭,SYNTH-TX-A1,SYNTH-ORDER-A,SYNTH-M-A,',
    '2026-08-12 11:48:01,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.90,合成信用卡(0001),已退款¥0.90,SYNTH-TX-A2,SYNTH-ORDER-A,SYNTH-M-A,',
    '2026-08-01 09:00:00,商户消费,合成平台商户,合成订单-B,支出,12.00,合成信用卡(0001),支付成功,SYNTH-TX-B,SYNTH-ORDER-B,SYNTH-M-B,'
  ]).join('\n')), mapped: false })
  const card = value.accounts.find(account => account.type === 'credit')
  card.name = '已确认的信用卡'
  const refund = value.events.find(event => event.economicNature === 'refund')
  const spend = value.events.find(event => event.economicNature === 'expense' && event.status !== 'excluded')
  spend.ledgerAccountId = card.accountId
  assert.equal(refund.ledgerAccountId, null)
  const model = local.create(value)
  model.settleRefundAccounts()
  const next = model.events.get(refund.eventId)
  assert.equal(next.ledgerAccountId, card.accountId)
  assert.ok(next.reasonCodes.includes('refund_source_conflict'))
  assert.equal([...model.relations.values()].some(row => row.relationType === 'refund_of' && row.status === 'confirmed'), false)
  const row = model.publicRow(refund.eventId)
  const fields = editorModel.accountFields(row, editorModel.create(row), [...model.accounts.values()])
  assert.equal(fields.find(field => field.label === '收款账户').name, '已确认的信用卡')
  const decision = model.finalState().decisions.events.find(item => item.eventId === refund.eventId)
  assert.equal(decision.editor.fields.ledgerAccountId, card.accountId)
  assert.equal(model.settleRefundAccounts().length, 0)
  model.edit({ eventId: refund.eventId, editorVersion: 1, fields: { ledgerAccountId: null } })
  model.settleRefundAccounts()
  assert.equal(model.events.get(refund.eventId).ledgerAccountId, null)

  const ambiguous = await facts({ content: Buffer.from(HEAD.concat([
    '2026-08-05 15:40:58,商户消费,合成平台商户,合成订单-A,支出,0.90,合成信用卡(0001),交易关闭,SYNTH-TX-C1,SYNTH-ORDER-C,SYNTH-M-C,',
    '2026-08-12 11:48:01,合成平台商户-退款,合成平台商户,合成平台商户,收入,0.90,合成信用卡(0001),已退款¥0.90,SYNTH-TX-C2,SYNTH-ORDER-C,SYNTH-M-C,',
    '2026-08-01 09:00:00,商户消费,合成平台商户,合成订单-B,支出,12.00,合成信用卡(0001),支付成功,SYNTH-TX-C3,SYNTH-ORDER-C3,SYNTH-M-C3,',
    '2026-08-02 09:00:00,商户消费,合成平台商户,合成订单-D,支出,8.00,合成信用卡(0001),支付成功,SYNTH-TX-C4,SYNTH-ORDER-C4,SYNTH-M-C4,'
  ]).join('\n')), mapped: false })
  const first = ambiguous.accounts.find(account => account.type === 'credit')
  first.name = '甲信用卡'
  const second = { ...first, accountId: randomUUID(), name: '乙信用卡' }
  ambiguous.accounts.push(second)
  const pending = ambiguous.events.find(event => event.economicNature === 'refund')
  const spends = ambiguous.events.filter(event => event.economicNature === 'expense' && event.status !== 'excluded')
  spends[0].ledgerAccountId = first.accountId
  spends[1].ledgerAccountId = second.accountId
  const unresolved = local.create(ambiguous)
  unresolved.settleRefundAccounts()
  assert.equal(unresolved.events.get(pending.eventId).ledgerAccountId, null)
})

test('分期本金改判解决字段冲突：本机草稿同步收起冲突事项', async () => {
  const { randomUUID } = require('node:crypto'), value = await facts({ count: 1 }), event = value.events[0]
  const credit = value.accounts.find(account => account.type === 'credit')
  Object.assign(event, { economicNature: 'repayment', flowDirection: 'neutral', ledgerAccountId: credit.accountId,
    reasonCodes: ['core_fields_conflict'],
    fieldSources: { ...event.fieldSources, installment: { creditStatement: true, component: 'principal', periodNumber: 1, totalTerms: 6 } } })
  const issueId = randomUUID()
  value.issues.push({ issueId, issueType: 'field_conflict', primaryReasonCode: 'core_fields_conflict',
    reasonCodes: ['core_fields_conflict'], status: 'open', blocking: true, version: 1, memberCount: 1, candidateCount: 0,
    subjectEventIds: [event.eventId] })
  value.members.push({ memberId: randomUUID(), issueId, objectType: 'event', objectId: event.eventId,
    objectVersion: event.version, memberRole: 'subject', sortOrder: 0 })
  const model = local.create(value)
  model.edit({ eventId: event.eventId, editorVersion: 1, fields: { economicNature: 'expense' } })
  assert.equal(model.events.get(event.eventId).economicNature, 'expense')
  assert.equal(model.events.get(event.eventId).reasonCodes.includes('core_fields_conflict'), false)
  assert.equal(model.issues.get(issueId).status, 'resolved')
  assert.equal(model.issues.get(issueId).blocking, false)
})

test('24990 行本地核对：单笔保存/摘要仅更新关联对象，分页渲染有界', {timeout:120000}, async t => {
  const before=process.memoryUsage().heapUsed,prepare=performance.now(),value=await facts({count:24990})
  const start=performance.now(),model=local.create(value),reader=read.create(model),initialized=performance.now()
  reader.summary()
  const id=value.events[12000].eventId,timings=[]
  for(let index=0;index<20;index++){
    const began=performance.now();model.edit({eventId:id,editorVersion:1,fields:{note:'合成修改'+index}})
    assert.ok(model.dirtyEvents.size<=1,'单笔备注不得重新推导整批')
    reader.summary();timings.push(performance.now()-began)
  }
  const page=reader.read('economicEvents.list',{view:'active',pageSize:40})
  assert.equal(page.items.length,40);assert.equal(page.total,24990)
  assert.ok(Buffer.byteLength(JSON.stringify(page))<64*1024)
  const issuePage=reader.read('reviewIssues.list',{group:'category',pageSize:40})
  assert.ok(issuePage.items.length>0)
  assert.ok(Buffer.byteLength(JSON.stringify(issuePage))<64*1024,'大问题组只传范围摘要和有界成员页')
  assert.ok(Math.max(...timings)<500,'本机单笔编辑和摘要应在 500ms 内完成')
  compare(model,reader)
  t.diagnostic(JSON.stringify({rows:24990,fixtureMs:Math.round(start-prepare),initializeMs:Math.round(initialized-start),
    editP95Ms:Number(timings.sort((a,b)=>a-b)[18].toFixed(2)),snapshotBytes:Buffer.byteLength(JSON.stringify(value)),
    heapGrowthMiB:Number(((process.memoryUsage().heapUsed-before)/1048576).toFixed(1)),pageBytes:Buffer.byteLength(JSON.stringify(page))}))
})

test('本机退款候选只有一种表形状：行数组 + 覆盖 metadata，缺 metadata 时按未覆盖处理', async () => {
  const value = await facts({ count: 3 }), ids = [...value.events.map(row => row.eventId)]
  const open = model => {
    model.edit({ eventId: ids[0], editorVersion: 1, fields: { economicNature: 'refund', amountMinor: '60',
      occurredLocalAt: '2026-09-02 12:00:00', timezoneOffsetMinutes: -480 } })
    return model.events.get(ids[0])
  }
  // 新快照：表是数组，覆盖信息在独立 metadata（快照编码按表逐行展开，包装对象会直接抛错）。
  const covered = local.create({ ...value, refundCandidates: [], refundCandidatesCovered: { covered: true, coveredCount: 0, total: 0 } })
  const coveredEvent = open(covered)
  assert.equal(covered.refundCandidates(coveredEvent, 'event').length, 2, '本批候选不受历史覆盖标记影响')
  assert.equal(covered.refundCandidates(coveredEvent, 'event').historyComplete, true)
  assert.equal(covered.refundCandidates(coveredEvent, 'transaction').historyComplete, true)
  // 旧快照没有覆盖 metadata：本批照常，已入账范围按“没查全”处理，暂记仍要服务端复核。
  const legacy = local.create({ ...value, refundCandidates: [] })
  const legacyEvent = open(legacy)
  assert.equal(legacy.refundCandidates(legacyEvent, 'event').historyComplete, true, '本批范围永远完整')
  assert.equal(legacy.refundCandidates(legacyEvent, 'transaction').historyComplete, false)
})

test('本机计划候选按同一指纹判断：同名同长期数靠本金和起始月区分，旧快照明确报错', async () => {
  const value = await facts({ count: 2 }), accountId = value.accounts[0].accountId
  const plan = (loanId, extra) => ({ loanId, accountId, name: '某卡分期', version: 1, kind: 'installment',
    scheduleTerms: 12, startDate: '2026-03-01', baselineDate: '2026-03-01', baselinePrincipalMinor: '300000',
    installmentSetup: { schema: 1, originalPrincipalMinor: '600000', historicalPaidTerms: 0 }, archivedAt: null, ...extra })
  value.loans = [plan('a', {}), plan('b', { baselinePrincipalMinor: '500000', startDate: '2026-05-01',
    installmentSetup: { schema: 1, originalPrincipalMinor: '500000', historicalPaidTerms: 0 } }),
    plan('e', { baselinePrincipalMinor: '700000', startDate: '2026-05-01',
      installmentSetup: { schema: 1, originalPrincipalMinor: '700000', historicalPaidTerms: 0 } }),
    plan('c', { accountId: value.accounts[1].accountId }), plan('d', { archivedAt: '2026-06-01' })]
  const reader = read.create(local.create(value))
  // 账单行带着本金：只有 a 完全一致。
  const one = reader.read('loans.planCandidates', { accountId, totalTerms: 12, planLabel: '某卡分期',
    principalMinor: '600000', startMonth: '2026-03' })
  assert.deepEqual(one.items.map(row => [row.loanId, row.matched]), [['a', true], ['b', false], ['e', false]],
    '同卡未归档的分期计划都要列出来，归档和别的卡不出现')
  assert.equal(one.items[0].startMonth, '2026-03')
  assert.equal(one.items[0].originalPrincipalMinor, '600000')
  // 每期账单行没有本金事实：起始月相同的 b、e 都算命中，必须由用户按本金自己挑，不能预选。
  const many = reader.read('loans.planCandidates', { accountId, totalTerms: 12, planLabel: '某卡分期', startMonth: '2026-05' })
  assert.deepEqual(many.items.map(row => [row.loanId, row.matched]), [['a', false], ['b', true], ['e', true]])
  // 旧快照没有计划种类列：明确报错，不能悄悄返回空候选。
  value.loans = value.loans.map(({ kind, ...row }) => row)
  assert.throws(() => read.create(local.create(value)).read('loans.planCandidates', { accountId, totalTerms: 12 }),
    error => error.code === 'LOCAL_REVIEW_REQUIRED')
  assert.throws(() => reader.read('loans.planCandidates', { accountId: '', totalTerms: 12 }),
    error => error.code === 'VALIDATION_ERROR')
})

test('组合支付删到一个账户就离开待核对，已核对后仍可改回分摊', async () => {
  const { randomUUID } = require('node:crypto')
  async function combinedRepayment() {
    const value = await facts({ count: 1 }), event = value.events[0]
    const card = value.accounts.find(account => account.type === 'wallet')
    const target = value.accounts.find(account => account.type === 'credit')
    const balance = { accountId: randomUUID(), name: '支付宝账户余额', type: 'wallet', nature: 'asset', currency: 'CNY', version: 1 }
    value.accounts.push(balance)
    Object.assign(event, {
      economicNature: 'repayment', flowDirection: 'neutral', amountMinor: '151217',
      ledgerAccountId: card.accountId, counterpartyLedgerAccountId: target.accountId,
      status: 'needs_action', categoryId: null, reasonCodes: ['payment_components_ambiguous']
    })
    event.fieldSources = { ...event.fieldSources, semanticBlockers: ['payment_components_ambiguous'],
      paymentComponents: [
        { componentKind: 'financial', label: '浙江农商联合银行储蓄卡(5564)', amountMinor: null },
        { componentKind: 'financial', label: '支付宝账户余额', amountMinor: null }
      ] }
    const issueId = randomUUID()
    value.issues.push({ issueId, issueType: 'shared_fields', primaryReasonCode: 'payment_components_ambiguous',
      reasonCodes: ['payment_components_ambiguous'], status: 'open', blocking: true, version: 1, memberCount: 1,
      candidateCount: 0, subjectEventIds: [event.eventId] })
    value.members.push({ memberId: randomUUID(), issueId, objectType: 'event', objectId: event.eventId,
      objectVersion: event.version, memberRole: 'subject', sortOrder: 0 })
    return { value, eventId: event.eventId, issueId, card, balance }
  }
  const pending = (model, eventId) => model.eventIssues(eventId).filter(issue => issue.status === 'open' && issue.blocking && issue.issueType !== 'category_assignment')
  const draft = await combinedRepayment()
  const draftModel = local.create(draft.value)
  draftModel.edit({ eventId: draft.eventId, editorVersion: 1, composition: { kind: 'payment', incomplete: true, evidenceNote: '',
    parts: [{ accountId: draft.card.accountId, amountMinor: null }, { accountId: draft.balance.accountId, amountMinor: null }] } })
  assert.equal(draftModel.events.get(draft.eventId).status, 'needs_action')
  assert.equal(draftModel.events.get(draft.eventId).reasonCodes.includes('payment_components_ambiguous'), true)
  assert.equal(draftModel.issues.get(draft.issueId).status, 'open')
  const single = await combinedRepayment()
  const model = local.create(single.value)
  assert.equal(model.issues.get(single.issueId).status, 'open')
  model.edit({ eventId: single.eventId, editorVersion: 1, composition: { kind: 'single' } })
  const confirmed = model.events.get(single.eventId)
  assert.equal(confirmed.status, 'ready')
  assert.equal(confirmed.fieldSources.editorOverrides.composition, 'single')
  assert.equal(confirmed.reasonCodes.includes('payment_components_ambiguous'), false)
  assert.equal((confirmed.fieldSources.semanticBlockers || []).includes('payment_components_ambiguous'), false)
  assert.equal(model.issues.get(single.issueId).status, 'resolved')
  assert.equal(pending(model, single.eventId).length, 0)
  const splitAgain = await combinedRepayment()
  const splitModel = local.create(splitAgain.value)
  splitModel.edit({ eventId: splitAgain.eventId, editorVersion: 1, composition: { kind: 'single' } })
  splitModel.edit({ eventId: splitAgain.eventId, editorVersion: 1, composition: { kind: 'payment', evidenceNote: '改回两个账户',
    parts: [{ accountId: splitAgain.card.accountId, amountMinor: '100000' }, { accountId: splitAgain.balance.accountId, amountMinor: '51217' }] } })
  const split = splitModel.events.get(splitAgain.eventId)
  assert.equal(split.status, 'ready')
  assert.equal(split.fieldSources.editorOverrides.composition, 'payment')
  assert.equal(split.fieldSources.paymentResolution.allocations.length, 2)
  assert.equal(pending(splitModel, splitAgain.eventId).length, 0)
  const back = await combinedRepayment()
  const backModel = local.create(back.value)
  backModel.edit({ eventId: back.eventId, editorVersion: 1, composition: { kind: 'single' } })
  backModel.edit({ eventId: back.eventId, editorVersion: 1, composition: { kind: 'payment', incomplete: true, evidenceNote: '',
    parts: [{ accountId: back.card.accountId, amountMinor: null }, { accountId: back.balance.accountId, amountMinor: null }] } })
  assert.equal(backModel.events.get(back.eventId).status, 'needs_action')
  assert.equal(backModel.events.get(back.eventId).fieldSources.editorOverrides.incompleteComposition.kind, 'payment')
  assert.ok(pending(backModel, back.eventId).length > 0)
})

test('账户与分类目录返回副本，页面按路径更新不会改写模型', async () => {
  const value = await facts({ count: 2 }), model = local.create(value), reader = read.create(model)
  const account = reader.read('financeUpdates.options', { kind: 'accounts', pageSize: 100 }).items
    .find(row => row.accountId === value.accounts[0].accountId)
  const category = reader.read('financeUpdates.options', { kind: 'categories', pageSize: 100 }).items
    .find(row => row.categoryId === value.categories[0].categoryId)
  assert.ok(account && category, '目录要包含快照里的账户和分类')
  // 页面数据与模型共用对象时，按路径 setData 会连带改写模型，账户归属随之串位。
  account.name = '页面改名'
  category.name = '页面分类'
  assert.equal(model.accounts.get(account.accountId).name, value.accounts[0].name)
  assert.equal(model.categories.get(category.categoryId).name, value.categories[0].name)
})

test('受影响账户带上每户笔数，名称仍是账本账户名', async () => {
  const value = await facts({ count: 1 }), model = local.create(value), reader = read.create(model)
  const eventId = value.events[0].eventId, accountId = value.accounts[0].accountId
  model.edit({ eventId, editorVersion: 1, fields: { economicNature: 'expense', ledgerAccountId: accountId,
    categoryId: value.categories[0].categoryId, amountMinor: value.events[0].amountMinor } })
  assert.equal(model.events.get(eventId).status, 'ready')
  const row = reader.read('financeUpdates.options', { kind: 'affected_accounts', pageSize: 100 }).items
    .find(item => item.accountId === accountId)
  assert.ok(row)
  assert.equal(row.name, '微信零钱')
  assert.equal(row.count, 1)
})

test('整批复核失败不把已经通过的交易标成待核对，已做的决定也不被重新打开', async () => {
  const value = await facts({ count: 4 }), model = local.create(value), reader = read.create(model)
  const issue = [...model.issues.values()].find(row => row.status === 'open' && row.subjectEventIds.length)
  const covered = [issue.subjectEventIds[0]]
  model.review({ issueId: issue.issueId, decision: 'exclude_events', selection: { mode: 'include', eventIds: covered } })
  const rest = [...model.events.values()].filter(event => !covered.includes(event.eventId) && event.status !== 'excluded')
  assert.ok(rest.length >= 2)
  const wallet = value.accounts.find(account => account.type === 'wallet')
  const credit = value.accounts.find(account => account.type === 'credit')
  const category = value.categories.find(row => row.kind === 'expense')
  const expense = rest[0], repayment = rest[1]
  model.edit({ eventId: expense.eventId, editorVersion: 1, fields: { economicNature: 'expense', ledgerAccountId: wallet.accountId,
    categoryId: category.categoryId, amountMinor: expense.amountMinor } })
  const fields = { ...model.events.get(repayment.eventId).fieldSources }
  delete fields.repaymentChannelResolution
  delete fields.repaymentAllocations
  delete fields.repaymentAllocationVersion
  delete fields.paymentResolution
  delete fields.paymentAccounts
  model.events.set(repayment.eventId, { ...model.events.get(repayment.eventId), economicNature: 'repayment', flowDirection: 'neutral',
    sourceDirection: 'expense', ledgerAccountId: credit.accountId, counterpartyLedgerAccountId: wallet.accountId, categoryId: null,
    status: 'needs_action', reasonCodes: [], fieldSources: fields })
  const reopened = { ...model.issues.get(issue.issueId), status: 'open', blocking: true, subjectEventIds: covered }
  model.applySupplement({
    historyCoverage: value.historyCoverage, history: [], accounts: value.accounts, categories: value.categories,
    issues: [reopened], members: value.members.filter(row => row.issueId === issue.issueId),
    problems: [
      { eventIds: [expense.eventId], reason: 'VALIDATION_ERROR', issueType: 'server_recheck' },
      { eventIds: [repayment.eventId], reason: 'VALIDATION_ERROR', issueType: 'server_recheck' },
      { issueId: issue.issueId, eventIds: covered, reason: 'refund_source_conflict', issueType: 'refund_relation' }
    ]
  })
  assert.equal(model.invalid.has(expense.eventId), false)
  assert.equal(model.publicRow(expense.eventId).localConflict, undefined)
  assert.equal(model.invalid.get(repayment.eventId), 'account_roles')
  assert.equal(model.issues.get(issue.issueId).status, 'resolved')
  assert.equal(covered.every(id => !model.invalid.has(id)), true)
  const page = reader.read('economicEvents.list', { view: 'review_pending', viewVersion: reader.version(), pageSize: 20 })
  assert.equal(page.items.some(row => row.eventId === expense.eventId), false)
  assert.equal(page.items.some(row => row.eventId === repayment.eventId), true)
  assert.equal(reader.summary().coverage.selectedEventsReadyToPost, false)
})
