const test=require('node:test'),assert=require('node:assert/strict')
const {createExportFiles,csvCell}=require('../miniprogram/services/export-files')
function fixture(){
 const files=new Map(),root='/private-synthetic',time=1789300000000
 const fs={readdirSync:()=>[...files.keys()].map(p=>p.slice(root.length+1)),unlinkSync:p=>files.delete(p),writeFileSync:(p,v)=>files.set(p,v),appendFileSync:(p,v)=>{assert.ok(files.has(p));files.set(p,files.get(p)+v)}}
 return {files,root,time,service:createExportFiles({getFileSystemManager:()=>fs,env:{USER_DATA_PATH:root}},()=>time)}
}
test('CSV 文本阻止公式与控制前缀，JSONL 保持原文及整数精度，按段写入',async()=>{
 for(const text of ['=SUM(1,2)',' +1','-1','@SUM(A1)','\tvalue','\rvalue','\nvalue'])assert.ok(csvCell(text).startsWith('"\''))
 assert.equal(csvCell('合成"猫"'),'"合成""猫"""')
 const f=fixture(),value={table:'catledger_transactions',row:{transaction_id:'合成',type:'expense',amount_minor:'9223372036854775807',note:'=SUM(1,2)\n合成🐱'}}
 const line=JSON.stringify(value)+'\n';let page=0
 const result=await f.service.generate({requestId:'synthetic',isCurrent:()=>true,call:async(action)=>{
  if(action==='dataExports.start')return {exportId:'00000000-0000-4000-8000-000000000001',format:'catledger-jsonl-v1',schemaVersion:17,tables:['catledger_transactions']}
  if(action==='dataExports.page')return ++page===1?{text:line.slice(0,30),bytes:30,rows:0,totalRows:0,nextCursor:'part'}:{text:line.slice(30),bytes:200,rows:1,totalRows:1,nextCursor:null,completeToken:'end'}
  assert.equal(action,'dataExports.finish');return {complete:true,rows:1,exportId:'synthetic'}
 }})
 assert.deepEqual(JSON.parse(f.files.get(result.files.jsonl).split('\n')[1]),value)
 assert.match(f.files.get(result.files.csv),/"'=SUM\(1,2\)/);assert.match(f.files.get(result.files.csv),/9223372036854775807/)
 f.service.remove(result.files);assert.equal(f.files.size,0)
})
test('关闭、失败或快照失效清理未完成文件；过期只删除本功能私有文件',async()=>{
 for(const failure of ['EXPORT_CHANGED','CLOSED']){
  const f=fixture();let active=true
  await assert.rejects(f.service.generate({requestId:'synthetic',isCurrent:()=>active,call:async a=>{
   if(a==='dataExports.start')return {exportId:'00000000-0000-4000-8000-000000000001'}
   if(failure==='CLOSED'){active=false;return {text:''}}
   throw new Error(failure)
  }}));assert.equal(f.files.size,0)
 }
 const f=fixture(),prefix=f.root+'/catledger-export-00000000-0000-4000-8000-000000000001-'
 f.files.set(prefix+(f.time-3600001)+'.jsonl','private');f.files.set(prefix+f.time+'.csv','current');f.files.set(f.root+'/avatar.png','keep')
 f.service.cleanup(false);assert.equal(f.files.size,2);f.service.cleanup(true);assert.deepEqual([...f.files.values()],['keep'])
})
