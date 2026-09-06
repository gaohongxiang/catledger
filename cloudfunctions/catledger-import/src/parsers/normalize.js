const { importError } = require('../errors')
const { observeField } = require('../field-observation')
const { paymentAccountDetails } = require('../payment-account')
const { resolveRowSemantic } = require('../row-semantic-resolver')
const { normalizeText } = require('./text')

const MAX_MINOR_UNITS = 9223372036854775807n
const LOCAL_TIME_PATTERN = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
const EXCEL_SERIAL_PATTERN = /^\d{1,7}(?:\.\d+)?$/
const EXCEL_UNIX_EPOCH_SERIAL = 25569
const MILLISECONDS_PER_DAY = 86_400_000

function issue(code, field, severity = 'warning') {
  return { code, field, severity }
}

function parseAmountMinor(raw) {
  let value = normalizeText(raw, 64).replace(/^(?:CNY|RMB|[¥￥])\s*/i, '').replace(/元$/, '').trim()
  if (!value || value.startsWith('-')) return null
  const match = /^\+?((?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*))(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return null
  const yuan = match[1].replaceAll(',', '')
  const fraction = (match[2] || '').padEnd(2, '0')
  const minor = BigInt(yuan) * 100n + BigInt(fraction || '0')
  if (minor > MAX_MINOR_UNITS) return null
  return minor.toString()
}

function parsedLocalDateTime(localEpoch, timezoneOffsetMinutes) {
  const check = new Date(localEpoch)
  const year = check.getUTCFullYear()
  const month = check.getUTCMonth() + 1
  const day = check.getUTCDate()
  const hour = check.getUTCHours()
  const minute = check.getUTCMinutes()
  const second = check.getUTCSeconds()
  if (year < 1000 || year > 9999) return null

  const yearText = String(year).padStart(4, '0')
  const monthText = String(month).padStart(2, '0')
  const dayText = String(day).padStart(2, '0')
  const hourText = String(hour).padStart(2, '0')
  const minuteText = String(minute).padStart(2, '0')
  const secondText = String(second).padStart(2, '0')
  const localDate = `${yearText}-${monthText}-${dayText}`
  const localAt = `${localDate} ${hourText}:${minuteText}:${secondText}.000`
  const utcEpoch = localEpoch + timezoneOffsetMinutes * 60_000
  return {
    localDate,
    localAt,
    utcAt: new Date(utcEpoch).toISOString().replace('T', ' ').replace('Z', ''),
    timezoneOffsetMinutes
  }
}

function parseExcelSerialDateTime(value, timezoneOffsetMinutes) {
  if (!EXCEL_SERIAL_PATTERN.test(value)) return null
  const serial = Number(value)
  if (!Number.isFinite(serial) || serial < 1 || serial >= 2_958_466) return null
  // Excel's 1900 date system contains the non-existent 1900-02-29 at serial 60.
  if (serial >= 60 && serial < 61) return null
  const unixDays = serial - (serial < 60 ? EXCEL_UNIX_EPOCH_SERIAL - 1 : EXCEL_UNIX_EPOCH_SERIAL)
  const localEpoch = Math.round((unixDays * MILLISECONDS_PER_DAY) / 1000) * 1000
  return parsedLocalDateTime(localEpoch, timezoneOffsetMinutes)
}

function parseLocalDateTime(raw, timezoneOffsetMinutes) {
  const value = normalizeText(raw, 64)
  const match = LOCAL_TIME_PATTERN.exec(value)
  if (!match) return parseExcelSerialDateTime(value, timezoneOffsetMinutes)
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00'] = match
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText
  ].map(Number)
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(localEpoch)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day || check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null
  return parsedLocalDateTime(localEpoch, timezoneOffsetMinutes)
}

function normalizeDirection(value) {
  switch (normalizeText(value, 32)) {
    case '收入':
    case '收':
      return 'income'
    case '支出':
    case '支':
      return 'expense'
    case '/':
    case '中性交易':
    case '中性':
    case '不计收支':
      return 'neutral'
    default:
      return 'unknown'
  }
}

function normalizeRow(sourceType, raw, timezoneOffsetMinutes, rowIssues = [], sourceFormat = null, presentFields = null) {
  const issues = [...rowIssues]
  const time = parseLocalDateTime(raw.transactionTime, timezoneOffsetMinutes)
  const amountMinor = parseAmountMinor(raw.amount)
  const direction = normalizeDirection(raw.direction)
  const semantic = resolveRowSemantic({
    sourceType,
    sourceFormat,
    rawTransactionType: raw.transactionType,
    transactionType: raw.transactionType,
    rawDirection: raw.direction,
    direction,
    rawStatus: raw.status,
    status: raw.status,
    paymentMethod: raw.paymentMethod,
    counterparty: raw.counterparty,
    item: raw.item,
    amountMinor,
    currency: 'CNY'
  })
  const transactionType = semantic.legacy.transactionType
  const economicEffect = semantic.legacy.economicEffect
  const paymentAccount = paymentAccountDetails(sourceType, raw.paymentMethod)

  if (!time) issues.push(issue('row_time_invalid', 'transaction_time', 'error'))
  if (amountMinor == null) issues.push(issue('row_amount_invalid', 'amount', 'error'))
  if (direction === 'unknown') issues.push(issue('row_direction_unknown', 'direction'))
  semantic.issues.forEach((semanticIssue) => {
    if (!issues.some((existing) => existing.code === semanticIssue.code && existing.field === semanticIssue.field)) {
      issues.push(semanticIssue)
    }
  })

  const hasError = issues.some((item) => item.severity === 'error')
  let eligibility = 'review_required'
  if (hasError || economicEffect === 'closed' || economicEffect === 'failed') {
    eligibility = 'non_postable'
  } else if (semantic.resolutionStatus === 'resolved' && economicEffect === 'normal' &&
      (direction === 'income' || direction === 'expense') &&
      (transactionType === 'payment' || transactionType === 'fee')) {
    eligibility = 'postable'
  }

  const observation = (field, options = {}) => observeField(raw[field], {
    ...options, present: !presentFields || presentFields.has(field)
  })
  return {
    normalized: {
      localDate: time && time.localDate,
      localAt: time && time.localAt,
      utcAt: time && time.utcAt,
      timezoneOffsetMinutes,
      amountMinor,
      currency: 'CNY',
      direction,
      transactionType,
      economicEffect,
      counterparty: normalizeText(raw.counterparty, 255),
      item: normalizeText(raw.item, 255),
      paymentMethod: paymentAccount.recognized ? paymentAccount.displayName : '',
      note: normalizeText(raw.note, 1024)
    },
    observations: {
      transactionTime: observation('transactionTime', { parsed: Boolean(time) }),
      amount: observation('amount', { parsed: amountMinor != null }),
      direction: observation('direction', { known: direction !== 'unknown' }),
      status: observation('status', {
        known: !semantic.issues.some((item) => item.code === 'row_status_unknown')
      }),
      transactionType: observation('transactionType', {
        known: !semantic.issues.some((item) => ['row_transaction_type_unknown', 'row_semantic_conflict'].includes(item.code))
      }),
      paymentMethod: observation('paymentMethod'),
      counterparty: observation('counterparty'),
      counterpartyAccount: observation('counterpartyAccount'),
      item: observation('item'),
      note: observation('note')
    },
    issues,
    semantic,
    parseState: hasError ? 'invalid' : 'valid',
    eligibility,
    processingState: eligibility === 'non_postable' ? 'ignored' : 'pending'
  }
}

function ensureNormalizedForIdentity(row) {
  if (!row.normalized.localAt || row.normalized.amountMinor == null) {
    throw importError('VALIDATION_ERROR')
  }
}

module.exports = {
  ensureNormalizedForIdentity,
  normalizeDirection,
  normalizeRow,
  parseAmountMinor,
  parseLocalDateTime
}
