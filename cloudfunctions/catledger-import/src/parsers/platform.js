const { normalizeText } = require('./text')
const { normalizeRow } = require('./normalize')

const FIELD_ALIASES = Object.freeze({
  wechat: {
    transactionTime: ['交易时间', '交易日期'],
    transactionType: ['交易类型', '业务类型'],
    counterparty: ['交易对方', '交易对象', '对方'],
    item: ['商品', '商品说明', '商品名称'],
    direction: ['收/支', '收支', '收支类型'],
    amount: ['金额(元)', '交易金额(元)', '金额'],
    paymentMethod: ['支付方式', '付款方式'],
    status: ['当前状态', '交易状态', '状态'],
    transactionId: ['交易单号', '微信交易单号'],
    orderId: ['订单号'],
    merchantOrderId: ['商户单号', '商家单号'],
    note: ['备注', '交易备注']
  },
  alipay_app: {
    transactionTime: ['交易时间'],
    transactionType: ['交易分类', '交易类型'],
    counterparty: ['交易对方'],
    item: ['商品说明', '商品名称'],
    direction: ['收/支'],
    amount: ['金额'],
    paymentMethod: ['收/付款方式', '付款方式', '资金渠道'],
    status: ['交易状态'],
    transactionId: ['交易订单号', '支付宝交易号', '交易号'],
    orderId: ['订单号'],
    merchantOrderId: ['商家订单号', '商户订单号'],
    note: ['备注']
  },
  alipay_web: {
    transactionTime: ['交易创建时间'],
    transactionType: ['类型', '交易类型'],
    counterparty: ['交易对方'],
    item: ['商品名称', '商品说明'],
    direction: ['收/支'],
    amount: ['金额(元)', '金额(元)', '金额'],
    paymentMethod: ['收/付款方式', '付款方式', '资金渠道'],
    status: ['交易状态'],
    transactionId: ['交易号', '支付宝交易号', '交易订单号'],
    orderId: ['订单号'],
    merchantOrderId: ['商户订单号', '商家订单号'],
    note: ['备注']
  }
})

const DESCRIPTORS = Object.freeze({
  wechat: {
    key: 'wechat',
    sourceType: 'wechat',
    sourceFormat: 'wechat_csv',
    parserName: 'wechat-pay-csv-evidence',
    parserVersion: 'wechat-csv-parser-v1',
    normalizationVersion: 'wechat-normalization-v5',
    markers: ['微信支付账单明细']
  },
  alipay_app: {
    key: 'alipay_app',
    sourceType: 'alipay',
    sourceFormat: 'alipay_app_csv',
    parserName: 'alipay-app-csv-evidence',
    parserVersion: 'alipay-evidence-parser-v1',
    normalizationVersion: 'alipay-normalization-v7',
    markers: ['支付宝(中国)网络技术有限公司 电子客户回单', '支付宝支付科技有限公司 电子客户回单']
  },
  alipay_web: {
    key: 'alipay_web',
    sourceType: 'alipay',
    sourceFormat: 'alipay_web_csv',
    parserName: 'alipay-web-csv-evidence',
    parserVersion: 'alipay-evidence-parser-v1',
    normalizationVersion: 'alipay-normalization-v7',
    markers: ['支付宝交易记录明细查询', '交易记录明细列表']
  }
})

function canonicalHeader(value) {
  return normalizeText(value, 128).replaceAll(' ', '').replaceAll('（', '(').replaceAll('）', ')')
}

function inspectHeader(values, descriptor) {
  const aliases = FIELD_ALIASES[descriptor.key]
  const positions = {}
  let knownCount = 0
  values.forEach((value, index) => {
    const header = canonicalHeader(value)
    for (const [field, names] of Object.entries(aliases)) {
      if (positions[field] == null && names.map(canonicalHeader).includes(header)) {
        positions[field] = index
        knownCount += 1
        break
      }
    }
  })
  return {
    positions,
    knownCount,
    hasCore: positions.transactionTime != null && positions.amount != null
  }
}

function recordText(record) {
  return record.values.map((value) => normalizeText(value, 1024)).join(' ')
}

function hasMarker(records, descriptor) {
  const content = records.slice(0, 40).map(recordText).join('\n').replaceAll('（', '(').replaceAll('）', ')')
  return descriptor.markers.some((marker) => content.includes(marker))
}

function findHeader(records, descriptor) {
  let best = null
  records.slice(0, 120).forEach((record, index) => {
    const inspected = inspectHeader(record.values, descriptor)
    if (inspected.hasCore && (!best || inspected.knownCount > best.header.knownCount)) {
      best = { index, record, header: inspected }
    }
  })
  return best
}

function probePlatform(records, descriptor) {
  const header = findHeader(records, descriptor)
  if (!header) return { descriptor, confidence: 0, header: null }
  const marker = hasMarker(records, descriptor)
  const uniqueHeaders = descriptor.key === 'wechat'
    ? ['微信交易单号', '当前状态']
    : descriptor.key === 'alipay_app'
      ? ['交易分类', '支付宝交易号', '交易订单号']
      : ['交易创建时间', '金额(元)']
  const normalizedHeaders = header.record.values.map(canonicalHeader)
  const unique = uniqueHeaders.some((value) => normalizedHeaders.includes(canonicalHeader(value)))
  const confidence = (marker ? 100 : 0) + (unique ? 30 : 0) + header.header.knownCount
  return { descriptor, confidence, header, marker }
}

function choosePlatform(records, { xlsx = false } = {}) {
  const candidates = Object.values(DESCRIPTORS).map((descriptor) => probePlatform(records, descriptor))
    .filter((candidate) => candidate.header && candidate.confidence >= 5)
    .sort((left, right) => right.confidence - left.confidence)
  if (!candidates[0] || (candidates[1] && candidates[0].confidence === candidates[1].confidence)) return null
  const selected = { ...candidates[0], descriptor: { ...candidates[0].descriptor } }
  if (xlsx) {
    if (selected.descriptor.sourceType !== 'wechat') return null
    selected.descriptor.sourceFormat = 'wechat_xlsx'
    selected.descriptor.parserName = 'wechat-pay-xlsx-evidence'
    selected.descriptor.parserVersion = 'wechat-xlsx-parser-v1'
  }
  return selected
}

function valueAt(values, positions, field) {
  const index = positions[field]
  return index == null || index >= values.length ? '' : String(values[index])
}

function isEmpty(values) {
  return values.every((value) => normalizeText(value, 1024) === '')
}

function isSeparator(values) {
  if (!values[0] || values.slice(1).some((value) => normalizeText(value, 1024))) return false
  return /^-{10,}$/.test(normalizeText(values[0], 1024))
}

function parseStatementPeriod(records) {
  const content = records.slice(0, 80).map(recordText).join('\n')
  const combined = /(?:起始|开始)(?:日期|时间)?\s*[:：]?\s*\[?\s*(\d{4}[-/]\d{2}[-/]\d{2})(?:\s+\d{2}:\d{2}:\d{2})?\s*\]?[^\d]{0,30}(?:终止|结束)(?:日期|时间)?\s*[:：]?\s*\[?\s*(\d{4}[-/]\d{2}[-/]\d{2})/.exec(content)
  if (!combined) return { start: null, end: null }
  return { start: combined[1].replaceAll('/', '-'), end: combined[2].replaceAll('/', '-') }
}

function sourceProfileCandidate(records, sourceType) {
  const content = records.slice(0, 60).map(recordText).join('\n')
  if (sourceType === 'wechat') {
    const match = /(?:微信昵称|昵称)\s*[:：]\s*([^\n,，]{1,128})/.exec(content)
    return { kind: 'display_only', displayName: match ? normalizeText(match[1], 128) : '', identifier: '' }
  }
  const match = /(?:支付宝账户|支付宝账号|账号)\s*[:：]\s*\[?\s*([^\]\n,，]{2,128})/.exec(content)
  if (!match) return { kind: 'missing', displayName: '', identifier: '' }
  const value = normalizeText(match[1], 128)
  const masked = /[*＊•·xX]{2,}/.test(value)
  return masked
    ? { kind: 'masked_display_only', displayName: value, identifier: '' }
    : { kind: 'stable_identifier', displayName: '', identifier: value }
}

function parsePlatformRecords(records, selected, timezoneOffsetMinutes) {
  const { descriptor, header } = selected
  const positions = header.header.positions
  const rows = []
  for (const record of records.slice(header.index + 1)) {
    if (isEmpty(record.values)) continue
    if (isSeparator(record.values)) break
    const repeated = inspectHeader(record.values, descriptor).hasCore
    const raw = {
      transactionTime: valueAt(record.values, positions, 'transactionTime'),
      amount: valueAt(record.values, positions, 'amount'),
      direction: valueAt(record.values, positions, 'direction'),
      status: valueAt(record.values, positions, 'status'),
      transactionType: valueAt(record.values, positions, 'transactionType'),
      counterparty: valueAt(record.values, positions, 'counterparty'),
      item: valueAt(record.values, positions, 'item'),
      paymentMethod: valueAt(record.values, positions, 'paymentMethod'),
      note: valueAt(record.values, positions, 'note')
    }
    const structuralIssues = []
    if (repeated) structuralIssues.push({ code: 'row_repeated_header', field: 'row', severity: 'error' })
    if (record.formulaColumns && record.formulaColumns.length > 0) {
      structuralIssues.push({ code: 'xlsx_formula_unsupported', field: 'row', severity: 'error' })
    }
    const normalized = normalizeRow(
      descriptor.sourceType,
      raw,
      timezoneOffsetMinutes,
      structuralIssues
    )
    rows.push({
      rowNumber: rows.length + 1,
      sourceLocator: record.sourceLocator || `CSV:${record.startLine}-${record.endLine}`,
      raw,
      rawFields: header.record.values.map((name, index) => ({ name, value: record.values[index] || '' })),
      identifiers: {
        transactionId: valueAt(record.values, positions, 'transactionId'),
        orderId: valueAt(record.values, positions, 'orderId'),
        merchantOrderId: valueAt(record.values, positions, 'merchantOrderId')
      },
      ...normalized
    })
  }

  const period = parseStatementPeriod(records)
  return {
    descriptor,
    metadata: {
      sourceProfile: sourceProfileCandidate(records, descriptor.sourceType),
      statementStartLocal: period.start,
      statementEndLocal: period.end
    },
    issues: selected.marker ? [] : [{ code: 'file_preamble_missing', field: 'preamble', severity: 'warning' }],
    rows
  }
}

module.exports = {
  DESCRIPTORS,
  choosePlatform,
  inspectHeader,
  parsePlatformRecords
}
