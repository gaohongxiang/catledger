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
