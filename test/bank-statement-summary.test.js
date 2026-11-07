const test = require('node:test')
const assert = require('node:assert/strict')

const { statementSummary } = require('../cloudfunctions/catledger-import/src/parsers/bank-statement')
const { installmentEvidence } = require('../cloudfunctions/catledger-import/src/profiles/bank-installment')

// 合成夹具：模拟信用卡账单表头区文本（兴业 6106 口径），绝不包含真实交易或账户数据。
const SYNTHETIC_HEADER = [
  '兴业银行信用卡账单',
  '账单日=20260813',
  '到期还款日=20260902',
  '账单周期=20260714-20260813',
  '本期应还款总额=¥8137.39',
  '本期最低还款额=¥7016.04'
].join('\n')

test('信用卡表头区解析出本期应还/最低还款/到期日/账单周期', function () {
  const summary = statementSummary(SYNTHETIC_HEADER)
  assert.deepEqual(summary, {
    statementDueMinor: '8137.39',
    statementMinimumMinor: '7016.04',
    statementDueDate: '2026-09-02',
    statementCycle: '20260714-20260813'
  })
})

test('金额带千分位、括号、人民币符号均可解析', function () {
  const summary = statementSummary('本期应还款总额：￥12,345.60\n最低还款额：1,234.50')
  assert.equal(summary.statementDueMinor, '12345.60')
  assert.equal(summary.statementMinimumMinor, '1234.50')
})

test('缺少账单信息时返回 null', function () {
  assert.equal(statementSummary('招商银行储蓄卡流水'), null)
  assert.equal(statementSummary(''), null)
})

test('分期期次「第n期共N期」解析出当前期次与总期数', function () {
  const ev = installmentEvidence({
    bankStatementKind: 'credit', direction: 'expense',
    transactionType: '', item: '电销现分按月收12期第8期共12期', note: ''
  })
  assert.ok(ev)
  assert.equal(ev.periodNumber, 8)
  assert.equal(ev.totalTerms, 12)
  assert.equal(ev.component, 'principal')
})

test('分期利息行「分期付款利息第12期共12期」归为利息分项', function () {
  const ev = installmentEvidence({
    bankStatementKind: 'credit', direction: 'expense',
    transactionType: '', item: '分期付款利息第12期共12期', note: ''
  })
  assert.ok(ev)
  assert.equal(ev.periodNumber, 12)
  assert.equal(ev.component, 'interest')
})

// 端到端：信用卡账单经 parseBank 后，汇总数进入 metadata.statement 并写入 statementAnalysis（不含交易明细）。
test('信用卡账单 parseBank 产出账单汇总并进入 statementAnalysis', function () {
  const { parseBank } = require('../cloudfunctions/catledger-import/src/parsers/bank')
  const { statementAnalysis } = require('../cloudfunctions/catledger-import/src/statement-analysis')
  const records = [
    { values: ['兴业银行信用卡账单', '', '', '', ''], sourceLocator: 'L1' },
    { values: ['本期应还款总额=8137.39 本期最低还款额=7016.04 到期还款日=20260902 账单周期=20260714-20260813', '', '', '', ''], sourceLocator: 'L2' },
    { values: ['交易日期', '交易金额', '借贷', '摘要', '交易类型'], sourceLocator: 'L3' },
    { values: ['2026-08-01', '-100.00', '借', '合成消费', '消费'], sourceLocator: 'L4' }
  ]
  const sheets = [{ name: '账单', date1904: false, records }]
  const content = Buffer.from('synthetic-credit-statement')
  const preview = parseBank(sheets, { content, extension: 'xlsx', timezoneOffsetMinutes: -480, bankMapping: null })
  const mapping = { schemaVersion: 1, sheetIndex: 0, headerRow: 3, headerToken: preview.bankPreview.headerToken,
    columns: { transactionTime: 0, amount: 1, direction: 2, item: 3, transactionType: 4 },
    amountMode: 'signed', positiveDirection: 'income', debitDirection: 'expense', currency: 'CNY', statementKind: 'credit' }
  const doc = parseBank(sheets, { content, extension: 'xlsx', timezoneOffsetMinutes: -480, bankMapping: mapping })
  assert.equal(doc.metadata.statement.statementDueMinor, '8137.39')
  assert.equal(doc.metadata.statement.statementMinimumMinor, '7016.04')
  const analysis = statementAnalysis(doc)
  assert.deepEqual(analysis.statement, doc.metadata.statement)
  // 分析快照不包含原始交易明细
  assert.equal(JSON.stringify(analysis).includes('合成消费'), false)
})

// 真实账单布局：账务信息是「表头行 + 值行」的表格，而不是「标签=值」文本。
// 用合成二维数组复现该布局（不提交真实账单）。
test('表头行+值行布局的账务信息也能解析（兴业 6106 口径）', function () {
  const { statementSummary } = require('../cloudfunctions/catledger-import/src/parsers/bank-statement')
  const headerRows = [
    ['兴业银行信用卡历史账单交易流水', '', '', '', '', ''],
    ['(20260801-20260831)', '', '', '', '', ''],
    ['账务信息', '', '', '', '', ''],
    ['账单日', '到期还款日', '账单周期', '本期应还款总额', '本期最低还款额', ''],
    ['Statement Date', 'Payment Due Date', 'Statement Cycle', 'New balance', 'Minimum Payment', ''],
    ['20260813', '20260902', '20260714-20260813', '¥8137.39', '¥7016.04', ''],
    ['交易明细', '', '', '', '', '']
  ]
  const summary = statementSummary(headerRows)
  assert.deepEqual(summary, {
    statementDueMinor: '8137.39',
    statementMinimumMinor: '7016.04',
    statementDueDate: '2026-09-02',
    statementCycle: '20260714-20260813'
  })
})
