const assert = require('node:assert/strict')
const test = require('node:test')
const XLSX = require('xlsx')
const iconv = require('iconv-lite')
const { parseEvidenceFile } = require('../src/parsers')
const { buildRowIdentity } = require('../src/identity')
const { bankTime, signedAmount } = require('../src/parsers/bank')
const { parseLocalDateTime } = require('../src/parsers/normalize')

function spreadsheet(rows, extension, options = {}) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '合成明细')
  if (options.date1904) book.Workbook = { WBProps: { date1904: true } }
  if (options.mutate) options.mutate(book)
  return XLSX.write(book, { type: 'buffer', bookType: extension === 'xls' ? 'biff8' : 'xlsx' })
}
const header = ['交易日期', '交易金额', '收支', '交易类型', '卡号', '流水号', '摘要']
const record = ['2026/9/2', '12.34', '支出', '消费', '6222000000001234', 'SYNTHETIC-1', '合成商品']
async function parse(rows, extension = 'csv', overrides = {}, options = {}) {
  const content = extension === 'csv' ? Buffer.from(rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n')) : spreadsheet(rows, extension, options)
  const input = { content, extension, timezoneOffsetMinutes: -480 }
  const inspected = await parseEvidenceFile(input)
  assert.equal(inspected.mappingRequired, true)
  const preview = inspected.bankPreview
  const bankMapping = { ...preview.suggested, schemaVersion: 1, sheetIndex: preview.sheetIndex,
    headerRow: preview.headerRow, headerToken: preview.headerToken, ...overrides }
  return { document: await parseEvidenceFile({ ...input, bankMapping }), input, preview, bankMapping }
}
const identity = (row, fileSha256 = 'a'.repeat(64)) => buildRowIdentity({ sourceType: 'bank', sourceProfileKey: 'unbound', fileSha256, row })

for (const extension of ['csv', 'xls', 'xlsx']) {
  test(`银行 ${extension} 保留原始字段、实际行、时区和独立同额交易`, async () => {
    const { document } = await parse([['合成银行账户明细'], header, record, [...record.slice(0, 5), 'SYNTHETIC-2', '独立商品']], extension)
    assert.equal(document.descriptor.sourceFormat, 'bank_' + extension)
    assert.equal(document.rows.length, 2)
    const row = document.rows[0]
    assert.equal(row.raw.transactionTime, '2026/9/2')
    assert.equal(row.rawFields.find(field => field.name === '卡号').value, record[4])
    assert.equal(row.normalized.utcAt, '2026-09-01 16:00:00.000')
    assert.equal(row.normalized.amountMinor, '1234')
    assert.equal(row.normalized.direction, 'expense')
    assert.equal(row.parseState, 'valid')
    assert.equal(row.eligibility, 'postable')
    assert.match(row.sourceLocator, extension === 'csv' ? /^CSV:3-3$/ : /:3$/)
    assert.notEqual(identity(row).identityKey, identity(document.rows[1]).identityKey)
    assert.equal(identity(row).identityKey, identity(row, 'b'.repeat(64)).identityKey)
  })
}

test('同尾号的不同完整账户不共享流水身份和账户归属；无完整账号只用物理证据', async () => {
  const { document } = await parse([header, record, [...record.slice(0, 4), '6333000000001234', ...record.slice(5)], [...record.slice(0, 4), '****1234', ...record.slice(5)]])
  const [a, b, masked] = document.rows
  assert.notEqual(identity(a).identityKey, identity(b).identityKey)
  assert.notEqual(a.bankPaymentKey, b.bankPaymentKey)
  assert.notEqual(a.semantic.ledgerAccountRef.accountIdentityKey, b.semantic.ledgerAccountRef.accountIdentityKey)
  assert.equal(identity(masked).kind, 'physical_record')
  assert.notEqual(identity(masked).identityKey, identity(masked, 'b'.repeat(64)).identityKey)
})

test('Excel 超过 15 位的数值账号或流水号不作为稳定来源身份', async () => {
  const { document } = await parse([header, [...record.slice(0, 4), 6222000000001234, ...record.slice(5)]], 'xls')
  assert.equal(identity(document.rows[0]).kind, 'physical_record')
})

test('有符号信用卡金额必须明确正数含义，负数与括号金额反向', async () => {
  const rows = [['交易日期', '交易金额', '摘要'], ['20260902', '100.00', '合成消费'], ['20260902103000', '-20.00', '合成还款'], ['2026.9.2', '(8.00)', '合成退款']]
  const { document, input, bankMapping } = await parse(rows, 'csv', { positiveDirection: 'expense' })
  assert.deepEqual(document.rows.map(row => row.normalized.direction), ['expense', 'income', 'income'])
  assert.deepEqual(document.rows.map(row => row.normalized.amountMinor), ['10000', '2000', '800'])
  assert.equal(document.rows[1].raw.amount, '-20.00')
  assert.equal(document.rows[0].eligibility, 'review_required')
  await assert.rejects(parseEvidenceFile({ ...input, bankMapping: { ...bankMapping, positiveDirection: '' } }), { publicCode: 'VALIDATION_ERROR' })
})

test('收入支出分列、借贷确认、零值和冲突不推算为另一种交易', async () => {
  const { document } = await parse([['交易日期', '收入金额', '支出金额'], ['2026-09-02', '12.34', '0'], ['2026-09-02', '', '8.50'], ['2026-09-02', '1', '1'], ['2026-09-02', '0', '0'], ['2026-09-02', '-3', '']])
  assert.deepEqual(document.rows.slice(0, 2).map(row => [row.normalized.direction, row.normalized.amountMinor]), [['income', '1234'], ['expense', '850']])
  assert.ok(document.rows.slice(2).every(row => row.parseState === 'invalid'))
  const borrowed = [['交易日期', '交易金额', '借贷标志'], ['2026-09-02', '10', 'DR'], ['2026-09-02', '20', 'CR']]
  const asset = await parse(borrowed, 'csv', { debitDirection: 'expense' })
  const credit = await parse(borrowed, 'csv', { debitDirection: 'income' })
  assert.deepEqual(asset.document.rows.map(row => row.normalized.direction), ['expense', 'income'])
  assert.deepEqual(credit.document.rows.map(row => row.normalized.direction), ['income', 'expense'])
  const ambiguous = await parse(borrowed)
  assert.ok(ambiguous.document.rows.every(row => row.parseState === 'invalid'))
})

test('表头令牌绑定文件和工作表，重复列、越界、未知参数被拒绝', async () => {
  const { input, bankMapping } = await parse([header, record])
  for (const bad of [
    { headerToken: '0'.repeat(64) }, { sheetIndex: 8 }, { headerRow: 121 }, { schemaVersion: 2 },
    { columns: { transactionTime: 0, amount: 0, direction: 2 } }, { columns: { ...bankMapping.columns, note: 64 } }, { currency: 'USD' }, { extra: true }
  ]) await assert.rejects(parseEvidenceFile({ ...input, bankMapping: { ...bankMapping, ...bad } }), { publicCode: 'VALIDATION_ERROR' })
})

test('GB18030 CSV、HTML XLS、实际空行和工作表选择', async () => {
  const csv = iconv.encode([header.join(','), record.join(',')].join('\n'), 'gb18030')
  assert.equal((await parseEvidenceFile({ content: csv, extension: 'csv', timezoneOffsetMinutes: -480 })).mappingRequired, true)
  const html = '<html><table>' + [header, record].map(row => '<tr>' + row.map(value => '<td>' + value + '</td>').join('') + '</tr>').join('') + '</table></html>'
  assert.equal((await parseEvidenceFile({ content: Buffer.from(html), extension: 'xls', timezoneOffsetMinutes: -480 })).mappingRequired, true)
  const { document, input, preview } = await parse([[], [], header, record], 'xlsx', {}, { mutate(book) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, record]), '另一明细')
  } })
  assert.equal(preview.headerRow, 3)
  assert.match(document.rows[0].sourceLocator, /:4$/)
  const second = await parseEvidenceFile({ ...input, bankPreview: { sheetIndex: 1 } })
  assert.equal(second.bankPreview.sheetIndex, 1)
  assert.equal(second.bankPreview.headerRow, 1)
})

test('日期系统、时间列、金额精度、非法日期都受到校验', async () => {
  assert.equal(bankTime('20260923', '153000'), '2026-09-23 15:30:00')
  assert.equal(parseLocalDateTime(bankTime('2026-02-30', ''), -480), null)
  for (const value of ['1.001', 'NaN', '1e4', '92233720368547758.08', '--1', '-(1)']) assert.equal(signedAmount(value), null)
  const { document } = await parse([header, [44791, ...record.slice(1)]], 'xlsx', {}, { date1904: true })
  assert.equal(document.rows[0].normalized.localDate, '2026-08-19')
})

test('公式、外币和隐藏额外列阻断入账，控制行和重复表头保持守恒', async () => {
  const { document } = await parse([header, record, header, ['合计', '12.34'], ['2026-09-03', '12.34', '支出', '消费', '', '', '公式']], 'xlsx', {}, { mutate(book) {
    book.Sheets['合成明细'].B5 = { t: 'n', v: 12.34, f: '6.17*2' }
  } })
  assert.equal(document.rows.length, 2)
  assert.equal(document.records.controlFields.length, 1)
  assert.equal(document.rows[1].parseState, 'invalid')
  const foreign = await parse([['交易日期', '交易金额', '收支', '币种'], ['2026-09-02', '10', '支出', 'USD']])
  assert.equal(foreign.document.rows[0].parseState, 'invalid')
  assert.ok(foreign.document.rows[0].issues.some(issue => issue.code === 'bank_currency_unsupported'))
})

test('XLS 损坏、超行超列以及伪装的 ZIP/XML 实体不接受', async () => {
  const check = content => parseEvidenceFile({ content, extension: 'xls', timezoneOffsetMinutes: -480 })
  await assert.rejects(check(Buffer.from('not a workbook')), { publicCode: 'FILE_FORMAT_UNSUPPORTED' })
  await assert.rejects(check(Buffer.from('<?xml version="1.0"?><!DOCTYPE Workbook [<!ENTITY x SYSTEM "file:///x">]><Workbook/>')), { publicCode: 'FILE_FORMAT_UNSUPPORTED' })
  await assert.rejects(check(spreadsheet([header, record], 'xlsx')), { publicCode: 'FILE_ENCODING_INVALID' })
  await assert.rejects(check(spreadsheet([Array(65).fill('列'), Array(65).fill('1')], 'xls')), { publicCode: 'CSV_COLUMN_LIMIT_EXCEEDED' })
  await assert.rejects(check(spreadsheet([header, ...Array.from({ length: 5000 }, () => record)], 'xls')), { publicCode: 'CSV_RECORD_LIMIT_EXCEEDED' })
})

test('信用卡双语表头优先交易日期，支持紧凑日期加时分，尾部记录数与说明不混成交易', async () => {
  const rows = [
    ['合成信用卡人民币账单'],
    ['交易日期', '记账日期', '交易金额', '交易摘要', '尾号4位', ''],
    ['Trans Date', 'Post Date', 'Amount', 'Tran Description', 'Card No.', ''],
    ['20260902 08:35', '20260903', '¥-100.00', '合成还款', '合成1234', ''],
    ['20260904 19:20', '20260905', '¥12.34', '合成消费', '合成1234', ''],
    [], ['共计2条记录'], [], ['说明：仅用于合成验证。']
  ]
  const { document, preview } = await parse(rows, 'xls', { positiveDirection: 'expense' })
  assert.equal(preview.headerRow, 2)
  assert.deepEqual(preview.suggested.columns, { transactionTime: 0, amount: 2, item: 3, paymentMethod: 4 })
  assert.equal(document.rows.length, 2)
  assert.ok(document.rows.every(row => row.parseState === 'valid'))
  assert.equal(document.rows[0].raw.transactionTime, '20260902 08:35')
  assert.equal(document.rows[0].normalized.localAt, '2026-09-02 08:35:00.000')
  assert.equal(document.rows[0].normalized.amountMinor, '10000')
  assert.equal(document.rows[0].normalized.direction, 'income')
  assert.equal(document.rows[1].normalized.direction, 'expense')
  assert.equal(document.rows[1].normalized.item, '合成消费')
  assert.equal(document.rows[1].raw.paymentMethod, '合成1234')
  assert.deepEqual(document.controls, [{ kind: 'row_count', sourceLocator: 'XLS:1:合成明细:7', passed: true }])
  assert.equal(document.records.metadataRows.length, 2)
  assert.equal(document.records.decorativeRows.length, 4)
  assert.ok(document.rows.every(row => row.eligibility === 'review_required'))
})

test('银行记录数不匹配会阻断，含交易字段的说明行不会被当成页脚丢弃', async () => {
  const { document } = await parse([header, record, ['共计2条记录']])
  assert.equal(document.controls[0].passed, false)
  assert.ok(document.issues.some(issue => issue.code === 'statement_count_mismatch' && issue.severity === 'error'))
  const damaged = await parse([header, record, ['说明：损坏的日期', '3.00', '支出', '消费']])
  assert.equal(damaged.document.rows.length, 2)
  assert.equal(damaged.document.rows[1].parseState, 'invalid')
  assert.equal(bankTime('20260923 15:30'), '2026-09-23 15:30')
  assert.equal(bankTime('20260923T15:30:45'), '2026-09-23T15:30:45')
  assert.equal(parseLocalDateTime(bankTime('20260230 12:00'), -480), null)
})

module.exports = { spreadsheet }
