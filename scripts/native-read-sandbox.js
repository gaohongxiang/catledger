// 独立原生工程从启动前替换云调用与业务存储，所有数据来自一次性本机 MySQL。
// node scripts/native-read-sandbox.js /private/tmp/catledger-read-native [source-root]
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { randomBytes, randomUUID, createHash } = require('node:crypto')
const { isolatedMysql } = require('./isolated-mysql')
const grants = require('./runtime-role-grants')
const { createObserver } = require('./performance-observer')
async function main() {
  const project = process.argv[2], source = path.resolve(process.argv[3] || path.join(__dirname, '..'))
  if (!project || !project.startsWith('/private/tmp/catledger-read-native') || fs.existsSync(project)) throw Error('Use a new dedicated temporary project')
  const { localServices, call } = require(path.join(source, 'test/helpers/local-services'))
  const db = await isolatedMysql(), key = randomBytes(24).toString('hex'), traces = []
  let server, closing = false
  async function close() {
    if (closing) return; closing = true
    if (server) await new Promise(resolve => server.close(resolve))
    await db.close()
  }
  process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1 }))
  process.once('SIGINT', () => close().catch(() => { process.exitCode = 1 }))
  try {
    const apiPool = await db.role('api', grants.api), importPool = await db.role('import', grants.importer), observer = createObserver(apiPool)
    const services = localServices({ apiPool: observer.pool, importPool }), api = (action, data) => call(services.api, action, data)
    const identity = await api('bootstrap')
    await api('profile.update', { requestId: randomUUID(), nickname: '合成验证', previousNickname: '' })
    const account = await api('accounts.create', { requestId: randomUUID(), name: '合成验证零钱', type: 'wallet', openingDisplayBalanceMinor: '50000', occurredLocalAt: '2026-09-01T10:00:00', timezoneOffsetMinutes: -480 })
    const categoryId = identity.categories.find(c => c.kind === 'expense').id
    for (let i = 0; i < 305; i++) await api('transactions.create', { requestId: randomUUID(), type: 'expense', sourceAccountId: account.accountId, categoryId,
      amountMinor: '100', occurredLocalAt: '2026-09-02T12:00:00', timezoneOffsetMinutes: -480, note: '合成原生分页' })
    const debt = await api('accounts.create', { requestId: randomUUID(), name: '合成借款账户', type: 'other_liability', openingDisplayBalanceMinor: '10000', occurredLocalAt: '2026-09-01T10:00:00', timezoneOffsetMinutes: -480 })
    const loan = await api('loans.create', { requestId: randomUUID(), name: '合成贷款', kind: 'borrowing', accountId: debt.accountId, baselinePrincipalMinor: '10000', baselineDate: '2026-09-01' })
    server = http.createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      if (request.url !== '/' + key || request.method !== 'POST') { response.writeHead(404); response.end('{}'); return }
      let input = ''; for await (const part of request) { input += part; if (Buffer.byteLength(input) > 65536) { response.writeHead(413); response.end('{}'); return } }
      try {
        const payload = JSON.parse(input), handler = payload.name === 'catledger-api' ? services.api : payload.name === 'catledger-import' ? services.import : null
        if (!handler) throw Error('Unknown function')
        observer.reset(); const start = Date.now(), result = await handler(payload.data), body = JSON.stringify({ result }), stats = observer.snapshot()
        traces.push({ action: payload.data.action, ok: result.ok, code: result.error && result.error.code, ms: Date.now() - start,
          responseBytes: Buffer.byteLength(body), sqlCount: stats.sqlCount, summaryCount: stats.summaryCount, sqlMs: stats.sqlMs, connectionMs: stats.connectionMs, identityMs: stats.identityMs })
        if (traces.length > 500) traces.shift()
        response.end(body)
      } catch (_) { response.writeHead(400); response.end('{"result":{"ok":false,"error":{"code":"LOCAL_BRIDGE_FAILED"}}}') }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/' + key
    fs.mkdirSync(project); fs.cpSync(path.join(source, 'miniprogram'), path.join(project, 'miniprogram'), { recursive: true })
    const config = JSON.parse(fs.readFileSync(path.join(source, 'project.config.json')))
    config.projectname = path.basename(project); config.setting = { ...config.setting, urlCheck: false }; delete config.cloudfunctionRoot
    fs.writeFileSync(path.join(project, 'project.config.json'), JSON.stringify(config, null, 2))
    const appPath = path.join(project, 'miniprogram/app.js'), appSource = fs.readFileSync(appPath, 'utf8')
    const hash = createHash('sha256')
    function treeHash(directory, prefix) { for (const name of fs.readdirSync(directory).sort()) { if (name === 'node_modules') continue; const filename = path.join(directory, name), relative = prefix + '/' + name; if (fs.statSync(filename).isDirectory()) treeHash(filename, relative); else { hash.update(relative); hash.update(fs.readFileSync(filename)) } } }
    for (const folder of ['miniprogram', 'cloudfunctions/catledger-api', 'cloudfunctions/catledger-import']) treeHash(path.join(source, folder), folder)
    const sourceHash = hash.digest('hex'), sourceSha = fs.existsSync(path.join(source, '.read-source-sha')) ? fs.readFileSync(path.join(source, '.read-source-sha'), 'utf8').trim() : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
    fs.writeFileSync(appPath, "require('./native-read-transport')\n" + appSource)
    fs.writeFileSync(path.join(project, 'miniprogram/native-read-transport.js'), `
const storage = new Map(), traces = []
const state = { traces, storage, failReads: false, delayMs: 40 }
wx.getStorageSync = key => storage.get(key)
wx.setStorageSync = (key, value) => storage.set(key, value)
wx.removeStorageSync = key => storage.delete(key)
wx.cloud.init = () => {}
wx.cloud.callFunction = options => new Promise((resolve, reject) => {
  const start = Date.now()
  setTimeout(() => {
    if (state.failReads && ['dashboard.get','reads.validate'].includes(options.data.action)) {
      traces.push({ action: options.data.action, ms: Date.now() - start, ok: false })
      reject({ errMsg: 'request:fail timeout' }); return
    }
    wx.request({ url: ${JSON.stringify(endpoint)}, method: 'POST', data: { name: options.name, data: options.data }, timeout: 20000,
      success(response) {
        const value = response.data
        traces.push({ action: options.data.action, ms: Date.now() - start, ok: !!(value.result && value.result.ok) })
        if (options.success) options.success(value); resolve(value)
      }, fail(error) { if (options.fail) options.fail(error); reject(error) }
    })
  }, state.delayMs)
})
for (const name of ['uploadFile','downloadFile','deleteFile']) wx.cloud[name] = () => Promise.reject(new Error('Native read sandbox blocks cloud files'))
require('./services/read-observer').enable(true)
module.exports = state
`)
    fs.writeFileSync(path.join(project, 'native-state.json'), JSON.stringify([{ loanId: loan.loanId, accountId: account.accountId, categoryId, sourceHash, sourceSha, source }]), { mode: 0o600 })
    process.stdout.write('Native READ sandbox ready; synthetic local data only.\n')
    process.on('SIGUSR1', () => process.stdout.write(JSON.stringify({ kind: 'native-read-server', traces }) + '\n'))
  } catch (error) { await close(); throw error }
}
main().catch(error => { process.stderr.write('Native READ sandbox failed: ' + (error.publicCode || error.code || error.name) + '\n'); process.exitCode = 1 })
