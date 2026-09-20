const { randomUUID } = require('node:crypto')
const manifest = require('./export-manifest.json')
const { executeLedgerRead } = require('./ledger-read')
const { resolveUid } = require('./ledger-transaction')
const { ledgerError } = require('./ledger-errors')
const { encodeCursor, decodeCursor } = require('./cursor')
const { digestIdempotencyKey } = require('./request-digest')
const { safeRollback } = require('./database-errors')
const MAX_ROWS = 50, MAX_BYTES = 64 * 1024, FORMAT = 'catledger-jsonl-v1'
const JOB_SQL = 'SELECT export_id AS exportId,request_digest AS requestDigest,data_revision AS revision,started_at AS startedAt,expires_at AS expiresAt,result_json AS result FROM catledger_data_exports WHERE uid=?'
const parseJson = value => typeof value === 'string' ? JSON.parse(value) : value

function createDataExportService({ getPool, now = Date.now }) {
  function fresh(job, revision) {
    if (!job || Date.parse(job.expiresAt.replace(' ', 'T') + 'Z') <= now()) throw ledgerError('EXPORT_EXPIRED')
    if (String(job.revision) !== String(revision)) throw ledgerError('EXPORT_CHANGED')
  }
  function publicJob(job) {
    return { exportId:job.exportId,format:FORMAT,startedAt:job.startedAt,expiresAt:job.expiresAt,
      schemaVersion:20,tables:manifest.map(t=>t.name),maxRows:MAX_ROWS,maxBytes:MAX_BYTES }
  }
  // 临时任务不属于账本，不写 mutation_receipts，也不递增业务修订。
  async function locked(context, operation) {
    const c = await getPool().getConnection()
    try {
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await c.beginTransaction()
      const uid = await resolveUid(c, context.provider, context.subjectHash)
      const [[user]] = await c.execute("SELECT data_revision AS revision FROM catledger_users WHERE uid=? AND status='active' FOR UPDATE",[uid])
      if (!user) throw ledgerError('INITIALIZATION_REQUIRED')
      const result = await operation(c,uid,user.revision)
      await c.commit(); return result
    } catch (e) { await safeRollback(c); throw e } finally { c.release() }
  }
  async function start(context) {
    const requestDigest = digestIdempotencyKey(context.data.requestId)
    return locked(context, async(c,uid,revision)=>{
      const [[existing]] = await c.execute(JOB_SQL,[uid])
      if (existing && existing.requestDigest === requestDigest) { fresh(existing,revision); return publicJob(existing) }
      const exportId=randomUUID(),expiresAt=new Date(now()+3600000).toISOString().slice(0,23).replace('T',' ')
      await c.execute(`INSERT INTO catledger_data_exports(uid,export_id,request_digest,data_revision,expires_at)
        VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE export_id=VALUES(export_id),request_digest=VALUES(request_digest),
        data_revision=VALUES(data_revision),started_at=CURRENT_TIMESTAMP(3),expires_at=VALUES(expires_at),completed_at=NULL,result_json=NULL`,
      [uid,exportId,requestDigest,revision,expiresAt])
      const [[job]] = await c.execute(JOB_SQL,[uid]); return publicJob(job)
    })
  }
  function position(context,uid) {
    const data=context.data, pos=data.cursor ? decodeCursor(context.subjectHash,data.cursor) :
      { action:'dataExports.page',uid,id:data.exportId,t:0,key:null,offset:0,rows:0 }
    if(pos.action!=='dataExports.page'||pos.uid!==uid||pos.id!==data.exportId||!Number.isInteger(pos.t)||pos.t<0||pos.t>manifest.length||
      !Number.isSafeInteger(pos.offset)||pos.offset<0||!Number.isSafeInteger(pos.rows)||pos.rows<0||
      (pos.key!==null && (!Array.isArray(pos.key)||pos.key.length!==manifest[pos.t]?.keys.length))) throw ledgerError('VALIDATION_ERROR')
    return pos
  }
  async function page(context) {
    return executeLedgerRead({getPool,...context,consistentSnapshot:true,operation:async(c,uid)=>{
      const [[job]]=await c.execute(JOB_SQL,[uid])
      if(!job||job.exportId!==context.data.exportId) throw ledgerError('NOT_FOUND')
      const [[user]]=await c.execute('SELECT data_revision AS revision FROM catledger_users WHERE uid=?',[uid]);fresh(job,user.revision)
      const pos=position(context,uid), chunks=[];let bytes=0,completedRows=0
      while(pos.t<manifest.length&&bytes<MAX_BYTES&&completedRows<MAX_ROWS){
        const table=manifest[pos.t],keys=table.keys,tuple='('+keys.join(',')+')'
        const condition=pos.key ? ` AND ${tuple} ${pos.offset?'>=':'>'} (${keys.map(()=>'?').join(',')})` : ''
        // 仅取一行，宽 JSON 不能在一个 SQL 结果内累积 50 份大对象。
        const [[row]]=await c.execute(`SELECT ${table.columns.join(',')} FROM ${table.name} WHERE uid=?${condition} ORDER BY ${keys.join(',')} LIMIT 1`,[uid,...(pos.key||[])])
        if(!row){pos.t++;pos.key=null;pos.offset=0;continue}
        for(const column of table.json) if(row[column]!=null) row[column]=parseJson(row[column])
        const line=Buffer.from(JSON.stringify({table:table.name,row})+'\n','utf8'),available=MAX_BYTES-bytes
        if(pos.offset>line.length)throw ledgerError('VALIDATION_ERROR')
        let end=Math.min(line.length,pos.offset+available)
        while(end<line.length&&(line[end]&0xc0)===0x80)end--
        if(end===pos.offset)break
        chunks.push(line.subarray(pos.offset,end).toString('utf8'));bytes+=end-pos.offset
        pos.key=keys.map(k=>row[k]);pos.offset=end===line.length?0:end
        if(!pos.offset){completedRows++;pos.rows++}else break
      }
      const token=encodeCursor(context.subjectHash,pos),complete=pos.t===manifest.length
      return {text:chunks.join(''),bytes,rows:completedRows,totalRows:pos.rows,nextCursor:complete?null:token,completeToken:complete?token:null}
    }})
  }
  async function finish(context) {
    return locked(context,async(c,uid,revision)=>{
      const pos=position({...context,data:{...context.data,cursor:context.data.completeToken}},uid)
      if(pos.t!==manifest.length||pos.offset!==0)throw ledgerError('VALIDATION_ERROR')
      const [[job]]=await c.execute(JOB_SQL,[uid])
      if(!job||job.exportId!==context.data.exportId)throw ledgerError('NOT_FOUND')
      if(job.result)return parseJson(job.result)
      fresh(job,revision)
      const result={exportId:job.exportId,complete:true,rows:pos.rows,format:FORMAT,startedAt:job.startedAt}
      await c.execute('UPDATE catledger_data_exports SET completed_at=CURRENT_TIMESTAMP(3),result_json=? WHERE uid=?',[JSON.stringify(result),uid])
      return result
    })
  }
  return {start,page,finish}
}
module.exports={createDataExportService,manifest,MAX_ROWS,MAX_BYTES,FORMAT}
