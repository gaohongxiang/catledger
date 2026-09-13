// 私有临时文件只在用户主动点击时交给微信分享；业务原文不进入缓存或日志。
const OWN_FILE = /^catledger-export-[a-f0-9-]{36}-(\d{13})\.(jsonl|csv)$/
const CSV_COLUMNS = ['transaction_id','type','amount_minor','currency','source_account_id','destination_account_id',
  'category_id','original_transaction_id','occurred_local_at','timezone_offset_minutes','note','deleted_at']
function csvCell(value) {
  let text=value==null?'':String(value)
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text="'"+text
  return '"'+text.replace(/"/g,'""')+'"'
}
function createExportFiles(platform, now) {
  now=now||Date.now
  const fs=platform.getFileSystemManager(),root=platform.env.USER_DATA_PATH
  function cleanup(all) {
    const names=fs.readdirSync(root)
    names.forEach(name=>{const match=OWN_FILE.exec(name);if(match&&(all||now()-Number(match[1])>=3600000))fs.unlinkSync(root+'/'+name)})
  }
  function remove(files) { Object.values(files||{}).forEach(path=>{if(path.startsWith(root+'/')&&OWN_FILE.test(path.slice(root.length+1))){try{fs.unlinkSync(path)}catch(_){}}}) }
  async function generate({call,requestId,isCurrent,progress}) {
    cleanup(false)
    const job=await call('dataExports.start',{requestId})
    if(!isCurrent())throw new Error('导出已停止')
    if(!/^[a-f0-9-]{36}$/.test(job.exportId))throw new Error('导出响应无效')
    const createdAt=now(),base=root+'/catledger-export-'+job.exportId+'-'+createdAt,files={jsonl:base+'.jsonl',csv:base+'.csv'}
    let cursor=null,buffer='',totalRows=0
    try{
      fs.writeFileSync(files.jsonl,JSON.stringify({format:job.format,schemaVersion:job.schemaVersion,startedAt:job.startedAt,tables:job.tables})+'\n','utf8')
      fs.writeFileSync(files.csv,'\ufeff'+CSV_COLUMNS.map(csvCell).join(',')+'\r\n','utf8')
      let terminal=null
      do{
        const page=await call('dataExports.page',{exportId:job.exportId,...(cursor?{cursor}:{})})
        if(!isCurrent())throw new Error('导出已停止')
        if(typeof page.text!=='string'||page.rows>50||page.bytes>65536)throw new Error('导出响应无效')
        fs.appendFileSync(files.jsonl,page.text,'utf8')
        buffer+=page.text
        let end
        while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
          if(line){const record=JSON.parse(line);if(record.table==='catledger_transactions'){
            fs.appendFileSync(files.csv,CSV_COLUMNS.map(key=>csvCell(record.row[key])).join(',')+'\r\n','utf8')
          }}
        }
        // 原始行只保留当前一行，超过合法云函数数据包上限时停止并清理，不截断。
        if(buffer.length>16*1024*1024)throw new Error('单条记录过大，导出未完成')
        cursor=page.nextCursor;terminal=page.completeToken;totalRows=page.totalRows
        if(progress)progress(totalRows)
      }while(cursor)
      if(buffer)throw new Error('导出记录不完整')
      const result=await call('dataExports.finish',{exportId:job.exportId,completeToken:terminal})
      if(!isCurrent())throw new Error('导出已停止')
      if(!result.complete||result.rows!==totalRows)throw new Error('导出数量不一致')
      fs.appendFileSync(files.jsonl,JSON.stringify({completed:true,rows:result.rows,exportId:result.exportId})+'\n','utf8')
      return {files,rows:result.rows,expiresAt:createdAt+3600000}
    }catch(error){remove(files);throw error}
  }
  return {cleanup,remove,generate}
}
function cleanup(all) {
  if(typeof wx==='undefined'||!wx.getFileSystemManager||!wx.env)return
  try{createExportFiles(wx).cleanup(all)}catch(_){/* 下次启动/主动清理继续，仅处理自己的临时文件。 */}
}
module.exports={createExportFiles,csvCell,CSV_COLUMNS,cleanup}
