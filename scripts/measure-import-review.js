// MINI-1915 合成对照：固定 UUID/时钟，保留所有业务字段、关系、摘要及 SQL 顺序。
// 仅在独立进程与 isolatedMysql 中运行；不向产品运行时注入测试接口。
const fs = require('node:fs')
const crypto = require('node:crypto')
const { isolatedMysql } = require('./isolated-mysql')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function measure() {
  const lab = await isolatedMysql(), OriginalDate = Date, originalUuid = crypto.randomUUID
  let sequence = 0
  crypto.randomUUID = () => '19150000-0000-4000-8000-' + String(++sequence).padStart(12, '0')
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : ['2026-09-24T00:00:00.000Z'])) }
    static now() { return 1790208000000 }
  }
  try {
    const { localServices, call, prepareSyntheticUpdate } = require('../test/helpers/local-services')
    const { hashWechatSubject } = require('../cloudfunctions/catledger-import/src/handler')
    let sql = []
    const pool = { async getConnection() {
      const connection = await lab.owner.getConnection()
      await connection.query('SET timestamp = 1790208000')
      return new Proxy(connection, { get(target, key) {
        if (!['execute', 'query', 'beginTransaction', 'commit', 'rollback'].includes(key)) return typeof target[key] === 'function' ? target[key].bind(target) : target[key]
        return async (...args) => {
          sql.push(hash([key, args[0] || key]))
          return target[key](...args)
        }
      } })
    } }
    const uid = '1915000000', seed = await pool.getConnection()
    await seed.execute("INSERT INTO catledger_users (uid,status) VALUES (?,'active')", [uid])
    await seed.execute("INSERT INTO catledger_user_identities (uid,provider,subject_hash) VALUES (?,'wechat-mini',?)", [uid, hashWechatSubject('synthetic-mini1915')])
    seed.release()
    const services = localServices({ apiPool: pool, importPool: pool, subject: 'synthetic-mini1915' })
    const results = []
    async function sample(name, operation) {
      sql = []
      const result = await operation().catch(error => { error.measurementStage = name; throw error })
      results.push({ name, sqlCount: sql.length, sqlOrderHash: hash(sql), responseBytes: Buffer.byteLength(JSON.stringify(result)), resultHash: hash(result) })
      return result
    }
    const invoke = (handler, action, data) => call(handler, action, data).catch(error => { error.measurementStage = action; throw error })
    const api = (action, data) => invoke(services.api, action, data)
    const imp = (action, data) => invoke(services.import, action, data)
    const identity = await api('bootstrap')
    const account = await api('accounts.create', { requestId: crypto.randomUUID(), name: '合成核对账户', type: 'wallet',
      openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })
    let update = await sample('prepare', () => prepareSyntheticUpdate(services, 3, 'SYNTHETIC-MINI1915'))
    const updateId = update.updateId
    const summary = () => imp('financeUpdates.summary', { updateId })
    const issues = () => imp('reviewIssues.list', { updateId })
    const open = (await issues()).items.filter(i => i.issueType === 'account_mapping' && i.status === 'open')
    const request = { requestId: crypto.randomUUID(), updateId, updateVersion: update.appliedVersion,
      decisions: open.map(i => ({ issueId: i.issueId, issueVersion: i.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: account.accountId } })) }
    update = await sample('map-accounts', () => imp('reviewIssues.resolveAccountMappings', request))
    await sample('map-replay', () => imp('reviewIssues.resolveAccountMappings', request))
    await sample('refresh-no-candidates', () => imp('reviewIssues.refreshAccountGroups', { requestId: crypto.randomUUID(), updateId, version: update.appliedVersion }))
    await sample('refresh-again', () => imp('reviewIssues.refreshAccountGroups', { requestId: crypto.randomUUID(), updateId, version: update.appliedVersion }))
    await sample('summary', summary)
    await sample('event-page', () => imp('economicEvents.list', { updateId }))
    const post = { requestId: crypto.randomUUID(), updateId, version: update.appliedVersion }
    await sample('post', () => imp('financeUpdates.post', post))
    await sample('post-replay', () => imp('financeUpdates.post', post))
    // 新来源同额独立记录：显式历史核对，绝不为测量绕过门禁。
    const next = await sample('prepare-history', async () => {
      const content = Buffer.from('交易日期,交易金额,收支,交易类型,摘要\n2026-09-01 12:00,1.00,支出,消费,合成银行消费')
      const file = (await imp('imports.prepareMany', { requestId: crypto.randomUUID(), files: [{ fileName: '合成银行.csv', size: content.length }] })).files[0]
      services.objects.set(file.cloudPath, content)
      const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }
      const preview = (await imp('imports.parseFile', { requestId: crypto.randomUUID(), ...input })).bankPreview
      const parsed = await imp('imports.parseFile', { requestId: crypto.randomUUID(), ...input, bankMapping: { ...preview.suggested,
        schemaVersion: 1, headerRow: preview.headerRow, sheetIndex: preview.sheetIndex, headerToken: preview.headerToken } })
      return imp('financeUpdates.prepare', { requestId: crypto.randomUUID(), batchIds: [parsed.batch.batchId] })
    })
    const nextId = next.updateId
    const mappings = (await imp('reviewIssues.list', { updateId: nextId, status: 'open' })).items.filter(i => i.issueType === 'account_mapping')
    if (mappings.length) await sample('map-history-accounts', () => imp('reviewIssues.resolveAccountMappings', {
      requestId: crypto.randomUUID(), updateId: nextId, updateVersion: next.appliedVersion,
      decisions: mappings.map(i => ({ issueId: i.issueId, issueVersion: i.version, operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: account.accountId } }))
    }))
    const pending = (await imp('reviewIssues.list', { updateId: nextId, status: 'open' })).items
    if (!pending.some(i => i.primaryReasonCode === 'historical_duplicate_candidate') || pending.some(i => !['category_assignment', 'same_event'].includes(i.issueType))) {
      const error = Error('synthetic history setup failed')
      error.measurementStage = 'history-setup:' + pending.map(i => i.issueType + ':' + i.primaryReasonCode).join(',')
      throw error
    }
    for (const issue of pending) {
      const view = await imp('financeUpdates.summary', { updateId: nextId })
      const category = issue.issueType === 'category_assignment'
      await sample(category ? 'category-fields' : 'history-distinct', () => imp('reviewIssues.resolve', { requestId: crypto.randomUUID(), updateId: nextId,
        updateVersion: view.update.version, issueId: issue.issueId, issueVersion: issue.version, decision: category ? 'apply_fields' : 'confirm_distinct',
        ...(category ? { fields: { categoryId: identity.categories.find(c => c.kind === 'expense').id } } : {}) }))
    }
    const nextView = await imp('financeUpdates.summary', { updateId: nextId })
    await sample('post-distinct', () => imp('financeUpdates.post', { requestId: crypto.randomUUID(), updateId: nextId, version: nextView.update.version }))
    const [tables] = await lab.owner.execute("SELECT TABLE_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND COLUMN_NAME='uid' ORDER BY TABLE_NAME", [lab.database])
    const graph = []
    for (const { name } of tables) {
      if (!/^catledger_[a-z_]+$/.test(name)) throw Error('unexpected table')
      const [keys] = await lab.owner.execute("SELECT COLUMN_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [lab.database, name])
      const [rows] = await lab.owner.execute('SELECT * FROM `' + name + '` WHERE uid=? ORDER BY ' + keys.map(k => '`' + k.name + '`').join(','), [uid])
      // 不删除 ID/外键、金额、业务时间、版本、JSON 或空/非空状态。
      graph.push({ table: name, rows: rows.length, hash: hash(rows) })
    }
    return { clock: '2026-09-24T00:00:00Z', uuid: 'fixed sequential UUIDs; no ID elision or remapping', samples: results, graph }
  } finally {
    global.Date = OriginalDate
    crypto.randomUUID = originalUuid
    await lab.close()
  }
}
if (require.main === module) measure().then(result => {
  const output = process.argv[2]
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  else process.stdout.write(JSON.stringify(result) + '\n')
}).catch(error => { process.stderr.write('合成对照失败：' + (error.measurementStage || 'setup') + ' / ' + (error.publicCode || error.code || error.name) + '\n'); process.exitCode = 1 })
module.exports = { measure }
