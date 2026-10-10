const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const { localServices, call } = require('./helpers/local-services')

test('统一交易编辑器：真实 MySQL 单笔、关系、事务及入账闭环',
  { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 180000 }, async t => {
    const lab = await isolatedMysql()
    try {
      const grants = require('../scripts/runtime-role-grants')
      const apiPool = await lab.role('api', grants.api), importer = await lab.role('import', grants.importer)
      let failurePattern = null
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target,key) {
          if (key === 'execute') return async (sql,values) => {
            if (failurePattern && failurePattern.test(sql)) throw Error('synthetic rollback boundary')
            return target.execute(sql,values)
          }
          return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        } })
      } }
      async function batch(c, amounts = [100,40,60], map = true, day = '01') {
        const content=Buffer.from(['微信支付账单明细,,,,,,,,,,,','交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,订单号,商户单号,备注',
          ...amounts.map((amount,index)=>`2026-09-${day} 12:0${index}:00,商户消费,合成商户,合成商品,支出,${amount}.00,微信零钱,支付成功,SYNTHETIC-EDITOR-${randomUUID()},,,合成备注`)].join('\n'))
        const file=(await c.imp('imports.prepareMany',{requestId:randomUUID(),files:[{fileName:'合成统一编辑.csv',size:content.length}]})).files[0]
        c.services.objects.set(file.cloudPath,content)
        const parsed=await c.imp('imports.parseFile',{requestId:randomUUID(),importId:file.importId,fileID:'cloud://synthetic.bucket/'+file.cloudPath,timezoneOffsetMinutes:-480})
        c.update=await c.imp('financeUpdates.prepare',{requestId:randomUUID(),batchIds:[parsed.batch.batchId]})
        if(map) {
          const issues=(await c.imp('reviewIssues.list',{updateId:c.update.updateId,group:'accounts',status:'open'})).items
          if(issues.length) await c.imp('reviewIssues.resolveAccountMappings',{requestId:randomUUID(),updateId:c.update.updateId,
            updateVersion:(await summary(c)).update.version,decisions:issues.map(issue=>({issueId:issue.issueId,issueVersion:issue.version,operation:'resolve',decision:'apply_fields',fields:{mappingAccountId:c.accounts.wallet}}))})
        }
        return c
      }
      async function setup(amounts, map=true) {
        const services=localServices({apiPool,importPool,subject:'synthetic-unified-editor-'+randomUUID()})
        const c={services,api:(action,data)=>call(services.api,action,data),imp:(action,data)=>call(services.import,action,data),accounts:{}}
        const identity=await c.api('bootstrap');c.uid=identity.uid;c.categories=identity.categories
        for(const type of ['wallet','bank','credit','other_liability']) c.accounts[type]=(await c.api('accounts.create',{requestId:randomUUID(),name:'合成编辑-'+type,type,
          openingDisplayBalanceMinor:'1000000',occurredLocalAt:'2026-08-01T00:00:00',timezoneOffsetMinutes:-480})).accountId
        return batch(c,amounts,map)
      }
      const summary=c=>c.imp('financeUpdates.summary',{updateId:c.update.updateId})
      const rows=async c=>(await c.imp('economicEvents.list',{updateId:c.update.updateId})).items
      const dump=async(c,table,order)=>(await lab.owner.execute(`SELECT * FROM ${table} WHERE uid=? ORDER BY ${order}`,[c.uid]))[0]
      async function input(c,index,change) {
        const row=(await rows(c))[index]
        return {requestId:randomUUID(),updateId:c.update.updateId,updateVersion:(await summary(c)).update.version,
          eventId:row.eventId,eventVersion:row.version,editorVersion:1,fields:{},...change}
      }
      async function detail(c,eventId) {
        let cursor=null,text=''
        do { const result=await c.imp('economicEvents.detail',{updateId:c.update.updateId,eventId,cursor});text+=result.part;cursor=result.nextCursor } while(cursor)
        return JSON.parse(text)
      }
      const post=async c=>c.imp('financeUpdates.post',{requestId:randomUUID(),updateId:c.update.updateId,version:(await summary(c)).update.version})
      await t.test('待核对同组第二笔可以修改全部基本字段，仅改本笔且原文、正式余额及长期映射保持',async()=>{
        const c=await setup([100,40],false),before=await rows(c),raw=await dump(c,'catledger_import_rows','row_id'),ledger=await dump(c,'catledger_transactions','transaction_id'),mappings=await dump(c,'catledger_import_account_mappings','mapping_id')
        const data=await input(c,1,{fields:{economicNature:'income',ledgerAccountId:c.accounts.bank,amountMinor:'4300',occurredLocalAt:'2026-09-01 12:02:03',timezoneOffsetMinutes:-480,note:'',counterparty:''}})
        await c.imp('financeUpdates.setReview',data)
        const after=await rows(c),edited=await detail(c,data.eventId)
        assert.deepEqual(after.find(row=>row.eventId===before[0].eventId),before[0])
        assert.equal(edited.note,'');assert.equal(edited.counterparty,'');assert.equal(edited.amountMinor,'4300')
        assert.equal(edited.editorFacts.version,1);assert.equal(edited.ledgerAccountId,c.accounts.bank)
        assert.equal(edited.primaryEvidence.note,'合成备注')
        assert.deepEqual(await dump(c,'catledger_import_rows','row_id'),raw)
        assert.deepEqual(await dump(c,'catledger_transactions','transaction_id'),ledger)
        assert.deepEqual(await dump(c,'catledger_import_account_mappings','mapping_id'),mappings)
        assert.equal((await rows(c)).find(row=>row.eventId===before[0].eventId).status,'needs_action')
      })
      await t.test('手动还款与借款严格验证真实角色；缺账户可保存但不能入账',async()=>{
        const c=await setup([100]),data=await input(c,0,{fields:{economicNature:'repayment',counterpartyLedgerAccountId:c.accounts.bank},decisions:{ownership:{owner:'self'}}})
        await assert.rejects(c.imp('financeUpdates.setReview',data),{publicCode:'VALIDATION_ERROR'})
        await c.imp('financeUpdates.setReview',{...data,requestId:randomUUID(),fields:{...data.fields,counterpartyLedgerAccountId:null}})
        await assert.rejects(post(c),{publicCode:'UNRESOLVED_IMPORT'})
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{counterpartyLedgerAccountId:c.accounts.credit}}))
        await post(c)
        const transfer=(await dump(c,'catledger_transactions','transaction_id')).find(row=>row.origin==='import')
        assert.equal(transfer.type,'transfer');assert.equal(transfer.source_account_id,c.accounts.wallet);assert.equal(transfer.destination_account_id,c.accounts.credit)
        assert.equal(String(transfer.amount_minor),'10000')
      })
      await t.test('流入来源的本人还款只按真实角色校验，不把付款端误当负债端',async()=>{
        const c=await setup([100])
        // 直接种入合成流入来源方向，隔离验证资金适配与保存边界；不冒充解析器验证。
        await lab.owner.execute("UPDATE catledger_import_rows SET normalized_direction='income' WHERE uid=?",[c.uid])
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'repayment',ledgerAccountId:c.accounts.credit,
          counterpartyLedgerAccountId:c.accounts.wallet},decisions:{ownership:{owner:'self'}}}))
        await post(c)
        const row=(await dump(c,'catledger_transactions','transaction_id')).find(row=>row.origin==='import')
        assert.equal(row.type,'transfer');assert.equal(row.source_account_id,c.accounts.wallet);assert.equal(row.destination_account_id,c.accounts.credit)
      })
      await t.test('组合支付不完整草稿持久化，完整确认原子拆分且不生成虚拟账户',async()=>{
        const c=await setup([100])
        await c.imp('financeUpdates.setReview',await input(c,0,{composition:{kind:'payment',incomplete:true,evidenceNote:'合成组合详情',parts:[{accountId:c.accounts.wallet,amountMinor:'3000'},{accountId:null,amountMinor:null}]}}))
        let row=(await rows(c))[0],facts=await detail(c,row.eventId)
        assert.equal(facts.editorFacts.incompleteComposition.parts[1].amountMinor,null)
        await assert.rejects(post(c),{publicCode:'UNRESOLVED_IMPORT'})
        await c.imp('financeUpdates.setReview',await input(c,0,{composition:{kind:'payment',evidenceNote:'合成组合详情',parts:[{accountId:c.accounts.wallet,amountMinor:'3000'},{accountId:c.accounts.credit,amountMinor:'7000'}]}}))
        await post(c)
        const transactions=(await dump(c,'catledger_transactions','transaction_id')).filter(row=>row.origin==='import')
        assert.deepEqual(transactions.map(row=>String(row.amount_minor)).sort(),['3000','7000'])
        assert.ok(transactions.every(row=>row.type==='expense'))
      })
      await t.test('本批退款支持手动改性质，同事务累计检查及过量修改回滚',async()=>{
        const c=await setup(),original=(await rows(c))[0]
        let data=await input(c,1,{fields:{economicNature:'refund'},decisions:{refund:{mode:'link',kind:'event',id:original.eventId,version:original.version}}})
        await c.imp('financeUpdates.setReview',data)
        await c.imp('financeUpdates.setReview',await input(c,2,{fields:{economicNature:'refund'},decisions:{refund:{mode:'link',kind:'event',id:original.eventId,version:original.version}}}))
        const before=await dump(c,'catledger_economic_events','event_id'),relations=await dump(c,'catledger_economic_event_relations','relation_id')
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,1,{fields:{amountMinor:'4100'}})),{publicCode:'CONFLICT'})
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields:{amountMinor:'9900'}})),{publicCode:'VALIDATION_ERROR'})
        assert.deepEqual(await dump(c,'catledger_economic_events','event_id'),before)
        assert.deepEqual(await dump(c,'catledger_economic_event_relations','relation_id'),relations)
        await post(c)
        const transactions=(await dump(c,'catledger_transactions','transaction_id')).filter(row=>row.origin==='import')
        assert.equal(transactions.filter(row=>row.type==='refund').length,2)
        assert.equal(new Set(transactions.filter(row=>row.type==='refund').map(row=>row.original_transaction_id)).size,1)
      })
      await t.test('历史原消费候选及关联包含待入账累计，不允许超退或把失败读取当无候选',async()=>{
        const c=await setup([100]);await post(c)
        const original=(await dump(c,'catledger_transactions','transaction_id')).find(row=>row.origin==='import')
        await batch(c,[40,60],true,'02')
        const row=(await rows(c))[0]
        const candidates=await c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:row.eventId,eventVersion:row.version,kind:'transaction',pageSize:1})
        assert.ok(candidates.items.some(item=>item.id===original.transaction_id));assert.ok(candidates.total>=1)
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'refund'},decisions:{refund:{mode:'link',kind:'transaction',id:original.transaction_id,version:Number(original.version)}}}))
        await c.imp('financeUpdates.setReview',await input(c,1,{fields:{economicNature:'refund'},decisions:{refund:{mode:'link',kind:'transaction',id:original.transaction_id,version:Number(original.version)}}}))
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields:{amountMinor:'4001'}})),{publicCode:'CONFLICT'})
        await post(c)
        const refunds=(await dump(c,'catledger_transactions','transaction_id')).filter(row=>row.type==='refund')
        assert.equal(refunds.reduce((sum,row)=>sum+BigInt(row.amount_minor),0n),10000n)
      })
      await t.test('原始状态与同笔判断不被普通保存清除，更新后仍有真实组入口',async()=>{
        const c=await setup([100]),row=(await rows(c))[0],issueId=randomUUID()
        await lab.owner.execute(`INSERT INTO catledger_review_issues (uid,issue_id,update_id,issue_key,issue_key_version,issue_type,status,version,blocking,primary_reason_code,member_count,candidate_count,rule_version,reason_codes_json)
          VALUES (?,?,?,?,'review-issue-v11','same_event','open',1,1,'same_event_candidate',1,0,'synthetic-test',JSON_ARRAY('same_event_candidate'))`,[c.uid,issueId,c.update.updateId,randomUUID()])
        await lab.owner.execute(`INSERT INTO catledger_review_issue_members (uid,member_id,update_id,issue_id,object_type,object_id,object_version,member_role,sort_order) VALUES (?,?,?,?,'event',?,?,'subject',0)`,[c.uid,randomUUID(),c.update.updateId,issueId,row.eventId,row.version])
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{note:'只修改合成备注'}}))
        const result=await detail(c,row.eventId)
        assert.equal(result.status,'needs_action');assert.equal(result.pendingIssue.issueId,issueId)
        await assert.rejects(post(c),{publicCode:'UNRESOLVED_IMPORT'})
      })
      await t.test('字段/关系中途失败完整回滚，同请求重试并发只写一次',async()=>{
        const c=await setup(),original=(await rows(c))[0]
        const data=await input(c,1,{fields:{economicNature:'refund',note:'合成原子保存'},decisions:{refund:{mode:'link',kind:'event',id:original.eventId,version:original.version}}})
        const tables=[['catledger_economic_events','event_id'],['catledger_economic_event_relations','relation_id'],['catledger_review_issues','issue_id'],['catledger_review_issue_members','member_id'],['catledger_finance_actions','action_id'],['catledger_mutation_receipts','idempotency_key_digest']]
        const before=await Promise.all(tables.map(([table,key])=>dump(c,table,key)))
        for (const pattern of [/INSERT INTO catledger_finance_actions/, /INSERT INTO catledger_economic_event_relations/,
          /UPDATE catledger_review_issues SET/, /UPDATE catledger_economic_events SET/, /UPDATE catledger_mutation_receipts/]) {
          failurePattern=pattern
          await assert.rejects(c.imp('financeUpdates.setReview',data),{publicCode:'INTERNAL_ERROR'}, String(pattern));failurePattern=null
          assert.deepEqual(await Promise.all(tables.map(([table,key])=>dump(c,table,key))),before, String(pattern))
        }
        const results=await Promise.all([c.imp('financeUpdates.setReview',data),c.imp('financeUpdates.setReview',data)])
        assert.deepEqual(results[0],results[1])
        assert.equal((await rows(c)).find(row=>row.eventId===data.eventId).version,data.eventVersion+1)
        assert.deepEqual(await c.imp('imports.commandResult',{requestId:data.requestId,commandAction:'financeUpdates.setReview'}),results[0])
      })
      await t.test('文本清空及人工金额经重整、入账保留，来源数据仍不变',async()=>{
        const c=await setup([100]),data=await input(c,0,{fields:{note:'',counterparty:'',amountMinor:'12345',
          economicNature:'fee',ledgerAccountId:c.accounts.bank,categoryId:c.categories.find(row=>row.kind==='expense').id,
          occurredLocalAt:'2026-09-03 13:14:15',timezoneOffsetMinutes:-480}})
        await c.imp('financeUpdates.setReview',data)
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v31' WHERE uid=? AND update_id=?",[c.uid,c.update.updateId])
        await c.imp('financeUpdates.organize',{requestId:randomUUID(),updateId:c.update.updateId,version:(await summary(c)).update.version})
        const row=await detail(c,data.eventId);assert.equal(row.note,'');assert.equal(row.counterparty,'');assert.equal(row.amountMinor,'12345')
        assert.equal(row.economicNature,'fee');assert.equal(row.ledgerAccountId,c.accounts.bank);assert.equal(row.categoryId,data.fields.categoryId)
        assert.ok(row.localAt.startsWith('2026-09-03 13:14:15'))
        await post(c)
        const transaction=(await dump(c,'catledger_transactions','transaction_id')).find(row=>row.origin==='import')
        assert.equal(String(transaction.amount_minor),'12345');assert.doesNotMatch(transaction.note,/合成备注|合成商户/);assert.match(transaction.note,/合成商品/)
      })
      await t.test('UE45 规则升级保留已确认人工退款关系，重整不改原事件/证据身份',async()=>{
        const c=await setup([100,40]),original=(await rows(c))[0]
        const data=await input(c,1,{fields:{economicNature:'refund',note:'人工合成退款'},decisions:{refund:{mode:'link',kind:'event',id:original.eventId,version:original.version}}})
        await c.imp('financeUpdates.setReview',data)
        const evidence=(await dump(c,'catledger_event_evidence','evidence_id')).map(row=>[row.evidence_id,row.row_id,row.event_id])
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v31' WHERE uid=? AND update_id=?",[c.uid,c.update.updateId])
        await c.imp('financeUpdates.organize',{requestId:randomUUID(),updateId:c.update.updateId,version:(await summary(c)).update.version})
        const row=await detail(c,data.eventId),relations=await dump(c,'catledger_economic_event_relations','relation_id')
        assert.equal(row.economicNature,'refund');assert.equal(row.note,'人工合成退款')
        assert.ok(relations.some(link=>link.source_event_id===data.eventId&&link.target_event_id===original.eventId&&link.status==='confirmed'&&link.manual===1))
        assert.deepEqual((await dump(c,'catledger_event_evidence','evidence_id')).map(item=>[item.evidence_id,item.row_id,item.event_id]),evidence)
        await post(c)
      })
      await t.test('越权账户/事件、旧版本、源状态和只读键均拒绝',async()=>{
        const c=await setup([100]),other=await setup([100]),data=await input(c,0,{fields:{note:'合成备注'}})
        await assert.rejects(other.imp('financeUpdates.setReview',data),{publicCode:'NOT_FOUND'})
        for(const fields of [{ledgerAccountId:other.accounts.wallet},{status:'ready'},{rawFields:{}},{occurredLocalAt:'2026-02-30 00:00:00',timezoneOffsetMinutes:-480}]) await assert.rejects(c.imp('financeUpdates.setReview',{...data,requestId:randomUUID(),fields}),{publicCode:'VALIDATION_ERROR'})
        await assert.rejects(c.imp('financeUpdates.setReview',{...data,eventVersion:data.eventVersion+1}),{publicCode:'CONFLICT'})
        await post(c)
        await assert.rejects(c.imp('financeUpdates.setReview',{...data,requestId:randomUUID()}),{publicCode:'CONFLICT'})
      })
      await t.test('UE54 已排除、已更正和已入账事件不能被普通修改复活，失败不留审计或回执',async()=>{
        for(const status of ['excluded','corrected','posted']) {
          const c=await setup([100]),data=await input(c,0,{fields:{note:'不得覆盖终态'}})
          // 单独固定事件生命周期，验证在批次版本仍匹配时也必须拒绝；整批入账另有真实链路覆盖。
          await lab.owner.execute('UPDATE catledger_economic_events SET state=?,status=? WHERE uid=? AND event_id=?',[status,status,c.uid,data.eventId])
          const tables=[['catledger_economic_events','event_id'],['catledger_finance_actions','action_id'],['catledger_mutation_receipts','idempotency_key_digest'],['catledger_transactions','transaction_id']]
          const before=await Promise.all(tables.map(([table,key])=>dump(c,table,key)))
          await assert.rejects(c.imp('financeUpdates.setReview',data),{publicCode:'CONFLICT'})
          assert.deepEqual(await Promise.all(tables.map(([table,key])=>dump(c,table,key))),before)
        }
      })
      await t.test('UE12/19/57 代还待核对、合法大额和内部负债转移保留各自财务边界',async()=>{
        const c=await setup([100]),row=(await rows(c))[0]
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{amountMinor:'9007199254740993'}}))
        assert.equal((await detail(c,row.eventId)).amountMinor,'9007199254740993')
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{amountMinor:'10000',economicNature:'unknown'},decisions:{ownership:{owner:'other',treatment:'pending'}}}))
        const pending=await detail(c,row.eventId)
        assert.equal(pending.status,'needs_action');assert.equal(pending.economicNature,'unknown');assert.equal(pending.counterpartyLedgerAccountId,null)
        const before=await dump(c,'catledger_transactions','transaction_id')
        await assert.rejects(post(c),{publicCode:'UNRESOLVED_IMPORT'})
        assert.deepEqual(await dump(c,'catledger_transactions','transaction_id'),before)
        const fields={economicNature:'repayment',ledgerAccountId:c.accounts.credit,counterpartyLedgerAccountId:c.accounts.other_liability}
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields,decisions:{ownership:{owner:'self'}}})),{publicCode:'VALIDATION_ERROR'})
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{...fields,economicNature:'internal_transfer'}}))
        await post(c)
        const transfer=(await dump(c,'catledger_transactions','transaction_id')).find(item=>item.origin==='import')
        assert.equal(transfer.type,'transfer');assert.equal(transfer.source_account_id,c.accounts.credit);assert.equal(transfer.destination_account_id,c.accounts.other_liability)
      })
      await t.test('UE40 同笔和同批不同笔并发各仅一个版本生效，冲突不会覆盖另一输入',async()=>{
        for(const sameEvent of [true,false]) {
          const c=await setup([100,40])
          const first=await input(c,0,{fields:{note:'并发甲'}}),second=await input(c,sameEvent?0:1,{fields:{note:'并发乙'}})
          const results=await Promise.allSettled([c.imp('financeUpdates.setReview',first),c.imp('financeUpdates.setReview',second)])
          assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
          assert.equal(results.find(row=>row.status==='rejected').reason.publicCode,'CONFLICT')
          assert.equal((await summary(c)).update.version,first.updateVersion+1)
          const events=await rows(c)
          assert.equal(events.filter(row=>row.note==='并发甲'||row.note==='并发乙').length,1)
        }
      })
      await t.test('UE30 无候选退款可暂记，回执明确待核对与可入账结果，读取不改数据库',async()=>{
        const c=await setup([40]),row=(await rows(c))[0]
        const before=await dump(c,'catledger_economic_events','event_id')
        for(const kind of ['event','transaction']) {
          const result=await c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:row.eventId,eventVersion:row.version,kind})
          assert.equal(result.total,0)
        }
        assert.deepEqual(await dump(c,'catledger_economic_events','event_id'),before)
        const pending=await c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'refund'}}))
        assert.equal(pending.event.status,'needs_action')
        const ready=await c.imp('financeUpdates.setReview',await input(c,0,{decisions:{refund:{mode:'pending'}}}))
        assert.equal(ready.event.status,'ready')
        await post(c)
        const refund=(await dump(c,'catledger_transactions','transaction_id')).find(row=>row.type==='refund')
        assert.equal(refund.destination_account_id,c.accounts.wallet);assert.equal(refund.original_transaction_id,null)
        assert.equal(refund.category_id,null)
      })
      await t.test('UE60 关联依赖快照拒绝原消费新版本，旧游标和跨用户账户不能进入候选',async()=>{
        const c=await setup([100,40]),original=(await rows(c))[0]
        const linked=await input(c,1,{fields:{economicNature:'refund'},decisions:{refund:{mode:'link',kind:'event',id:original.eventId,version:original.version}}})
        await c.imp('financeUpdates.setReview',linked)
        const facts=(await detail(c,linked.eventId)).editorFacts
        assert.equal(facts.expectedRelations.length,2)
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{note:'原消费新说明'}}))
        const before=await dump(c,'catledger_economic_events','event_id')
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,1,{fields:{note:'过期依赖'},expectedRelations:facts.expectedRelations})),{publicCode:'CONFLICT'})
        assert.deepEqual(await dump(c,'catledger_economic_events','event_id'),before)
        const other=await setup([1]),row=(await rows(c))[1]
        await assert.rejects(c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:row.eventId,eventVersion:row.version,kind:'event',fields:{ledgerAccountId:other.accounts.wallet}}),{publicCode:'VALIDATION_ERROR'})
        await assert.rejects(c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:row.eventId,eventVersion:row.version-1,kind:'event'}),{publicCode:'CONFLICT'})
      })
      await t.test('UE31/32 改退款性质须明确解除本笔关系；被引用的原消费不能改为收入',async()=>{
        const c=await setup(),original=(await rows(c))[0]
        for(const index of [1,2]) await c.imp('financeUpdates.setReview',await input(c,index,{fields:{economicNature:'refund'},
          decisions:{refund:{mode:'link',kind:'event',id:original.eventId,version:original.version}}}))
        const events=await dump(c,'catledger_economic_events','event_id'),links=await dump(c,'catledger_economic_event_relations','relation_id')
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'income'}})),{publicCode:'VALIDATION_ERROR'})
        const change=await input(c,1,{fields:{economicNature:'income'}})
        await assert.rejects(c.imp('financeUpdates.setReview',change),{publicCode:'VALIDATION_ERROR'})
        assert.deepEqual(await dump(c,'catledger_economic_events','event_id'),events)
        assert.deepEqual(await dump(c,'catledger_economic_event_relations','relation_id'),links)
        await c.imp('financeUpdates.setReview',{...change,requestId:randomUUID(),acknowledgedChanges:['refund']})
        const after=await dump(c,'catledger_economic_event_relations','relation_id')
        assert.equal(after.find(row=>row.source_event_id===change.eventId).status,'rejected')
        assert.deepEqual(after.filter(row=>row.source_event_id!==change.eventId),links.filter(row=>row.source_event_id!==change.eventId))
      })
      await t.test('UE28/51 过期、已删除或跨用户原消费不能关联，失败没有部分保存',async()=>{
        const c=await setup([40]),other=await setup([100])
        const create=owner=>owner.api('transactions.create',{requestId:randomUUID(),type:'expense',amountMinor:'10000',sourceAccountId:owner.accounts.wallet,categoryId:owner.categories.find(row=>row.kind==='expense').id,
          occurredLocalAt:'2026-08-15T12:00:00',timezoneOffsetMinutes:-480,note:'合成历史消费'})
        const original=await create(c),foreign=await create(other)
        const before=await dump(c,'catledger_economic_events','event_id')
        for(const [id,version] of [[foreign.transactionId,1],[original.transactionId,2],[randomUUID(),1]]) {
          await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'refund'},
            decisions:{refund:{mode:'link',kind:'transaction',id,version}}})),{publicCode:'CONFLICT'})
          assert.deepEqual(await dump(c,'catledger_economic_events','event_id'),before)
        }
        await c.api('transactions.delete',{requestId:randomUUID(),transactionId:original.transactionId,version:1})
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'refund'},
          decisions:{refund:{mode:'link',kind:'transaction',id:original.transactionId,version:1}}})),{publicCode:'CONFLICT'})
        assert.deepEqual(await dump(c,'catledger_economic_events','event_id'),before)
      })
      await t.test('UE27 已有退款改金额排除自身，可靠身份复用的待入账退款不重复占额度',async()=>{
        const c=await setup([40,10]),original=await c.api('transactions.create',{requestId:randomUUID(),type:'expense',amountMinor:'10000',sourceAccountId:c.accounts.wallet,categoryId:c.categories.find(row=>row.kind==='expense').id,
          occurredLocalAt:'2026-08-15T12:00:00',timezoneOffsetMinutes:-480})
        const linked=await input(c,0,{fields:{economicNature:'refund'},decisions:{refund:{mode:'link',kind:'transaction',id:original.transactionId,version:1}}})
        await c.imp('financeUpdates.setReview',linked)
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{amountMinor:'5000'}}))
        const after=await rows(c),candidate=await c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:after[1].eventId,eventVersion:after[1].version,kind:'transaction'})
        assert.equal(candidate.items.find(row=>row.id===original.transactionId).remainingMinor,'5000')
        // 使用同一可靠 identity 的两条真实来源关系播种复用状态，单独验累计查询；不模拟金额相似去重。
        const formal=await c.api('transactions.create',{requestId:randomUUID(),type:'refund',amountMinor:'5000',destinationAccountId:c.accounts.wallet,
          originalTransactionId:original.transactionId,occurredLocalAt:'2026-09-01T12:00:00',timezoneOffsetMinutes:-480})
        await lab.owner.execute(`INSERT INTO catledger_economic_event_transactions
          (uid,link_id,update_id,event_id,transaction_id,role,creation_method,rule_version,transaction_version)
          VALUES (?,?,?,?,?,'historical_primary','reused','event-transaction-link-v2',1)`,[c.uid,randomUUID(),c.update.updateId,linked.eventId,formal.transactionId])
        const reused=await c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:after[1].eventId,eventVersion:after[1].version,kind:'transaction'})
        assert.equal(reused.items.find(row=>row.id===original.transactionId).remainingMinor,'5000')
      })
      await t.test('UE08/09/51 本息费明确900+80+20，缺项待核对、越权费用拒绝，保存不提前记账',async()=>{
        const c=await setup([1000]),categoryId=(await c.api('bootstrap')).categories.find(row=>row.kind==='expense').id
        const fields={economicNature:'repayment',counterpartyLedgerAccountId:c.accounts.other_liability}
        const repayment={confirmed:true,mode:'defer',assetAccountId:c.accounts.wallet,liabilityAccountId:c.accounts.other_liability,
          principalMinor:'90000',interestMinor:'8000',feeMinor:'2000',interestTreatment:'expense',feeTreatment:'expense',interestCategoryId:categoryId,feeCategoryId:categoryId}
        const before=await dump(c,'catledger_transactions','transaction_id')
        const {confirmed,assetAccountId,liabilityAccountId,...draft}=repayment
        const partial=await c.imp('financeUpdates.setReview',await input(c,0,{fields,decisions:{repayment:{mode:'review',draft:{...draft,interestMinor:null}}}}))
        assert.equal(partial.event.status,'needs_action')
        await assert.rejects(post(c),{publicCode:'UNRESOLVED_IMPORT'})
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{decisions:{repayment:{...repayment,interestCategoryId:randomUUID()}}})),{publicCode:'VALIDATION_ERROR'})
        await c.imp('financeUpdates.setReview',await input(c,0,{decisions:{repayment}}))
        assert.deepEqual(await dump(c,'catledger_transactions','transaction_id'),before)
        await post(c)
        const tx=(await dump(c,'catledger_transactions','transaction_id')).filter(row=>row.origin==='import')
        assert.deepEqual(tx.map(row=>[row.type,String(row.amount_minor)]).sort(),[['expense','2000'],['expense','8000'],['transfer','90000']])
        assert.ok(tx.every(row=>row.source_account_id===c.accounts.wallet))
        assert.equal((await c.api('loans.unassigned')).total,1)
      })
      await t.test('UE08 已记本息费只清偿既有收费项，入账1000不重复费用且本金只减900',async()=>{
        const c=await setup([1000]),categoryId=(await c.api('bootstrap')).categories.find(row=>row.kind==='expense').id
        const {plan,authorization}=require('./helpers/loan-charges')
        const loan=await c.api('loans.create',{...plan,requestId:randomUUID(),accountId:c.accounts.other_liability,
          baselinePrincipalMinor:'1080000',repaymentMinor:'98000',feeUpfrontMinor:'2000',
          installmentSetup:{...plan.installmentSetup,originalPrincipalMinor:'1080000',recordType:'bank_loan'}})
        await c.api('loans.configureCharges',{...authorization,requestId:randomUUID(),loanId:loan.loanId,version:loan.version,
          interestCategoryId:categoryId,feeCategoryId:categoryId,upfrontChargeDate:'2026-01-01'})
        await c.api('loans.syncCharges',{requestId:randomUUID(),loanId:loan.loanId})
        const latest=(await c.api('loans.get',{loanId:loan.loanId})).loan,charges=(await c.api('loans.chargePlan',{loanId:loan.loanId})).items
        const interest=charges.find(row=>row.chargeKey==='period:1:interest'),fee=charges.find(row=>row.chargeKey==='upfront:fee')
        assert.equal(interest.amountMinor,'8000');assert.equal(fee.amountMinor,'2000')
        const before=await dump(c,'catledger_transactions','transaction_id')
        const decision={confirmed:true,mode:'associate',loanId:loan.loanId,loanVersion:latest.version,
          assetAccountId:c.accounts.wallet,liabilityAccountId:c.accounts.other_liability,principalMinor:'90000',interestMinor:'8000',feeMinor:'2000',
          interestTreatment:'accrued',feeTreatment:'accrued',chargeAllocations:[{chargeId:interest.chargeId,component:'interest',amountMinor:'8000'},
            {chargeId:fee.chargeId,component:'fee',amountMinor:'2000'}]}
        await assert.rejects(c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'repayment',counterpartyLedgerAccountId:c.accounts.other_liability},
          decisions:{repayment:{...decision,chargeAllocations:[{...decision.chargeAllocations[0],chargeId:randomUUID()},decision.chargeAllocations[1]]}}})),{publicCode:'NOT_FOUND'})
        await c.imp('financeUpdates.setReview',await input(c,0,{fields:{economicNature:'repayment',counterpartyLedgerAccountId:c.accounts.other_liability},decisions:{repayment:decision}}))
        assert.deepEqual(await dump(c,'catledger_transactions','transaction_id'),before)
        await post(c)
        const after=await dump(c,'catledger_transactions','transaction_id'),created=after.filter(row=>!before.some(old=>old.transaction_id===row.transaction_id))
        assert.deepEqual(created.map(row=>[row.type,String(row.amount_minor)]),[['transfer','100000']])
        assert.equal((await c.api('loans.get',{loanId:loan.loanId})).loan.remainingPrincipalMinor,'990000')
        const settled=(await c.api('loans.chargePlan',{loanId:loan.loanId})).items
        assert.equal(settled.find(row=>row.chargeId===interest.chargeId).outstandingMinor,'0')
        assert.equal(settled.find(row=>row.chargeId===fee.chargeId).outstandingMinor,'0')
      })
    } finally { await lab.close() }
  })
