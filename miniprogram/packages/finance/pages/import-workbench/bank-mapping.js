const FIELD_LABELS = {
  transactionTime: '交易日期', time: '单独的时间列', amount: '交易金额', direction: '收支标记',
  income: '流入账户的金额', expense: '流出账户的金额', currency: '币种', transactionId: '交易流水号',
  counterparty: '交易对方', item: '用途或摘要', paymentMethod: '本方卡号或账号', status: '交易状态',
  transactionType: '交易类型', note: '备注', installmentReference:'分期编号', installmentPeriod:'当前期数',
  installmentTerms:'分期总期数', installmentComponent:'本金 / 利息分项'
}
const MODES = [
  { value: 'direction', label: '金额列 + 收支标记' },
  { value: 'split', label: '流入、流出分为两列' },
  { value: 'signed', label: '按金额正负区分' }
]
const DIRECTIONS = [{ value: '', label: '请选择' }, { value: 'income', label: '流入账户' }, { value: 'expense', label: '流出账户' }]
const STATEMENTS = [{value:'standard',label:'储蓄卡 / 普通银行流水'},{value:'credit',label:'信用卡账单'}]

function view(clientId, name, preview, draft) {
  const current = Object.assign({}, preview.suggested, draft, {
    columns: Object.assign({}, draft ? draft.columns : preview.suggested.columns)
  })
  const amountFields = { direction: ['amount', 'direction'], split: ['income', 'expense'], signed: ['amount'] }[current.amountMode]
  const required = ['transactionTime'].concat(amountFields)
  const options = [{ index: -1, name: '不使用这一列' }].concat(preview.headers.map(function (header) {
    return { index: header.index, name: '第 ' + (header.index + 1) + ' 列 · ' + header.name }
  }))
  const suggested = preview.suggested.columns || {}
  const fields = Object.keys(FIELD_LABELS).filter(function (field) {
    return !['amount', 'direction', 'income', 'expense'].includes(field) || amountFields.includes(field)
  }).map(function (field) {
    const column = current.columns[field]
    const selected = column == null ? 0 : column + 1
    // 每个字段标清来源：自动识别、人工改过、还没选。必填未选要显眼。
    const status = column == null ? 'missing' : suggested[field] === column ? 'auto' : 'manual'
    return { key: field, label: FIELD_LABELS[field], required: required.includes(field), status,
      selected: selected, value: options[selected] ? options[selected].name : options[0].name,
      example: column == null ? '' : preview.samples.map(row => row[column] || '空').join(' / ') }
  })
  const requiredFields = fields.filter(field => field.required)
  const optionalFields = fields.filter(field => !field.required)
  const missingLabels = requiredFields.filter(field => field.status === 'missing').map(field => field.label)
  // 结构类设置也标来源：自动识别 / 已修改 / 未选（借贷含义这类必答项）。
  const statementAuto = (preview.suggested.statementKind || 'standard') === (current.statementKind || 'standard')
  const amountModeAuto = preview.suggested.amountMode === current.amountMode
  const positiveStatus = current.positiveDirection ? (preview.suggested.positiveDirection === current.positiveDirection ? 'auto' : 'manual') : 'missing'
  const debitStatus = current.debitDirection ? (preview.suggested.debitDirection === current.debitDirection ? 'auto' : 'manual') : 'missing'
  return { clientId, name, preview, draft: current, fields, requiredFields, optionalFields,
    statementAuto, amountModeAuto, positiveStatus, debitStatus,
    missingLabels, ready: missingLabels.length === 0,
    readyLabel: missingLabels.length ? '还差 ' + missingLabels.join('、') : requiredFields.length + ' 项已就绪',
    columnOptions: options,
    amountModes: MODES, modeIndex: MODES.findIndex(mode => mode.value === current.amountMode),
    directionOptions: DIRECTIONS, positiveIndex: DIRECTIONS.findIndex(option => option.value === current.positiveDirection),
    debitIndex: DIRECTIONS.findIndex(option => option.value === current.debitDirection), headerRowInput: String(preview.headerRow),
    statementOptions:STATEMENTS,statementIndex:current.statementKind==='credit'?1:0,advanced: false, error: '' }
}

function payload(sheet) {
  const required = ['transactionTime'].concat({ direction: ['amount', 'direction'], split: ['income', 'expense'], signed: ['amount'] }[sheet.draft.amountMode])
  if (required.some(field => sheet.draft.columns[field] == null)) return { error: '请选好交易日期和金额对应的列' }
  if (sheet.draft.amountMode === 'signed' && !sheet.draft.positiveDirection) return { error: '请确认正数表示流入还是流出账户' }
  const columns = {}
  sheet.fields.forEach(function (field) { if (sheet.draft.columns[field.key] != null) columns[field.key] = sheet.draft.columns[field.key] })
  if (new Set(Object.values(columns)).size !== Object.keys(columns).length) return { error: '一列不能同时用于两个字段，请检查选择' }
  if (sheet.draft.amountMode === 'direction' && !sheet.draft.debitDirection && sheet.preview.samples.some(function (row) {
    return /^(借|贷|借方|贷方|debit|credit|dr|cr|d|c)$/i.test(String(row[columns.direction] || '').trim())
  })) return { error: '请确认借方 / DR / D 表示流入还是流出账户' }
  return { value: { schemaVersion: 1, sheetIndex: sheet.preview.sheetIndex, headerRow: sheet.preview.headerRow,
    headerToken: sheet.preview.headerToken, columns: columns, amountMode: sheet.draft.amountMode,
    positiveDirection: sheet.draft.positiveDirection || '', debitDirection: sheet.draft.debitDirection || '', currency: 'CNY',statementKind:sheet.draft.statementKind || 'standard' } }
}

module.exports = { view, payload }
