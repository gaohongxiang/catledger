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
      let failAfterIssue = false
      const importPool = { async getConnection() {
        const connection = await importer.getConnection()
        return new Proxy(connection, { get(target,key) {
          if (key === 'execute') return async (sql,values) => {
            if (failAfterIssue && /UPDATE catledger_economic_events SET/.test(sql)) throw Error('synthetic rollback after relation and issue changes')
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
        c.uid=(await c.api('bootstrap')).uid
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
        const candidates=await c.imp('economicEvents.refundCandidates',{updateId:c.update.updateId,eventId:row.eventId,kind:'transaction',pageSize:1})
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
        failAfterIssue=true
        await assert.rejects(c.imp('financeUpdates.setReview',data),{publicCode:'INTERNAL_ERROR'});failAfterIssue=false
        assert.deepEqual(await Promise.all(tables.map(([table,key])=>dump(c,table,key))),before)
        const results=await Promise.all([c.imp('financeUpdates.setReview',data),c.imp('financeUpdates.setReview',data)])
        assert.deepEqual(results[0],results[1])
        assert.equal((await rows(c)).find(row=>row.eventId===data.eventId).version,data.eventVersion+1)
        assert.deepEqual(await c.imp('imports.commandResult',{requestId:data.requestId,commandAction:'financeUpdates.setReview'}),results[0])
      })
      await t.test('文本清空及人工金额经重整、入账保留，来源数据仍不变',async()=>{
        const c=await setup([100]),data=await input(c,0,{fields:{note:'',counterparty:'',amountMinor:'12345'}})
        await c.imp('financeUpdates.setReview',data)
        await lab.owner.execute("UPDATE catledger_finance_updates SET plan_version='organizer-plan-v31' WHERE uid=? AND update_id=?",[c.uid,c.update.updateId])
        await c.imp('financeUpdates.organize',{requestId:randomUUID(),updateId:c.update.updateId,version:(await summary(c)).update.version})
        const row=await detail(c,data.eventId);assert.equal(row.note,'');assert.equal(row.counterparty,'');assert.equal(row.amountMinor,'12345')
        await post(c)
        const transaction=(await dump(c,'catledger_transactions','transaction_id')).find(row=>row.origin==='import')
        assert.equal(String(transaction.amount_minor),'12345');assert.doesNotMatch(transaction.note,/合成备注|合成商户/);assert.match(transaction.note,/合成商品/)
      })
      await t.test('越权账户/事件、旧版本、源状态和只读键均拒绝',async()=>{
        const c=await setup([100]),other=await setup([100]),data=await input(c,0,{fields:{note:'合成备注'}})
        await assert.rejects(other.imp('financeUpdates.setReview',data),{publicCode:'NOT_FOUND'})
        for(const fields of [{ledgerAccountId:other.accounts.wallet},{status:'ready'},{rawFields:{}},{occurredLocalAt:'2026-02-30 00:00:00',timezoneOffsetMinutes:-480}]) await assert.rejects(c.imp('financeUpdates.setReview',{...data,requestId:randomUUID(),fields}),{publicCode:'VALIDATION_ERROR'})
        await assert.rejects(c.imp('financeUpdates.setReview',{...data,eventVersion:data.eventVersion+1}),{publicCode:'CONFLICT'})
        await post(c)
        await assert.rejects(c.imp('financeUpdates.setReview',{...data,requestId:randomUUID()}),{publicCode:'CONFLICT'})
      })
    } finally { await lab.close() }
  })
