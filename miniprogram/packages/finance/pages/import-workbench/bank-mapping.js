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
// 预览只做展示格式化，不改原始值，也不改变入账语义。
function displayDate(value) {
  const raw = String(value == null ? '' : value).trim()
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}:\d{2})/)
  if (compact) return compact[2] + '-' + compact[3] + ' ' + compact[4]
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/)
  if (iso) return iso[2] + '-' + iso[3] + ' ' + iso[4]
  return raw
}
function displayAmount(value) {
  const raw = String(value == null ? '' : value).trim()
  const match = raw.match(/^([¥￥$])?\s*([+-]?)\s*([\d,]+(?:\.\d+)?)$/)
  if (!match) return raw
  const sign = match[2] === '-' ? '−' : match[2] === '+' ? '+' : ''
  const parts = match[3].replace(/,/g, '').split('.')
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return sign + grouped + (parts[1] ? '.' + parts[1] : '')
}

function view(clientId, name, preview, draft) {
  const current = Object.assign({}, preview.suggested, draft, {
    columns: Object.assign({}, draft ? draft.columns : preview.suggested.columns)
  })
  const amountFields = { direction: ['amount', 'direction'], split: ['income', 'expense'], signed: ['amount'] }[current.amountMode]
  const required = ['transactionTime'].concat(amountFields)
  const options = [{ index: -1, name: '不使用这一列' }].concat(preview.headers.map(function (header) {
    return { index: header.index, name: '第 ' + (header.index + 1) + ' 列 · ' + header.name }
  }))
  // 哪个物理列已经被哪个字段占用，直接在选项里说清；选中时会和原字段互换。
  const usedBy = {}
  Object.keys(current.columns).forEach(function (field) {
    if (current.columns[field] != null) usedBy[current.columns[field]] = field
  })
  // 选项里标清“这列已经被谁用了”；已有列时互换，没有列时移过来。
  const annotate = function (option, field) {
    const owner = option.index < 0 ? null : usedBy[option.index]
    if (!owner || owner === field) return option
    return { index: option.index, name: option.name + '（已用于' + FIELD_LABELS[owner] +
      (current.columns[field] == null ? '，选后移过来' : '，选后互换') + '）' }
  }
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
      options: options.map(option => annotate(option, field)),
      example: column == null ? '' : preview.samples.map(row => row[column] || '空').join(' / ') }
  })
  // 预览表直接用账单原文列名；我们起的语义名只出现在选择器里。
  const headerName = index => {
    const header = (preview.headers || []).find(item => item.index === index)
    return header ? header.name : ''
  }
  const amountKeys = current.amountMode === 'split' ? ['income', 'expense'] : ['amount']
  const previewSpec = [{ key: 'transactionTime', label: '交易日期', required: true }]
    .concat(amountKeys.map(key => ({ key, label: key === 'income' ? '流入' : key === 'expense' ? '流出' : '交易金额', required: true })))
    .concat([{ key: 'item', label: '摘要', required: false }, { key: 'counterparty', label: '交易对方', required: false }])
  const previewColumns = previewSpec.filter(column => column.required || current.columns[column.key] != null).slice(0, 3)
    .map(column => {
      const index = current.columns[column.key]
      const numeric = ['amount', 'income', 'expense'].includes(column.key)
      return { key: column.key, label: column.label, required: column.required, numeric,
        slot: column.key === 'transactionTime' ? 'date' : numeric ? 'amount' : 'text',
        missing: column.required && index == null,
        header: index == null ? '选择列' : headerName(index) || '第 ' + (index + 1) + ' 列',
        selected: index == null ? 0 : index + 1, options: options.map(option => annotate(option, column.key)) }
    })
  const previewRows = (preview.samples || []).slice(0, 3).map((row, rowIndex) => ({ key: String(rowIndex),
    cells: previewColumns.map((column, cellIndex) => {
      const index = current.columns[column.key]
      const raw = index == null ? '' : String(row[index] == null ? '' : row[index])
      const value = !raw ? raw : column.key === 'transactionTime' ? displayDate(raw) : column.numeric ? displayAmount(raw) : raw
      return { key: column.key + '-' + cellIndex, value, numeric: column.numeric, slot: column.slot,
        missing: column.missing, required: column.required }
    }) }))
  const samplesHaveDebit = (preview.samples || []).some(row => /^(借|贷|借方|贷方|debit|credit|dr|cr|d|c)$/i
    .test(String(row[current.columns.direction] || '').trim()))
  const directionMissing = current.amountMode === 'signed' ? !current.positiveDirection
    : current.amountMode === 'direction' ? (!current.debitDirection && samplesHaveDebit) : false
  const directionLabel = current.amountMode === 'signed' ? '正数表示' : '借贷含义'
  // 未选时把“缺什么”写在标签上，别只写“待选择”。
  const directionValue = current.amountMode === 'signed'
    ? (current.positiveDirection === 'income' ? '正数 = 流入' : current.positiveDirection === 'expense' ? '正数 = 流出' : '正数方向待选')
    : (current.debitDirection === 'income' ? '借方 = 流入' : current.debitDirection === 'expense' ? '借方 = 流出' : '借贷含义待选')
  const tokens = [
    { key: 'statementKind', label: '账单类型', value: (STATEMENTS.find(item => item.value === (current.statementKind || 'standard')) || STATEMENTS[0]).label, warning: false },
    { key: 'headerRow', label: '表头', value: '表头 ' + preview.headerRow + ' 行', warning: false },
    { key: 'amountMode', label: '金额格式', value: (MODES.find(item => item.value === current.amountMode) || MODES[0]).label, warning: false },
    { key: 'direction', label: directionLabel, value: directionValue, warning: directionMissing }
  ]
  const requiredFields = fields.filter(field => field.required)
  const optionalFields = fields.filter(field => !field.required)
    .sort((a, b) => (a.status === 'missing' ? 1 : 0) - (b.status === 'missing' ? 1 : 0))
  const missingLabels = requiredFields.filter(field => field.status === 'missing').map(field => field.label)
  // 结构设置收成一句摘要；用户先看到“识别成什么”，要看细节再点“调整”。
  const summaryParts = [
    (STATEMENTS.find(item => item.value === (current.statementKind || 'standard')) || STATEMENTS[0]).label,
    '表头 ' + preview.headerRow + ' 行',
    (MODES.find(item => item.value === current.amountMode) || MODES[0]).label
  ]
  if (current.amountMode === 'signed' && current.positiveDirection) {
    summaryParts.push(current.positiveDirection === 'income' ? '正数 = 流入' : '正数 = 流出')
  }
  if (current.amountMode === 'direction' && current.debitDirection) {
    summaryParts.push(current.debitDirection === 'income' ? '借方 = 流入' : '借方 = 流出')
  }
  // 只把挡住确认的那一项提出来直接选，不再让用户去猜哪个标签该点。
  const ask = current.amountMode === 'signed' ? { key: 'positiveDirection', copy: '正数表示流入还是流出？' }
    : current.amountMode === 'direction' ? { key: 'debitDirection', copy: '借方 / DR / D 表示流入还是流出？' } : null
  const copyText = missingLabels.length ? '还差 ' + missingLabels.join('、') + '：点列名选列'
    : '点列名换列'
  // 结构类设置也标来源：自动识别 / 已修改 / 未选（借贷含义这类必答项）。
  const statementAuto = (preview.suggested.statementKind || 'standard') === (current.statementKind || 'standard')
  const amountModeAuto = preview.suggested.amountMode === current.amountMode
  const positiveStatus = current.positiveDirection ? (preview.suggested.positiveDirection === current.positiveDirection ? 'auto' : 'manual') : 'missing'
  const debitStatus = current.debitDirection ? (preview.suggested.debitDirection === current.debitDirection ? 'auto' : 'manual') : 'missing'
  const ready = (missingLabels.length === 0) && !directionMissing
  return { clientId, name, preview, draft: current, fields, requiredFields, optionalFields,
    previewColumns, previewRows, tokens, directionMissing, ready, summaryText: summaryParts.join(' · '),
    ask, copyText, settingsOpen: false,
    readyLabel: missingLabels.length ? '还差 ' + missingLabels.join('、') : directionMissing ? '还差' + directionLabel : requiredFields.length + ' 项已就绪',
    statementAuto, amountModeAuto, positiveStatus, debitStatus,
    missingLabels,
    amountModes: MODES, modeIndex: MODES.findIndex(mode => mode.value === current.amountMode),
    directionOptions: DIRECTIONS, positiveIndex: DIRECTIONS.findIndex(option => option.value === current.positiveDirection),
    debitIndex: DIRECTIONS.findIndex(option => option.value === current.debitDirection), headerRowInput: String(preview.headerRow),
    statementOptions:STATEMENTS,statementIndex:current.statementKind==='credit'?1:0, error: '' }
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
