const assert = require('node:assert/strict')
const test = require('node:test')

const { normalizeAccountName } = require('../src/account-name')

test('account names are normalized for display and active uniqueness', () => {
  assert.deepEqual(normalizeAccountName('  日常\t银行卡  '), {
    name: '日常 银行卡',
    normalizedName: '日常 银行卡'
  })
  assert.deepEqual(normalizeAccountName('ＣＡＳＨ'), {
    name: 'CASH',
    normalizedName: 'cash'
  })
})

test('account names reject empty and oversized values', () => {
  assert.throws(() => normalizeAccountName('   '), { publicCode: 'VALIDATION_ERROR' })
  assert.throws(() => normalizeAccountName('猫'.repeat(33)), { publicCode: 'VALIDATION_ERROR' })
})
