const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const yazl = require('yazl')

const { buildRowIdentity, buildSourceProfile } = require('../src/identity')
const { parseEvidenceFile } = require('../src/parsers')
const { readCsvRecords } = require('../src/parsers/csv')
const { normalizeRow, parseLocalDateTime } = require('../src/parsers/normalize')

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name))
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function columnName(index) {
  let result = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result
  }
  return result
}

function sheetXml(rows) {
  const body = rows.map((values, rowIndex) => {
    const cells = values.map((value, columnIndex) => (
      `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`
    )).join('')
    return `<row r="${rowIndex + 1}">${cells}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

function buildSyntheticXlsx(rows) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账单" sheetId="1" r:id="rId1"/></sheets></workbook>`), 'xl/workbook.xml')
    zip.addBuffer(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`), 'xl/_rels/workbook.xml.rels')
    zip.addBuffer(Buffer.from(sheetXml(rows)), 'xl/worksheets/sheet1.xml')
    const chunks = []
    zip.outputStream.on('data', (chunk) => chunks.push(chunk))
    zip.outputStream.once('error', reject)
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)))
    zip.end()
  })
}

test('微信 CSV 保留同额同日的两条独立物理证据', async () => {
  const document = await parseEvidenceFile({
    content: fixture('wechat-pay.csv'),
    extension: 'csv',
    timezoneOffsetMinutes: -480
  })
  assert.equal(document.descriptor.sourceType, 'wechat')
  assert.equal(document.descriptor.sourceFormat, 'wechat_csv')
  assert.equal(document.rows.length, 2)
  assert.equal(document.rows[0].normalized.amountMinor, '1234')
  assert.equal(document.rows[1].normalized.amountMinor, '1234')
  assert.equal(document.rows[0].eligibility, 'postable')
  assert.equal(document.metadata.statementStartLocal, '2026-08-01')

  const profile = buildSourceProfile({
    sourceType: 'wechat',
    candidate: document.metadata.sourceProfile
  })
  const first = buildRowIdentity({
    sourceType: 'wechat', sourceProfileKey: profile.profileKey,
    fileSha256: 'a'.repeat(64), row: document.rows[0]
  })
  const second = buildRowIdentity({
    sourceType: 'wechat', sourceProfileKey: profile.profileKey,
    fileSha256: 'a'.repeat(64), row: document.rows[1]
  })
  assert.notEqual(first.identityKey, second.identityKey)
  assert.equal(first.coreDigest, second.coreDigest)
})

test('支付宝 App 与网页 CSV 投影到相同候选结构', async () => {
  const app = await parseEvidenceFile({
    content: fixture('alipay-app.csv'), extension: 'csv', timezoneOffsetMinutes: -480
  })
  const web = await parseEvidenceFile({
    content: fixture('alipay-web.csv'), extension: 'csv', timezoneOffsetMinutes: -480
  })
  assert.equal(app.descriptor.sourceFormat, 'alipay_app_csv')
  assert.equal(web.descriptor.sourceFormat, 'alipay_web_csv')
  assert.equal(app.rows[0].normalized.direction, 'expense')
  assert.equal(web.rows[0].normalized.direction, 'expense')
  assert.equal(app.rows[0].normalized.paymentMethod, '支付宝账户余额')
  assert.equal(app.descriptor.normalizationVersion, 'alipay-normalization-v7')
  assert.equal(app.rows[0].identifiers.transactionId, 'ALI-APP-001')
  assert.equal(web.rows[0].identifiers.transactionId, 'ALI-WEB-001')
})

test('余额宝收益发放归为收入而不是内部转账', function () {
  const row = normalizeRow('alipay', {
    transactionTime: '2026-07-02 08:00:00',
    amount: '1.23',
    direction: '收入',
    transactionType: '不计收支',
    counterparty: '天弘基金管理有限公司',
    item: '余额宝-2026.07.02-收益发放',
    paymentMethod: '余额宝',
    status: '交易成功',
    note: ''
  }, -480)
  assert.equal(row.normalized.transactionType, 'payment')
  assert.equal(row.eligibility, 'postable')
})

test('普通商品文案包含提现或充值时仍按消费分类', function () {
  const withdrawalCopy = normalizeRow('alipay', {
    transactionTime: '2026-07-02 08:00:00', amount: '12.00', direction: '支出',
    transactionType: '购物', counterparty: '合成商店', item: '商家提现优惠券',
    paymentMethod: '余额', status: '交易成功', note: ''
  }, -480)
  const topUpCopy = normalizeRow('alipay', {
    transactionTime: '2026-07-02 09:00:00', amount: '30.00', direction: '支出',
    transactionType: '购物', counterparty: '合成商店', item: '话费充值活动',
    paymentMethod: '余额', status: '交易成功', note: ''
  }, -480)
  assert.equal(withdrawalCopy.normalized.transactionType, 'payment')
  assert.equal(topUpCopy.normalized.transactionType, 'payment')
})

test('普通商品文案包含余额宝、转入或还款时不升级为资金动作', function () {
  for (const item of ['余额宝周边礼品', '余额宝-提现活动', '转入会员活动', '还款-优惠券']) {
    const parsed = normalizeRow('alipay', {
      transactionTime: '2026-07-02 08:00:00', amount: '12.00', direction: '支出',
      transactionType: '购物', counterparty: '合成商店', item,
      paymentMethod: '余额', status: '交易成功', note: ''
    }, -480)
    assert.equal(parsed.normalized.transactionType, 'payment', item)
  }
})

test('支付宝官方账户存取仍识别提现和充值', function () {
  const withdrawal = normalizeRow('alipay', {
    transactionTime: '2026-07-02 08:00:00', amount: '12.00', direction: '不计收支',
    transactionType: '账户存取', counterparty: '合成银行', item: '提现-实时提现',
    paymentMethod: '余额', status: '交易成功', note: ''
  }, -480)
  const topUp = normalizeRow('alipay', {
    transactionTime: '2026-07-02 09:00:00', amount: '30.00', direction: '不计收支',
    transactionType: '账户存取', counterparty: '支付宝', item: '充值-快捷充值',
    paymentMethod: '合成银行储蓄卡(5564)', status: '交易成功', note: ''
  }, -480)
  assert.equal(withdrawal.normalized.transactionType, 'withdrawal')
  assert.equal(topUp.normalized.transactionType, 'top_up')
})

test('微信 XLSX 使用受限 OOXML 读取器而不是通用 Excel 执行引擎', async () => {
  const xlsx = await buildSyntheticXlsx([
    ['微信支付账单明细'],
    ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '微信交易单号'],
    ['2026-08-15 10:20:30', '商户消费', '合成商户', '日用品', '支出', '8.50', '零钱', '支付成功', 'WX-XLSX-001']
  ])
  const document = await parseEvidenceFile({
    content: xlsx, extension: 'xlsx', timezoneOffsetMinutes: -480
  })
  assert.equal(document.descriptor.sourceFormat, 'wechat_xlsx')
  assert.equal(document.rows.length, 1)
  assert.equal(document.rows[0].sourceLocator, 'XLSX:1:账单:3')
  assert.equal(document.rows[0].normalized.amountMinor, '850')
})

test('微信 XLSX 的 Excel 数值日期转换为账单本地时间', function () {
  const parsed = parseLocalDateTime('46232.58625', -480)
  assert.deepEqual(parsed, {
    localDate: '2026-07-29',
    localAt: '2026-07-29 14:04:12.000',
    utcAt: '2026-07-29 06:04:12.000',
    timezoneOffsetMinutes: -480
  })
  assert.equal(parseLocalDateTime('60.5', -480), null)
})

test('不支持的正文不会只因 csv 扩展名被接受', async () => {
  await assert.rejects(
    parseEvidenceFile({ content: Buffer.from('name,value\nfoo,1'), extension: 'csv', timezoneOffsetMinutes: -480 }),
    { publicCode: 'FILE_FORMAT_UNSUPPORTED' }
  )
})

test('CSV 字节大小与记录、列结构限制使用不同错误码', () => {
  const supported = Array.from({ length: 241 }, function (_, rowIndex) {
    return Array.from({ length: 13 }, function (_, columnIndex) {
      return 'R' + rowIndex + 'C' + columnIndex
    }).join(',')
  }).join('\n')
  assert.equal(readCsvRecords(supported).length, 241)

  const tooManyRecords = Array.from({ length: 5001 }, function () { return 'value' }).join('\n')
  assert.throws(() => readCsvRecords(tooManyRecords), { publicCode: 'CSV_RECORD_LIMIT_EXCEEDED' })

  const tooManyColumns = Array.from({ length: 65 }, function () { return 'value' }).join(',')
  assert.throws(() => readCsvRecords(tooManyColumns), { publicCode: 'CSV_COLUMN_LIMIT_EXCEEDED' })
})

test('CSV 同时兼容 CRLF、LF 与 CR 混合换行', () => {
  const records = readCsvRecords('A,B\rC,D\nE,F\r\nG,H')
  assert.equal(records.length, 4)
  assert.deepEqual(records.map(function (record) { return record.values }), [
    ['A', 'B'],
    ['C', 'D'],
    ['E', 'F'],
    ['G', 'H']
  ])
})
