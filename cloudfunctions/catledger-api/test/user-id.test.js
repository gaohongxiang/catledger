const assert = require('node:assert/strict')
const test = require('node:test')
const { createUserId } = require('../src/user-id')

test('用户ID是首位非0的10位数字字符串', () => {
  for (let index = 0; index < 100; index += 1) {
    assert.match(createUserId(), /^[1-9][0-9]{9}$/)
  }
})
