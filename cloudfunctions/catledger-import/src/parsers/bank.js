const { digestParts, sha256 } = require('../digest')
const { importError } = require('../errors')
const { observeField } = require('../field-observation')
const { bankProfile } = require('../profiles/bank')
const { normalizeRow, parseAmountMinor, parseLocalDateTime } = require('./normalize')

const ALIASES = Object.freeze({
  transactionTime: ['交易时间', '交易日期', '交易日', '记账日期', '入账日期', '日期', 'trans date', 'transaction date', 'transaction time', 'date'],
  time: ['交易时刻', '时间', 'trans time', 'time'],
  amount: ['交易金额', '金额', '发生额', '人民币金额', '记账金额', 'amount', 'transaction amount'],
  direction: ['收支', '收/支', '收支类型', '交易方向', '借贷标志', '借贷方向', '借贷', 'direction', 'debit/credit'],
  income: ['收入', '收入金额', '入账金额', '贷方发生额', '贷方金额', '贷方', 'credit amount', 'income'],
  expense: ['支出', '支出金额', '出账金额', '借方发生额', '借方金额', '借方', 'debit amount', 'expense'],
  currency: ['币种', '货币', 'currency'],
  transactionId: ['交易流水号', '流水号', '交易号', '交易序号', '凭证号', 'reference', 'reference number'],
  counterparty: ['交易对方', '对方户名', '对方名称', '收款人', '付款人', '商户名称', 'transaction description', 'description'],
  item: ['商品说明', '商品名称', '交易用途', '用途', '摘要', '交易摘要', '交易描述', 'tran description', 'memo'],
  paymentMethod: ['本方账号', '本方卡号', '账号', '账户', '卡号', '尾号4位', 'card no', 'card no.', 'card number', 'account number'],
  status: ['交易状态', '状态', 'status'],
  transactionType: ['交易类型', '交易分类', '类型', '业务名称', '业务类型', 'transaction type'],
  note: ['备注', '附言', 'note'],
  installmentReference: ['分期编号','分期计划编号','合同编号','installment id'],
  installmentPeriod: ['当前期数','当前期次','本期期号','分期期次','installment period'],
  installmentTerms: ['总期数','分期总期数','installment terms'],
  installmentComponent: ['分期分项','本息类型','installment component']
})
const FIELDS = Object.keys(ALIASES)
const clean = value => String(value == null ? '' : value).normalize('NFKC').trim()
const headerKey = value => clean(value).toLowerCase().replace(/\s/g, '').replace(/\((?:元|人民币|cny|rmb)\)$/u, '')
const opposite = direction => direction === 'income' ? 'expense' : 'income'
const recordNumber = (record, index) => record.rowNumber || record.logicalNumber || index + 1
const PRIMARY_DATE_HEADERS = ['交易时间', '交易日期', '交易日', 'trans date', 'transaction date', 'transaction time'].map(headerKey)
const BANK_RECORD_COUNT = /^(?:合计|总计|共计|共)\s*(\d+)\s*(?:条|笔)(?:记录|交易)?$/u

function inferColumns(values) {
  const columns = {}
  for (const [field, aliases] of Object.entries(ALIASES)) {
    let indexes = values.map((value, index) => aliases.some(alias => headerKey(alias) === headerKey(value)) ? index : -1).filter(index => index >= 0)
    if (field === 'transactionTime') {
      const primary = indexes.filter(index => PRIMARY_DATE_HEADERS.includes(headerKey(values[index])))
      if (primary.length) indexes = primary
    }
    if (indexes.length === 1) columns[field] = indexes[0]
  }
  return columns
}

function headerIndex(records) {
  let best = null
  records.slice(0, 120).forEach((record, index) => {
    if (recordNumber(record, index) > 120) return
    const columns = inferColumns(record.values)
    const score = Object.keys(columns).length + (columns.transactionTime == null ? 0 : 5) +
      (['amount', 'income', 'expense'].some(field => columns[field] != null) ? 5 : 0)
    if (record.values.filter(clean).length > 1 && (!best || score > best.score)) best = { index, score }
  })
  return best ? best.index : -1
}

function headerToken(contentHash, sheetIndex, record) {
  return digestParts('bank-header-v1', contentHash, sheetIndex, record.sourceLocator || record.logicalNumber, JSON.stringify(record.values))
}

function inspectBank(sheets, contentHash, requested = {}) {
  if (requested == null || typeof requested !== 'object' || Array.isArray(requested) ||
      Object.keys(requested).some(key => !['sheetIndex', 'headerRow'].includes(key))) throw importError('VALIDATION_ERROR')
  const candidates = sheets.map((sheet, index) => ({ index, header: headerIndex(sheet.records) })).filter(item => {
    if (item.header < 0) return false
    const records = sheets[item.index].records
    const columns = inferColumns(records[item.header].values)
    if (columns.transactionTime != null && ['amount', 'income', 'expense'].some(field => columns[field] != null)) return true
    return records.slice(item.header + 1, item.header + 21).some(record => record.values.some((value, column) =>
      /^(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|\d{8}(?:\d{6})?)$/u.test(clean(value).split(' ')[0]) &&
      record.values.some((amount, index) => index !== column && signedAmount(amount))))
  })
  if (!candidates.length) throw importError('FILE_FORMAT_UNSUPPORTED')
  const sheetIndex = requested.sheetIndex == null ? candidates[0].index : requested.sheetIndex
  if (!Number.isInteger(sheetIndex) || !sheets[sheetIndex]) throw importError('VALIDATION_ERROR')
  const sheet = sheets[sheetIndex]
  if (requested.headerRow != null && (!Number.isInteger(requested.headerRow) || requested.headerRow < 1 || requested.headerRow > 120)) throw importError('VALIDATION_ERROR')
  const index = requested.headerRow == null ? headerIndex(sheet.records)
    : sheet.records.findIndex((record, i) => recordNumber(record, i) === requested.headerRow)
  if (index < 0 || !sheet.records[index]) throw importError('VALIDATION_ERROR')
  const header = sheet.records[index]
  const columns = inferColumns(header.values)
  // Debit/credit columns are suggestions only: credit-card statements reverse
  // the apparent asset-account meaning. Every bank mapping is confirmed once.
  const amountMode = columns.income != null && columns.expense != null ? 'split' : columns.direction != null ? 'direction' : 'signed'
  const preview = {
    schemaVersion: 1, sheetIndex, headerRow: recordNumber(header, index), headerToken: headerToken(contentHash, sheetIndex, header),
    sheets: sheets.map((value, i) => ({ index: i, name: value.name.slice(0, 64) })),
    headers: header.values.map((value, i) => ({ index: i, name: clean(value).slice(0, 48) || `第 ${i + 1} 列` })),
    samples: sheet.records.slice(index + 1).filter(record => record.values.some(clean)).slice(0, 2)
      .map(record => record.values.map(value => clean(value).slice(0, 32))),
    suggested: { columns, amountMode, positiveDirection: '', debitDirection: '', currency: 'CNY',
      statementKind: /信用卡/.test(sheet.records.slice(0,index+1).map(record=>record.values.join(' ')).join(' ')) ? 'credit' : 'standard' }
  }
  return preview
}

function validateMapping(sheets, contentHash, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['schemaVersion', 'sheetIndex', 'headerRow', 'headerToken', 'columns', 'amountMode', 'positiveDirection', 'debitDirection', 'currency', 'statementKind'].includes(key)) ||
      input.schemaVersion !== 1 || input.currency !== 'CNY') throw importError('VALIDATION_ERROR')
  const preview = inspectBank(sheets, contentHash, { sheetIndex: input.sheetIndex, headerRow: input.headerRow })
  if (input.headerToken !== preview.headerToken || !input.columns || typeof input.columns !== 'object' || Array.isArray(input.columns)) {
    throw importError('VALIDATION_ERROR')
  }
  const columns = {}, used = new Set()
  if (input.statementKind != null && !['standard','credit'].includes(input.statementKind)) throw importError('VALIDATION_ERROR')
  for (const [field, index] of Object.entries(input.columns)) {
    if (!FIELDS.includes(field) || !Number.isInteger(index) || index < 0 || index >= preview.headers.length || used.has(index)) {
      throw importError('VALIDATION_ERROR')
    }
    columns[field] = index
    used.add(index)
  }
  const required = { split: ['income', 'expense'], direction: ['amount', 'direction'], signed: ['amount'] }[input.amountMode]
  if (!required || columns.transactionTime == null || required.some(field => columns[field] == null) ||
      input.amountMode === 'signed' && !['income', 'expense'].includes(input.positiveDirection) ||
      input.debitDirection && !['income', 'expense'].includes(input.debitDirection)) throw importError('VALIDATION_ERROR')
  const activeAmountFields = new Set(required)
  for (const field of ['income', 'expense', 'amount', 'direction']) if (!activeAmountFields.has(field)) delete columns[field]
  return { schemaVersion: 1, sheetIndex: input.sheetIndex, headerRow: input.headerRow, headerToken: input.headerToken,
    columns, amountMode: input.amountMode, positiveDirection: input.amountMode === 'signed' ? input.positiveDirection : '',
    debitDirection: input.amountMode === 'direction' ? input.debitDirection || '' : '', currency: 'CNY', statementKind:input.statementKind || 'standard' }
}

function signedAmount(value) {
  let text = clean(value).replace(/^(?:CNY|RMB|[¥￥])\s*/i, '').replace(/元$/, '').trim()
  let negative = false
  if (/^\(.*\)$/u.test(text)) { negative = true; text = text.slice(1, -1).trim() }
  else if (text.startsWith('-')) { negative = true; text = text.slice(1).trim() }
  const minor = parseAmountMinor(text)
  return minor == null ? null : { minor, negative, absolute: text }
}

function bankTime(date, time, date1904) {
  let text = clean(date).replace(/^'/, '')
  text = text.replace(/^(\d{4})(\d{2})(\d{2})(?=[ T]\d{2}:\d{2}(?::\d{2})?$)/u, '$1-$2-$3')
  if (/^\d{8}$/u.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  if (/^\d{14}$/u.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12)}`
  text = text.replace(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/u, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    let clock = clean(time)
    if (/^\d{6}$/u.test(clock)) clock = `${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4)}`
    text += ` ${clock || '00:00:00'}`
  } else if (date1904 && /^\d+(?:\.\d+)?$/u.test(text)) text = String(Number(text) + 1462)
  return text
}

function bankDirection(value, debitDirection) {
  const text = clean(value).toLowerCase()
  if (['收入', '收', '入账', '存入', '转入', 'income', 'in'].includes(text)) return 'income'
  if (['支出', '支', '出账', '取出', '转出', 'expense', 'out'].includes(text)) return 'expense'
  if (['借', '借方', 'debit', 'dr', 'd'].includes(text)) return debitDirection || 'unknown'
  if (['贷', '贷方', 'credit', 'cr', 'c'].includes(text)) return debitDirection ? opposite(debitDirection) : 'unknown'
  return 'unknown'
}

function parseBank(sheets, { content, extension, timezoneOffsetMinutes, bankMapping, bankPreview }) {
  const contentHash = sha256(content)
  if (!bankMapping) return { mappingRequired: true, bankPreview: inspectBank(sheets, contentHash, bankPreview) }
  const mapping = validateMapping(sheets, contentHash, bankMapping)
  const sheet = sheets[mapping.sheetIndex]
  const selectedHeaderIndex = sheet.records.findIndex((record, i) => recordNumber(record, i) === mapping.headerRow)
  const header = sheet.records[selectedHeaderIndex]
  const descriptor = bankProfile(extension)
  const rows = [], metadataRows = [], controlFields = [], decorativeRows = []
  const amountFields = { direction: ['amount', 'direction'], split: ['income', 'expense'], signed: ['amount'] }[mapping.amountMode]
  const headerFields = ['transactionTime', ...amountFields]
  const countControls = []
  const metadataText = sheet.records.slice(0, selectedHeaderIndex).map(record => record.values.join(' ')).join('\n')
  const foreignCurrency = /(?:币种|货币)\s*[:：]?\s*(?:美元|港币|港元|欧元|日元|英镑|USD|HKD|EUR|JPY|GBP)/iu.test(metadataText)
  sheet.records.forEach((record, index) => {
    const values = record.values
    const at = field => mapping.columns[field] == null ? '' : String(values[mapping.columns[field]] || '')
    const captured = kind => ({ kind, sourceLocator: record.sourceLocator || `CSV:${record.startLine}-${record.endLine}`, values })
    const inferredHeader = inferColumns(values)
    if (index < selectedHeaderIndex) { metadataRows.push(captured('metadata')); return }
    if (index === selectedHeaderIndex || !values.some(clean) || JSON.stringify(values) === JSON.stringify(header.values) ||
        headerFields.every(field => inferredHeader[field] === mapping.columns[field])) {
      decorativeRows.push(captured('decorative')); return
    }
    const occupied = values.map(clean).filter(Boolean)
    const recordCount = occupied.length === 1 && BANK_RECORD_COUNT.exec(occupied[0])
    if (recordCount) {
      controlFields.push(captured('control'))
      countControls.push({ sourceLocator: captured('control').sourceLocator, expected: Number(recordCount[1]) })
      return
    }
    // A footer note is metadata only when it occupies a single cell and has no
    // transaction fields. Keep the original record; never discard a damaged row.
    if (occupied.length === 1 && /^(?:说明|温馨提示|重要提示)\s*[:：]/u.test(occupied[0])) {
      metadataRows.push(captured('metadata')); return
    }
    if (!parseLocalDateTime(bankTime(at('transactionTime'), at('time'), sheet.date1904), timezoneOffsetMinutes) &&
        /^(?:合计|总计|小计|本页合计|余额|期初余额|期末余额)(?:[:：\s]|$)/u.test(clean(values.find(clean)))) {
      controlFields.push(captured('control')); return
    }
    const rowIssues = []
    const error = (code, field) => rowIssues.push({ code, field, severity: 'error' })
    let rawAmount = at('amount'), amount, direction
    if (mapping.amountMode === 'split') {
      const income = clean(at('income')) ? signedAmount(at('income')) : { minor: '0' }
      const expense = clean(at('expense')) ? signedAmount(at('expense')) : { minor: '0' }
      if (!income || !expense || income.negative || expense.negative || (income.minor !== '0') === (expense.minor !== '0')) {
        error('bank_amount_columns_conflict', 'amount')
      } else {
        direction = income.minor !== '0' ? 'income' : 'expense'
        rawAmount = at(direction)
        amount = direction === 'income' ? income : expense
      }
    } else {
      amount = signedAmount(rawAmount)
      direction = mapping.amountMode === 'signed' ? amount && (amount.negative ? opposite(mapping.positiveDirection) : mapping.positiveDirection)
        : bankDirection(at('direction'), mapping.debitDirection)
    }
    if (!amount || amount.minor === '0') error('row_amount_invalid', 'amount')
    if (!['income', 'expense'].includes(direction)) error('row_direction_unknown', 'direction')
    if (foreignCurrency || clean(at('currency')) && !/^(?:人民币|人民币元|CNY|RMB|156|元|¥|￥)$/iu.test(clean(at('currency')))) error('bank_currency_unsupported', 'currency')
    if (record.formulaColumns && record.formulaColumns.length) error('xlsx_formula_unsupported', 'row')
    if (values.slice(header.values.length).some(clean)) error('row_extra_columns', 'row')
    const raw = { transactionTime: at('transactionTime'), amount: rawAmount, direction: at('direction'),
      status: at('status'), transactionType: at('transactionType'), counterparty: at('counterparty'),
      counterpartyAccount: '', item: at('item'), paymentMethod: at('paymentMethod'), note: at('note'),
      bankStatementKind:mapping.statementKind,
      installmentFields: { reference:at('installmentReference'),period:at('installmentPeriod'),terms:at('installmentTerms'),component:at('installmentComponent') } }
    const normalized = normalizeRow('bank', { ...raw,
      transactionTime: bankTime(raw.transactionTime, at('time'), sheet.date1904),
      amount: amount ? amount.absolute : '', direction: direction === 'income' ? '收入' : direction === 'expense' ? '支出' : ''
    }, timezoneOffsetMinutes, rowIssues, descriptor.sourceFormat, new Set(Object.keys(mapping.columns)))
    // Original fields stay untouched; the selected column/amount interpretation
    // is separately persisted in statement analysis and the parse fingerprint.
    for (const field of ['transactionTime', 'amount', 'direction']) {
      normalized.observations[field] = observeField(raw[field], { present: mapping.columns[field] != null })
    }
    const ownAccount = clean(raw.paymentMethod).replace(/^'+/, '').replace(/[ -]/g, '')
    const numericIdentity = ['paymentMethod', 'transactionId'].some(field =>
      (record.numericColumns || []).includes(mapping.columns[field]) && clean(at(field)).replace(/^'+/, '').length > 15)
    const bankAccountIdentity = !numericIdentity && /^\d{8,32}$/u.test(ownAccount) ? digestParts('bank-own-account-v1', ownAccount) : null
    const bankPaymentKey = normalized.semantic.ledgerAccountRef
      ? digestParts('bank-payment-v1', bankAccountIdentity || contentHash, bankAccountIdentity ? '' : clean(raw.paymentMethod)) : null
    if (bankPaymentKey) {
      for (const field of ['ledgerAccountRef', 'fromAccountRef', 'toAccountRef']) {
        const reference = normalized.semantic[field]
        if (reference) normalized.semantic[field] = { ...reference, paymentMethodKey: bankPaymentKey,
          accountIdentityKey: digestParts('bank-account-group-v1', bankPaymentKey) }
      }
    }
    rows.push({ rowNumber: rows.length + 1, sourceLocator: captured('data').sourceLocator, raw,
      rawFields: values.map((value, column) => ({ name: header.values[column] || '', value, column: column + 1 })),
      identifiers: { transactionId: at('transactionId'), orderId: '', merchantOrderId: '' },
      bankAccountIdentity, bankPaymentKey,
      ...normalized })
  })
  const dates = rows.map(row => row.normalized.localDate).filter(Boolean).sort()
  const controls = countControls.map(control => ({ kind: 'row_count', sourceLocator: control.sourceLocator, passed: control.expected === rows.length }))
  const issues = []
  if (controls.some(control => !control.passed)) issues.push({ code: 'statement_count_mismatch', field: 'statement', severity: 'error' })
  if (controlFields.length > countControls.length) issues.push({ code: 'bank_controls_unverified', field: 'statement', severity: 'warning' })
  return { descriptor, profile: { profileId: descriptor.profileId, profileVersion: descriptor.profileVersion,
    adapterVersion: descriptor.adapterVersion, policyVersion: descriptor.policyVersion }, bankMapping: mapping,
    metadata: { sourceProfile: { kind: 'missing', identifier: '', displayName: '' },
      statementStartLocal: dates[0] || null, statementEndLocal: dates[dates.length - 1] || null },
    controls, diagnostics: { unknownHeaders: [], missingFields: [], duplicateFields: [] },
    records: { dataRows: rows, metadataRows, controlFields, decorativeRows },
    issues, rows }
}

module.exports = { parseBank, inspectBank, validateMapping, bankDirection, bankTime, signedAmount }
