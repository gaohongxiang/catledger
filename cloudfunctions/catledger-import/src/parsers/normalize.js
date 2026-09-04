const { importError } = require('../errors')
const { paymentAccountDetails } = require('../payment-account')
const { classifySourceAction } = require('../source-action')
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

function containsAny(value, candidates) {
  return candidates.some((candidate) => value.includes(candidate))
}

function normalizeEconomicEffect(sourceType, transactionType, status) {
  const type = normalizeText(transactionType, 128)
  const state = normalizeText(status, 128)
  if (containsAny(state, ['失败', '未支付', '未收款'])) return 'failed'
  if (containsAny(state, ['关闭', '撤销', '取消'])) return 'closed'
  if (containsAny(state, ['退款成功', '退款完成', '已退款', '已退还', '已全额退款', '已部分退款', '退税成功'])) return 'refund'
  if (sourceType === 'wechat' && type.includes('退款') && containsAny(state, ['成功', '完成', '到账'])) return 'refund'
  if (containsAny(state, [
    '交易成功', '支付成功', '等待确认收货', '还款成功', '交易完成', '已完成', '收款成功',
    '成功', '已收钱', '已到账', '已支付', '已存入', '已转账', '已领取'
  ])) return 'normal'
  return 'unknown'
}

function classifyWechatType(value) {
  return classifySourceAction({ sourceType: 'wechat', rawTransactionType: value }).normalizedTransactionType
}

function classifyAlipayType(transactionType, item, direction) {
  return classifySourceAction({
    sourceType: 'alipay',
    rawTransactionType: transactionType,
    item,
    direction
  }).normalizedTransactionType
}

function normalizeRow(sourceType, raw, timezoneOffsetMinutes, rowIssues = []) {
  const issues = [...rowIssues]
  const time = parseLocalDateTime(raw.transactionTime, timezoneOffsetMinutes)
  const amountMinor = parseAmountMinor(raw.amount)
  const direction = normalizeDirection(raw.direction)
  const transactionType = sourceType === 'wechat'
    ? classifyWechatType(raw.transactionType)
    : classifyAlipayType(raw.transactionType, raw.item, direction)
  const economicEffect = normalizeEconomicEffect(sourceType, raw.transactionType, raw.status)
  const paymentAccount = paymentAccountDetails(sourceType, raw.paymentMethod)

  if (!time) issues.push(issue('row_time_invalid', 'transaction_time', 'error'))
  if (amountMinor == null) issues.push(issue('row_amount_invalid', 'amount', 'error'))
  if (direction === 'unknown') issues.push(issue('row_direction_unknown', 'direction'))
  if (transactionType === 'unknown') issues.push(issue('row_transaction_type_unknown', 'transaction_type'))
  if (economicEffect === 'unknown') issues.push(issue('row_status_unknown', 'status'))

  const hasError = issues.some((item) => item.severity === 'error')
  let eligibility = 'review_required'
  if (hasError || economicEffect === 'closed' || economicEffect === 'failed') {
    eligibility = 'non_postable'
  } else if (economicEffect === 'normal' &&
      (direction === 'income' || direction === 'expense') &&
      (transactionType === 'payment' || transactionType === 'fee')) {
    eligibility = 'postable'
  }

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
    issues,
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
  classifyAlipayType,
  classifyWechatType,
  ensureNormalizedForIdentity,
  normalizeDirection,
  normalizeEconomicEffect,
  normalizeRow,
  parseAmountMinor,
  parseLocalDateTime
}
