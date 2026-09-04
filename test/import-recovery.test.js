const assert = require('node:assert/strict')
const test = require('node:test')

const recovery = require('../miniprogram/services/import-recovery')

function pending(createdAt) {
  return {
    importId: 'import-id',
    fileID: 'cloud://private/path.csv',
    requestId: 'request-id',
    fileName: '账单.csv',
    fileSize: 51617,
    version: 1,
    createdAt: createdAt
  }
}

test('待解析文件在有效期内可恢复且只保留必要字段', function () {
  const now = 100000000
  assert.deepEqual(recovery.normalizePendingParse(pending(now - 1000), now), pending(now - 1000))
})

test('过期、未来时间和结构不完整的恢复状态会被拒绝', function () {
  const now = 100000000
  assert.equal(recovery.normalizePendingParse(pending(now - 24 * 60 * 60 * 1000 - 1), now), null)
  assert.equal(recovery.normalizePendingParse(pending(now + 60001), now), null)
  assert.equal(recovery.normalizePendingParse({ importId: 'missing-fields', createdAt: now }, now), null)
})
