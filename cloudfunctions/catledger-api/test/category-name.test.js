const assert = require('node:assert/strict')
const test = require('node:test')

const { normalizeCategoryName } = require('../src/category-name')

test('category names are normalized for active uniqueness', () => {
  assert.deepEqual(normalizeCategoryName('  宠物  日常  '), {
    name: '宠物 日常',
    normalizedName: '宠物 日常'
  })
  assert.equal(normalizeCategoryName('ＴＲＡＶＥＬ').normalizedName, 'travel')
})

test('category names reject empty and oversized values', () => {
  assert.throws(() => normalizeCategoryName('  '), { publicCode: 'VALIDATION_ERROR' })
  assert.throws(() => normalizeCategoryName('分'.repeat(33)), { publicCode: 'VALIDATION_ERROR' })
})
