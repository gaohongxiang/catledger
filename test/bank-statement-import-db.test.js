const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const XLSX = require('../cloudfunctions/catledger-import/node_modules/xlsx')
const { isolatedMysql } = require('../scripts/isolated-mysql')
const grants = require('../scripts/runtime-role-grants')
const { localServices, call } = require('./helpers/local-services')
const hasDatabase = ['HOST', 'USER', 'PASSWORD', 'NAME'].every(key => process.env['CATLEDGER_TEST_DB_' + key])

// 合成信用卡账单：表头区带「账务信息」横向表格（本期应还/最低/到期日/周期），下方交易明细。
// 不含任何真实账单数据，纯合成。
function creditFile({ due = '¥8137.39', minimum = '¥7016.04' } = {}) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['合成银行信用卡账单', '', '', '', ''],
    ['账务信息', '', '', '', ''],
    ['账单日', '到期还款日', '账单周期', '本期应还款总额', '本期最低还款额'],
    ['20260813', '20260902', '20260714-20260813', due, minimum],
    ['交易明细', '', '', '', ''],
    ['交易日期', '交易金额', '收支', '摘要', '卡号'],
    ['2026-08-31', '-1737.39', '收入', '合成还款', '6106'],
    ['2026-08-30', '63.04', '支出', '合成消费', '6106']
  ]), '账单')
  return XLSX.write(book, { type: 'buffer', bookType: 'biff8' })
}

test('信用卡账单：预览自动识别汇总数；确认页填的汇总数覆盖并存入 analysis_json', { skip: !hasDatabase, timeout: 60000 }, async t => {
  const lab = await isolatedMysql()
  try {
    const apiPool = await lab.role('api', grants.api), importPool = await lab.role('import', grants.importer)
    const services = localServices({ apiPool, importPool, subject: 'synthetic-statement-import' })
    const imp = (action, data) => call(services.import, action, data)
    await call(services.api, 'bootstrap')
    const content = creditFile()
    const prepared = await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成信用卡.xls', size: content.length }] })
    const file = prepared.files[0]; services.objects.set(file.cloudPath, content)
    const input = { importId: file.importId, fileID: 'cloud://synthetic.bucket/' + file.cloudPath, timezoneOffsetMinutes: -480 }

    let preview
    await t.test('预览阶段识别出账单汇总（未确认列映射时）', async () => {
      const result = await imp('imports.parseFile', { requestId: randomUUID(), ...input })
      assert.equal(result.mappingRequired, true)
      preview = result.bankPreview
      assert.equal(preview.suggested.statementKind, 'credit')
      assert.equal(preview.statement.statementDueMinor, '8137.39')
      assert.equal(preview.statement.statementMinimumMinor, '7016.04')
      assert.equal(preview.statement.statementDueDate, '2026-09-02')
      assert.equal(preview.statement.statementCycle, '20260714-20260813')
    })

    const mappingFor = () => ({ schemaVersion: 1, sheetIndex: preview.sheetIndex, headerRow: preview.headerRow, headerToken: preview.headerToken,
      columns: { transactionTime: 0, amount: 1, direction: 2, item: 3, paymentMethod: 4 },
      amountMode: 'signed', positiveDirection: 'expense', debitDirection: '', currency: 'CNY', statementKind: 'credit' })

    const readStatement = async () => {
      const [[row]] = await lab.owner.execute(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(analysis_json,'$.statement.statementDueMinor')) AS due, JSON_UNQUOTE(JSON_EXTRACT(analysis_json,'$.statement.statementMinimumMinor')) AS minimum FROM catledger_import_batches WHERE uid=(SELECT uid FROM catledger_import_files WHERE import_id=?)",
        [file.importId])
      return row
    }

    await t.test('传用户填的汇总数 → 覆盖自动识别值写入 analysis_json', async () => {
      const result = await imp('imports.parseFile', { requestId: randomUUID(), ...input, bankMapping: mappingFor(),
        statement: { statementDueMinor: '9000.00', statementMinimumMinor: '8000.00' } })
      assert.ok(result)
      const row = await readStatement()
      assert.equal(row.due, '900000')
      assert.equal(row.minimum, '800000')
    })

    await t.test('非法汇总数被拒绝（全新文件首次解析）', async () => {
      const content2 = creditFile()
      const prepared2 = await imp('imports.prepareMany', { requestId: randomUUID(), files: [{ fileName: '合成信用卡2.xls', size: content2.length }] })
      const file2 = prepared2.files[0]; services.objects.set(file2.cloudPath, content2)
      const input2 = { importId: file2.importId, fileID: 'cloud://synthetic.bucket/' + file2.cloudPath, timezoneOffsetMinutes: -480 }
      const preview2 = (await imp('imports.parseFile', { requestId: randomUUID(), ...input2 })).bankPreview
      const mapping2 = { schemaVersion: 1, sheetIndex: preview2.sheetIndex, headerRow: preview2.headerRow, headerToken: preview2.headerToken,
        columns: { transactionTime: 0, amount: 1, direction: 2, item: 3, paymentMethod: 4 },
        amountMode: 'signed', positiveDirection: 'expense', debitDirection: '', currency: 'CNY', statementKind: 'credit' }
      await assert.rejects(imp('imports.parseFile', { requestId: randomUUID(), ...input2, bankMapping: mapping2,
        statement: { statementDueDate: '2026-13-40' } }), { publicCode: 'VALIDATION_ERROR' })
    })
  } finally {
    await lab.close()
  }
})
