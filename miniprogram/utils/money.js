function normalizeMinorString(value) {
  const text = String(value == null ? '0' : value)
  const negative = text.charAt(0) === '-'
  const digits = negative ? text.slice(1) : text
  return {
    negative: negative,
    digits: digits.replace(/^0+(?=\d)/, '') || '0'
  }
}

function formatMinor(value) {
  const parsed = normalizeMinorString(value)
  const padded = parsed.digits.padStart(3, '0')
  const integer = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const decimal = padded.slice(-2)
  return (parsed.negative ? '-' : '') + '¥' + integer + '.' + decimal
}

function yuanToMinor(value, options) {
  const allowZero = options && options.allowZero
  const text = String(value == null ? '' : value).trim()
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text)) {
    throw new Error('请输入正确金额，最多保留两位小数')
  }
  const parts = text.split('.')
  const minor = (parts[0] + (parts[1] || '').padEnd(2, '0')).replace(/^0+(?=\d)/, '') || '0'
  if (!allowZero && minor === '0') {
    throw new Error('金额必须大于 0')
  }
  return minor
}

function minorToYuan(value) {
  const parsed = normalizeMinorString(value)
  const padded = parsed.digits.padStart(3, '0')
  return (parsed.negative ? '-' : '') + padded.slice(0, -2) + '.' + padded.slice(-2)
}

module.exports = {
  formatMinor: formatMinor,
  minorToYuan: minorToYuan,
  yuanToMinor: yuanToMinor
}
