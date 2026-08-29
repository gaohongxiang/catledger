const assert = require('node:assert/strict')
const test = require('node:test')

const {
  MAX_MINOR_UNITS,
  minorUnitsToString,
  parseMinorUnits
} = require('../src/money')

test('minor-unit amounts remain exact strings and BigInts', () => {
  assert.equal(parseMinorUnits('1'), 1n)
  assert.equal(parseMinorUnits(MAX_MINOR_UNITS.toString()), MAX_MINOR_UNITS)
  assert.equal(parseMinorUnits('0', { allowZero: true }), 0n)
  assert.equal(minorUnitsToString(9007199254740993n), '9007199254740993')
  assert.equal(minorUnitsToString('-1'), '-1')
})

test('minor-unit parsing rejects floats, non-canonical values and overflow', () => {
  for (const value of [0, '01', '-1', '1.00', ' 1', '1 ', '', null]) {
    assert.throws(() => parseMinorUnits(value), { publicCode: 'VALIDATION_ERROR' })
  }
  assert.throws(() => parseMinorUnits('0'), { publicCode: 'VALIDATION_ERROR' })
  assert.throws(
    () => parseMinorUnits((MAX_MINOR_UNITS + 1n).toString()),
    { publicCode: 'VALIDATION_ERROR' }
  )
})
