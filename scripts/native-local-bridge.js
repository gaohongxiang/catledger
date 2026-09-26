// 微信模拟器 → 本机真实函数 handler → 一次性 MySQL。仅合成账本，绝不代理到云端。
// 启动后把私有 state 文件作为 automation_evaluate 的参数；结束 SIGTERM 自动回收。
const fs = require('node:fs')
const http = require('node:http')
const { randomBytes, randomUUID } = require('node:crypto')
const { isolatedMysql } = require('./isolated-mysql')
const grants = require('./runtime-role-grants')
const { localServices, call, prepareSyntheticUpdate } = require('../test/helpers/local-services')
async function main() {
  const stateFile = process.argv[2]
  if (!stateFile || !stateFile.startsWith('/private/tmp/')) throw new Error('State file must be in /private/tmp')
  const db = await isolatedMysql(), key = randomBytes(24).toString('hex'), traces = []
  let server, closing = false
  async function close() {
    if (closing) return
    closing = true
    if (server) await new Promise(resolve => server.close(resolve))
    await db.close()
    fs.rmSync(stateFile, { force: true })
  }
  process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1 }))
  process.once('SIGINT', () => close().catch(() => { process.exitCode = 1 }))
  try {
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer)
    const services = localServices({ apiPool, importPool })
    const identity = await call(services.api, 'bootstrap')
    const account = await call(services.api, 'accounts.create', { requestId: randomUUID(), name: '合成验证零钱', type: 'wallet', openingDisplayBalanceMinor: '50000',
      occurredLocalAt: '2026-09-01T10:00:00', timezoneOffsetMinutes: -480 })
    await call(services.api, 'accounts.createBatch', { requestId: randomUUID(), accounts: Array.from({ length: 20 }, (_, i) => ({ type: i === 19 ? 'credit' : 'wallet', name: '合成备用账户' + String(i + 1).padStart(2, '0') })) })
    const update = await prepareSyntheticUpdate(services, 121, 'SYNTHETIC-NATIVE')
    let loanState={}
    if(process.argv[3]==='loans') {
      const api=(action,data)=>call(services.api,action,data)
      const credit=await api('accounts.create',{requestId:randomUUID(),name:'合成分期信用卡',type:'credit',openingDisplayBalanceMinor:'600000',occurredLocalAt:'2026-01-01T00:00:00',timezoneOffsetMinutes:-480})
      const bank=await api('accounts.create',{requestId:randomUUID(),name:'合成还款银行卡',type:'bank',openingDisplayBalanceMinor:'9000000',occurredLocalAt:'2026-01-01T00:00:00',timezoneOffsetMinutes:-480})
      const categoryId=identity.categories.find(c=>c.kind==='expense').id
      const loan=await api('loans.create',{...require('../test/helpers/loan-charges').plan,requestId:randomUUID(),accountId:credit.accountId})
      const coverage=[]
      for(const month of ['01','04']){
        const txn=await api('transactions.create',{requestId:randomUUID(),type:'expense',sourceAccountId:credit.accountId,categoryId,amountMinor:'2000',occurredLocalAt:'2026-'+month+'-01T12:00:00',timezoneOffsetMinutes:-480})
        coverage.push({chargeKey:'period:'+Number(month)+':interest',transactionId:txn.transactionId})
      }
      loanState={loanId:loan.loanId,creditAccountId:credit.accountId,bankAccountId:bank.accountId,categoryId,coverage}
    }
    server = http.createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (request.url !== '/' + key || request.method !== 'POST') { response.writeHead(404); response.end('{}'); return }
      const buffers = []; let bytes = 0
      for await (const part of request) { bytes += part.length; if (bytes > 65536) { response.writeHead(413); response.end('{}'); return }; buffers.push(part) }
      const start = Date.now()
      try {
        const payload = JSON.parse(Buffer.concat(buffers)), handler = payload.name === 'catledger-api' ? services.api : payload.name === 'catledger-import' ? services.import : null
        if (!handler) throw new Error('Unknown local function')
        const result = await handler(payload.data)
        const body = JSON.stringify({ result })
        traces.push({ function: payload.name, action: payload.data.action, ok: result.ok, code: result.error && result.error.code, ms: Date.now() - start, requestBytes: bytes, responseBytes: Buffer.byteLength(body) })
        if (traces.length > 500) traces.shift()
        response.end(body)
      } catch (_) { response.writeHead(400); response.end('{"result":{"ok":false,"error":{"code":"LOCAL_BRIDGE_FAILED"}}}') }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const state = { endpoint: 'http://127.0.0.1:' + server.address().port + '/' + key, updateId: update.updateId,
      ...loanState,accountId: account.accountId, uid: identity.uid, categories: identity.categories, source: 'local synthetic MySQL; not cloud acceptance' }
    fs.writeFileSync(stateFile, JSON.stringify([state]), { mode: 0o600 })
    process.stdout.write('Native local bridge ready: 121 synthetic rows, '+(loanState.loanId?23:21)+' accounts, separate runtime roles.\n')
    process.once('SIGUSR1', () => { process.stdout.write(JSON.stringify({ kind: 'native-local-traces', traces }) + '\n') })
  } catch (error) { await close(); throw error }
}
main().catch(error => { process.stderr.write('Native local bridge failed: ' + (error.code || error.publicCode || error.name) + '\n'); process.exitCode = 1 })
