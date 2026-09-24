const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const XLSX = require('../cloudfunctions/catledger-import/node_modules/xlsx')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call, syntheticBill } = require('./helpers/local-services')
const { createImportService } = require('../cloudfunctions/catledger-import/src/import-service')
const { hashWechatSubject } = require('../cloudfunctions/catledger-import/src/handler')

function bankFile({ prefix = 'BANK-SYNTHETIC', sameId = false, amount = 10, type = '消费', account = '6222000000001234' } = {}) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['交易日期', '交易金额', '收支', '交易类型', '卡号', '流水号', '摘要'],
    ['2026-09-02', String(amount), '支出', type, account, prefix + '-1', '合成商品甲'],
    ['2026-09-02', String(amount), '支出', type, account, prefix + (sameId ? '-1' : '-2'), '合成商品乙']
  ]), '交易明细')
  return XLSX.write(book, { type: 'buffer', bookType: 'biff8' })
}

test('银行 XLS 经原有最小权限和隔离 MySQL 完成解析、去重、整理与原子入账', { skip: !process.env.CATLEDGER_TEST_DB_HOST, timeout: 120000 }, async t => {
  const lab = await isolatedMysql(), logs = []
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const subject = 'synthetic-bank-import'
    const services = localServices({ apiPool, importPool, subject, logger: { error: value => logs.push(value), warn: value => logs.push(value) } })
    const api = (action, data) => call(services.api, action, data), imp = (action, data) => call(services.import, action, data)
    const user = await api('bootstrap')
    const account = (await api('accounts.create', { requestId: randomUUID(), type: 'bank', name: '合成银行账户',
      openingDisplayBalanceMinor: '100000', occurredLocalAt: '2026-09-01T00:00:00', timezoneOffsetMinutes: -480 })).accountId
    const other = localServices({ apiPool, importPool, subject: 'synthetic-bank-other' }); await call(other.api, 'bootstrap')
    async function prepare(content, name = '合成银行.xls') {
      const result = await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: name, size: content.length }] })
      const file = result.files[0]; services.objects.set(file.cloudPath, content)
      return { file, input: { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 } }
    }
    async function inspect(prepared) {
      const result = await imp('imports.parseFile', { requestId: randomUUID(), ...prepared.input })
      assert.equal(result.mappingRequired, true)
      const p = result.bankPreview
      return { ...p.suggested, schemaVersion: 1, sheetIndex: p.sheetIndex, headerRow: p.headerRow, headerToken: p.headerToken }
    }
    async function parsed(content) {
      const prepared = await prepare(content), bankMapping = await inspect(prepared)
      return imp('imports.parseFile', { requestId: randomUUID(), ...prepared.input, bankMapping })
    }
    async function mapAccounts(update) {
      const issues = await imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })
      const decisions = issues.items.filter(row => row.status === 'open').map(row => ({ issueId: row.issueId, issueVersion: row.version,
        operation: 'resolve', decision: 'apply_fields', fields: { mappingAccountId: account } }))
      return decisions.length ? imp('reviewIssues.resolveAccountMappings', { requestId: randomUUID(), updateId: update.updateId,
        updateVersion: update.appliedVersion, decisions }) : update
    }
    let postedContent, parsedBank, postedUpdate
    await t.test('待确认不建交易/批次，上传仍可恢复；另一用户不能读取或套用列映射', async () => {
      postedContent = bankFile()
      const prepared = await prepare(postedContent), mapping = await inspect(prepared)
      const file = await imp('imports.getFile', { importId: prepared.file.importId })
      assert.equal(file.import.errorCode, 'BANK_MAPPING_REQUIRED')
      const [[counts]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_batches WHERE uid=? AND import_id=?', [user.uid, prepared.file.importId])
      assert.equal(Number(counts.n), 0)
      await assert.rejects(call(other.import, 'imports.parseFile', { requestId: randomUUID(), ...prepared.input, bankMapping: mapping }), { publicCode: 'NOT_FOUND' })
      const resumed = { requestId: randomUUID(), importId: prepared.file.importId, timezoneOffsetMinutes: -480, bankMapping: mapping }
      const concurrent = await Promise.all([imp('imports.parseFile', resumed), imp('imports.parseFile', resumed)])
      assert.equal(concurrent[0].batch.batchId, concurrent[1].batch.batchId)
      parsedBank = concurrent[0]
      assert.deepEqual(parsedBank.batch.summary, { total: 2, valid: 2, invalid: 0, pending: 2, posted: 0 })
      const [[receipt]] = await lab.owner.execute("SELECT COUNT(*) AS n FROM catledger_mutation_receipts WHERE uid=? AND result_json LIKE '%合成商品%'", [user.uid])
      assert.equal(Number(receipt.n), 0)
    })
    await t.test('银行和微信成功文件混合整理；坏文件不改变成功批次', async () => {
      const bad = await prepare(Buffer.from('bad synthetic xls'))
      const failed = await imp('imports.parseFile', { requestId: randomUUID(), ...bad.input })
      assert.equal(failed.import.state, 'failed')
      const wxFile = await prepare(syntheticBill(1, 'SYNTHETIC-BANK-MIXED'), '合成微信.csv')
      const wxParsed = await imp('imports.parseFile', { requestId: randomUUID(), ...wxFile.input })
      let update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [parsedBank.batch.batchId, wxParsed.batch.batchId] })
      update = await mapAccounts(update)
      const events = await imp('economicEvents.list', { updateId: update.updateId })
      assert.equal(events.items.length, 3)
      assert.equal(events.items.filter(event => event.primaryEvidence.sourceType === 'bank').length, 2)
      postedUpdate = await imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion })
      const rows = await api('transactions.list', { importUpdateId: update.updateId })
      assert.equal(rows.transactions.length, 3)
      const balance = (await api('accounts.list')).accounts.find(row => row.accountId === account).bookBalanceMinor
      assert.equal(balance, '97900')
    })
    await t.test('同文件再导不重记；同账号同流水不因新文件重记；冲突金额留待人工核对', async () => {
      const duplicate = await parsed(postedContent)
      assert.equal(duplicate.duplicateImportId, parsedBank.import.importId)
      const sameSource = await parsed(bankFile({ sameId: true }))
      let update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [sameSource.batch.batchId] })
      const events = await imp('economicEvents.list', { updateId: update.updateId })
      assert.ok(events.items.every(event => event.status === 'excluded'))
      const conflict = await parsed(bankFile({ amount: 12 }))
      update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [conflict.batch.batchId] })
      const issues = await imp('reviewIssues.list', { updateId: update.updateId })
      assert.ok(issues.items.some(issue => issue.issueType === 'identity_conflict' && issue.primaryReasonCode === 'identity_conflict'))
      await assert.rejects(imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion }), { publicCode: 'UNRESOLVED_IMPORT' })
    })
    await t.test('解析持久化故障全部回滚，原上传可重试且不重复插行', async () => {
      const prepared = await prepare(bankFile({ prefix: 'BANK-ROLLBACK' })), bankMapping = await inspect(prepared)
      const faulty = createImportService({ storage: { async downloadExact(_, key) { return services.objects.get(key) }, async remove() { return true } },
        getPool: () => ({ async getConnection() {
          const connection = await importPool.getConnection(), execute = connection.execute.bind(connection)
          connection.execute = async (sql, bindings) => {
            if (/INSERT INTO catledger_import_rows/u.test(sql)) throw new Error('synthetic rollback fault')
            return execute(sql, bindings)
          }
          const release = connection.release.bind(connection)
          connection.release = () => { connection.execute = execute; connection.release = release; release() }
          return connection
        } }) })
      const data = { requestId: randomUUID(), ...prepared.input, bankMapping }
      await assert.rejects(faulty.parseFile({ provider: 'wechat-mini', subjectHash: hashWechatSubject(subject), data }), /synthetic rollback fault/)
      const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_batches WHERE uid=? AND import_id=?', [user.uid, prepared.file.importId])
      assert.equal(Number(count.n), 0)
      const retried = await imp('imports.parseFile', data)
      assert.equal(retried.batch.summary.total, 2)
    })
    await t.test('无交易类型的银行资金款项保留性质核对；原始账单不进入诊断日志', async () => {
      const source = await parsed(bankFile({ prefix: 'BANK-UNKNOWN', type: '不明确的合成业务', account: '' }))
      const update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [source.batch.batchId] })
      await assert.rejects(imp('financeUpdates.post', { requestId: randomUUID(), updateId: update.updateId, version: update.appliedVersion }), { publicCode: 'UNRESOLVED_IMPORT' })
      assert.doesNotMatch(JSON.stringify(logs), /6222000000001234|BANK-SYNTHETIC|合成商品|bankPreview|bindings|password/)
      assert.equal(postedUpdate.status, 'posted')
    })
    await t.test('不同银行账户同流水号和不同平台碰巧同号不自动合并', async () => {
      const first = await parsed(bankFile({ prefix: 'SYNTHETIC-NAMESPACE', account: '6222000000001111', amount: 1 }))
      const second = await parsed(bankFile({ prefix: 'SYNTHETIC-NAMESPACE', account: '6333000000001111', amount: 1 }))
      const wxFile = await prepare(syntheticBill(2, 'SYNTHETIC-NAMESPACE'), '合成同号微信.csv')
      const wxParsed = await imp('imports.parseFile', { requestId: randomUUID(), ...wxFile.input })
      const update = await imp('financeUpdates.prepare', { requestId: randomUUID(), batchIds: [first.batch.batchId, second.batch.batchId, wxParsed.batch.batchId] })
      const events = await imp('economicEvents.list', { updateId: update.updateId })
      assert.equal(events.items.length, 6)
      const accounts = await imp('reviewIssues.list', { updateId: update.updateId, group: 'accounts' })
      assert.equal(accounts.items.filter(issue => issue.accountContext && issue.accountContext.sourceType === 'bank').length, 2)
    })
    await t.test('人民币和无法识别的外币混在一个文件时整文件保持待修正，不静默丢行', async () => {
      const prepared = await prepare(Buffer.from('交易日期,交易金额,收支,币种\n2026-09-02,10,支出,CNY\n2026-09-02,20,支出,USD'), '合成混合币种.csv')
      const bankMapping = await inspect(prepared)
      const result = await imp('imports.parseFile', { requestId: randomUUID(), ...prepared.input, bankMapping })
      assert.equal(result.import.state, 'failed')
      assert.equal(result.import.errorCode, 'BANK_ROWS_INVALID')
      const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_batches WHERE uid=? AND import_id=?', [user.uid, prepared.file.importId])
      assert.equal(Number(count.n), 0)
    })
    await t.test('双语信用卡表格读取完整，记录数不符时不创建批次', async () => {
      const rows = [
        ['合成信用卡账单'],
        ['交易日期', '记账日期', '交易金额', '交易摘要', '尾号4位'],
        ['Trans Date', 'Post Date', 'Amount', 'Tran Description', 'Card No.'],
        ['20260902 08:35', '20260903', '¥-100.00', '合成还款', '合成1234'],
        ['20260904 19:20', '20260905', '¥12.34', '合成消费', '合成1234'],
        ['共计2条记录'], ['说明：此表只用于合成验证。']
      ]
      async function prepareMonthly(count) {
        const book = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows.map((row, i) => i === 5 ? ['共计' + count + '条记录'] : row)), '合成明细')
        return prepare(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }))
      }
      const prepared = await prepareMonthly(2)
      const bankMapping = { ...await inspect(prepared), positiveDirection: 'expense' }
      const result = await imp('imports.parseFile', { requestId: randomUUID(), ...prepared.input, bankMapping })
      assert.equal(result.batch.summary.total, 2)
      assert.equal(result.batch.summary.invalid, 0)
      const bad = await prepareMonthly(3)
      const badMapping = { ...await inspect(bad), positiveDirection: 'expense' }
      const failed = await imp('imports.parseFile', { requestId: randomUUID(), ...bad.input, bankMapping: badMapping })
      assert.equal(failed.import.errorCode, 'BANK_ROWS_INVALID')
      const [[count]] = await lab.owner.execute('SELECT COUNT(*) AS n FROM catledger_import_batches WHERE uid=? AND import_id=?', [user.uid, bad.file.importId])
      assert.equal(Number(count.n), 0)
    })
  } finally { await lab.close() }
})
