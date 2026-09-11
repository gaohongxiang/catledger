function normalizeSigned(value) {
  const text = String(value == null ? '0' : value)
  const negative = text.charAt(0) === '-'
  const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, '') || '0'
  return { negative: negative && digits !== '0', digits: digits }
}

function compareAbs(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1
  return left === right ? 0 : (left > right ? 1 : -1)
}

function addAbs(left, right) {
  let carry = 0
  let output = ''
  let leftIndex = left.length - 1
  let rightIndex = right.length - 1
  while (leftIndex >= 0 || rightIndex >= 0 || carry) {
    const sum = Number(left[leftIndex] || 0) + Number(right[rightIndex] || 0) + carry
    output = String(sum % 10) + output
    carry = Math.floor(sum / 10)
    leftIndex -= 1
    rightIndex -= 1
  }
  return output
}

function subtractAbs(larger, smaller) {
  let borrow = 0
  let output = ''
  let largerIndex = larger.length - 1
  let smallerIndex = smaller.length - 1
  while (largerIndex >= 0) {
    let digit = Number(larger[largerIndex]) - borrow - Number(smaller[smallerIndex] || 0)
    if (digit < 0) { digit += 10; borrow = 1 } else borrow = 0
    output = String(digit) + output
    largerIndex -= 1
    smallerIndex -= 1
  }
  return output.replace(/^0+(?=\d)/, '') || '0'
}

function addMinor(leftValue, rightValue) {
  const left = normalizeSigned(leftValue)
  const right = normalizeSigned(rightValue)
  if (left.negative === right.negative) {
    const digits = addAbs(left.digits, right.digits)
    return left.negative && digits !== '0' ? '-' + digits : digits
  }
  const comparison = compareAbs(left.digits, right.digits)
  if (comparison === 0) return '0'
  const larger = comparison > 0 ? left : right
  const smaller = comparison > 0 ? right : left
  const digits = subtractAbs(larger.digits, smaller.digits)
  return larger.negative ? '-' + digits : digits
}

module.exports = { addMinor }
