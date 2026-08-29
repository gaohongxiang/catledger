const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

class LocalTimeValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LocalTimeValidationError'
    this.publicCode = 'VALIDATION_ERROR'
  }
}

function padMilliseconds(value = '') {
  return value.padEnd(3, '0')
}

function parseLocalDateTime(value, timezoneOffsetMinutes) {
  if (typeof value !== 'string' || !Number.isInteger(timezoneOffsetMinutes) ||
      timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840) {
    throw new LocalTimeValidationError('Local time or timezone offset is invalid')
  }

  const match = LOCAL_DATETIME_PATTERN.exec(value)
  if (!match) {
    throw new LocalTimeValidationError('Local time format is invalid')
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00', millisecondText = ''] = match
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const [year, month, day, hour, minute, second] = parts
  const millisecond = Number(padMilliseconds(millisecondText))
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const check = new Date(localEpoch)

  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day || check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    throw new LocalTimeValidationError('Local time does not exist')
  }

  const utcEpoch = localEpoch + timezoneOffsetMinutes * 60_000
  const localDate = `${yearText}-${monthText}-${dayText}`
  const localAt = `${localDate} ${hourText}:${minuteText}:${secondText}.${String(millisecond).padStart(3, '0')}`
  const occurredAtUtc = new Date(utcEpoch).toISOString().replace('T', ' ').replace('Z', '')

  return {
    localDate,
    localAt,
    occurredAtUtc,
    timezoneOffsetMinutes
  }
}

function parseMonth(value) {
  if (typeof value !== 'string') {
    throw new LocalTimeValidationError('Month must be text')
  }

  const match = MONTH_PATTERN.exec(value)
  if (!match) {
    throw new LocalTimeValidationError('Month format is invalid')
  }

  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) {
    throw new LocalTimeValidationError('Month is outside the supported range')
  }

  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return {
    startDate: `${match[1]}-${match[2]}-01`,
    endDate: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`
  }
}

function parseLocalDate(value) {
  if (typeof value !== 'string') {
    throw new LocalTimeValidationError('Date must be text')
  }

  const match = DATE_PATTERN.exec(value)
  if (!match) {
    throw new LocalTimeValidationError('Date format is invalid')
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const epoch = Date.UTC(year, month - 1, day)
  const check = new Date(epoch)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new LocalTimeValidationError('Date does not exist')
  }

  const next = new Date(epoch + 24 * 60 * 60 * 1000)
  return {
    startDate: value,
    endDate: `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
  }
}

module.exports = {
  LocalTimeValidationError,
  parseLocalDate,
  parseLocalDateTime,
  parseMonth
}
