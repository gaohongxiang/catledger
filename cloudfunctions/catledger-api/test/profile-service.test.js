const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeNickname, createProfileService } = require('../src/profile-service')

test('昵称服务去除首尾空白并接受一至六个 Unicode 字符', () => {
  for (const nickname of ['猫', '一二三四五六', '一二三四五🐱']) {
    assert.equal(normalizeNickname(' ' + nickname + ' '), nickname)
  }
})

test('非法昵称在写事务前拒绝，不触及账本或幂等回执', async () => {
  const service = createProfileService({ getPool() { assert.fail('非法昵称不应访问数据库') } })
  for (const nickname of ['', '  ', '一二三四五六七', '一二三四五🐱🐱', '猫\u0000猫', '猫\n猫', null]) {
    await assert.rejects(service.update({
      provider: 'test', subjectHash: 'synthetic',
      data: { requestId: '00000000-0000-4000-8000-000000000002', nickname, previousNickname: '' }
    }), { publicCode: 'VALIDATION_ERROR' })
  }
})
