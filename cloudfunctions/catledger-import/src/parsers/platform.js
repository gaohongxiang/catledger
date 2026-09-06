const { normalizeText } = require('./text')
const { normalizeRow } = require('./normalize')
const { classifyRecord, hasTransactionStructure, inspectControls } = require('./record-classifier')
const { profileForFormat, profilesForContainer } = require('../profiles')

const DESCRIPTORS = Object.freeze({
  wechat: { ...profileForFormat('wechat_csv'), key: 'wechat' },
  alipay_app: { ...profileForFormat('alipay_app_csv'), key: 'alipay_app' },
  alipay_web: { ...profileForFormat('alipay_web_csv'), key: 'alipay_web' }
})

function canonicalHeader(value) {
  return normalizeText(value, 128).replaceAll(' ', '').replaceAll('（', '(').replaceAll('）', ')')
}

function inspectHeader(values, descriptor) {
  const aliases = descriptor.fieldAliases
  const positions = {}
  const duplicateFields = []
  const knownIndexes = new Set()
  let knownCount = 0
  values.forEach((value, index) => {
    const header = canonicalHeader(value)
    for (const [field, names] of Object.entries(aliases)) {
      if (names.map(canonicalHeader).includes(header)) {
        knownIndexes.add(index)
        if (positions[field] == null) {
          positions[field] = index
          knownCount += 1
        } else {
          duplicateFields.push(field)
        }
        break
      }
    }
  })
  const missingFields = descriptor.requiredFields.filter((field) => positions[field] == null)
  const unknownHeaders = values.map((value, index) => ({ value: normalizeText(value, 128), index }))
    .filter((entry) => entry.value && !knownIndexes.has(entry.index))
    .map((entry) => entry.value)
  return {
    positions,
    knownCount,
    duplicateFields,
    missingFields,
    unknownHeaders,
    hasCore: positions.transactionTime != null && positions.amount != null,
    valid: missingFields.length === 0 && duplicateFields.length === 0
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
  const normalizedHeaders = header.record.values.map(canonicalHeader)
  const unique = descriptor.uniqueHeaders.some((value) => normalizedHeaders.includes(canonicalHeader(value)))
  const confidence = (marker ? 100 : 0) + (unique ? 30 : 0) + header.header.knownCount
  return { descriptor, confidence, header, marker }
}

function choosePlatform(records, { xlsx = false } = {}) {
  const candidates = profilesForContainer(xlsx ? 'xlsx' : 'csv')
    .map((profile) => probePlatform(records, profile))
    .filter((candidate) => candidate.header && candidate.header.header.valid && candidate.confidence >= 5)
  if (candidates.length !== 1) return null
  return { ...candidates[0], descriptor: { ...candidates[0].descriptor } }
}

function valueAt(values, positions, field) {
  const index = positions[field]
  return index == null || index >= values.length ? '' : String(values[index])
}

function sourceLocator(record) {
  return record.sourceLocator || `CSV:${record.startLine}-${record.endLine}`
}

function classifiedRecord(record, kind) {
  return { kind, sourceLocator: sourceLocator(record), values: record.values }
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
  const controlFields = []
  const metadataRows = []
  const decorativeRows = []
  for (const [index, record] of records.entries()) {
    if (index === header.index) continue
    const kind = classifyRecord(record, positions)
    if (kind === 'decorative') {
      decorativeRows.push(classifiedRecord(record, kind))
      continue
    }
    const repeatedHeader = inspectHeader(record.values, descriptor)
    if (repeatedHeader.valid) {
      decorativeRows.push(classifiedRecord(record, 'repeated_header'))
      continue
    }
    if (kind === 'control') {
      controlFields.push(classifiedRecord(record, kind))
      continue
    }
    if (kind === 'metadata' || index < header.index && !hasTransactionStructure(record, positions)) {
      metadataRows.push(classifiedRecord(record, 'metadata'))
      continue
    }
    const raw = {
      transactionTime: valueAt(record.values, positions, 'transactionTime'),
      amount: valueAt(record.values, positions, 'amount'),
      direction: valueAt(record.values, positions, 'direction'),
      status: valueAt(record.values, positions, 'status'),
      transactionType: valueAt(record.values, positions, 'transactionType'),
      counterparty: valueAt(record.values, positions, 'counterparty'),
      counterpartyAccount: valueAt(record.values, positions, 'counterpartyAccount'),
      item: valueAt(record.values, positions, 'item'),
      paymentMethod: valueAt(record.values, positions, 'paymentMethod'),
      note: valueAt(record.values, positions, 'note')
    }
    const structuralIssues = []
    if (record.values.slice(header.record.values.length).some((value) => normalizeText(value, 1024))) {
      structuralIssues.push({ code: 'row_extra_columns', field: 'row', severity: 'warning' })
    }
    if (!normalizeText(raw.transactionTime, 128) && !normalizeText(raw.amount, 128)) {
      structuralIssues.push({ code: 'row_structure_unknown', field: 'row', severity: 'error' })
    }
    if (record.formulaColumns && record.formulaColumns.length > 0) {
      structuralIssues.push({ code: 'xlsx_formula_unsupported', field: 'row', severity: 'error' })
    }
    const normalized = normalizeRow(
      descriptor.sourceType,
      raw,
      timezoneOffsetMinutes,
      structuralIssues,
      descriptor.sourceFormat,
      new Set(Object.keys(positions))
    )
    rows.push({
      rowNumber: rows.length + 1,
      sourceLocator: sourceLocator(record),
      raw,
      rawFields: Array.from({ length: Math.max(header.record.values.length, record.values.length) }, (_, index) => ({
        name: header.record.values[index] || '', value: record.values[index] || '', column: index + 1
      })),
      identifiers: {
        transactionId: valueAt(record.values, positions, 'transactionId'),
        orderId: valueAt(record.values, positions, 'orderId'),
        merchantOrderId: valueAt(record.values, positions, 'merchantOrderId')
      },
      ...normalized
    })
  }

  const period = parseStatementPeriod(metadataRows)
  const controlAnalysis = inspectControls(controlFields, rows, descriptor)
  return {
    descriptor,
    profile: {
      profileId: descriptor.profileId,
      profileVersion: descriptor.profileVersion,
      adapterVersion: descriptor.adapterVersion,
      policyVersion: descriptor.policyVersion
    },
    metadata: {
      sourceProfile: sourceProfileCandidate(metadataRows, descriptor.sourceType),
      statementStartLocal: period.start,
      statementEndLocal: period.end
    },
    controls: controlAnalysis.controls,
    diagnostics: {
      unknownHeaders: header.header.unknownHeaders,
      missingFields: header.header.missingFields,
      duplicateFields: header.header.duplicateFields
    },
    records: {
      dataRows: rows,
      controlFields,
      metadataRows,
      decorativeRows
    },
    issues: [
      ...controlAnalysis.issues,
      ...(selected.marker ? [] : [{ code: 'file_preamble_missing', field: 'preamble', severity: 'warning' }]),
      ...header.header.unknownHeaders.map(() => ({ code: 'file_header_unknown', field: 'header', severity: 'warning' }))
    ],
    rows
  }
}

module.exports = {
  DESCRIPTORS,
  choosePlatform,
  inspectHeader,
  parsePlatformRecords
}
