const assert = require('node:assert/strict')
const test = require('node:test')

const { needsEditingTransaction } = require('../miniprogram/pages/transaction-editor/model')

test('编辑和待关联退款都必须载入当前交易，新增模式不载入', () => {
  assert.equal(needsEditingTransaction('edit'), true)
  assert.equal(needsEditingTransaction('link-refund'), true)
  assert.equal(needsEditingTransaction('create'), false)
})
